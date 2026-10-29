/**
 * Walkshed geometry: finding each stop's walkshed, merging them, clipping to an area, nested tiers, and population.
 *
 * Shared by the site (seattle-transit-access.tsx) and the build scripts in isochrone-generation/, so precomputed
 * numbers come from exactly the same code the map draws with. Functions take Turf as a parameter, since the site
 * loads it from a CDN (window.turf) and scripts import it.
 */
import { FUTURE_SCENARIO, FUTURE_SCENARIO_BASE_YEAR } from './frequency.ts';

// Walk times the map can show. Each stop's walkshed file has a polygon for each (isochrone_5min, isochrone_10min);
// stops without one fall back to a circle of about that walking distance (a quarter or half mile).
export const WALK_MINUTES = [5, 10] as const;
export type WalkMinutes = typeof WALK_MINUTES[number];
export const WALK_RADIUS_METERS: Record<WalkMinutes, number> = { 5: 402.336, 10: 804.672 };

/**
 * A stop's pre-computed walkshed polygon for the walk time, or null if it has none
 *
 * `isochrones` maps stop_id -> isochrone entry. In the Future scenario, GTFS stops use the base year's walksheds
 * and future stops their own.
 */
export function findIsochrone(isochrones: Map<string, any>, stop: any, year: string, walkMinutes: WalkMinutes): any {
  const stopId = stop.id || stop.stop_id;
  const isochroneYear = (year === FUTURE_SCENARIO && !stop.isFuture) ? FUTURE_SCENARIO_BASE_YEAR : year;

  // Try different feed combinations
  const possibleKeys = [
    `${isochroneYear}_soundtransit_${stopId}`,  // Try Sound Transit first (more likely to be frequent)
    `${isochroneYear}_metro_${stopId}`,          // Then Metro
    stopId                                        // Finally, try the raw ID in case it's already composite (for future stops)
  ];

  const field = walkMinutes === 5 ? 'isochrone_5min' : 'isochrone_10min';
  for (const key of possibleKeys) {
    const isoData = isochrones.get(key);
    if (isoData && isoData[field]) {
      return isoData[field];
    }
  }
  return null;
}

/**
 * Walkshed polygon for each stop - pre-computed isochrones when available, circular buffers otherwise
 */
export function walkshedsForStops(turf: any, stops: any[], isochrones: Map<string, any>, year: string, walkMinutes: WalkMinutes): any[] {
  return stops.map(stop =>
    findIsochrone(isochrones, stop, year, walkMinutes)
      ?? turf.circle([stop.lon, stop.lat], WALK_RADIUS_METERS[walkMinutes] / 1000, { steps: 32, units: 'kilometers' })
  );
}

/**
 * Merge polygons into one with turf.union, in a tree: pairs, then pairs of pairs, and so on.
 *
 * Merging one at a time into a single growing shape gets slower with every polygon, since each union scans the
 * whole merged outline (minutes for a few thousand walksheds). In a tree most unions are between small shapes,
 * which takes seconds. A polygon that fails to merge is set aside and retried at the end, and skipped if it fails
 * again, so one bad geometry doesn't drop the rest of its branch.
 */
export function mergeWalksheds(turf: any, polygons: any[]): any {
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
        next.push(turf.union(level[i], level[i + 1]));
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
      union = turf.union(union, polygon);
    } catch {
      continue;
    }
  }
  return union;
}

/**
 * Clip a merged walkshed to an area's boundary and calculate coverage
 *
 * Returns the part inside the area, the part outside (only if withOutside, since only the loosest tier's is drawn
 * and the cut is slow against a detailed boundary like King County's), and the inside area as a percentage of the area
 */
export function clipToArea(turf: any, union: any, boundary: any, withOutside = true) {
  try {
    let mergedPolygon = null;
    let mergedPolygonOutOfBounds = null;
    let coveragePercent = '0';

    // If the boundary is available, clip walksheds to it
    if (boundary) {
      const boundaryAreaSqMeters = turf.area(boundary.features[0]);
      try {
        // Simplify the boundary for faster intersection (tolerance = 0.001 degrees ~= 100m)
        const simplifiedBoundary = turf.simplify(boundary.features[0], { tolerance: 0.001, highQuality: false });

        // Calculate intersection (walkshed area within the area)
        let clipped = null;
        try {
          clipped = turf.intersect(union, simplifiedBoundary);
        } catch (intersectErr) {
          console.error('turf.intersect failed:', intersectErr);
        }

        // Calculate difference (walkshed area outside the area)
        if (withOutside) {
          try {
            mergedPolygonOutOfBounds = turf.difference(union, simplifiedBoundary);
          } catch (diffErr) {
            console.error('Difference operation failed (may be no out-of-bounds area):', diffErr);
          }
        }

        if (clipped) {
          mergedPolygon = clipped;

          // Calculate coverage using the actual boundary area (use original, not simplified)
          const clippedAreaSqMeters = turf.area(clipped);
          coveragePercent = (clippedAreaSqMeters / boundaryAreaSqMeters * 100).toFixed(1);
        } else {
          // No intersection - all walksheds are outside the area
          mergedPolygon = null;
          mergedPolygonOutOfBounds = union;
          coveragePercent = '0';
        }
      } catch (err) {
        // If clipping fails, fall back to unclipped calculation
        console.error('Clipping to the boundary failed, using full walkshed:', err);
        mergedPolygon = union;
        coveragePercent = (turf.area(union) / boundaryAreaSqMeters * 100).toFixed(1);
      }
    } else {
      // No boundary available, use full walkshed (coverage is unknown without an area to divide by)
      mergedPolygon = union;
    }

    return { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent };
  } catch (err) {
    console.error('Error calculating walkshed coverage:', err);
    return { mergedPolygon: null, mergedPolygonOutOfBounds: null, coveragePercent: '0' };
  }
}

