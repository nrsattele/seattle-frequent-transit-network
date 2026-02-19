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

- Reads GTFS ZIP files (stops, trips, stop_times, calendar)
- Calculates hourly trip frequencies for each stop on weekdays
- Aggregates to maximum frequency across all routes at each stop
- Outputs: `base_data/all_stops_{year}.json` with pre-calculated frequencies

**Run:**
```bash
cd isochrone-generation
node extract-all-stops.js [year]  # year: 2020, 2025, or 2027
```

### 2: Isochrone setup
**File:** `isochrone-generation/generate-isochrones.js`

- Reads output from step 1
- Calls the Mapbox API to get 5 and 10 minute walksheds around each stop
- Outputs: `base_data/isochrones_{year}.json` with the geometry of the walksheds

**Run:**
```bash
cd isochrone-generation
node generate-isochrones.js [year]  # year: 2020, 2025, or 2027
```

### 3: Website!
**File:** `seattle-transit-access.tsx`

- Loads pre-processed data from all_stops JSON files
- Filters stops meeting frequent transit criteria
- Visualizes 10-minute walksheds (using pre-computed isochrones or circles)
- Calculates coverage statistics and population served
- Interactive map with year selection (2020, 2025, 2027)

**Run:**
```bash
npm run dev
```
