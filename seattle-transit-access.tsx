import { useState, useEffect, useRef, useMemo } from 'react';

// Geographic constants for Seattle
const SEATTLE_CENTER = [47.6062, -122.3321]; // Center coordinates for map initialization
const HALF_MILE_METERS = 804.672; // Walking distance buffer (approximately 10 minute walk)

// The 2027 scenario has no GTFS feed of its own; it layers future_stops_2027.json on top of this year's data.
// Keep in sync with GTFS_YEAR in isochrone-generation/extract-all-stops.js.
const FUTURE_SCENARIO_BASE_YEAR = '2026';

// Time-of-day presets.
enum Preset {
  AllDay,
  AmPeak,
  Midday,
  PmPeak,
  Evening,
  LateNight,
  Overnight,
}

// Hours are [start, end) on a 24-hour clock, matching the keys of hourly_trips.
const PRESETS: Record<Preset, { label: string; hours: readonly [number, number] }> = {
  [Preset.AllDay]: { label: 'All day', hours: [6, 19] },
  [Preset.AmPeak]: { label: 'AM peak', hours: [6, 9] },
  [Preset.Midday]: { label: 'Midday', hours: [9, 15] },
  [Preset.PmPeak]: { label: 'PM peak', hours: [15, 19] },
  [Preset.Evening]: { label: 'Evening', hours: [19, 21] },
  [Preset.LateNight]: { label: 'Late night', hours: [21, 24] },
  [Preset.Overnight]: { label: 'Overnight', hours: [0, 6] },
};

const HEADWAYS = [10, 15, 20, 30, 60]; // Minutes between buses, offered in the headway dropdown

// One color per headway, used in both single and tiers mode so a headway always looks the same.
// The tier colors stay distinguishable in every pair under red-green colorblindness, and the cool hues stay clear
// of the yellow/orange/red population density layer. The purple is darker than the blue so the two don't merge
// for colorblind viewers. 10 min keeps the blue of the original single-headway map.
// 20 min only appears in single mode, never beside the tiers, so it's a neutral slate rather than a fifth hue.
const HEADWAY_COLORS: Record<number, string> = {
  10: '#2563eb', // blue
  15: '#0b8f6a', // bluish green
  20: '#475569', // slate
  30: '#6d3c9e', // purple
  60: '#62bbe9', // sky blue
};

// Tiers mode draws nested walksheds for these headways, tightest first, each as a ring outside the tighter tier
const TIER_HEADWAYS = [10, 15, 30, 60];
const TIER_FILL_OPACITY = 0.35;
const TIER_MARKER_MIN_ZOOM = 14; // In tiers mode, stop markers would hide the bands when zoomed out

// Format an hour of the day (0-24) for display, e.g. 6 -> "6am", 15 -> "3pm", 0 or 24 -> "midnight"
function formatHour(hour: number): string {
  if (hour % 24 === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/**
 * Does a stop with these hourly trip counts have service every `headway` minutes or better during the preset?
 *
 * The preset's window must average at least 60 / headway trips per hour, and no hour may drop below the next
 * looser headway in HEADWAYS. e.g. 15 minutes needs an average of 4 trips per hour with no hour under 3
 * (every 20 minutes). This forgives routes that ex: ramp up slowly in the morning.
 *
 * This generalizes the city-matched 10-minute rule: 4+ trips every hour (15 minutes) AND 77+ trips in total
 * from 6am-7pm. All day + 10 minutes keeps the city's 77-trip total rather than 6 x 13 = 78.
 */
function qualifies(hourlyTrips: Record<string, number> | undefined, preset: Preset, headway: number): boolean {
  if (!hourlyTrips) return false;

  const [start, end] = PRESETS[preset].hours;
  const looserHeadway = HEADWAYS[HEADWAYS.indexOf(headway) + 1] ?? headway;
  const minTripsPerHour = 60 / looserHeadway;
  const minTotalTrips = preset === Preset.AllDay && headway === 10 ? 77 : (60 / headway) * (end - start);

  let total = 0;
  for (let h = start; h < end; h++) {
    const trips = hourlyTrips[h.toString()] || 0;
    if (trips < minTripsPerHour) return false;
    total += trips;
  }

  return total >= minTotalTrips;
}

/**
 * Merge polygons into one with turf.union, in a tree: pairs, then pairs of pairs, and so on.
 *
 * Merging one at a time into a single growing shape gets slower with every polygon, since each union scans the
 * whole merged outline (minutes for a few thousand walksheds). In a tree most unions are between small shapes,
 * which takes seconds. A polygon that fails to merge is set aside and retried at the end, and skipped if it fails
 * again, so one bad geometry doesn't drop the rest of its branch.
 */
function mergeWalksheds(polygons: any[]): any {
  const failed: any[] = [];
  let level = polygons;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        continue;
      }
      try {
        next.push(window.turf.union(level[i], level[i + 1]));
      } catch {
        next.push(level[i]);
        failed.push(level[i + 1]);
      }
    }
    level = next;
  }

  let union = level[0];
  for (const polygon of failed) {
    try {
      union = window.turf.union(union, polygon);
    } catch {
      continue;
    }
  }
  return union;
}

const SEATTLE_POPULATION = 737015; // Seattle 2020 Census count
const POPULATION_GRID_SIZE = 24; // Walkshed is cut into this many cells per side for population served

/**
 * Population living inside a walkshed, from census blocks prepared as { feature, population, area, bbox }
 *
 * Partially covered blocks count in proportion to the area covered, which assumes people are spread evenly across
 * each block (an approximation: people cluster in buildings, not parking lots).
 *
 * Intersecting every block with the whole walkshed takes 10-15s, since each intersection scans the walkshed's full
 * outline. Instead the walkshed is cut into a grid of small pieces once, and each block is intersected only with the
 * pieces its bounding box overlaps. Same result in about 1s.
 */
