import { useState, useEffect, useRef } from 'react';

// Geographic constants for Seattle
const SEATTLE_CENTER = [47.6062, -122.3321]; // Center coordinates for map initialization
const HALF_MILE_METERS = 804.672; // Walking distance buffer (approximately 10 minute walk)

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
  const [frequentStops, setFrequentStops] = useState<any[]>([]); // Stops meeting frequency criteria
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
  // 2020 is base year, 2025 is near-future, 2027 is 2025 plus hardocded 'future' data
  const [selectedYear, setSelectedYear] = useState<string>('2020');
  const [availableYears] = useState<string[]>(['2020', '2025', '2027']);

  // React refs - maintain references to DOM elements and map objects
  const mapRef = useRef<HTMLDivElement>(null); // Container for Leaflet map
  const leafletMapRef = useRef<any>(null); // Leaflet map instance
  const mergedPolygonRef = useRef<any>(null); // Combined walkshed polygon for visualization
  const mergedPolygonOutOfBoundsRef = useRef<any>(null); // Out-of-bounds walkshed portions

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
   * Cleanup function removes script tags when component unmounts
   */
  useEffect(() => {
    // Load Leaflet CSS for map styling
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
    document.head.appendChild(link);

    // Load Leaflet JS for interactive mapping
    const leafletScript = document.createElement('script');
    leafletScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
    leafletScript.onload = () => setLeafletLoaded(true);
    document.head.appendChild(leafletScript);

    // Load Turf.js for geospatial operations (polygon unions, area calculations)
    const turfScript = document.createElement('script');
    turfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js';
    turfScript.onload = () => setTurfLoaded(true);
    document.head.appendChild(turfScript);

    // Cleanup: remove all injected scripts when component unmounts
    return () => {
      document.head.removeChild(link);
      document.head.removeChild(leafletScript);
      document.head.removeChild(turfScript);
    };
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
   * Triggers whenever we process new GTFS data or change years
   */
  useEffect(() => {
    if (frequentStops.length > 0 && leafletMapRef.current) {
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
   * Loads isochrones for the selected year or for 2027, loads both 2025 and 2027 ones.
   *
   */
  useEffect(() => {
    async function loadIsochrones() {
      const isoMap = new Map();

      // For 2027, load both 2025 (base) and 2027 (future stops) isochrones
      const yearsToLoad = selectedYear === '2027' ? ['2025', '2027'] : [selectedYear];

      // Load relevant isochrone files.
      for (const year of yearsToLoad) {
        const isochroneUrl = `/base_data/isochrones_${year}.json`;
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
        const response = await fetch('/base_data/seattle-city-limits.geojson');
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
   */
  useEffect(() => {
    if (seattleBoundary && frequentStops.length > 0 && isochrones.size > 0 && turfLoaded && window.turf) {
      recalculateWalksheds();
    }
  }, [seattleBoundary, frequentStops, isochrones]);

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

    // Draw merged walkshed polygon (combined ½ mile walking areas within Seattle)
    // This shows the total area with access to frequent transit
    if (mergedPolygonRef.current) {
      L.geoJSON(mergedPolygonRef.current, {
        style: {
          fillColor: '#3b82f6', // Blue fill
          fillOpacity: 0.25, // Semi-transparent
          color: '#2563eb', // Darker blue border
          weight: 2,
          opacity: 0.8
        }
      }).addTo(map);
    }

    // Add individual stop markers with tooltips showing stop name and ID
    const bounds = [];
    frequentStops.forEach(stop => {
      bounds.push([stop.lat, stop.lon]);

      // Different styling for future stops vs existing stops
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
        fillColor: '#1e40af', // Dark blue for existing stops
        fillOpacity: 1,
        color: 'white', // White border for contrast
        weight: 2
      };

      // Create circle marker for each frequent transit stop
      const tooltip = isFuture
        ? `${stop.name}<br><small>${stop.routeName || 'Future Stop'}</small><br><small>Opening: ${stop.description || 'TBD'}</small>`
        : `${stop.name}<br><small>ID: ${stop.id}</small>`;

      L.circleMarker([stop.lat, stop.lon], markerOptions)
        .bindTooltip(tooltip)
        .addTo(map);
    });

    // Auto-zoom map to show all stops with padding
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  /**
   * Try to find an isochrone for a stop by checking possible feed combinations
   * Returns the isochrone data if found, null otherwise
   */
  function findIsochroneForStop(stop: any, year: string): any {
    const stopId = stop.id || stop.stop_id;

    // For 2027 viewing mode, GTFS stops come from 2025 data and new stops from 2027 data.
    // So we need to check 2025 isochrones for non-future stops
    const isochroneYear = (year === '2027' && !stop.isFuture) ? '2025' : year;

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
   * Calculate walkshed coverage from frequent stops
   *
   * Uses pre-computed isochrones when available, falls back to circular buffers
   */
  function calculateWalkshedCoverage(stopList: any[], boundary: any = null) {
    if (!turfLoaded || !window.turf || stopList.length === 0) {
      return {
        mergedPolygon: null,
        mergedPolygonOutOfBounds: null,
        coveragePercent: '0'
      };
    }

    try {
      // Create walksheds - use isochrones if available, otherwise circles
      const walksheds = stopList.map((stop: any) => {
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

      // Merge all overlapping walksheds into a single polygon
      let union = walksheds[0];
      for (let i = 1; i < walksheds.length; i++) {
        try {
          union = window.turf.union(union, walksheds[i]);
        } catch {
          continue;
        }
      }

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
      // Fallback: Simple calculation
      const totalWalkshedArea = stopList.length * Math.PI * Math.pow(HALF_MILE_METERS, 2);
      const seattleAreaSqMeters = 217000000;
      return {
        mergedPolygon: null,
        mergedPolygonOutOfBounds: null,
        coveragePercent: (totalWalkshedArea / seattleAreaSqMeters * 100).toFixed(1) + '+'
      };
    }
  }

  /**
   * Recalculate walksheds when Seattle boundary becomes available
   *
   * This is called when the boundary loads after GTFS data has been processed
   */
  function recalculateWalksheds() {
    if (frequentStops.length === 0 || !seattleBoundary) return;

    console.log('Recalculating with boundary:', seattleBoundary.type);
    const { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent } =
      calculateWalkshedCoverage(frequentStops, seattleBoundary);

    mergedPolygonRef.current = mergedPolygon;
    mergedPolygonOutOfBoundsRef.current = mergedPolygonOutOfBounds;

    setStats({
      stopCount: frequentStops.length,
      coveragePercent: parseFloat(coveragePercent) > 100 ? '100+' : coveragePercent
    });

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
   * For 2027, loads 2025 GTFS data as the base (since 2027 data doesn't exist yet)
   *
   * File structure expected: /base_data/all_stops_{year}.json
   */
  async function loadUploadedFile() {
    setLoading(true);
    setError(null);

    try {
      // For 2027, use 2025 GTFS data as the base (since 2027 data doesn't exist yet)
      const gtfsYear = selectedYear === '2027' ? '2025' : selectedYear;
      const allStopsUrl = `/base_data/all_stops_${gtfsYear}.json`;

      if (selectedYear === '2027') {
        console.log('Using 2025 GTFS data as base for 2027 scenario');
      }
      console.log(`Loading pre-processed stop data from: ${allStopsUrl}`);

      const response = await fetch(allStopsUrl);
      if (!response.ok) {
        throw new Error(`all_stops_${gtfsYear}.json not found. Please run extract-all-stops.js first.`);
      }

      const allStops = await response.json();
      console.log(`Loaded ${allStops.length} stops with frequency data`);

      // Process the stops data to identify frequent stops
      await processAllStopsData(allStops);

    } catch (err: any) {
      setError('Error loading stop data: ' + err.message);
      console.error('Error loading all_stops data:', err);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Process pre-processed all_stops data to identify frequent transit stops
   *
   * Takes the all_stops JSON data (which already has hourly_trips calculated)
   * and filters for stops that meet the frequent transit criteria.
   *
   * FREQUENCY CRITERIA:
   * A "frequent transit" stop must have at least 4 trips per hour (every 15 mins)
   * from 6am-7pm (hours 6-18), AND average 6+ trips per hour (78+ total trips, every 10).
   */
  async function processAllStopsData(allStops: any[]) {
    console.log(`Processing ${allStops.length} stops to identify frequent transit...`);

    // Filter for stops that meet frequent transit criteria
    const frequentStopList = allStops.filter((stop: any) => {
      const hourlyTrips = stop.hourly_trips;
      if (!hourlyTrips) return false;

      // Check if EVERY hour from 6am-7pm has at least 4 trips
      // AND it averages 6 trips per hour (78 trips total)
      let total = 0;
      let minTripsInAnyHour = Infinity;

      for (let h = 6; h < 19; h++) {
        const trips = hourlyTrips[h.toString()] || 0;
        total += trips;
        minTripsInAnyHour = Math.min(minTripsInAnyHour, trips);

        if (trips < 4) {
          return false;
        }
      }

      if (total < 77) {
        return false;
      }

      return true;
    }).map((s: any) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      hourlyTrips: s.hourly_trips
    }));

    // Load and add future stops if this is a future year scenario
    const finalStopList = await addFutureStops(frequentStopList, selectedYear);
    console.log(`Total stops including future: ${finalStopList.length}`);

    // Update UI state with frequent stops (triggers map redraw)
    setFrequentStops(finalStopList);

    // Calculate walkshed coverage area
    const { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent } =
      calculateWalkshedCoverage(finalStopList, seattleBoundary);

    // Update UI with calculated statistics
    setStats({
      stopCount: finalStopList.length,
      coveragePercent: parseFloat(coveragePercent) > 100 ? '100+' : coveragePercent
    });

    // Store merged polygons for map visualization
    mergedPolygonRef.current = mergedPolygon;
    mergedPolygonOutOfBoundsRef.current = mergedPolygonOutOfBounds;

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
      const futureStopsUrl = `/base_data/future_stops/future_stops_${year}.json`;
      console.log(`Loading future stops from: ${futureStopsUrl}`);

      const response = await fetch(futureStopsUrl);
      if (!response.ok) {
        console.warn(`No future stops file found for ${year}`);
        return existingStops;
      }

      const futureData = await response.json();

      // Filter to only enabled stops that meet frequency requirements
      const enabledFutureStops = futureData.stops
        .filter((stop: any) => {
          // Must be enabled
          if (stop.enabled === false) return false;

          // Check hourly_trips frequency (must have 4+ trips per hour in all hours 6-18)
          const hourlyTrips = stop.hourly_trips || {};
          for (let h = 6; h < 19; h++) {
            const trips = hourlyTrips[h.toString()] || 0;
            if (trips < 4) {
              console.warn(`Future stop ${stop.id} does not meet frequency requirement (${trips} trips at hour ${h})`);
              return false;
            }
          }
          return true;
        })
        .map((stop: any) => ({
          id: stop.id,
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
          isFuture: true,
          routeName: stop.route_name,
          description: stop.description,
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
   * Load US Census population data and calculate how many people live within walksheds
   *
   * - Local GeoJSON file: Census block geometries with population counts for King County
   *   (KING_COUNTY_BLOCK_2020_POPULATION.geojson in base_data directory)
   *
   * - Load census blocks with population data from local file
   * - Filter to only Seattle blocks using `Place`
   * - Use Turf.js to check which blocks intersect with walkshed polygon
   * - For partial overlaps, allocate population proportionally based on intersection area
   * - Sum allocated population across all intersecting blocks
   * - Calculate percentage of Seattle's total population served
   *
   * NOTE: Proportional allocation assumes population is evenly distributed across each
   * census block, which is an approximation (people cluster in buildings, not parking lots).
   */
  async function loadCensusData(walkshedPolygon: any) {
    if (!turfLoaded || !window.turf) return;

    setLoadingCensus(true);

    try {
      // STEP 1: Load census block geometries with population data from base_data directory
      const censusUrl = '/base_data/KING_COUNTY_BLOCK_2020_POPULATION.geojson';
      console.log(`Loading census data from: ${censusUrl}`);

      const censusResponse = await fetch(censusUrl);
      if (!censusResponse.ok) {
        setCensusData({
          error: 'Census data file not found. Please add KING_COUNTY_BLOCK_2020_POPULATION.geojson to base_data/'
        });
        setLoadingCensus(false);
        return;
      }

      const blockGeometries = await censusResponse.json();
      console.log(`Loaded ${blockGeometries.features?.length || 0} census blocks`);

      // STEP 2: Calculate which census blocks intersect with walkshed
      // For each block, check if it overlaps with the merged walkshed polygon
      let populationInWalkshed = 0;
      let blocksInWalkshed = 0;

      blockGeometries.features?.forEach((block: any) => {
        const population = parseInt(
          block.properties.TOT_POP ||
          '0'
        );

        if (block.properties.Place !== 'Seattle' || population < 1) {
          return; // Skip blocks outside Seattle
        }

        try {
          // Check if this census block intersects with the walkshed polygon
          const intersects = window.turf.booleanIntersects(block, walkshedPolygon);
          if (intersects) {
            // If block is fully inside the walkshed, use full population (skip expensive intersect)
            if (window.turf.booleanWithin(block, walkshedPolygon)) {
              populationInWalkshed += population;
              blocksInWalkshed++;
            } else {
              // Block partially overlaps — calculate proportional population
              const blockArea = window.turf.area(block);
              const intersection = window.turf.intersect(block, walkshedPolygon);

              if (intersection) {
                const intersectionArea = window.turf.area(intersection);
                const ratio = intersectionArea / blockArea;
                populationInWalkshed += population * ratio;
                blocksInWalkshed++;
              } else {
                // Fallback: if intersection calculation fails but booleanIntersects was true,
                // use full population
                populationInWalkshed += population;
                blocksInWalkshed++;
              }
            }
          }
        } catch (err) {
          // Skip blocks that cause geometry errors
          console.debug(`Skipping block due to geometry error:`, err);
        }
      });

      // Store census blocks for visualization
      setCensusBlocks(blockGeometries);

      // Calculate percentage of Seattle population served
      const seattlePopulation = 737015; // Seattle 2020 Census count
      const populationPercent = ((populationInWalkshed / seattlePopulation) * 100).toFixed(1);

      // Update UI with population statistics
      setCensusData({
        population: populationInWalkshed.toLocaleString(),
        populationPercent: populationPercent,
        blocksCount: blocksInWalkshed
      });

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
    setFrequentStops([]);
    setCensusBlocks(null);
    setShowCensusBlocks(false);
    mergedPolygonRef.current = null;
    mergedPolygonOutOfBoundsRef.current = null;

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
              Stops with service every 10 minutes, 6am-7pm weekdays + 10-minute walksheds
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
            {/* Stop count metric */}
            <div>
              <span className="text-gray-600 text-sm">Frequent Transit Stops:</span>
              <span className="ml-2 text-2xl font-bold text-blue-600">{stats.stopCount}</span>
            </div>
            {/* Area coverage metric (percentage of Seattle covered by walksheds) */}
            <div>
              <span className="text-gray-600 text-sm">Coverage (by area):</span>
              <span className="ml-2 text-2xl font-bold text-green-600">{stats.coveragePercent}%</span>
              <span className="text-gray-500 text-xs ml-1">(merged walksheds)</span>
            </div>
            {/* Population metrics - shown when census data loads successfully */}
            {censusData && !censusData.error && (
              <div>
                <span className="text-gray-600 text-sm">Population Served:</span>
                <span className="ml-2 text-2xl font-bold text-purple-600">{censusData.populationPercent}%</span>
                <span className="text-gray-500 text-xs ml-1">({censusData.population} people)</span>
              </div>
            )}
            {/* Census error message if data failed to load */}
            {censusData?.error && (
              <div>
                <span className="text-red-600 text-sm">{censusData.error}</span>
              </div>
            )}
            {/* Button to calculate population served (only shown when walkshed is ready and census hasn't been loaded yet) */}
            {!censusData && !loadingCensus && mergedPolygonRef.current && (
              <button
                onClick={() => loadCensusData(mergedPolygonRef.current)}
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