/**
 * Merged, clipped walksheds and coverage for each headway, tightest first
 *
 * Tiers are nested, so each headway's walkshed is the tighter headway's walkshed plus only the stops that newly
 * qualify, rather than a fresh merge of every stop. `bestHeadway` maps stop id -> tightest headway it meets (see
 * bestHeadways). With `withRings`, each tier also gets its ring: the part not covered by the tighter tier, so each
 * area can be drawn in exactly one tier's color.
 */
export function computeTiers(turf: any, options: {
  stops: any[];
  bestHeadway: Map<string, number>;
  headways: number[];
  boundary: any;
  walksheds: (stops: any[]) => any[];
  withRings?: boolean;
}) {
  const { stops, bestHeadway, headways, boundary, walksheds, withRings = false } = options;
  let union = null;
  let outOfBounds = null;
  const tiers: { headway: number; stopCount: number; coveragePercent: string; polygon: any; ring: any }[] = [];

  for (const headway of headways) {
    const tierStops = stops.filter(stop => bestHeadway.get(stop.id)! <= headway);
    const newStops = stops.filter(stop => bestHeadway.get(stop.id) === headway);
    if (newStops.length > 0) {
      const merged = mergeWalksheds(turf, walksheds(newStops));
      union = union ? mergeWalksheds(turf, [union, merged]) : merged;
    }

    const { mergedPolygon, mergedPolygonOutOfBounds, coveragePercent } = union
      ? clipToArea(turf, union, boundary, headway === headways[headways.length - 1])
      : { mergedPolygon: null, mergedPolygonOutOfBounds: null, coveragePercent: '0' };
    outOfBounds = mergedPolygonOutOfBounds; // The loosest headway's ends up kept, which contains the others

    // Nearly identical edges (points differing in the 14th decimal place) can make the difference fail, slowly
    // (sometimes only after a stack overflow), so both shapes are rounded to 6 decimal places (~10cm) first.
    const tighter = tiers[tiers.length - 1]?.polygon;
    let ring = mergedPolygon;
    if (withRings && mergedPolygon && tighter) {
      try {
        const round = (shape: any) => turf.truncate(shape, { precision: 6 });
        ring = turf.difference(round(mergedPolygon), round(tighter));
      } catch (err) {
        console.error('Tier ring difference failed, drawing the full tier:', err);
      }
    }

    tiers.push({
      headway,
      stopCount: tierStops.length,
      coveragePercent: parseFloat(coveragePercent) > 100 ? '100+' : coveragePercent,
      polygon: mergedPolygon,
      ring
    });
  }

  return { tiers, outOfBounds };
}

export const POPULATION_GRID_SIZE = 24; // Walkshed is cut into this many cells per side for population served

/**
 * Census blocks in a place (null = all) with people, prepared once with the area and bounding box
 * populationInWalkshed needs
 */
export function prepareCensusBlocks(turf: any, features: any[], place: string | null): any[] {
  return features
    .filter(block => (place === null || block.properties.Place === place) && parseInt(block.properties.TOT_POP || '0') > 0)
    .map(block => ({
      feature: block,
      population: parseInt(block.properties.TOT_POP),
      area: turf.area(block),
      bbox: turf.bbox(block)
    }));
}

/**
 * Population living inside a walkshed, from census blocks prepared by prepareCensusBlocks
 *
 * Partially covered blocks count in proportion to the area covered, which assumes people are spread evenly across
 * each block (an approximation: people cluster in buildings, not parking lots).
 *
 * Intersecting every block with the whole walkshed takes 10-15s, since each intersection scans the walkshed's full
 * outline. Instead the walkshed is cut into a grid of small pieces once, and each block is intersected only with the
 * pieces its bounding box overlaps. Same result in about 1s.
 */
export function populationInWalkshed(turf: any, walkshed: any, blocks: any[]): number {
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
