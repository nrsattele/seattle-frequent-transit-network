/**
 * Frequency rules and the options they're measured over: years, days, time-of-day presets, headways and areas.
 *
 * Shared by the site (seattle-transit-access.tsx) and the build scripts in isochrone-generation/, so both classify
 * stops exactly the same way. Plain TypeScript with no browser or Node dependencies; scripts run it with
 * `node --experimental-transform-types`.
 */

// The Future scenario has no GTFS feed of its own; it layers future_stops/future_stops.json on top of this year's data.
// Keep in sync with GTFS_YEAR in isochrone-generation/extract-all-stops.js.
export const FUTURE_SCENARIO_BASE_YEAR = '2026';

// The Future scenario's key in the year selector and its data file names (all_stops_future.json, isochrones_future.json)
export const FUTURE_SCENARIO = 'future';

// Years and scenarios with data, in the order the site offers them
export const YEARS = ['2020', '2025', '2026', FUTURE_SCENARIO];

// Time-of-day presets.
export enum Preset {
  AllDay,
  AmPeak,
  Midday,
  PmPeak,
  Evening,
  LateNight,
  Overnight,
}

// Hours are [start, end) on a 24-hour clock, matching the keys of hourly_trips.
export const PRESETS: Record<Preset, { label: string; hours: readonly [number, number] }> = {
  [Preset.AllDay]: { label: 'All day', hours: [6, 19] },
  [Preset.AmPeak]: { label: 'AM peak', hours: [6, 9] },
  [Preset.Midday]: { label: 'Midday', hours: [9, 15] },
  [Preset.PmPeak]: { label: 'PM peak', hours: [15, 19] },
  [Preset.Evening]: { label: 'Evening', hours: [19, 21] },
  [Preset.LateNight]: { label: 'Late night', hours: [21, 24] },
  [Preset.Overnight]: { label: 'Overnight', hours: [0, 6] },
};

// Days of service. Each has its own all_stops file from extract-all-stops.js (weekdays use a representative Wednesday).
export enum Day {
  Weekday,
  Saturday,
  Sunday,
}

export const DAYS: Record<Day, { label: string; plural: string; fileSuffix: string }> = {
  [Day.Weekday]: { label: 'Weekday', plural: 'weekdays', fileSuffix: '' },
  [Day.Saturday]: { label: 'Saturday', plural: 'Saturdays', fileSuffix: '_saturday' },
  [Day.Sunday]: { label: 'Sunday', plural: 'Sundays', fileSuffix: '_sunday' },
};

// Areas that coverage and population are measured within
export enum Area {
  Seattle,
  KingCounty,
}

// Boundary files exclude major bodies of water, so coverage is a share of land. `place` filters census blocks by
// their Place field (null = every block). Populations are 2020 Census counts.
export const AREAS: Record<Area, { label: string; boundaryFile: string; population: number; place: string | null }> = {
  [Area.Seattle]: { label: 'Seattle', boundaryFile: 'seattle-city-limits.geojson', population: 737015, place: 'Seattle' },
  [Area.KingCounty]: { label: 'King County', boundaryFile: 'king-county-limits.geojson', population: 2269675, place: null },
};

export const HEADWAYS = [10, 15, 20, 30, 60, 120]; // Minutes between buses, offered in the headway dropdown
export const TIER_HEADWAYS = [10, 15, 30, 60, 120]; // Tiers mode draws nested walksheds for these, tightest first
export const LONG_WINDOW_HOURS = 6; // Presets this long (All day, Midday, Overnight) may fall one trip short of the average

