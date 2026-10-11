# gtfs-frequency-map
A map visualizing access to frequent transit in Seattle

## Overview

This project analyzes GTFS (General Transit Feed Specification) data to identify and visualize "frequent transit" stops - stops with high-frequency service throughout the day.

**Frequent Transit Definition:**
- 4+ trips per hour between 6am-7pm on a represenative weekday
- Averages 5.8+ trips per hour (76+ total trips during the window)
- Note it isn't actually 6 trips per hour all day to get around some data inconsitencies and to maintain parity with city-produced maps.

## flow

### 1: Offline GTFS Processing
**File:** `isochrone-generation/extract-all-stops.js`

- Reads GTFS ZIP files (stops, trips, stop_times, calendar, calendar_dates)
- Calculates hourly trip frequencies for each stop on a representative Wednesday
- Aggregates to maximum frequency across all routes at each stop
- Outputs: `base_data/all_stops_{year}.json` with pre-calculated frequencies
- 2027 is a scenario, not a feed: it extracts only the hand-made stops in `base_data/future_stops/future_stops_2027.json`, which the site layers on top of the 2026 data

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
- Filters stops meeting frequent transit criteria
- Visualizes 10-minute walksheds (using pre-computed isochrones or circles)
- Calculates coverage statistics and population served
- Interactive map with year selection (2020, 2025, 2026, 2027)

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
