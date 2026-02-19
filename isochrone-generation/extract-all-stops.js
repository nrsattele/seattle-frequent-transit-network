/**
 * Extract all unique stops from GTFS feeds
 *
 * This script reads the GTFS ZIP files directly and extracts all stops,
 * merging Metro and Sound Transit into a single comprehensive list.
 *
 * Usage:
 *   node extract-all-stops.js
 *
 * Output:
 *   base_data/all_stops.json
 */

import JSZip from 'jszip';
import Papa from 'papaparse';
import fs from 'fs';

// GTFS files to process (paths relative to project root)
// Each entry: [file_path, feed_name]
const GTFS_FILES_2020 = [
  ['../public/base_data/2020/feb_2020_metro_gtfs.zip', 'metro']
];

const GTFS_FILES_2025 = [
  ['../public/base_data/2025/dec_2025_metro_gtfs.zip', 'metro'],
  ['../public/base_data/2025/dec_2025_soundtransit_gtfs.zip', 'soundtransit']
];

// Choose which dataset to process (can be set via command line argument)
const DATASET = process.argv[2] || '2025'; // Default to 2025

// For 2027, use 2025 GTFS as base and add future stops
const GTFS_YEAR = DATASET === '2027' ? '2025' : DATASET;
const GTFS_FILES = GTFS_YEAR === '2020' ? GTFS_FILES_2020 : GTFS_FILES_2025;
const OUTPUT_FILE = `../public/base_data/all_stops_${DATASET}.json`;
const FUTURE_STOPS_FILE = `../public/base_data/future_stops/future_stops_${DATASET}.json`;

/**
 * Extract stops from a single GTFS ZIP file with frequency calculation
 */
