import { useState, useEffect, useRef, useMemo } from 'react';
import {
  FUTURE_SCENARIO, FUTURE_SCENARIO_BASE_YEAR, YEARS, Preset, PRESETS, Day, DAYS, Area, AREAS, HEADWAYS, TIER_HEADWAYS,
  qualifies, bestHeadways, stopsFromFile, futureStopsForDay
} from './shared/frequency.ts';
import {
  WALK_MINUTES, type WalkMinutes, walkshedsForStops, computeTiers, prepareCensusBlocks, populationInWalkshed
} from './shared/walksheds.ts';

// Geographic constants for Seattle
const SEATTLE_CENTER = [47.6062, -122.3321]; // Center coordinates for map initialization

const YEAR_LABELS: Record<string, string> = { [FUTURE_SCENARIO]: 'Future' }; // Dropdown labels for keys that aren't a year

// One color per headway, used in both single and tiers mode so a headway always looks the same.
// The tier colors stay distinguishable in every pair under red-green colorblindness, and the cool hues stay clear
// of the yellow/orange/red population density layer. The purple is darker than the blue so the two don't merge
// for colorblind viewers. 10 min keeps the blue of the original single-headway map.
// 20 min only appears in single mode, never beside the tiers, so it's a neutral slate rather than a fifth hue.
// 120 min is a warm gray for barely any service; no fifth hue passed against the other tiers.
const HEADWAY_COLORS: Record<number, string> = {
  10: '#2563eb', // blue
  15: '#0b8f6a', // bluish green
  20: '#475569', // slate
  30: '#6d3c9e', // purple
  60: '#62bbe9', // sky blue
  120: '#a8a29e', // warm gray
};

const TIER_FILL_OPACITY = 0.35;
const IS_TOUCH = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: none)').matches;
const TIER_MARKER_MIN_ZOOM = 14; // In tiers mode, stop markers would hide the bands when zoomed out

