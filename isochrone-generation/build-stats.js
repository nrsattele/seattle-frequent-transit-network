/**
 * Precompute coverage and population for every year, day, preset, walk time, area and headway
 *
 * Uses the same rules and geometry code as the site (shared/frequency.ts, shared/walksheds.ts), so the numbers
 * match what the map shows. The site reads the output for comparing years.
 *
 * Usage (from isochrone-generation/):
 *   node --experimental-transform-types build-stats.js [--workers N] [--only YEAR] [--out FILE]
 *
 * Reads: public/base_data/all_stops_*.json, isochrones_*.json, future_stops/future_stops.json, the area boundary
 *   files and KING_COUNTY_BLOCK_2020_POPULATION.geojson. No network calls.
 * Writes: public/base_data/stats.json, where results[year][day][preset][walk minutes][headway] is
 *   { stops, Seattle: { coverage, population }, KingCounty: { coverage, population } }, e.g.
 *   results["2026"].Weekday.AllDay["10"]["15"]. Stop counts are county-wide; coverage is the % of the area's land;
 *   population percentages come from dividing by the area's total (AREAS in shared/frequency.ts).
 *
 * Rerun (npm run build-stats) after changing the rules (shared/frequency.ts), the walkshed code (shared/walksheds.ts),
 * or any of the data files above, e.g. after re-running extract-all-stops.js or generate-isochrones.js.
 */
import fs from 'fs';
import os from 'os';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import * as turf from '@turf/turf';
import {
  YEARS, FUTURE_SCENARIO, FUTURE_SCENARIO_BASE_YEAR, Preset, PRESETS, Day, DAYS, Area, AREAS, HEADWAYS,
  LONG_WINDOW_HOURS, bestHeadways, stopsFromFile, futureStopsForDay
} from '../shared/frequency.ts';
import { WALK_MINUTES, walkshedsForStops, computeTiers, clipToArea, prepareCensusBlocks, populationInWalkshed } from '../shared/walksheds.ts';

const DATA = new URL('../public/base_data/', import.meta.url);
const outArg = process.argv.indexOf('--out');
const OUTPUT = outArg > 0 ? new URL('file:///' + process.argv[outArg + 1].split('\\').join('/')) : new URL('stats.json', DATA);
const readJson = name => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));

// Pretty-print, but keep each headway entry and each list of numbers on one line, so a rebuild's diff shows exactly
// which numbers changed while the file stays compact
export function formatStats(stats) {
  const oneLine = value => typeof value === 'object' && value !== null
    ? (Array.isArray(value)
      ? `[${value.map(oneLine).join(', ')}]`
      : `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(', ')} }`)
    : JSON.stringify(value);
  const pretty = (value, indent) => {
    if (typeof value !== 'object' || value === null) return JSON.stringify(value);
    if (Array.isArray(value) || 'stops' in value) return oneLine(value);
    const inner = indent + '  ';
    return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n')}\n${indent}}`;
  };
  return pretty(stats, '') + '\n';
}
const presetKeys = Object.keys(PRESETS).map(Number);
const dayKeys = Object.keys(DAYS).map(Number);
const areaKeys = Object.keys(AREAS).map(Number);