async function extractStopsFromZip(zipPath, feedName, dataset) {
  console.log(`\nProcessing: ${zipPath} (feed: ${feedName})`);

  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);

  // Extract required GTFS files
  const stopsFile = zip.file('stops.txt');
  const stopTimesFile = zip.file('stop_times.txt');
  const tripsFile = zip.file('trips.txt');
  const calendarFile = zip.file('calendar.txt');

  if (!stopsFile) {
    console.error(`No stops.txt found in ${zipPath}`);
    return [];
  }

  // Parse stops.txt
  const stopsText = await stopsFile.async('text');
  const parsedStops = Papa.parse(stopsText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  // If we don't have the other files needed for frequency calculation, return basic stop data
  if (!stopTimesFile || !tripsFile || !calendarFile) {
    console.warn(`Missing files for frequency calculation in ${zipPath}, returning basic stop data`);
    const stops = parsedStops.data
      .map(s => ({
        id: `${dataset}_${feedName}_${s.stop_id}`,
        original_id: s.stop_id,
        feed: feedName,
        dataset: dataset,
        name: s.stop_name,
        lat: parseFloat(s.stop_lat),
        lon: parseFloat(s.stop_lon),
        code: s.stop_code || null
      }))
      .filter(s => !isNaN(s.lat) && !isNaN(s.lon));
    return stops;
  }

  // Parse stop_times.txt
  const stopTimesText = await stopTimesFile.async('text');
  const parsedStopTimes = Papa.parse(stopTimesText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  // Parse trips.txt
  const tripsText = await tripsFile.async('text');
  const parsedTrips = Papa.parse(tripsText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  // Parse calendar.txt
  const calendarText = await calendarFile.async('text');
  const parsedCalendar = Papa.parse(calendarText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  // Calculate frequencies
  const stopFrequencies = calculateStopFrequencies(
    parsedStopTimes.data,
    parsedTrips.data,
    getRelevantServiceIds(parsedCalendar.data)
  );

  // Combine stop data with frequencies
  const stops = parsedStops.data
    .map(s => ({
      id: `${dataset}_${feedName}_${s.stop_id}`,
      original_id: s.stop_id,
      feed: feedName,
      dataset: dataset,
      name: s.stop_name,
      lat: parseFloat(s.stop_lat),
      lon: parseFloat(s.stop_lon),
      code: s.stop_code || null,
      hourly_trips: stopFrequencies.get(s.stop_id) || {}
    }))
    .filter(s => !isNaN(s.lat) && !isNaN(s.lon));

  return stops;
}

/**
 * Calculate hourly trip frequencies for each stop given the active service IDs.
 * Tracks each stop+route+direction combination separately, then aggregates to get
 * the maximum frequency across all route/direction combinations for each stop.
 */
function calculateStopFrequencies(stopTimes, trips, activeServiceIds) {
  if (activeServiceIds.size === 0) {
    console.warn('No active weekday service IDs found');
    return new Map();
  }

  // Create trip lookup
  const tripInfo = {};
  trips.forEach(t => {
    tripInfo[t.trip_id] = {
      route_id: t.route_id,
      direction_id: t.direction_id,
      service_id: t.service_id
    };
  });

  // Filter for trips on services in activeServiceIds
  const activeTrips = new Set(
    trips
      .filter(t => activeServiceIds.has(t.service_id))
      .map(t => t.trip_id)
  );

  // Routes that are allowed to be combined for the definition of frequent service.
  const combinableRoutes = new Map([
    // Routes 3 and 4.
    ['100173', '100219'],
    ['100219', '100173'],
  ]);

  // Count trips per hour for each stop+route+direction combination
  // Similar to stopRouteDirectionHeadways in seattle-transit-access.tsx
  const stopRouteDirectionHeadways = {};

  // Process all stop times, filtering for relevant trips only
  stopTimes
    .filter(st => activeTrips.has(st.trip_id))
    .forEach(stopTime => {
      const time = stopTime.arrival_time || stopTime.departure_time;
      if (!time) return;

      // Extract hour (handle times like "25:30:00")
      const hour = parseInt(time.split(':')[0]) % 24;

      const stopId = stopTime.stop_id;
      const tripId = stopTime.trip_id;
      const trip = tripInfo[tripId];
      if (!trip) return;

      // Allow combining certain routes for frequency calculation
      let route_id = trip.route_id;
      if (combinableRoutes.has(route_id)) {
        const otherRoute = combinableRoutes.get(route_id);
        const first = [route_id, otherRoute].sort()[0];
        const second = [route_id, otherRoute].sort()[1];
        route_id = `${first}|${second}`;
      }

      // Create unique key for this stop + route + direction combination
      const key = `${stopId}|${route_id}|${trip.direction_id}`;

      // Initialize tracking object if this is the first time we see this combination
      if (!stopRouteDirectionHeadways[key]) {
        stopRouteDirectionHeadways[key] = {
          stop_id: stopId,
          route_id: route_id,
          direction_id: trip.direction_id,
          tripTimes: {} // Map of trip_id -> hour (count each trip only once)
        };
      }

      // Count each trip only once per stop+route+direction
      if (!stopRouteDirectionHeadways[key].tripTimes[tripId]) {
        if (!stopRouteDirectionHeadways[key].tripTimes[hour]) {
          stopRouteDirectionHeadways[key].tripTimes[hour] = new Set();
        }
        stopRouteDirectionHeadways[key].tripTimes[hour].add(tripId);
      }
    });

  // Now aggregate by stop: for each stop, take the MAXIMUM frequency across all route/direction combinations
  // This gives us the best service frequency available at each stop
  const stopMaxFrequencies = new Map();

  Object.values(stopRouteDirectionHeadways).forEach(({ stop_id, tripTimes }) => {
    // Convert trip sets to counts per hour
    const hourlyTrips = {};
    for (let h = 0; h < 24; h++) {
      hourlyTrips[h] = tripTimes[h] ? tripTimes[h].size : 0;
    }

    // If we haven't seen this stop yet, or this route/direction has better frequency, update it
    if (!stopMaxFrequencies.has(stop_id)) {
      stopMaxFrequencies.set(stop_id, hourlyTrips);
    } else {
      // Take the maximum frequency for each hour across all route/direction combinations
      const existingFreq = stopMaxFrequencies.get(stop_id);
      for (let h = 0; h < 24; h++) {
        existingFreq[h] = Math.max(existingFreq[h] || 0, hourlyTrips[h] || 0);
      }
    }
  });

  // Convert to final format with string keys
  const result = new Map();
  for (const [stopId, hourlyTrips] of stopMaxFrequencies.entries()) {
    const hourlyTripsStr = {};
    for (let h = 0; h < 24; h++) {
      hourlyTripsStr[h.toString()] = hourlyTrips[h];
    }
    result.set(stopId, hourlyTripsStr);
  }

  return result;
}

/**
 * Get service IDs active on a representative weekday.
 * Finds the list of 'weekday' service IDs (Mon-Fri) and filters to one active during the first wednesday.
 */
function getRelevantServiceIds(calendar) {
  const weekdayServiceEntries = calendar
    .filter(c =>
      c.monday === '1' &&
      c.tuesday === '1' &&
      c.wednesday === '1' &&
      c.thursday === '1' &&
      c.friday === '1'
    );

  if (weekdayServiceEntries.length === 0) {
    console.error('No weekday services found in calendar.txt');
    return new Set();
  }

  // Find the latest start date
  const allStartDates = weekdayServiceEntries
    .map(s => s.start_date)
    .filter(d => d)
    .sort();

  if (allStartDates.length === 0) {
    console.error('No start dates found in calendar.txt');
    return new Set();
  }

  const latestStartDate = allStartDates[allStartDates.length - 1];

  // Parse the start date (YYYYMMDD)
  const year = parseInt(latestStartDate.substring(0, 4));
  const month = parseInt(latestStartDate.substring(4, 6)) - 1;
  const day = parseInt(latestStartDate.substring(6, 8));
  const startDate = new Date(year, month, day);

  // Find the first Wednesday on or after the start date
  let wednesdayDate = new Date(startDate);
  while (wednesdayDate.getDay() !== 3) {
    wednesdayDate.setDate(wednesdayDate.getDate() + 1);
  }

  // Format back to YYYYMMDD
  const wednesdayDateStr =
    wednesdayDate.getFullYear().toString() +
    (wednesdayDate.getMonth() + 1).toString().padStart(2, '0') +
    wednesdayDate.getDate().toString().padStart(2, '0');

  // Find all service IDs active on this Wednesday
  const activeServiceIds = weekdayServiceEntries
    .filter(s => {
      const start = s.start_date || '0';
      const end = s.end_date || '99999999';
      return wednesdayDateStr >= start && wednesdayDateStr <= end;
    })
    .map(s => s.service_id);

  console.log(`  Found ${activeServiceIds.length} active weekday service(s) for ${wednesdayDateStr}`);

  return new Set(activeServiceIds);
}

/**
 * Load future stops from JSON file (for future year scenarios)
 */
function loadFutureStops(dataset) {
  // Only load future stops for years that have them
  const futureYears = ['2027'];
  if (!futureYears.includes(dataset)) {
    return [];
  }

  if (!fs.existsSync(FUTURE_STOPS_FILE)) {
    console.log(`\nNo future stops file found for ${dataset}`);
    return [];
  }

  console.log(`\nLoading future stops from ${FUTURE_STOPS_FILE}...`);
  const futureData = JSON.parse(fs.readFileSync(FUTURE_STOPS_FILE, 'utf-8'));

  // Filter to enabled stops that meet frequency requirements
  const enabledStops = futureData.stops.filter(stop => {
    if (stop.enabled === false) return false;

    // Check frequency requirements (4+ trips per hour in hours 6-18)
    const hourlyTrips = stop.hourly_trips || {};
    for (let h = 6; h < 19; h++) {
      const trips = hourlyTrips[h.toString()] || 0;
      if (trips < 4) {
        console.log(`Skipping ${stop.id} (${stop.name}) - only ${trips} trips at hour ${h}`);
        return false;
      }
    }
    return true;
  });

  console.log(`Found ${enabledStops.length} enabled future stops (from ${futureData.stops.length} total)`);

  // Transform to our format
  return enabledStops.map(stop => ({
    id: stop.id,
    original_id: stop.id,
    feed: 'future',
    dataset: dataset,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    route_name: stop.route_name
  }));
}

/**
 * Merge stops from multiple feeds
 * Since each stop now has a composite key (feed_stopid), there are no duplicates
 */
function mergeStops(stopArrays) {
  const allStops = [];

  for (const stops of stopArrays) {
    allStops.push(...stops);
  }

  return allStops;
}

/**
 * Main execution
 */
async function main() {
  console.log(`Extracting all stops from ${DATASET} GTFS feeds...\n`);

  let allStopArrays = [];

  // For 2027, only extract future stops (GTFS stops from 2025 already have isochrones)
  if (DATASET === '2027') {
    console.log(`Extracting only NEW future stops for ${DATASET} (2025 GTFS stops already have isochrones)\n`);

    const futureStops = loadFutureStops(DATASET);
    if (futureStops.length > 0) {
      allStopArrays.push(futureStops);
    } else {
      console.error('No future stops found!');
      process.exit(1);
    }
  } else {
    // For other years, process GTFS files normally
    for (const [gtfsFile, feedName] of GTFS_FILES) {
      if (!fs.existsSync(gtfsFile)) {
        console.error(`File not found: ${gtfsFile}`);
        continue;
      }

      const stops = await extractStopsFromZip(gtfsFile, feedName, DATASET);
      allStopArrays.push(stops);
    }
  }

  // Merge all stops
  console.log('\nMerging stops from all feeds...');
  const mergedStops = mergeStops(allStopArrays);
  console.log(`  Total unique stops: ${mergedStops.length}`);

  // Sort by stop ID for consistency
  mergedStops.sort((a, b) => a.id.localeCompare(b.id));

  // Save to file
  console.log(`\nSaving to ${OUTPUT_FILE}...`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mergedStops, null, 2));

  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`Saved ${mergedStops.length} stops`);
  console.log(`  File size: ${Math.round(stats.size / 1024)} KB`);

  // Print summary
  console.log('\nSummary:');
  console.log(`  Total stops: ${mergedStops.length}`);
  console.log(`  Estimated isochrone generation time: ~${Math.round(mergedStops.length / 10)} seconds`);
  console.log(`  Estimated file size: ~${Math.round(mergedStops.length * 12 / 1024)} MB`);
  console.log('\nReady to generate isochrones!');
}

main().catch(console.error);