function populationInWalkshed(walkshed: any, blocks: any[]): number {
  const turf = window.turf;
  const [x0, y0, x1, y1] = turf.bbox(walkshed);
  const n = POPULATION_GRID_SIZE;
  const dx = (x1 - x0) / n;
  const dy = (y1 - y0) / n;

  // Clip the walkshed to each grid cell, dropping the empty rings bboxClip leaves behind
  const cells: any[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const clipped = turf.bboxClip(walkshed, [x0 + i * dx, y0 + j * dy, x0 + (i + 1) * dx, y0 + (j + 1) * dy]);
      const geometry = clipped.geometry;
      const polygons = (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates])
        .map((polygon: any[]) => polygon.filter(ring => ring.length >= 4))
        .filter((polygon: any[]) => polygon.length > 0);
      cells.push(polygons.length > 0 ? turf.multiPolygon(polygons) : null);
    }
  }

  let population = 0;
  for (const block of blocks) {
    const [bx0, by0, bx1, by1] = block.bbox;
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;

    const i0 = Math.max(0, Math.floor((bx0 - x0) / dx));
    const i1 = Math.min(n - 1, Math.floor((bx1 - x0) / dx));
    const j0 = Math.max(0, Math.floor((by0 - y0) / dy));
    const j1 = Math.min(n - 1, Math.floor((by1 - y0) / dy));
    let coveredArea = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = cells[i * n + j];
        if (!cell) continue;
        try {
          const part = turf.intersect(block.feature, cell);
          if (part) coveredArea += turf.area(part);
        } catch {
          // Skip pieces that cause geometry errors
        }
      }
    }
    population += block.population * Math.min(1, coveredArea / block.area);
  }
  return population;
}

/**
 * Load a script at most once per page, resolving when its global is available.
 *
 * React StrictMode (dev) and hot reloads re-run effects. Loading Leaflet a second time replaces window.L,
 * leaving the existing map on a different Leaflet copy than new layers, which crashes in Bounds.intersects.
 */
const scriptLoads = new Map<string, Promise<void>>();
function loadScriptOnce(src: string, globalName: 'L' | 'turf'): Promise<void> {
  if (window[globalName]) return Promise.resolve();
  if (!scriptLoads.has(src)) {
    scriptLoads.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    }));
  }
  return scriptLoads.get(src)!;
}

/**
 * Seattle Transit Visualizer
 *
 * This component visualizes "frequent transit" stops on a map with a walkshed around them.
 * - Loads pre-processed stop data with per-hour trip frequencies from all_stops JSON files
 * - Filters stops that meet frequent transit criteria
 * - Visualizes 10-minute walksheds (pre-computed isochrones or circle buffers)
 * - Integrates US Census data to calculate population served
 * - Displays coverage statistics and interactive map
 * - Supports future year scenario for 2027 w/ planned transit expansions hard coded in future_stops JSON
 *
 * Data Processing:
 * - GTFS parsing is done offline by extract-all-stops.js
 * - Hourly frequencies are pre-calculated and stored in all_stops_{year}.json
 * - This site then loads and filters that pre-processed data
 */
