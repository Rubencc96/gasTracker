/**
 * Data Service for gasTracker
 * Handles station fetching, fuel price extraction, and provincial statistics computation.
 */

export const PROVINCES = {
  '46': {
    id: '46',
    name: 'Valencia',
    center: [39.4699, -0.3763],
    zoom: 10,
  },
};

export const FUEL_TYPES = {
  gasoline_95: {
    id: 'gasoline_95',
    label: 'Gasolina 95',
    shortLabel: 'G95',
    key: 'price_gasoline_95',
    color: '#10b981',
  },
  diesel_a: {
    id: 'diesel_a',
    label: 'Diésel A',
    shortLabel: 'Diésel',
    key: 'price_diesel_a',
    color: '#0284c7',
  },
  gasoline_98: {
    id: 'gasoline_98',
    label: 'Gasolina 98',
    shortLabel: 'G98',
    key: 'price_gasoline_98',
    color: '#8b5cf6',
  },
  diesel_premium: {
    id: 'diesel_premium',
    label: 'Diésel Premium',
    shortLabel: 'D+ Plus',
    key: 'price_diesel_premium',
    color: '#f59e0b',
  },
};

/**
 * Fetch stations dataset from static JSON
 */
export async function loadStationsData() {
  // Bulletproof path resolution for GitHub Pages subpaths and local dev
  const pathname = window.location.pathname;
  const basePath = pathname.endsWith('/')
    ? pathname
    : pathname.includes('.')
      ? pathname.substring(0, pathname.lastIndexOf('/') + 1)
      : pathname + '/';
  const dataUrl = `${window.location.origin}${basePath}data/stations.json`;
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to load stations data: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data;
}

/**
 * Get latest price for a station and fuel type
 */
export function getLatestPrice(station, fuelId) {
  if (!station || !station.data || station.data.length === 0) {
    return null;
  }
  const key = FUEL_TYPES[fuelId]?.key || `price_${fuelId}`;
  const latestEntry = station.data[station.data.length - 1];
  const price = latestEntry ? latestEntry[key] : null;
  return typeof price === 'number' ? price : null;
}

/**
 * Get station stats for a fuel type
 */
export function getStationStats(station, fuelId) {
  if (!station || !station.stats) {
    return { mean: null, trend: null, trendPercent: null };
  }
  const key = FUEL_TYPES[fuelId]?.key || `price_${fuelId}`;
  return {
    mean: station.stats[`mean_${key}`] ?? null,
    trend: station.stats[`trend_${key}`] ?? null,
    trendPercent: station.stats[`trend_percent_${key}`] ?? null,
  };
}

/**
 * Compute aggregate statistics for the entire province for a given fuel type
 */
export function computeProvincialStats(stations, fuelId, provinceId = null) {
  const prices = [];
  let minStation = null;
  let maxStation = null;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let sumTrend = 0;
  let countTrend = 0;
  let minTrend = Infinity;
  let maxTrend = -Infinity;
  let countDrops = 0;
  let countRises = 0;
  let countStable = 0;

  const targetStations = provinceId
    ? stations.filter(st => {
        if (st.province_id) return st.province_id === provinceId;
        if (st.postal_code) return st.postal_code.startsWith(provinceId);
        return true;
      })
    : stations;

  for (const station of targetStations) {
    const price = getLatestPrice(station, fuelId);
    if (price !== null) {
      prices.push(price);

      if (price < minPrice) {
        minPrice = price;
        minStation = station;
      }
      if (price > maxPrice) {
        maxPrice = price;
        maxStation = station;
      }

      const stats = getStationStats(station, fuelId);
      if (typeof stats.trend === 'number') {
        sumTrend += stats.trend;
        countTrend++;
        if (stats.trend < minTrend) minTrend = stats.trend;
        if (stats.trend > maxTrend) maxTrend = stats.trend;

        if (stats.trend < -0.002) countDrops++;
        else if (stats.trend > 0.002) countRises++;
        else countStable++;
      }
    }
  }

  if (prices.length === 0) {
    return {
      count: 0,
      avg: null,
      min: null,
      max: null,
      minStation: null,
      maxStation: null,
      avgTrend: null,
      minTrend: null,
      maxTrend: null,
      countDrops: 0,
      countRises: 0,
      countStable: 0,
      p25: null,
      p75: null,
    };
  }

  prices.sort((a, b) => a - b);
  const sum = prices.reduce((acc, p) => acc + p, 0);
  const avg = Number((sum / prices.length).toFixed(3));
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];
  const avgTrend = countTrend > 0 ? Number((sumTrend / countTrend).toFixed(3)) : 0;

  return {
    count: prices.length,
    avg,
    min: minPrice,
    max: maxPrice,
    minStation,
    maxStation,
    avgTrend,
    minTrend: countTrend > 0 && minTrend !== Infinity ? Number(minTrend.toFixed(3)) : 0,
    maxTrend: countTrend > 0 && maxTrend !== -Infinity ? Number(maxTrend.toFixed(3)) : 0,
    countDrops,
    countRises,
    countStable,
    p25,
    p75,
  };
}