// Format an hour of the day (0-24) for display, e.g. 6 -> "6am", 15 -> "3pm", 0 or 24 -> "midnight"
function formatHour(hour: number): string {
  if (hour % 24 === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
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
 * This component maps transit stops by how often buses come, with a 5- or 10-minute walkshed around each.
 * - Loads pre-processed stop data with per-hour trip frequencies from all_stops JSON files
 * - Filters stops by a time-of-day preset and headway (see PRESETS and qualifies())
 * - Single mode shows one headway; tiers mode shows nested bands for TIER_HEADWAYS
 * - Visualizes 5- or 10-minute walksheds (pre-computed isochrones or circle buffers), merged per headway
 * - Integrates US Census data to calculate population served, on request
 * - Displays coverage statistics and interactive map
 * - Supports a Future scenario w/ planned transit expansions hard coded in future_stops JSON
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
  const [area, setArea] = useState<Area>(Area.Seattle); // Area that coverage and population are measured within
  const [boundaries, setBoundaries] = useState<Partial<Record<Area, any>>>({}); // Boundary polygons, loaded per area on first use
  const boundary = boundaries[area] ?? null; // Selected area's boundary
  const [isochrones, setIsochrones] = useState<Map<string, any>>(new Map()); // Pre-computed walksheds keyed by stop_id
  const [censusBlocks, setCensusBlocks] = useState<any>(null); // Census blocks with population for visualization

  // UI state - tracks loading and error states
  const [loading, setLoading] = useState<boolean>(false); // GTFS data loading indicator
  const [loadingCensus, setLoadingCensus] = useState<boolean>(false); // Census data loading indicator
  const [error, setError] = useState<string | null>(null); // Error message display
  const [showCensusBlocks, setShowCensusBlocks] = useState<boolean>(false); // Toggle census block visualization

  // Year selection - allows switching between different GTFS datasets
  // 2020 is base year, 2025 and 2026 are recent feeds, Future is 2026 plus hardcoded future stops
  const [selectedYear, setSelectedYear] = useState<string>('2020');
  const [availableYears] = useState<string[]>(YEARS);

  // Frequency selection - which time of day and how often buses must come for a stop to count
  const [day, setDay] = useState<Day>(Day.Weekday);
  const [preset, setPreset] = useState<Preset>(Preset.AllDay);
  const [headway, setHeadway] = useState<number>(10); // Minutes between buses, in single mode
  const [mode, setMode] = useState<'single' | 'tiers'>('single');
  const [walkMinutes, setWalkMinutes] = useState<WalkMinutes>(10); // Walkshed size
  const [showControls, setShowControls] = useState<boolean>(false); // Phones only: controls are collapsed behind an Options button // One headway, or nested bands for TIER_HEADWAYS
  const modeRef = useRef(mode); // For the map's zoom handler, which outlives renders
  modeRef.current = mode;

  // The headways being drawn, tightest first. Single mode is a one-tier list so both modes share the same code.
  const activeHeadways = mode === 'tiers' ? TIER_HEADWAYS : [headway];

  // Stops meeting the loosest active headway, and the tightest active headway each one meets.
  // Changing year, preset, headway or mode re-filters without re-fetching.
  const { frequentStops, bestHeadway } = useMemo(() => {
    const bestHeadway = bestHeadways(yearStops, preset, activeHeadways);
    return { frequentStops: yearStops.filter(stop => bestHeadway.has(stop.id)), bestHeadway };
  }, [yearStops, preset, headway, mode]);

  // React refs - maintain references to DOM elements and map objects
  const mapRef = useRef<HTMLDivElement>(null); // Container for Leaflet map
  const leafletMapRef = useRef<any>(null); // Leaflet map instance
  const canvasRendererRef = useRef<any>(null); // Shared canvas renderer, so thousands of stop markers stay fast
  const fitToStopsRef = useRef<boolean>(true); // Zoom to fit the stops on the next draw (set when the year changes)
  const fitToAreaRef = useRef<boolean>(false); // Zoom to fit the area's boundary on the next draw (set when the area changes)
  const markersLayerRef = useRef<any>(null); // Layer group holding the stop markers, so tiers mode can hide them by zoom
  // In-bounds merged walkshed per active headway, and its ring: the part not covered by the next tighter headway
  const tierPolygonsRef = useRef<{ headway: number; polygon: any; ring: any }[]>([]);
  // Census file, loaded once per page, with each area's populated blocks prepared on first use
  const censusCacheRef = useRef<{ geometries: any; blocksByArea: Partial<Record<Area, any[]>> } | null>(null);
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
  }, [frequentStops, boundary, showCensusBlocks]);

  /**
   * Effect: Auto-load pre-processed stop data when year changes
   *
   * Loads pre-processed all_stops JSON file from /base_data/{year}/ directory
   */
  useEffect(() => {
    loadUploadedFile();
  }, [selectedYear, day]);

  /**
   * Effect: Load pre-computed isochrones for the selected year
   *
   * Isochrones are accurate walking polygons generated offline
   * Loads isochrones for the selected year, or for Future, both the base year and the future stops ones.
   *
   */
  useEffect(() => {
    async function loadIsochrones() {
      const isoMap = new Map();

      // For Future, load both base year and future stops isochrones
      const yearsToLoad = selectedYear === FUTURE_SCENARIO ? [FUTURE_SCENARIO_BASE_YEAR, FUTURE_SCENARIO] : [selectedYear];

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
   * Effect: Load the selected area's boundary GeoJSON, the first time the area is selected
   *
   * This boundary is used to clip walksheds and calculate accurate coverage within the area.
   */
  useEffect(() => {
    if (boundaries[area]) return;
    async function loadBoundary() {
      const { label, boundaryFile } = AREAS[area];
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}base_data/${boundaryFile}`);
        if (response.ok) {
          const loaded = await response.json();
          console.log(`${label} boundary loaded successfully`);
          setBoundaries(previous => ({ ...previous, [area]: loaded }));
        }
      } catch (err) {
        console.error(`Could not load ${label} boundary:`, err);
      }
    }
    loadBoundary();
  }, [area]);

  /**
   * Effect: Recalculate walksheds when the area's boundary loads OR when stops/isochrones load
   *
   * This handles multiple scenarios:
   * 1. Boundary loads after GTFS data is already processed
   * 2. GTFS data loads after boundary is already available
   * 3. Isochrones load after stops are already calculated
   * 4. Preset or headway changes (including to a selection with no qualifying stops)
   */
  useEffect(() => {
    if (boundary && yearStops.length > 0 && isochrones.size > 0 && turfLoaded && window.turf) {
      recalculateWalksheds();
    }
  }, [boundary, frequentStops, isochrones, turfLoaded, walkMinutes]);

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
    canvasRendererRef.current = L.canvas({ padding: 0.5, pane: 'stops', tolerance: IS_TOUCH ? 10 : 0 }); // Wider tap target on touch screens

    markersLayerRef.current = L.layerGroup();
    map.on('zoomend', updateMarkerVisibility);
  }

  /**
   * Draw census blocks colored by population density
   *
   * Only shows blocks in the selected area with population > 0
   * Color intensity based on population density (people per square meter)
   */
  function drawCensusBlocks(map: any, L: any) {
    if (!censusBlocks || !censusBlocks.features) return;
    const place = AREAS[area].place;

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
        return (place === null || feature.properties.Place === place) &&
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
   * Draw qualifying stops and walkshed coverage on the map
   *
   * Layers (in order):
   * 1. Seattle city boundary (thin gray outline)
   * 2. Census blocks (if enabled, colored by population density)
   * 3. Out-of-bounds walkshed portions (gray, faded)
   * 4. In-bounds merged walksheds in each headway's color (one area in single mode, rings in tiers mode)
   * 5. Individual stop markers in their headway's color, in their own pane above the walksheds
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

    // Draw the selected area's boundary for reference, zooming to it after an area change
    if (boundary) {
      const boundaryLayer = L.geoJSON(boundary, {
        style: {
          fillColor: 'transparent',
          color: '#494d53a1', // Gray outline
          weight: 2,
          opacity: 0.6
        }
      }).addTo(map);
      if (fitToAreaRef.current) {
        map.fitBounds(boundaryLayer.getBounds(), { padding: [20, 20] });
        fitToAreaRef.current = false;
      }
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

    // Draw merged walkshed polygons within the area (combined walking areas), in the headway's color.
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
      // Built on hover rather than up front, since there can be thousands of markers
      const tooltip = () => {
        const stopHeadway = bestHeadway.get(stop.id)!;
        if (isFuture) {
          const tierLine = tiers ? `<br><small>Every ${stopHeadway} min or better</small>` : '';
          return `${stop.name}<br><small>${stop.routeName || 'Future Stop'}</small>${tierLine}`;
        }
        return `${stop.name}<br><small>ID: ${stop.id}</small>${stopRoutesSummary(stop, stopHeadway)}`;
      };

      L.circleMarker([stop.lat, stop.lon], { ...markerOptions, renderer: canvasRendererRef.current })
        [IS_TOUCH ? 'bindPopup' : 'bindTooltip'](tooltip) // Touch screens can't hover, so details open on tap
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
   * Tooltip lines about the routes at a stop: every route number serving it, and which route (or approved pair) gives
   * it its headway. Stops only qualify through a single route or pair (see stopQualifies), so there's always one.
   */
  function stopRoutesSummary(stop: any, stopHeadway: number): string {
    const routes: any[] = stop.routes || [];
    if (routes.length === 0) return '';

    const routeNames = [...new Set(routes.filter(r => !r.combined).map(r => r.route))]; // Combined pairs like "3/4" are listed via their routes
    const lines = [`Routes: ${routeNames.join(', ')}`];

    const single = routes.filter(r => qualifies(r.hourly_trips, preset, stopHeadway));
    if (single.length > 0) {
      // Combined pairs go to different places, so they're named without a destination
      const names = single.map(r => `${r.route}${r.headsign && !r.combined ? ` to ${r.headsign}` : ''}`);
      if (names.length === 1) {
        lines.push(`Every ${stopHeadway} min or better on ${names[0]}`);
      } else {
        // One route per line, so several routes that each qualify don't read as being added together
        lines.push(`Every ${stopHeadway} min or better on each of these, on its own:`);
        lines.push(...names.map(name => `&nbsp;&nbsp;• ${name}`));
      }
    }
    return lines.map(line => `<br><small>${line}</small>`).join('');
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
   * Recalculate walksheds for each active headway (see computeTiers), and redraw the map
   *
   * Runs when stops, isochrones, the boundary or the walk time change.
   */
  function recalculateWalksheds() {
    if (!boundary || !turfLoaded || !window.turf) return;

    const { tiers, outOfBounds } = computeTiers(window.turf, {
      stops: frequentStops,
      bestHeadway,
      headways: activeHeadways,
      boundary,
      walksheds: stops => walkshedsForStops(window.turf, stops, isochrones, selectedYear, walkMinutes),
      withRings: mode === 'tiers'
    });

    tierPolygonsRef.current = tiers.map(({ headway: tierHeadway, polygon, ring }) => ({ headway: tierHeadway, polygon, ring }));
    mergedPolygonOutOfBoundsRef.current = outOfBounds; // Loosest headway's, which contains the others

    setStats({ tiers: tiers.map(({ headway: tierHeadway, stopCount, coveragePercent }) => ({ headway: tierHeadway, stopCount, coveragePercent })) });

    // Redraw the map to show updated walksheds with isochrones
    if (leafletMapRef.current) {
      drawStops();
    }
  }

  /**
   * Auto-load pre-processed stop data from all_stops JSON file
   *
   * Loads stop data with pre-calculated hourly trip frequencies from the
   * all_stops_{year}.json files generated by extract-all-stops.js, or all_stops_{year}_{saturday|sunday}.json
   * for weekends
   *
   * For Future, loads base year GTFS data (there's no future feed). Its hand-made future stops use their
   * hourly_trips_saturday / hourly_trips_sunday on weekends when they have them, or reuse weekday trips.
   *
   * File structure expected: /base_data/all_stops_{year}{_saturday|_sunday}.json
   */
  async function loadUploadedFile() {
    setLoading(true);
    setError(null);

    try {
      // For Future, use base year GTFS data (there's no future feed)
      const gtfsYear = selectedYear === FUTURE_SCENARIO ? FUTURE_SCENARIO_BASE_YEAR : selectedYear;
      const stopsFile = `all_stops_${gtfsYear}${DAYS[day].fileSuffix}.json`;
      const allStopsUrl = `${import.meta.env.BASE_URL}base_data/${stopsFile}`;

      if (selectedYear === FUTURE_SCENARIO) {
        console.log(`Using ${FUTURE_SCENARIO_BASE_YEAR} GTFS data as base for the Future scenario`);
      }
      console.log(`Loading pre-processed stop data from: ${allStopsUrl}`);

      const response = await fetch(allStopsUrl);
      if (!response.ok) {
        throw new Error(`${stopsFile} not found. Please run extract-all-stops.js first.`);
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
    const stopList = stopsFromFile(allStops);

    // Load and add future stops if this is a future year scenario
    const finalStopList = await addFutureStops(stopList, selectedYear);
    console.log(`Total stops including future: ${finalStopList.length}`);

    setYearStops(finalStopList);
  }
  
  /**
   * Load and add future transit stops for scenario planning
   *
   * For the Future scenario, we add stops that are under construction
   * or planned but not yet in the GTFS feed. This allows "what-if" analysis.
   */
  async function addFutureStops(existingStops: any[], year: string): Promise<any[]> {
    // Only the Future scenario has future stops
    if (year !== FUTURE_SCENARIO) {
      return existingStops;
    }

    try {
      const futureStopsUrl = `${import.meta.env.BASE_URL}base_data/future_stops/future_stops.json`;
      console.log(`Loading future stops from: ${futureStopsUrl}`);

      const response = await fetch(futureStopsUrl);
      if (!response.ok) {
        console.warn(`No future stops file found for ${year}`);
        return existingStops;
      }

      const futureData = await response.json();

      // Keep enabled stops; frequentStops decides which meet the selected frequency
      const enabledFutureStops = futureStopsForDay(futureData, day);

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
   * - Only the selected area's blocks with people count (filtered by `Place`, or every block for King County)
   * - Single mode gets one number; tiers mode gets one per tier, each including the more frequent tiers
   * - Percentages are of the area's total population
   */
  async function loadCensusData() {
    if (!turfLoaded || !window.turf) return;

    setLoadingCensus(true);

    try {
      let loadedNow = false;
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

        censusCacheRef.current = { geometries, blocksByArea: {} };
        loadedNow = true;
      }
      if (!loadedNow) {
        // Let the loading indicator paint before the synchronous calculation
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Prepare the area's populated blocks once, with the area and bounding box the calculation needs
      const cache = censusCacheRef.current;
      const { place, population: areaPopulation } = AREAS[area];
      if (!cache.blocksByArea[area]) {
        cache.blocksByArea[area] = prepareCensusBlocks(window.turf, cache.geometries.features || [], place);
      }

      const blocks = cache.blocksByArea[area]!;
      const geometries = cache.geometries;
      const tiers = tierPolygonsRef.current.map(({ headway: tierHeadway, polygon }) => {
        const population = polygon ? populationInWalkshed(window.turf, polygon, blocks) : 0;
        return {
          headway: tierHeadway,
          population: Math.round(population).toLocaleString(),
          populationPercent: (population / areaPopulation * 100).toFixed(1)
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

  // Changing day loads that day's stop file; walksheds are the same, so the map keeps its view
  function handleDayChange(newDay: Day) {
    if (newDay === day) return;
    setDay(newDay);
    setCensusData(null);
  }

  function handleWalkMinutesChange(minutes: WalkMinutes) {
    setWalkMinutes(minutes);
    setCensusData(null);
  }

  function handleModeChange(newMode: 'single' | 'tiers') {
    setMode(newMode);
    setCensusData(null);
  }

  // Changing area re-clips walksheds to its boundary (loaded on first use) and zooms the map to it
  function handleAreaChange(newArea: Area) {
    if (newArea === area) return;
    setArea(newArea);
    setCensusData(null);
    fitToAreaRef.current = true;
  }

  const areaLabel = AREAS[area].label;

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
      <div className="bg-blue-600 text-white p-3 sm:p-4 shadow-lg">
        <div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex-1">
            <h1 className="text-xl sm:text-2xl font-bold">{areaLabel} Frequent Transit Access</h1>
            <p className="text-blue-100 text-xs sm:text-sm mt-1">
              {mode === 'tiers'
                ? `Stops by how often buses come, ${presetHours} ${DAYS[day].plural} + ${walkMinutes}-minute walksheds`
                : `Stops with service every ${headway} minutes, ${presetHours} ${DAYS[day].plural} + ${walkMinutes}-minute walksheds`}
            </p>
          </div>
          {/* Phones: Options button showing or hiding the controls (always shown on larger screens) */}
          <button
            onClick={() => setShowControls(!showControls)}
            className="sm:hidden shrink-0 px-3 py-1.5 rounded text-sm border bg-blue-700 text-white border-blue-500"
            aria-expanded={showControls}
          >
            {YEAR_LABELS[selectedYear] ?? selectedYear} · Options {showControls ? '▴' : '▾'}
          </button>
          {/* Area toggle and year selector dropdown */}
          <div className={`${showControls ? 'flex' : 'hidden'} sm:flex w-full sm:w-auto items-center gap-2 flex-wrap justify-start sm:justify-end`}>
            <div className="flex gap-1">
              {Object.entries(AREAS).map(([key, { label }]) => {
                const value = Number(key) as Area;
                return (
                  <button
                    key={key}
                    onClick={() => handleAreaChange(value)}
                    className={`px-3 py-1.5 rounded text-sm border ${
                      area === value
                        ? 'bg-white text-blue-700 border-white font-semibold'
                        : 'bg-blue-700 text-white border-blue-500 hover:bg-blue-800'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <label className="text-sm text-blue-100">Year:</label>
            <select
              value={selectedYear}
              onChange={(e) => handleYearChange(e.target.value)}
              className="px-3 py-1.5 rounded bg-blue-700 text-white border border-blue-500 hover:bg-blue-800 cursor-pointer"
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>{YEAR_LABELS[year] ?? year}</option>
              ))}
            </select>
          </div>
        </div>
        {/* Frequency controls - day, time of day preset buttons and headway dropdown */}
        <div className={`${showControls ? 'flex' : 'hidden'} sm:flex items-center gap-x-4 gap-y-2 flex-wrap mt-3`}>
          <div className="flex gap-1">
            {Object.entries(DAYS).map(([key, { label }]) => {
              const value = Number(key) as Day;
              return (
                <button
                  key={key}
                  onClick={() => handleDayChange(value)}
                  className={`px-3 py-1 rounded text-sm border ${
                    day === value
                      ? 'bg-white text-blue-700 border-white font-semibold'
                      : 'bg-blue-700 text-white border-blue-500 hover:bg-blue-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
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
          {/* Walk time toggle - walkshed size */}
          <div className="flex items-center gap-1">
            <span className="text-sm text-blue-100 mr-1">Walk</span>
            {WALK_MINUTES.map(minutes => (
              <button
                key={minutes}
                onClick={() => handleWalkMinutesChange(minutes)}
                className={`px-3 py-1 rounded text-sm border ${
                  walkMinutes === minutes
                    ? 'bg-white text-blue-700 border-white font-semibold'
                    : 'bg-blue-700 text-white border-blue-500 hover:bg-blue-800'
                }`}
              >
                {minutes} min
              </button>
            ))}
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
        <div className="bg-white border-b shadow-sm px-3 py-2 sm:p-4">
          <div className="flex gap-x-8 gap-y-1 sm:gap-y-3 items-center flex-wrap">
            {mode === 'tiers' ? (
              <>
                {/* Per-tier legend with stop count, area coverage and population served once calculated
                    (cumulative: each tier includes the more frequent ones) */}
                {stats.tiers.map((tier: any) => {
                  const tierPopulation = censusData?.tiers?.find((t: any) => t.headway === tier.headway);
                  return (
                    <div key={tier.headway} className="flex items-center gap-2">
                      {tierSwatch(tier.headway)}
                      <span className="text-gray-600 text-xs sm:text-sm">Every {tier.headway} min:</span>
                      <span className="text-base sm:text-lg font-bold text-gray-800">{tier.coveragePercent}%</span>
                      <span className="text-gray-500 text-xs -ml-1">area</span>
                      {tierPopulation && (
                        <>
                          <span className="text-base sm:text-lg font-bold text-gray-800" title={`${tierPopulation.population} people`}>
                            {tierPopulation.populationPercent}%
                          </span>
                          <span className="text-gray-500 text-xs -ml-1">people</span>
                        </>
                      )}
                      <span className="text-gray-500 text-xs">({tier.stopCount} stops)</span>
                    </div>
                  );
                })}
                <span className="hidden sm:inline text-gray-500 text-xs">
                  Share of {areaLabel} within a {walkMinutes}-minute walk, each tier including the more frequent ones. Zoom in to see stops.
                </span>
              </>
            ) : (
              <>
                {/* Stop count metric */}
                <div>
                  <span className="text-gray-600 text-sm">Frequent Transit Stops:</span>
                  <span className="ml-2 text-xl sm:text-2xl font-bold text-blue-600">{stats.tiers[0].stopCount}</span>
                </div>
                {/* Area coverage metric (percentage of the selected area covered by walksheds) */}
                <div>
                  <span className="text-gray-600 text-sm">Coverage (by area):</span>
                  <span className="ml-2 text-xl sm:text-2xl font-bold text-green-600">{stats.tiers[0].coveragePercent}%</span>
                  <span className="text-gray-500 text-xs ml-1">(merged walksheds)</span>
                </div>
              </>
            )}
            {/* Population metrics - shown when census data loads successfully (tiers mode shows them per tier above) */}
            {mode === 'single' && censusData?.tiers && (
              <div>
                <span className="text-gray-600 text-sm">Population Served:</span>
                <span className="ml-2 text-xl sm:text-2xl font-bold text-purple-600">{censusData.tiers[0].populationPercent}%</span>
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
      <div ref={mapRef} className="flex-1 relative min-h-[50vh]" />

      {/* Footer with methodology explanation */}
      <div className="hidden sm:block bg-gray-100 p-3 text-xs text-gray-600 border-t">
        <p>Shaded areas are within a {walkMinutes}-minute walk of a qualifying stop. Coverage and population count only the part inside {areaLabel}; dashed gray areas are outside it.</p>
      </div>
    </div>
  );
}