export default function SeattleTransitVisualizer() {
  // Data state - stores processed transit information
  const [yearStops, setYearStops] = useState<any[]>([]); // Every stop for the selected year (incl. future stops), with hourlyTrips
  const [stats, setStats] = useState<any>(null); // Calculated coverage statistics
  const [censusData, setCensusData] = useState<any>(null); // Population data from US Census
  const [seattleBoundary, setSeattleBoundary] = useState<any>(null); // Seattle city limits polygon
  const [isochrones, setIsochrones] = useState<Map<string, any>>(new Map()); // Pre-computed walksheds keyed by stop_id
  const [censusBlocks, setCensusBlocks] = useState<any>(null); // Census blocks with population for visualization

  // UI state - tracks loading and error states
  const [loading, setLoading] = useState<boolean>(false); // GTFS data loading indicator
  const [loadingCensus, setLoadingCensus] = useState<boolean>(false); // Census data loading indicator
  const [error, setError] = useState<string | null>(null); // Error message display
  const [showCensusBlocks, setShowCensusBlocks] = useState<boolean>(false); // Toggle census block visualization

  // Year selection - allows switching between different GTFS datasets
  // 2020 is base year, 2025 and 2026 are recent feeds, 2027 is 2026 plus hardcoded 'future' data
  const [selectedYear, setSelectedYear] = useState<string>('2020');
  const [availableYears] = useState<string[]>(['2020', '2025', '2026', '2027']);

  // Frequency selection - which time of day and how often buses must come for a stop to count
  const [preset, setPreset] = useState<Preset>(Preset.AllDay);
  const [headway, setHeadway] = useState<number>(10); // Minutes between buses, in single mode
  const [mode, setMode] = useState<'single' | 'tiers'>('single'); // One headway, or nested bands for TIER_HEADWAYS
  const modeRef = useRef(mode); // For the map's zoom handler, which outlives renders
  modeRef.current = mode;

  // The headways being drawn, tightest first. Single mode is a one-tier list so both modes share the same code.
  const activeHeadways = mode === 'tiers' ? TIER_HEADWAYS : [headway];

  // Stops meeting the loosest active headway, and the tightest active headway each one meets.
  // Changing year, preset, headway or mode re-filters without re-fetching.
  const { frequentStops, bestHeadway } = useMemo(() => {
    const bestHeadway = new Map<string, number>();
    for (const stop of yearStops) {
      const tightest = activeHeadways.find(h => qualifies(stop.hourlyTrips, preset, h));
      if (tightest !== undefined) bestHeadway.set(stop.id, tightest);
    }
    return { frequentStops: yearStops.filter(stop => bestHeadway.has(stop.id)), bestHeadway };
  }, [yearStops, preset, headway, mode]);

  // React refs - maintain references to DOM elements and map objects
  const mapRef = useRef<HTMLDivElement>(null); // Container for Leaflet map
  const leafletMapRef = useRef<any>(null); // Leaflet map instance
  const canvasRendererRef = useRef<any>(null); // Shared canvas renderer, so thousands of stop markers stay fast
  const fitToStopsRef = useRef<boolean>(true); // Zoom to fit the stops on the next draw (set when the year changes)
  const markersLayerRef = useRef<any>(null); // Layer group holding the stop markers, so tiers mode can hide them by zoom
  // In-bounds merged walkshed per active headway, and its ring: the part not covered by the next tighter headway
  const tierPolygonsRef = useRef<{ headway: number; polygon: any; ring: any }[]>([]);
  const censusCacheRef = useRef<{ geometries: any; seattleBlocks: any[] } | null>(null); // Census file, loaded once per page
  const mergedPolygonOutOfBoundsRef = useRef<any>(null); // Out-of-bounds portion of the loosest active headway

  // Library loading state - tracks when external CDN libraries are ready
  const [leafletLoaded, setLeafletLoaded] = useState<boolean>(false); // Mapping library
  const [turfLoaded, setTurfLoaded] = useState<boolean>(false); // Geospatial analysis library

  /**
   * Effect: Load external JavaScript libraries from CDN
   *
   * We load libraries dynamically at runtime because this is a simple app.
   * Libraries loaded:
   * - Leaflet: Interactive map rendering (CSS + JS)
   * - Turf.js: Geospatial calculations (polygon unions, area calculations, intersections)
   *
   * Scripts are loaded once per page and left in place (see loadScriptOnce)
   */
  useEffect(() => {
    // Load Leaflet CSS for map styling
    const leafletCss = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
    if (!document.querySelector(`link[href="${leafletCss}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = leafletCss;
      document.head.appendChild(link);
    }

    // Load Leaflet JS for interactive mapping
    loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', 'L')
      .then(() => setLeafletLoaded(true))
      .catch(err => console.error(err));

    // Load Turf.js for geospatial operations (polygon unions, area calculations)
    loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js', 'turf')
      .then(() => setTurfLoaded(true))
      .catch(err => console.error(err));
  }, []);

  /**
   * Effect: Initialize the Leaflet map once the library is loaded
   *
   * Only runs once when Leaflet becomes available
   */
  useEffect(() => {
    if (leafletLoaded && mapRef.current && !leafletMapRef.current) {
      initMap();
    }
  }, [leafletLoaded]);

  /**
   * Effect: Redraw map markers when frequent stops data changes
   *
   * Triggers whenever we process new GTFS data, change years, or change preset/headway.
   * Runs even when no stops qualify, so the previous selection's markers are cleared.
   */
  useEffect(() => {
    if (yearStops.length > 0 && leafletMapRef.current) {
      drawStops();
    }
  }, [frequentStops, seattleBoundary, showCensusBlocks]);

  /**
   * Effect: Auto-load pre-processed stop data when year changes
   *
   * Loads pre-processed all_stops JSON file from /base_data/{year}/ directory
   */
  useEffect(() => {
    loadUploadedFile();
  }, [selectedYear]);

  /**
   * Effect: Load pre-computed isochrones for the selected year
   *
   * Isochrones are accurate walking polygons generated offline
   * Loads isochrones for the selected year or for 2027, loads both the base year and 2027 ones.
   *
   */
  useEffect(() => {
    async function loadIsochrones() {
      const isoMap = new Map();

      // For 2027, load both base year and 2027 (future stops) isochrones
      const yearsToLoad = selectedYear === '2027' ? [FUTURE_SCENARIO_BASE_YEAR, '2027'] : [selectedYear];

      // Load relevant isochrone files.
      for (const year of yearsToLoad) {
        const isochroneUrl = `${import.meta.env.BASE_URL}base_data/isochrones_${year}.json`;
        try {
          const response = await fetch(isochroneUrl);
          if (response.ok) {
            const data = await response.json();
            data.isochrones.forEach((iso: any) => {
              isoMap.set(iso.stop_id, iso);
            });
          } else {
            console.warn(`No isochrones file found for ${year} (status ${response.status})`);
            setIsochrones(new Map());
          }
        } catch (err) {
          console.error('Could not load isochrones:', err);
          setIsochrones(new Map());
        }
      }
      console.log(`Total isochrones loaded: ${isoMap.size}`);
      setIsochrones(isoMap);
    }
    loadIsochrones();
  }, [selectedYear]);

  /**
   * Effect: Load Seattle city boundary GeoJSON
   *
   * This boundary is used to clip walksheds and calculate accurate coverage within the city limits.
   */
  useEffect(() => {
    async function loadSeattleBoundary() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}base_data/seattle-city-limits.geojson`);
        if (response.ok) {
          const boundary = await response.json();
          console.log('Seattle boundary loaded successfully');
          setSeattleBoundary(boundary);
        }
      } catch (err) {
        console.error('Could not load Seattle boundary:', err);
      }
    }
    loadSeattleBoundary();
  }, []);

  /**
   * Effect: Recalculate walksheds when Seattle boundary loads OR when stops/isochrones load
   *
   * This handles multiple scenarios:
   * 1. Boundary loads after GTFS data is already processed
   * 2. GTFS data loads after boundary is already available
   * 3. Isochrones load after stops are already calculated
   * 4. Preset or headway changes (including to a selection with no qualifying stops)
   */
  useEffect(() => {
    if (seattleBoundary && yearStops.length > 0 && isochrones.size > 0 && turfLoaded && window.turf) {
      recalculateWalksheds();
    }
  }, [seattleBoundary, frequentStops, isochrones, turfLoaded]);

  /**
   * Initialize the Leaflet map with OpenStreetMap tiles
   *
   * Creates a map centered on Seattle with street map background
   */
  function initMap() {
    const L = window.L;
    const map = L.map(mapRef.current).setView(SEATTLE_CENTER, 12);

    // Add OpenStreetMap tile layer as the base map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);

    leafletMapRef.current = map;
    // Stop markers get their own pane above the overlay pane (z-index 400), where walksheds and census blocks
    // are drawn as SVG. Otherwise whichever renderer was created last covers the other and takes the hover.
    map.createPane('stops');
    map.getPane('stops').style.zIndex = '450';
    canvasRendererRef.current = L.canvas({ padding: 0.5, pane: 'stops' });

    markersLayerRef.current = L.layerGroup();
    map.on('zoomend', updateMarkerVisibility);
  }

  /**
   * Draw census blocks colored by population density
   *
   * Only shows blocks in Seattle with population > 0
   * Color intensity based on population density (people per square meter)
   */
  function drawCensusBlocks(map: any, L: any) {
    if (!censusBlocks || !censusBlocks.features) return;

    // Helper function to get color based on density in square miles
    function getColor(density: number): string {
      if (density >= 20000) return '#7f1d1d';
      if (density >= 15000) return '#dc2626';
      if (density >= 10000) return '#f97316';
      if (density >= 5000) return '#fbbf24';
      return '#fde047';
    }

    // Draw each census block
    L.geoJSON(censusBlocks, {
      filter: (feature: any) => {
        return feature.properties.Place === 'Seattle' &&
               parseInt(feature.properties.TOT_POP || '0') > 0;
      },
      style: (feature: any) => {
        const population = parseInt(feature.properties.TOT_POP || '0');
        const area = parseInt(feature.properties.ACRES_LAND || '0') * 0.0015625; // Convert acres to square miles
        const density = population / area;

        return {
          fillColor: getColor(density),
          fillOpacity: 0.4,
          color: '#666',
          weight: 0.5,
          opacity: 0.3
        };
      },
      onEachFeature: (feature: any, layer: any) => {
        const population = parseInt(feature.properties.TOT_POP || '0');
        const area = parseInt(feature.properties.ACRES_LAND || '0') * 0.0015625; // Convert acres to square miles
        const density = population / area;

        layer.bindTooltip(
          `<strong>Population:</strong> ${population.toLocaleString()}<br>` +
          `<strong>Density:</strong> ${Math.round(density).toLocaleString()} per mi²<br>` +
          `<strong>Area:</strong> ${area.toFixed(3)} mi²`
        );
      }
    }).addTo(map);
  }

  /**
   * Draw frequent transit stops and walkshed coverage on the map
   *
   * Layers (in order):
   * 1. Seattle city boundary (thin gray outline)
   * 2. Census blocks (if enabled, colored by population density)
   * 3. Out-of-bounds walkshed portions (gray, faded)
   * 4. In-bounds merged walkshed polygon (blue shaded area showing combined coverage)
   * 5. Individual stop markers (dark blue circles with tooltips)
   *
   */
  function drawStops() {
    const L = window.L;
    const map = leafletMapRef.current;

    // Clear existing layers (circles, markers, polygons) to avoid duplicates
    markersLayerRef.current.clearLayers();
    map.eachLayer(layer => {
      if (layer instanceof L.Circle || layer instanceof L.CircleMarker || layer instanceof L.GeoJSON) {
        map.removeLayer(layer);
      }
    });

    // Draw Seattle city boundary for reference
    if (seattleBoundary) {
      L.geoJSON(seattleBoundary, {
        style: {
          fillColor: 'transparent',
          color: '#494d53a1', // Gray outline
          weight: 2,
          opacity: 0.6
        }
      }).addTo(map);
    }

    // Draw census blocks with population density coloring (if enabled)
    if (showCensusBlocks && censusBlocks && window.turf) {
      drawCensusBlocks(map, L);
    }

    // Draw out-of-bounds walkshed portions (gray, faded)
    if (mergedPolygonOutOfBoundsRef.current) {
      L.geoJSON(mergedPolygonOutOfBoundsRef.current, {
        style: {
          fillColor: '#727881c2', // Gray fill
          fillOpacity: 0.30,
          color: '#494e58a1', // Darker gray border
          weight: 1,
          opacity: 0.4,
          dashArray: '5, 5' // Dashed line to indicate out-of-bounds
        }
      }).addTo(map);
    }

    // Draw merged walkshed polygons within Seattle (combined 10-minute walking areas), in the headway's color.
    // Single mode: one area. Tiers mode: one ring per headway, so each area shows exactly one tier's color.
    // Over population density, tiers are outlines of the full tier instead, so the density colors show through.
    const tiers = mode === 'tiers';
    const tierOutlines = tiers && showCensusBlocks && !!censusBlocks;
    [...tierPolygonsRef.current].reverse().forEach(({ headway: tierHeadway, polygon, ring }) => {
      const shape = tiers && !tierOutlines ? ring : polygon;
      if (!shape) return;
      const color = HEADWAY_COLORS[tierHeadway];
      L.geoJSON(shape, {
        style: tiers ? {
          fillColor: color,
          fillOpacity: tierOutlines ? 0 : TIER_FILL_OPACITY,
          color,
          weight: tierOutlines ? 3 : 1,
          opacity: tierOutlines ? 1 : 0.8
        } : {
          fillColor: color,
          fillOpacity: 0.25, // Semi-transparent
          color,
          weight: 2,
          opacity: 0.8
        }
      }).addTo(map);
    });

    // Add individual stop markers with tooltips showing stop name and ID
    const bounds = [];
    frequentStops.forEach(stop => {
      bounds.push([stop.lat, stop.lon]);

      // Different styling for future stops vs existing stops. Existing stops take their headway's color.
      const isFuture = stop.isFuture === true;
      const markerOptions = isFuture ? {
        radius: 6,
        fillColor: '#10b981', // Green for future stops
        fillOpacity: 0.8,
        color: 'white', // White border for contrast
        weight: 2,
        dashArray: '3, 3' // Dashed border to indicate future
      } : {
        radius: 5,
        fillColor: HEADWAY_COLORS[bestHeadway.get(stop.id)!], // The color of the tightest headway the stop meets
        fillOpacity: 1,
        color: 'white', // White border for contrast
        weight: 2
      };

      // Create circle marker for each frequent transit stop
      const tierLine = tiers ? `<br><small>Every ${bestHeadway.get(stop.id)} min or better</small>` : '';
      const tooltip = isFuture
        ? `${stop.name}<br><small>${stop.routeName || 'Future Stop'}</small>${tierLine}`
        : `${stop.name}<br><small>ID: ${stop.id}</small>${tierLine}`;

      L.circleMarker([stop.lat, stop.lon], { ...markerOptions, renderer: canvasRendererRef.current })
        .bindTooltip(tooltip)
        .addTo(markersLayerRef.current);
    });
    updateMarkerVisibility();

    // Auto-zoom map to show all stops with padding, only after a year change so preset/headway changes keep the view
    if (fitToStopsRef.current && bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50] });
      fitToStopsRef.current = false;
    }
  }

  /**
   * Show stop markers, except in tiers mode below TIER_MARKER_MIN_ZOOM where they'd hide the bands.
   * Also called on every zoom, so it reads mode from a ref rather than state.
   */
  function updateMarkerVisibility() {
    const map = leafletMapRef.current;
    const markers = markersLayerRef.current;
    if (!map || !markers) return;

    const show = modeRef.current !== 'tiers' || map.getZoom() >= TIER_MARKER_MIN_ZOOM;
    if (show && !map.hasLayer(markers)) markers.addTo(map);
    if (!show && map.hasLayer(markers)) map.removeLayer(markers);
  }

  /**
   * Try to find an isochrone for a stop by checking possible feed combinations
   * Returns the isochrone data if found, null otherwise
   */
  function findIsochroneForStop(stop: any, year: string): any {
    const stopId = stop.id || stop.stop_id;

    // For 2027 viewing mode, GTFS stops come from base year data and new stops from 2027 data.
    // So we need to check base year isochrones for non-future stops
    const isochroneYear = (year === '2027' && !stop.isFuture) ? FUTURE_SCENARIO_BASE_YEAR : year;

    // Try different feed combinations
    const possibleKeys = [
      `${isochroneYear}_soundtransit_${stopId}`,  // Try Sound Transit first (more likely to be frequent)
      `${isochroneYear}_metro_${stopId}`,          // Then Metro
      stopId                                        // Finally, try the raw ID in case it's already composite (for future stops)
    ];

    for (const key of possibleKeys) {
      const isoData = isochrones.get(key);
      if (isoData && isoData.isochrone_10min) {
        return isoData.isochrone_10min;
      }
    }

    return null;
  }

  /**
   * Walkshed polygon for each stop - pre-computed isochrones when available, circular buffers otherwise
   */
  function walkshedsForStops(stopList: any[]): any[] {
    return stopList.map((stop: any) => {
      const isochronePolygon = findIsochroneForStop(stop, selectedYear);

      if (isochronePolygon) {
        // Use pre-computed 10-minute isochrone
        return isochronePolygon;
      } else {
        // Fall back to half-mile circular buffer
        return window.turf.circle(
          [stop.lon, stop.lat],
          HALF_MILE_METERS / 1000,
          { steps: 32, units: 'kilometers' }
        );
      }
    });
  }

  /**
   * Clip a merged walkshed to the city limits and calculate coverage
   *
   * Returns the part inside Seattle, the part outside, and the inside area as a percentage of the city
   */
  function clipToCity(union: any, boundary: any = null) {
    try {
      let mergedPolygon = null;
      let mergedPolygonOutOfBounds = null;
      let coveragePercent = '0';

      // If Seattle boundary is available, clip walksheds to city limits
      if (boundary) {
        const seattleBoundaryAreaSqMeters = window.turf.area(boundary.features[0]);
        try {
          // Simplify the boundary for faster intersection (tolerance = 0.001 degrees ~= 100m)
          const simplifiedBoundary = window.turf.simplify(boundary.features[0], {tolerance: 0.001, highQuality: false});

          // Calculate intersection (walkshed area within Seattle)
          let clipped = null;
          try {
            clipped = window.turf.intersect(union, simplifiedBoundary);
          } catch (intersectErr) {
            console.error('turf.intersect failed:', intersectErr);
          }

          // Calculate difference (walkshed area outside Seattle)
          try {
            const diff = window.turf.difference(
              union,
              simplifiedBoundary
            );
            console.log('Difference result:', diff);
            mergedPolygonOutOfBounds = diff;
          } catch (diffErr) {
            console.error('Difference operation failed (may be no out-of-bounds area):', diffErr);
          }

          if (clipped) {
            mergedPolygon = clipped;

            // Calculate coverage using actual Seattle boundary area (use original, not simplified)
            const clippedAreaSqMeters = window.turf.area(clipped);
            coveragePercent = (clippedAreaSqMeters / seattleBoundaryAreaSqMeters * 100).toFixed(1);
          } else {
            // No intersection - all walksheds are outside Seattle
            console.log('No intersection found - all walksheds outside Seattle');
            mergedPolygon = null;
            mergedPolygonOutOfBounds = union;
            coveragePercent = '0';
          }
        } catch (err) {
          // If clipping fails, fall back to unclipped calculation
          console.error('Clipping to Seattle boundary failed, using full walkshed:', err);
          mergedPolygon = union;
          const areaSqMeters = window.turf.area(union);
          const seattleAreaSqMeters = 217000000;
          coveragePercent = (areaSqMeters / seattleAreaSqMeters * 100).toFixed(1);
        }
      } else {
        // No boundary available, use full walkshed
        console.log('Seattle boundary not loaded yet');
        mergedPolygon = union;
        const areaSqMeters = window.turf.area(union);
        const seattleAreaSqMeters = 217000000;
        coveragePercent = (areaSqMeters / seattleAreaSqMeters * 100).toFixed(1);
      }

      return { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent };
    } catch (err) {
      console.error('Error calculating walkshed coverage:', err);
      return { mergedPolygon: null, mergedPolygonOutOfBounds: null, coveragePercent: '0' };
    }
  }

  /**
   * Recalculate walksheds for each active headway
   *
   * Runs when stops, isochrones or the boundary change. Tiers are nested, so each headway's walkshed is the
   * tighter headway's walkshed plus only the stops that newly qualify, rather than a fresh merge of every stop.
   */
  function recalculateWalksheds() {
    if (!seattleBoundary || !turfLoaded || !window.turf) return;

    let union = null;
    let outOfBounds = null;
    const tierPolygons = [];
    const tierStats = [];
    for (const tierHeadway of activeHeadways) {
      const tierStops = frequentStops.filter(stop => bestHeadway.get(stop.id)! <= tierHeadway);
      const newStops = frequentStops.filter(stop => bestHeadway.get(stop.id) === tierHeadway);
      if (newStops.length > 0) {
        const merged = mergeWalksheds(walkshedsForStops(newStops));
        union = union ? mergeWalksheds([union, merged]) : merged;
      }

      const { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent } = union
        ? clipToCity(union, seattleBoundary)
        : { mergedPolygon: null, mergedPolygonOutOfBounds: null, coveragePercent: '0' };
      outOfBounds = mergedPolygonOutOfBounds;

      // Ring: this tier minus the tighter tier, so each area is drawn in exactly one tier's color
      const tighter = tierPolygons[tierPolygons.length - 1]?.polygon;
      let ring = mergedPolygon;
      if (mergedPolygon && tighter) {
        try {
          ring = window.turf.difference(mergedPolygon, tighter);
        } catch (err) {
          console.error('Tier ring difference failed, drawing the full tier:', err);
        }
      }
      tierPolygons.push({ headway: tierHeadway, polygon: mergedPolygon, ring });
      tierStats.push({
        headway: tierHeadway,
        stopCount: tierStops.length,
        coveragePercent: parseFloat(coveragePercent) > 100 ? '100+' : coveragePercent
      });
    }

    tierPolygonsRef.current = tierPolygons;
    mergedPolygonOutOfBoundsRef.current = outOfBounds; // Loosest headway's, which contains the others

    setStats({ tiers: tierStats });

    // Redraw the map to show updated walksheds with isochrones
    if (leafletMapRef.current) {
      drawStops();
    }

  }

  /**
   * Auto-load pre-processed stop data from all_stops JSON file
   *
   * Loads stop data with pre-calculated hourly trip frequencies from the
   * all_stops_{year}.json files generated by extract-all-stops.js
   *
   * For 2027, loads base year GTFS data (since 2027 data doesn't exist yet)
   *
   * File structure expected: /base_data/all_stops_{year}.json
   */
  async function loadUploadedFile() {
    setLoading(true);
    setError(null);

    try {
      // For 2027, use base year GTFS data (since 2027 data doesn't exist yet)
      const gtfsYear = selectedYear === '2027' ? FUTURE_SCENARIO_BASE_YEAR : selectedYear;
      const allStopsUrl = `${import.meta.env.BASE_URL}base_data/all_stops_${gtfsYear}.json`;

      if (selectedYear === '2027') {
        console.log(`Using ${FUTURE_SCENARIO_BASE_YEAR} GTFS data as base for 2027 scenario`);
      }
      console.log(`Loading pre-processed stop data from: ${allStopsUrl}`);

      const response = await fetch(allStopsUrl);
      if (!response.ok) {
        throw new Error(`all_stops_${gtfsYear}.json not found. Please run extract-all-stops.js first.`);
      }

      const allStops = await response.json();
      console.log(`Loaded ${allStops.length} stops with frequency data`);

      // Keep every stop; frequentStops filters them for the selected preset and headway
      await processAllStopsData(allStops);

    } catch (err: any) {
      setError('Error loading stop data: ' + err.message);
      console.error('Error loading all_stops data:', err);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Store every stop for the selected year, including future stops for scenario years
   *
   * Takes the all_stops JSON data (which already has hourly_trips calculated) and keeps all of it.
   * Filtering to the selected frequency happens in frequentStops, and the walkshed effect
   * recalculates coverage whenever that list changes.
   */
  async function processAllStopsData(allStops: any[]) {
    const stopList = allStops.map((s: any) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      hourlyTrips: s.hourly_trips
    }));

    // Load and add future stops if this is a future year scenario
    const finalStopList = await addFutureStops(stopList, selectedYear);
    console.log(`Total stops including future: ${finalStopList.length}`);

    setYearStops(finalStopList);
  }
  
  /**
   * Load and add future transit stops for scenario planning
   *
   * For future years (like 2027), we can add stops that are under construction
   * or planned but not yet in the GTFS feed. This allows "what-if" analysis.
   */
  async function addFutureStops(existingStops: any[], year: string): Promise<any[]> {
    // Only load future stops for years that have a future stops file
    const futureYears = ['2027'];
    if (!futureYears.includes(year)) {
      return existingStops;
    }

    try {
      const futureStopsUrl = `${import.meta.env.BASE_URL}base_data/future_stops/future_stops_${year}.json`;
      console.log(`Loading future stops from: ${futureStopsUrl}`);

      const response = await fetch(futureStopsUrl);
      if (!response.ok) {
        console.warn(`No future stops file found for ${year}`);
        return existingStops;
      }

      const futureData = await response.json();

      // Keep enabled stops; frequentStops decides which meet the selected frequency
      const enabledFutureStops = futureData.stops
        .filter((stop: any) => stop.enabled !== false)
        .map((stop: any) => ({
          id: stop.id,
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
          isFuture: true,
          routeName: stop.route_name,
          hourlyTrips: stop.hourly_trips
        }));

      console.log(`Adding ${enabledFutureStops.length} future stops for ${year}`);

      // Combine existing and future stops
      return [...existingStops, ...enabledFutureStops];
    } catch (err) {
      console.error('Error loading future stops:', err);
      return existingStops;
    }
  }

  /**
   * Load US Census population data and calculate how many people live within each active headway's walkshed
   *
   * - Local GeoJSON file: Census block geometries with population counts for King County
   *   (KING_COUNTY_BLOCK_2020_POPULATION.geojson in base_data directory), fetched once per page
   * - Only Seattle blocks with people count (filtered by `Place`)
   * - Single mode gets one number; tiers mode gets one per tier, each including the more frequent tiers
   * - Percentages are of Seattle's total population
   */
  async function loadCensusData() {
    if (!turfLoaded || !window.turf) return;

    setLoadingCensus(true);

    try {
      if (!censusCacheRef.current) {
        const censusUrl = `${import.meta.env.BASE_URL}base_data/KING_COUNTY_BLOCK_2020_POPULATION.geojson`;
        console.log(`Loading census data from: ${censusUrl}`);

        const censusResponse = await fetch(censusUrl);
        if (!censusResponse.ok) {
          setCensusData({
            error: 'Census data file not found. Please add KING_COUNTY_BLOCK_2020_POPULATION.geojson to base_data/'
          });
          return;
        }

        const geometries = await censusResponse.json();
        console.log(`Loaded ${geometries.features?.length || 0} census blocks`);

        // Prepare populated Seattle blocks once, with the area and bounding box the calculation needs
        const seattleBlocks = (geometries.features || [])
          .filter((block: any) => block.properties.Place === 'Seattle' && parseInt(block.properties.TOT_POP || '0') > 0)
          .map((block: any) => ({
            feature: block,
            population: parseInt(block.properties.TOT_POP),
            area: window.turf.area(block),
            bbox: window.turf.bbox(block)
          }));
        censusCacheRef.current = { geometries, seattleBlocks };
      } else {
        // Let the loading indicator paint before the synchronous calculation
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      const { geometries, seattleBlocks } = censusCacheRef.current;
      const tiers = tierPolygonsRef.current.map(({ headway: tierHeadway, polygon }) => {
        const population = polygon ? populationInWalkshed(polygon, seattleBlocks) : 0;
        return {
          headway: tierHeadway,
          population: Math.round(population).toLocaleString(),
          populationPercent: (population / SEATTLE_POPULATION * 100).toFixed(1)
        };
      });

      // Store census blocks for visualization
      setCensusBlocks(geometries);
      setCensusData({ tiers });
    } catch (err: any) {
      setCensusData({
        error: 'Could not load census data: ' + err.message
      });
    } finally {
      setLoadingCensus(false);
    }
  }


  /**
   * Handle year selection change
   *
   * Resets all data and triggers reload of pre-processed stop data for selected year
   * The actual file loading is done by the useEffect hook
   */
  async function handleYearChange(year: string) {
    setSelectedYear(year);
    // Clear existing data
    setStats(null);
    setCensusData(null);
    setYearStops([]);
    setCensusBlocks(null);
    setShowCensusBlocks(false);
    tierPolygonsRef.current = [];
    mergedPolygonOutOfBoundsRef.current = null;
    fitToStopsRef.current = true;

    // Clear map layers
    if (leafletMapRef.current) {
      const L = window.L;
      const map = leafletMapRef.current;
      map.eachLayer(layer => {
        if (layer instanceof L.Circle || layer instanceof L.CircleMarker || layer instanceof L.GeoJSON) {
          map.removeLayer(layer);
        }
      });
    }
  }

  /**
   * Handle preset, headway or mode change
   *
   * frequentStops re-filters on its own and the effects redraw the map and walksheds.
   * Population served describes the previous walkshed, so clear it.
   */
  function handlePresetChange(newPreset: Preset) {
    setPreset(newPreset);
    setCensusData(null);
  }

  function handleHeadwayChange(newHeadway: number) {
    setHeadway(newHeadway);
    setCensusData(null);
  }

  function handleModeChange(newMode: 'single' | 'tiers') {
    setMode(newMode);
    setCensusData(null);
  }

  const [presetStart, presetEnd] = PRESETS[preset].hours;
  const presetHours = `${formatHour(presetStart)}–${formatHour(presetEnd)}`;

  // Legend swatch for a tier, drawn like its band on the map: a translucent fill, or an outline over population density
  function tierSwatch(tierHeadway: number) {
    const color = HEADWAY_COLORS[tierHeadway];
    const outline = showCensusBlocks && censusBlocks;
    return (
      <span className="relative inline-block w-4 h-4 rounded-sm overflow-hidden align-middle" style={{ border: `${outline ? 3 : 1}px solid ${color}` }}>
        {!outline && <span className="absolute inset-0" style={{ backgroundColor: color, opacity: TIER_FILL_OPACITY }} />}
      </span>
    );
  }

  /**
   * RENDER: Main component UI
   */
  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header bar with title and year selector */}
      <div className="bg-blue-600 text-white p-4 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Seattle Frequent Transit Access</h1>
            <p className="text-blue-100 text-sm mt-1">
              {mode === 'tiers'
                ? `Stops by how often buses come, ${presetHours} weekdays + 10-minute walksheds`
                : `Stops with service every ${headway} minutes, ${presetHours} weekdays + 10-minute walksheds`}
            </p>
          </div>
          {/* Year selector dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-blue-100">Year:</label>
            <select
              value={selectedYear}
              onChange={(e) => handleYearChange(e.target.value)}
              className="px-3 py-1.5 rounded bg-blue-700 text-white border border-blue-500 hover:bg-blue-800 cursor-pointer"
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
        </div>
        {/* Frequency controls - time of day preset buttons and headway dropdown */}
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap mt-3">
          <div className="flex flex-wrap gap-1">
            {Object.entries(PRESETS).map(([key, { label }]) => {
              const value = Number(key) as Preset;
              return (
                <button
                  key={key}
                  onClick={() => handlePresetChange(value)}
                  className={`px-3 py-1 rounded text-sm border ${
                    preset === value
                      ? 'bg-white text-blue-700 border-white font-semibold'
                      : 'bg-blue-700 text-white border-blue-500 hover:bg-blue-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* Mode toggle - nested tiers, or a single headway */}
          <div className="flex gap-1">
            {(['tiers', 'single'] as const).map(value => (
              <button
                key={value}
                onClick={() => handleModeChange(value)}
                className={`px-3 py-1 rounded text-sm border ${
                  mode === value
                    ? 'bg-white text-blue-700 border-white font-semibold'
                    : 'bg-blue-700 text-white border-blue-500 hover:bg-blue-800'
                }`}
              >
                {value === 'tiers' ? 'Tiers' : 'Single'}
              </button>
            ))}
          </div>
          {mode === 'single' && (
            <div className="flex items-center gap-2">
              <label className="text-sm text-blue-100">Every</label>
              <select
                value={headway}
                onChange={(e) => handleHeadwayChange(Number(e.target.value))}
                className="px-3 py-1 rounded bg-blue-700 text-white border border-blue-500 hover:bg-blue-800 cursor-pointer"
              >
                {HEADWAYS.map((minutes) => (
                  <option key={minutes} value={minutes}>{minutes}</option>
                ))}
              </select>
              <span className="text-sm text-blue-100">min or better</span>
            </div>
          )}
        </div>
      </div>

      {/* Loading indicators - shown while processing data */}
      {loading && (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
          <p className="text-yellow-800">Loading stop frequency data...</p>
        </div>
      )}

      {loadingCensus && (
        <div className="bg-purple-50 border-l-4 border-purple-400 p-4">
          <p className="text-purple-800">Loading census population data...</p>
        </div>
      )}

      {/* Error messages - shown when something goes wrong */}
      {error && (
        <div className="bg-red-50 border-l-4 border-red-400 p-4">
          <p className="text-red-800">{error}</p>
        </div>
      )}
      
      {/* Statistics bar - shown after data is processed */}
      {stats && (
        <div className="bg-white border-b shadow-sm p-4">
          <div className="flex gap-8 items-center flex-wrap">
            {mode === 'tiers' ? (
              <>
                {/* Per-tier legend with stop count, area coverage and population served once calculated
                    (cumulative: each tier includes the more frequent ones) */}
                {stats.tiers.map((tier: any) => {
                  const tierPopulation = censusData?.tiers?.find((t: any) => t.headway === tier.headway);
                  return (
                    <div key={tier.headway} className="flex items-center gap-2">
                      {tierSwatch(tier.headway)}
                      <span className="text-gray-600 text-sm">Every {tier.headway} min:</span>
                      <span className="text-lg font-bold text-gray-800">{tier.coveragePercent}%</span>
                      <span className="text-gray-500 text-xs -ml-1">area</span>
                      {tierPopulation && (
                        <>
                          <span className="text-lg font-bold text-gray-800" title={`${tierPopulation.population} people`}>
                            {tierPopulation.populationPercent}%
                          </span>
                          <span className="text-gray-500 text-xs -ml-1">people</span>
                        </>
                      )}
                      <span className="text-gray-500 text-xs">({tier.stopCount} stops)</span>
                    </div>
                  );
                })}
                <span className="text-gray-500 text-xs">
                  Share of Seattle within a 10-minute walk, each tier including the more frequent ones. Zoom in to see stops.
                </span>
              </>
            ) : (
              <>
                {/* Stop count metric */}
                <div>
                  <span className="text-gray-600 text-sm">Frequent Transit Stops:</span>
                  <span className="ml-2 text-2xl font-bold text-blue-600">{stats.tiers[0].stopCount}</span>
                </div>
                {/* Area coverage metric (percentage of Seattle covered by walksheds) */}
                <div>
                  <span className="text-gray-600 text-sm">Coverage (by area):</span>
                  <span className="ml-2 text-2xl font-bold text-green-600">{stats.tiers[0].coveragePercent}%</span>
                  <span className="text-gray-500 text-xs ml-1">(merged walksheds)</span>
                </div>
              </>
            )}
            {/* Population metrics - shown when census data loads successfully (tiers mode shows them per tier above) */}
            {mode === 'single' && censusData?.tiers && (
              <div>
                <span className="text-gray-600 text-sm">Population Served:</span>
                <span className="ml-2 text-2xl font-bold text-purple-600">{censusData.tiers[0].populationPercent}%</span>
                <span className="text-gray-500 text-xs ml-1">({censusData.tiers[0].population} people)</span>
              </div>
            )}
            {/* Census error message if data failed to load */}
            {censusData?.error && (
              <div>
                <span className="text-red-600 text-sm">{censusData.error}</span>
              </div>
            )}
            {/* Button to calculate population served (only shown when walkshed is ready and census hasn't been loaded yet) */}
            {!censusData && !loadingCensus && tierPolygonsRef.current.some(tier => tier.polygon) && (
              <button
                onClick={() => loadCensusData()}
                className="px-4 py-2 rounded text-sm bg-purple-100 text-purple-700 hover:bg-purple-200"
              >
                Calculate Population Served
              </button>
            )}
            {/* Toggle for census block visualization */}
            {censusBlocks && (
              <button
                onClick={() => setShowCensusBlocks(!showCensusBlocks)}
                className={`px-4 py-2 rounded text-sm ${
                  showCensusBlocks
                    ? 'bg-purple-600 text-white hover:bg-purple-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {showCensusBlocks ? 'Hide' : 'Show'} Population Density
              </button>
            )}
          </div>
        </div>
      )}

      {/* Map container - Leaflet renders the interactive map here */}
      <div ref={mapRef} className="flex-1 relative" />

      {/* Footer with methodology explanation */}
      <div className="bg-gray-100 p-3 text-xs text-gray-600 border-t">
        <p>10 min walksheds shown as merged blue area. Coverage calculated by merging overlapping walksheds (no double-counting).</p>
      </div>
    </div>
  );
}