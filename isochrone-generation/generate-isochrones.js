/**
 * Generate 10-minute walk isochrones for all transit stops
 *
 * This script uses the Mapbox Isochrone API to generate accurate walking
 * isochrones that account for:
 * - Actual street network
 * - Elevation/hills (via walking speed adjustments)
 * - Barriers (water, highways, etc.)
 *
 * Usage:
 * 1. Set MAPBOX_ACCESS_TOKEN environment variable
 * 2. Run: node generate-isochrones.js
 * 3. Output: base_data/isochrones.json
 */

import fetch from 'node-fetch';
import fs from 'fs';

// Configuration
const MAPBOX_ACCESS_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || '';
const CONTOUR_MINUTES = [5, 10]; // Generate both 5-minute and 10-minute walksheds

// Choose which dataset to process (can be set via command line argument)
const DATASET = process.argv[2] || '2025'; // Default to 2025

// Export ALL stops from your app (not just frequent ones)
// This allows for "what-if" analysis by changing which stops are frequent
const ALL_STOPS_FILE = `../public/base_data/all_stops_${DATASET}.json`;
const OUTPUT_FILE = `../public/base_data/isochrones_${DATASET}.json`;

/**
 * Generate isochrones for a single stop using Mapbox API
 * Generates BOTH 5-minute and 10-minute walksheds in a single API call
 */
async function generateIsochrones(stop) {
  const { lon, lat, id, name, feed, original_id, dataset } = stop;

  // Mapbox Isochrone API endpoint - request both 5 and 10 minute contours
  const contours = CONTOUR_MINUTES.join(',');
  const url = `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon},${lat}?contours_minutes=${contours}&polygons=true&access_token=${MAPBOX_ACCESS_TOKEN}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Extract both polygons (features are sorted by contour time)
    // features[0] = 5 minutes, features[1] = 10 minutes
    const isochrone5min = data.features.find(f => f.properties.contour === 5);
    const isochrone10min = data.features.find(f => f.properties.contour === 10);

    return {
      stop_id: id, // Composite key: year_feed_stopid
      original_id: original_id, // Original stop ID from GTFS
      feed: feed, // Feed name (metro, soundtransit, etc.)
      dataset: dataset, // Year (2020, 2025, etc.)
      stop_name: name,
      coordinates: { lon, lat },
      isochrone_5min: isochrone5min,
      isochrone_10min: isochrone10min
    };
  } catch (error) {
    console.error(`Error generating isochrones for stop ${id} (${name}):`, error.message);
    return null;
  }
}

/**
 * Generate isochrones for all stops with rate limiting
 * Skips stops that already have isochrones in existingIsochrones
 */
async function generateAllIsochrones(stops, existingIsochrones = []) {
  const isochrones = [...existingIsochrones]; // Start with existing data

  // Create a Set of existing stop IDs for fast lookup
  const existingStopIds = new Set(existingIsochrones.map(iso => iso.stop_id));

  // Filter to only stops that don't have isochrones yet
  const stopsToProcess = stops.filter(stop => !existingStopIds.has(stop.id));

  const total = stopsToProcess.length;
  const skipped = stops.length - stopsToProcess.length;

  console.log(`Total stops: ${stops.length}`);
  console.log(`Already have isochrones: ${skipped}`);
  console.log(`Need to generate: ${total}`);

  if (total === 0) {
    console.log('All stops already have isochrones! Nothing to do.');
    return isochrones;
  }

  for (let i = 0; i < stopsToProcess.length; i++) {
    const stop = stopsToProcess[i];

    console.log(`[${i + 1}/${total}] Processing: ${stop.name} (${stop.id})`);

    const result = await generateIsochrones(stop);

    if (result) {
      isochrones.push(result);
    }

    // Rate limiting: Mapbox allows ~600 requests/minute
    // Add 100ms delay between requests to be safe
    if (i < stopsToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Progress update every 50 stops
    if ((i + 1) % 50 === 0) {
      console.log(`\nProgress: ${i + 1}/${total} (${Math.round((i + 1) / total * 100)}%)\n`);
    }
  }

  return isochrones;
}

/**
 * Main execution
 */
async function main() {
  // Check for access token
  if (MAPBOX_ACCESS_TOKEN === '') {
    console.error('ERROR: Please set MAPBOX_ACCESS_TOKEN environment variable');
  }

  // Load ALL stops
  console.log(`Loading stops from ${DATASET} dataset: ${ALL_STOPS_FILE}...`);

  if (!fs.existsSync(ALL_STOPS_FILE)) {
    console.error(`ERROR: ${ALL_STOPS_FILE} not found!`);
    console.error(`run node extract-all-stops.js ${DATASET}\n`);
    process.exit(1);
  }

  let stops = JSON.parse(fs.readFileSync(ALL_STOPS_FILE, 'utf-8'));
  console.log(`Loaded ${stops.length} stops`);

  // Load existing isochrones if output file exists
  let existingIsochrones = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    console.log(`\nFound existing output file: ${OUTPUT_FILE}`);
    const existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    existingIsochrones = existingData.isochrones || [];
    console.log(`Loaded ${existingIsochrones.length} existing isochrones`);
  }

  // Calculate how many stops need processing
  const existingStopIds = new Set(existingIsochrones.map(iso => iso.stop_id));

  // Generate isochrones
  const isochrones = await generateAllIsochrones(stops, existingIsochrones);

  // Save results
  console.log(`\nGenerated ${isochrones.length} isochrones`);
  console.log(`Saving to ${OUTPUT_FILE}...`);

  const output = {
    generated_at: new Date().toISOString(),
    parameters: {
      total_stops: stops.length,
      successful: isochrones.length
    },
    isochrones: isochrones
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`Saved ${isochrones.length} isochrones to ${OUTPUT_FILE}`);
}

main().catch(console.error);
