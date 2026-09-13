/**
 * Smart Routing and Station Optimization Service
 * 
 * Implements client-side 2-step routing optimization:
 * 1. Straight-line (Haversine) filtering of top 15 closest stations.
 * 2. OSRM driving distance and duration query (with fallback).
 * 3. Custom economic scoring (Fuel savings vs. Driving consumption & time penalty).
 */

import { getLatestPrice } from './data.js';

const OSRM_TABLE_URL = 'https://router.project-osrm.org/table/v1/driving';
const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving';

/**
 * Calculates straight-line distance between two coordinates in kilometers (Haversine formula).
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Filter stations by fuel availability and return the top N closest by straight line distance.
 */
export function getTopClosestStations(stations, userLat, userLon, fuelId, limit = 15) {
  const valid = [];

  for (const st of stations) {
    const price = getLatestPrice(st, fuelId);
    if (price !== null && typeof st.latitude === 'number' && typeof st.longitude === 'number') {
      const haversineKm = calculateHaversineDistance(userLat, userLon, st.latitude, st.longitude);
      valid.push({
        station: st,
        price,
        haversineKm: Number(haversineKm.toFixed(2)),
      });
    }
  }

  valid.sort((a, b) => a.haversineKm - b.haversineKm);
  return valid.slice(0, limit);
}

/**
 * Query OSRM Table service for real driving distances and durations.
 * Falls back to estimated values if OSRM is unreachable or errors.
 */