if (isMainThread) {
  const args = process.argv.slice(2);
  const workerCount = Number(args[args.indexOf('--workers') + 1]) > 0 && args.includes('--workers')
    ? Number(args[args.indexOf('--workers') + 1])
    : Math.max(1, Math.min(6, os.cpus().length - 2));
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const years = only ? [only] : YEARS;

  // One unit = one year, day, preset and walk time; it covers every headway and both areas
  const units = [];
  for (const year of years) for (const day of dayKeys) for (const preset of presetKeys) for (const walk of WALK_MINUTES) units.push({ year, day, preset, walk });

  console.log(`Building stats: ${units.length} combinations of year/day/preset/walk time, ${workerCount} workers`);
  const started = Date.now();
  const results = [];
  let next = 0;
  let done = 0;

  await new Promise((resolve, reject) => {
    let active = 0;
    for (let w = 0; w < Math.min(workerCount, units.length); w++) {
      // Workers need the TypeScript flag to load the shared modules; memory flags aren't allowed, so set a limit here
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: process.execArgv.filter(arg => arg.startsWith('--experimental')),
        resourceLimits: { maxOldGenerationSizeMb: 4096 }
      });
      active++;
      const feed = () => { if (next < units.length) worker.postMessage(units[next++]); else worker.postMessage(null); };
      worker.on('message', message => {
        if (message.ready) return feed();
        results.push(message);
        done++;
        const elapsed = (Date.now() - started) / 1000;
        const eta = elapsed / done * (units.length - done);
        console.log(`  ${done}/${units.length}  ${message.year} ${DAYS[message.day].label} ${PRESETS[message.preset].label} ${message.walk} min  (${message.seconds}s; ~${Math.round(eta / 60)} min left)`);
        feed();
      });
      worker.on('error', reject);
      worker.on('exit', () => { if (--active === 0) resolve(); });
    }
  });

  // Nest results as year -> day -> preset -> walk minutes -> headway, using readable keys
  const existing = only && fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')).results : {};
  const nested = existing || {};
  for (const r of results.sort((a, b) => a.year.localeCompare(b.year) || a.day - b.day || a.preset - b.preset || a.walk - b.walk)) {
    const node = ((((nested[r.year] ??= {})[Day[r.day]] ??= {})[Preset[r.preset]] ??= {}));
    node[r.walk] = r.headways;
  }

  const output = {
    generated_at: new Date().toISOString(),
    settings: { headways: HEADWAYS, long_window_hours: LONG_WINDOW_HOURS, presets: Object.fromEntries(presetKeys.map(p => [Preset[p], PRESETS[p].hours])) },
    results: nested
  };
  fs.writeFileSync(OUTPUT, formatStats(output));
  console.log(`Wrote ${OUTPUT.pathname} (${Math.round(fs.statSync(OUTPUT).size / 1024)} KB) in ${Math.round((Date.now() - started) / 60000)} min`);
} else {
  // Worker: loads each data file once, then computes units as they arrive
  const cache = new Map();
  const once = (key, load) => { if (!cache.has(key)) cache.set(key, load()); return cache.get(key); };
  const census = () => once('census', () => readJson('KING_COUNTY_BLOCK_2020_POPULATION.geojson').features);
  const blocksFor = area => once(`blocks:${area}`, () => prepareCensusBlocks(turf, census(), AREAS[area].place));
  const boundaryFor = area => once(`boundary:${area}`, () => readJson(AREAS[area].boundaryFile));
  const futureData = () => once('future', () => readJson('future_stops/future_stops.json'));

  // Walksheds for a year; Future uses the base year's plus the future stops' (as the site does)
  const isochronesFor = year => once(`iso:${year}`, () => {
    // Only keep one year's walksheds in memory at a time
    for (const key of [...cache.keys()]) if (key.startsWith('iso:')) cache.delete(key);
    const map = new Map();
    for (const y of year === FUTURE_SCENARIO ? [FUTURE_SCENARIO_BASE_YEAR, FUTURE_SCENARIO] : [year]) {
      for (const iso of readJson(`isochrones_${y}.json`).isochrones) map.set(iso.stop_id, iso);
    }
    return map;
  });

  const stopsFor = (year, day) => once(`stops:${year}:${day}`, () => {
    const gtfsYear = year === FUTURE_SCENARIO ? FUTURE_SCENARIO_BASE_YEAR : year;
    const stops = stopsFromFile(readJson(`all_stops_${gtfsYear}${DAYS[day].fileSuffix}.json`));
    return year === FUTURE_SCENARIO ? [...stops, ...futureStopsForDay(futureData(), day)] : stops;
  });

  parentPort.on('message', unit => {
    if (unit === null) return process.exit(0);
    const started = Date.now();
    const { year, day, preset, walk } = unit;
    const stops = stopsFor(year, day);
    const isochrones = isochronesFor(year);
    const bestHeadway = bestHeadways(stops, preset, HEADWAYS);
    const frequent = stops.filter(stop => bestHeadway.has(stop.id));

    // Merge once (unclipped), then clip and count per area
    const { tiers } = computeTiers(turf, {
      stops: frequent,
      bestHeadway,
      headways: HEADWAYS,
      boundary: null,
      walksheds: list => walkshedsForStops(turf, list, isochrones, year, walk)
    });

    // Per headway: the county-wide stop count once, then each area's coverage (% of its land) and population
    const headways = {};
    for (const tier of tiers) {
      const entry = { stops: tier.stopCount };
      for (const area of areaKeys) {
        let coverage = 0;
        let population = 0;
        if (tier.polygon) {
          const { mergedPolygon, coveragePercent } = clipToArea(turf, tier.polygon, boundaryFor(area), false);
          coverage = parseFloat(coveragePercent);
          if (mergedPolygon) population = populationInWalkshed(turf, mergedPolygon, blocksFor(area));
        }
        entry[Area[area]] = { coverage, population: Math.round(population) };
      }
      headways[tier.headway] = entry;
    }
    parentPort.postMessage({ year, day, preset, walk, headways, seconds: Math.round((Date.now() - started) / 1000) });
  });
  parentPort.postMessage({ ready: true });
}