/**
 * Does a stop with these hourly trip counts have service every `headway` minutes or better during the preset?
 *
 * The preset's window must average at least 60 / headway trips per hour, and no hour may drop below the next
 * looser headway in HEADWAYS. e.g. 15 minutes needs an average of 4 trips per hour with no hour under 3
 * (every 20 minutes). This forgives routes that ex: ramp up slowly in the morning.
 *
 * Windows of LONG_WINDOW_HOURS or more may also fall one trip short of that total, which generalizes the
 * city-matched 10-minute rule: 4+ trips every hour (15 minutes) AND 77+ trips from 6am-7pm, i.e. 6 x 13 - 1.
 * Shorter windows get no slack, since one trip there is a big share (Evening at 30 minutes would otherwise pass
 * with 2 trips then 1, hourly for half the window).
 *
 * Headways longer than an hour (120 min) can't be checked hour by hour, since that would need half a trip per hour.
 * Instead every stretch of that many hours in the window needs at least 1 trip. (60 minutes is unaffected: its
 * floor of 60 / 120 = 0.5 trips still means at least 1 trip every hour.)
 */
export function qualifies(hourlyTrips: Record<string, number> | undefined, preset: Preset, headway: number): boolean {
  if (!hourlyTrips) return false;

  const [start, end] = PRESETS[preset].hours;
  if (headway > 60) {
    const span = headway / 60;
    for (let h = start; h + span <= end; h++) {
      let trips = 0;
      for (let k = h; k < h + span; k++) trips += hourlyTrips[k.toString()] || 0;
      if (trips < 1) return false;
    }
    return true;
  }

  const looserHeadway = HEADWAYS[HEADWAYS.indexOf(headway) + 1] ?? headway;
  const minTripsPerHour = 60 / looserHeadway;
  const hours = end - start;
  const minTotalTrips = (60 / headway) * hours - (hours >= LONG_WINDOW_HOURS ? 1 : 0);

  let total = 0;
  for (let h = start; h < end; h++) {
    const trips = hourlyTrips[h.toString()] || 0;
    if (trips < minTripsPerHour) return false;
    total += trips;
  }

  return total >= minTotalTrips;
}

/**
 * Does a stop meet the headway during the preset through a single route and direction, or an approved pair?
 *
 * Each stop's routes list has every route and direction serving it with its own hourly trips, plus an entry for
 * each pair in COMBINABLE_ROUTES (extract-all-stops.js) that serves it, e.g. "31/32". Different routes are never
 * mixed otherwise, not even hour by hour. Stops without a routes list (the hand-made Future stops, each a
 * single route) use their own hourly trips.
 */
export function stopQualifies(stop: any, preset: Preset, headway: number): boolean {
  const routes: any[] = stop.routes || [];
  if (routes.length === 0) return qualifies(stop.hourlyTrips, preset, headway);
  return routes.some(route => qualifies(route.hourly_trips, preset, headway));
}

/**
 * The tightest of `headways` (sorted tightest first) each stop meets during the preset, keyed by stop id.
 * Stops that meet none of them are left out.
 */
export function bestHeadways(stops: any[], preset: Preset, headways: number[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const stop of stops) {
    const tightest = headways.find(h => stopQualifies(stop, preset, h));
    if (tightest !== undefined) best.set(stop.id, tightest);
  }
  return best;
}

/**
 * Stops from an all_stops_{year}{_day}.json file, in the shape the rules and walkshed code use
 */
export function stopsFromFile(allStops: any[]): any[] {
  return allStops.map(s => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    hourlyTrips: s.hourly_trips,
    routes: s.routes || [] // Each route and direction serving the stop, with its own hourly_trips
  }));
}

/**
 * Enabled stops from future_stops/future_stops.json for a day of service. Each is a single route, so it has no
 * routes list. Weekends use the stop's own Saturday / Sunday trips when it has them (e.g. the I Line), otherwise
 * its weekday trips.
 */
export function futureStopsForDay(futureData: any, day: Day): any[] {
  return (futureData.stops || [])
    .filter((stop: any) => stop.enabled !== false)
    .map((stop: any) => ({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      isFuture: true,
      routeName: stop.route_name,
      hourlyTrips: (day === Day.Saturday && stop.hourly_trips_saturday)
        || (day === Day.Sunday && stop.hourly_trips_sunday)
        || stop.hourly_trips
    }));
}