export async function fetchDrivingMatrix(userLat, userLon, stationCandidates) {
  if (stationCandidates.length === 0) return [];

  // Construct coordinates query: source (user) is index 0
  const coords = [
    `${userLon.toFixed(6)},${userLat.toFixed(6)}`,
    ...stationCandidates.map(c => `${c.station.longitude.toFixed(6)},${c.station.latitude.toFixed(6)}`)
  ].join(';');

  const url = `${OSRM_TABLE_URL}/${coords}?sources=0&annotations=duration,distance`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`OSRM request failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.code === 'Ok' && data.distances && data.durations) {
      const distances = data.distances[0].slice(1); // skip source 0
      const durations = data.durations[0].slice(1);

      return stationCandidates.map((candidate, idx) => {
        const rawDist = distances[idx]; // in meters
        const rawDur = durations[idx]; // in seconds

        const drivingDistKm = rawDist != null ? Number((rawDist / 1000).toFixed(2)) : Number((candidate.haversineKm * 1.35).toFixed(2));
        const drivingTimeMin = rawDur != null ? Math.round(rawDur / 60) : Math.round((drivingDistKm / 42) * 60);

        return {
          ...candidate,
          drivingDistKm,
          drivingTimeMin: Math.max(1, drivingTimeMin),
          isEstimate: rawDist == null,
        };
      });
    }
  } catch (err) {
    console.warn('OSRM matrix fetch failed, falling back to realistic road estimates:', err.message);
  }

  // Graceful fallback: 1.35 winding factor, 42 km/h average driving speed
  return stationCandidates.map(candidate => {
    const estKm = Number((candidate.haversineKm * 1.35).toFixed(2));
    const estMin = Math.max(1, Math.round((estKm / 42) * 60));
    return {
      ...candidate,
      drivingDistKm: estKm,
      drivingTimeMin: estMin,
      isEstimate: true,
    };
  });
}

/**
 * Score stations based on multi-objective optimization problem:
 * balances proximity (minimizing distance) vs. economy (minimizing fuel price).
 * 
 * @param {Array} candidatesWithDriving - Station candidates with driving distances & times.
 * @param {number} preferenceAlpha - Value in [0, 1]:
 *   - 0.0: 100% Proximity (closest station regardless of price)
 *   - 0.5: Balanced trade-off (best distance vs savings ratio)
 *   - 1.0: 100% Price (cheapest station regardless of distance within candidate pool)
 * @param {number} tankLiters - Standard tank volume (default: 50L)
 */
export function scoreStations(candidatesWithDriving, preferenceAlpha = 0.5, tankLiters = 50) {
  if (candidatesWithDriving.length === 0) return [];

  const prices = candidatesWithDriving.map(c => c.price);
  const distances = candidatesWithDriving.map(c => c.drivingDistKm);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDist = Math.min(...distances);
  const maxDist = Math.max(...distances);

  const avgPrice = prices.reduce((acc, p) => acc + p, 0) / prices.length;
  const alpha = Math.max(0, Math.min(1, preferenceAlpha));

  const scored = candidatesWithDriving.map(c => {
    // Normalized Proximity Score [0, 1] (1 = closest, 0 = farthest)
    const distScore = maxDist === minDist ? 1 : (maxDist - c.drivingDistKm) / (maxDist - minDist);

    // Normalized Price Score [0, 1] (1 = cheapest, 0 = most expensive)
    const priceScore = maxPrice === minPrice ? 1 : (maxPrice - c.price) / (maxPrice - minPrice);

    // Composite Optimization Score: U(alpha) = (1 - alpha)*distScore + alpha*priceScore
    const compositeScore = Number(((1 - alpha) * distScore + alpha * priceScore).toFixed(4));

    // Economic metrics (savings vs closest station and average)
    const extraDistKm = Number(Math.max(0, c.drivingDistKm - minDist).toFixed(2));
    const priceDiffPerLiter = Number((avgPrice - c.price).toFixed(3));
    const grossSavings = Number(((avgPrice - c.price) * tankLiters).toFixed(2));
    const roundTripKm = c.drivingDistKm * 2;
    const drivingFuelCost = Number((roundTripKm * (7.0 / 100) * c.price).toFixed(2));
    const roundTripTimeMin = c.drivingTimeMin * 2;
    const timePenalty = Number(((roundTripTimeMin / 60) * 6.00).toFixed(2));
    const netSavings = Number((grossSavings - drivingFuelCost - timePenalty).toFixed(2));

    return {
      ...c,
      distScore: Number(distScore.toFixed(3)),
      priceScore: Number(priceScore.toFixed(3)),
      compositeScore,
      extraDistKm,
      priceDiffPerLiter,
      grossSavings,
      drivingFuelCost,
      timePenalty,
      netSavings,
      netScore: compositeScore, // for uniform ranking
    };
  });

  // Sort by compositeScore descending, breaking ties with price then distance
  scored.sort((a, b) => b.compositeScore - a.compositeScore || a.price - b.price || a.drivingDistKm - b.drivingDistKm);

  return scored;
}

/**
 * Run complete smart recommendations workflow:
 * Returns the top 3 optimal stations for the user given preferenceAlpha.
 */
export async function getSmartRecommendations(stations, userLat, userLon, fuelId, preferenceAlpha = 0.5) {
  // Step 1: Filter top 20 closest by straight-line Haversine (reasonable driving radius)
  const candidates = getTopClosestStations(stations, userLat, userLon, fuelId, 20);
  if (candidates.length === 0) return [];

  // Step 2: Query driving distance and duration from OSRM
  const withDriving = await fetchDrivingMatrix(userLat, userLon, candidates);

  // Step 3: Compute optimization scores with user slider
  const scored = scoreStations(withDriving, preferenceAlpha);

  // Return top 3 highlighted stations, plus all scored candidates for instant slider updates
  return {
    top3: scored.slice(0, 3),
    allClosest: scored,
    rawCandidates: withDriving, // cached for zero-latency slider recalculation
  };
}

/**
 * Fetch driving route geometry (GeoJSON) between user and destination from OSRM
 */
export async function fetchRouteGeoJSON(userLat, userLon, destLat, destLon) {
  const url = `${OSRM_ROUTE_URL}/${userLon.toFixed(6)},${userLat.toFixed(6)};${destLon.toFixed(6)},${destLat.toFixed(6)}?overview=full&geometries=geojson`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    const data = await response.json();

    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
      return {
        geojson: data.routes[0].geometry,
        distanceKm: Number((data.routes[0].distance / 1000).toFixed(2)),
        durationMin: Math.round(data.routes[0].duration / 60),
      };
    }
  } catch (err) {
    console.warn('Failed to fetch route geometry:', err.message);
  }
  return null;
}
