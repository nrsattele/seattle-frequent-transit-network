# gtfs-frequency-map
A map visualizing access to frequent transit in Seattle

## Overview

This project analyzes GTFS (General Transit Feed Specification) data to map how often buses and trains come at each stop, and how much of Seattle lives within a 10-minute walk of that service. It defaults to the city's frequent transit network (every 10 minutes, 6am-7pm weekdays), and you can pick other times of day and headways.

## How frequency is measured

Everything uses trips per hour at each stop on a representative weekday (the first Wednesday of the feed's service period).

**Time of day presets** (Evening, Late night and Overnight follow the time bands in [SDOT's Frequent Transit Network targets](https://www.seattle.gov/transportation/projects-and-programs/programs/transit-program/seattle-transit-measure/the-frequent-transit-network)):

| Preset | Hours |
|---|---|
| All day (default) | 6am-7pm |
| AM peak | 6-9am |
| Midday | 9am-3pm |
| PM peak | 3-7pm |
| Evening | 7-9pm |
| Late night | 9pm-midnight |
| Overnight | midnight-6am |

**Headways:** 10, 15, 20, 30, 60 and 120 minutes.

**Rule:** a stop meets a headway when, over the preset's hours, it averages at least 60/headway trips per hour and no single hour drops below the next looser headway:

The averaging forgives routes that ramp up slowly at the start of service without letting real gaps through. All day + 10 minutes needs 77 trips in total rather than 6 × 13 = 78, which matches the city's frequent transit maps.

120 minutes can't be checked hour by hour (that would be half a trip per hour), so instead every 2-hour stretch in the preset's hours needs at least one trip.

**Which trips count:** each stop is judged by its best single route and direction, so a corridor served by several less frequent routes isn't added together. The one exception is Routes 3 and 4, which run as one combined service and count together (`combinableRoutes` in `extract-all-stops.js`).

## flow

### 1: Offline GTFS Processing
**File:** `isochrone-generation/extract-all-stops.js`

- Reads GTFS ZIP files (stops, trips, stop_times, calendar, calendar_dates)
- Calculates hourly trip frequencies for each stop on a representative Wednesday
- Aggregates to maximum frequency across all routes at each stop
- Outputs: `base_data/all_stops_{year}.json` with pre-calculated frequencies for every stop (the site applies the frequency rules)
- 2027 is a scenario, not a feed: it extracts only the hand-made stops in `base_data/future_stops/future_stops_2027.json`, which the site layers on top of the 2026 data. Every enabled future stop is kept, whatever its frequency.

**Run:**
```bash
cd isochrone-generation
node extract-all-stops.js [year]  # year: 2020, 2025, 2026, or 2027
```

### 2: Isochrone setup
**File:** `isochrone-generation/generate-isochrones.js`

- Reads output from step 1
- Calls the Mapbox API to get 5 and 10 minute walksheds around each stop
- Outputs: `base_data/isochrones_{year}.json` with the geometry of the walksheds

**Run:**
```bash
cd isochrone-generation
node generate-isochrones.js [year]  # year: 2020, 2025, 2026, or 2027
```

### 3: Website!
**File:** `seattle-transit-access.tsx`

- Loads pre-processed data from all_stops JSON files
- Year selector (2020, 2025, 2026, 2027) and time of day preset buttons
- **Single mode:** one headway, picked from a dropdown. Each headway has its own color, used in both modes.
- **Tiers mode:** nested bands for every 10, 15, 30, 60 and 120 minutes, so you can see all levels of service at once. Stop markers appear from zoom 14 and their tooltips show the stop's tier.
- Visualizes 10-minute walksheds (using pre-computed isochrones or circles), merged per headway
- Coverage: share of Seattle's area within a 10-minute walk, per headway
- Population served (on request): share of Seattle's 2020 population within a 10-minute walk, from census blocks. The 56MB census file downloads on the first click, and partially covered blocks count in proportion to the area covered.
- Population density layer, available once population is calculated. Tiers draw as outlines over it.

**Run:**
```bash
npm run dev
```

## Adding a new year

1. Put the Metro and Sound Transit GTFS ZIPs in `public/base_data/{year}/`
2. Add a `GTFS_FILES_{year}` entry to `GTFS_FILES_BY_YEAR` in `extract-all-stops.js`
3. Run `node extract-all-stops.js {year}`, then `node generate-isochrones.js {year}` (needs `MAPBOX_ACCESS_TOKEN`; calls Mapbox once per stop)
4. Add the year to `availableYears` in `seattle-transit-access.tsx`
5. To move the future scenario onto the new year, update `FUTURE_SCENARIO_BASE_YEAR` in `seattle-transit-access.tsx` and `GTFS_YEAR` in `extract-all-stops.js`, then disable any future stops that now appear in the real feed and re-run `node extract-all-stops.js 2027`
