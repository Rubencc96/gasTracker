/**
 * Main Alpine.js Application Component
 */

import L from 'leaflet';
// Ensure L is globally available for leaflet.markercluster
window.L = L;
import 'leaflet.markercluster';

import {
  FUEL_TYPES,
  PROVINCES,
  loadStationsData,
  getLatestPrice,
  getStationStats,
  computeProvincialStats,
  getContinuousTrendColor,
} from '../services/data.js';
import {
  getSmartRecommendations,
  scoreStations,
  fetchRouteGeoJSON,
  calculateHaversineDistance,
} from '../services/routing.js';
import { renderStationPriceChart } from '../services/chart.js';

export function gasApp() {
  return {
    // State
    loading: true,
    error: null,
    stations: [],
    selectedProvince: '46',
    provinces: PROVINCES,
    displayMode: 'price', // 'price' | 'trend'
    selectedFuel: 'gasoline_95',
    searchQuery: '',
    selectedMunicipality: '',
    filterByVisibleArea: false,
    viewportUpdateCounter: 0,
    municipalities: [],
    sortBy: 'price', // 'price' | 'trend_drop' | 'trend_rise' | 'distance' | 'savings'
    viewMode: 'both', // 'both' | 'map' | 'list'
    mobileTab: 'map', // 'map' | 'list' | 'recommendations'
    activeMobileStation: null,
    preferenceAlpha: 0.5, // 0 = closest, 1 = cheapest
    isPickingLocationOnMap: false,
    provincialStats: {},
    fuelTypes: FUEL_TYPES,

    // Geolocation & Recommendations
    userLocation: {
      lat: null,
      lng: null,
      active: false,
      locating: false,
      address: '',
    },
    recommendations: {
      loading: false,
      top3: [],
      allClosest: [],
      rawCandidates: [],
    },

    // Modal & Route
    selectedStation: null,
    activeRouteInfo: null,
    toast: {
      show: false,
      message: '',
      type: 'info',
      timeout: null,
    },

    // Leaflet map references
    map: null,
    clusterGroup: null,
    routeLayer: null,
    userMarker: null,
    stationMarkersMap: new Map(),

    /**
     * Initialization lifecycle
     */
    async init() {
      try {
        this.loading = true;
        this.stations = await loadStationsData();

        // Extract distinct municipalities for selected province
        this.updateMunicipalities();

        // Calculate provincial stats for default fuel
        this.updateProvincialStats();

        // Initialize map & reactive watchers
        this.$nextTick(() => {
          this.initMap();
          this.renderMarkers();
          this.setupWatchers();
          this.loading = false;
          // Proactively request user location on startup
          this.requestInitialLocation();
        });
      } catch (err) {
        console.error('Failed to initialize gas tracker:', err);
        this.error = 'No se pudieron cargar los datos de las gasolineras. Comprueba la conexión o inténtalo más tarde.';
        this.loading = false;
      }
    },

    /**
     * Update distinct municipalities list based on current province
     */
    updateMunicipalities() {
      const munis = new Set();
      const provPrefix = this.selectedProvince;
      for (const st of this.stations) {
        if (provPrefix && st.postal_code && !st.postal_code.startsWith(provPrefix)) continue;
        if (st.municipality) munis.add(st.municipality);
      }
      this.municipalities = Array.from(munis).sort((a, b) => a.localeCompare(b, 'es'));
    },

    /**
     * Setup Alpine watchers for reactive filtering
     */
    setupWatchers() {
      this.$watch('searchQuery', () => {
        this.renderMarkers();
      });

      this.$watch('selectedProvince', (newProv) => {
        this.selectedMunicipality = '';
        this.updateMunicipalities();
        this.updateProvincialStats();
        this.renderMarkers();
        const prov = this.provinces[newProv];
        if (prov && this.map) {
          this.map.flyTo(prov.center, prov.zoom, { duration: 0.8 });
        }
      });

      this.$watch('selectedMunicipality', (val) => {
        this.renderMarkers();
        if (val) {
          this.focusMunicipality(val);
        }
      });

      this.$watch('displayMode', () => {
        this.renderMarkers();
      });

      this.$watch('sortBy', () => {
        this.renderMarkers();
      });

      this.$watch('filterByVisibleArea', () => {
        this.renderMarkers();
      });

      this.$watch('preferenceAlpha', () => {
        this.recalculateOptimization();
      });

      // Handle window resize
      window.addEventListener('resize', () => {
        if (this.map) {
          this.map.invalidateSize();
        }
      });
    },

    /**
     * Switch between 'price' and 'trend' visualization modes
     */
    setDisplayMode(mode) {
      if (this.displayMode === mode) return;
      this.displayMode = mode;
      if (mode === 'trend' && this.sortBy === 'price') {
        this.sortBy = 'trend_drop';
      } else if (mode === 'price' && (this.sortBy === 'trend_drop' || this.sortBy === 'trend_rise')) {
        this.sortBy = 'price';
      }
      this.renderMarkers();
    },

    /**
     * Initialize Leaflet map with cluster support
     */
    initMap() {
      const mapContainer = document.getElementById('map');
      if (!mapContainer || this.map) return;

      const prov = this.provinces[this.selectedProvince] || this.provinces['46'];

      // Province center coordinates
      this.map = L.map('map', {
        zoomControl: false,
        attributionControl: true,
      }).setView(prov.center, prov.zoom);

      // Add zoom control in top-right
      L.control.zoom({ position: 'topright' }).addTo(this.map);

      // CartoDB Positron light layer (uses API key in production to remove watermark without failing in local dev)
      const cartoKey = import.meta.env.PROD ? import.meta.env.VITE_CARTO_API_KEY : null;
      const tileUrl = cartoKey
        ? `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${cartoKey}`
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

      L.tileLayer(tileUrl, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(this.map);

      // Initialize Cluster Group with custom price/trend-aware badge
      this.clusterGroup = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 40, // Clustered tightly so nearby stations merge cleanly
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: true,
        iconCreateFunction: (cluster) => {
          const markers = cluster.getAllChildMarkers();
          const count = cluster.getChildCount();

          if (this.displayMode === 'trend') {
            const trends = markers
              .map(m => m.__stationTrend)
              .filter(t => typeof t === 'number');

            const hasTrends = trends.length > 0;
            const avgTrend = hasTrends ? trends.reduce((acc, t) => acc + t, 0) / trends.length : 0;
            const clusterColor = this.getContinuousTrendColor(hasTrends ? avgTrend : null);

            const sign = avgTrend > 0.0005 ? '↑ +' : avgTrend < -0.0005 ? '↓ ' : '= ';
            const trendLabel = hasTrends ? `${sign}${Math.abs(avgTrend).toFixed(3)}€` : `${count} gasolineras`;

            return L.divIcon({
              html: `
                <div class="price-cluster-badge continuous-trend" style="--cluster-color: ${clusterColor};">
                  <span>${trendLabel}</span>
                  <span class="cluster-count-pill">${count}</span>
                </div>
              `,
              className: 'custom-cluster-marker-wrapper',
              iconSize: [110, 28],
              iconAnchor: [55, 14],
            });
          }

          // Price mode
          const prices = markers
            .map(m => m.__stationPrice)
            .filter(p => typeof p === 'number');

          const minPrice = prices.length > 0 ? Math.min(...prices) : null;

          let tierClass = 'tier-mid';
          if (minPrice !== null && this.provincialStats.p25 && minPrice <= this.provincialStats.p25) {
            tierClass = 'tier-low';
          } else if (minPrice !== null && this.provincialStats.min && minPrice <= this.provincialStats.min + 0.005) {
            tierClass = 'tier-cheapest';
          } else if (minPrice !== null && this.provincialStats.p75 && minPrice >= this.provincialStats.p75) {
            tierClass = 'tier-high';
          }

          const priceLabel = minPrice !== null ? `desde ${minPrice.toFixed(3)}€` : `${count} gasolineras`;

          return L.divIcon({
            html: `
              <div class="price-cluster-badge ${tierClass}">
                <span>${priceLabel}</span>
                <span class="cluster-count-pill">${count}</span>
              </div>
            `,
            className: 'custom-cluster-marker-wrapper',
            iconSize: [110, 28],
            iconAnchor: [55, 14],
          });
        },
      });

      this.map.addLayer(this.clusterGroup);
      this.routeLayer = L.layerGroup().addTo(this.map);

      // Listen to map move and zoom events to update visible stations if filter is active
      this.map.on('moveend zoomend', () => {
        if (this.filterByVisibleArea) {
          this.viewportUpdateCounter++;
          this.renderMarkers();
        }
      });

      // Map click handler to set user location if user activates "pick location" mode
      this.map.on('click', (e) => {
        if (this.isPickingLocationOnMap) {
          this.setUserLocation(e.latlng.lat, e.latlng.lng, 'Punto fijado en el mapa');
          this.isPickingLocationOnMap = false;
          this.showToast('Ubicación fijada en el mapa.', 'success');
        }
      });

      // Invalidate size once map container has fully settled in layout
      setTimeout(() => {
        this.map.invalidateSize();
      }, 200);
    },

    /**
     * Helper to show a transient notification
     */
    showToast(message, type = 'info') {
      if (this.toast.timeout) clearTimeout(this.toast.timeout);
      this.toast.message = message;
      this.toast.type = type;
      this.toast.show = true;
      this.toast.timeout = setTimeout(() => {
        this.toast.show = false;
      }, 4000);
    },

    /**
     * Update provincial summary stats
     */
    updateProvincialStats() {
      this.provincialStats = computeProvincialStats(this.stations, this.selectedFuel, this.selectedProvince);
    },

    /**
     * Switch fuel type
     */
    async setFuel(fuelId) {
      if (this.selectedFuel === fuelId) return;
      this.selectedFuel = fuelId;
      this.updateProvincialStats();
      this.renderMarkers();

      // Recalculate smart recommendations if user is located
      if (this.userLocation.active) {
        await this.computeRecommendations();
      }

      // Re-render D3 chart if modal is currently open
      if (this.selectedStation) {
        this.$nextTick(() => {
          renderStationPriceChart(
            document.getElementById('station-history-chart'),
            this.selectedStation,
            this.selectedFuel
          );
        });
      }
    },

    /**
     * Get filtered and sorted stations list
     */
    get filteredStations() {
      // Reference counter to trigger reactivity when map moves if filterByVisibleArea is active
      if (this.filterByVisibleArea) {
        void this.viewportUpdateCounter;
      }

      const q = this.searchQuery.trim().toLowerCase();
      const provPrefix = this.selectedProvince;
      const muni = this.selectedMunicipality;
      const fuelId = this.selectedFuel;
      const bounds = (this.filterByVisibleArea && this.map) ? this.map.getBounds() : null;

      let list = this.stations.filter(st => {
        const price = getLatestPrice(st, fuelId);
        if (price === null) return false;

        // Filter by province if set
        if (provPrefix) {
          if (st.province_id && st.province_id !== provPrefix) return false;
          if (st.postal_code && !st.postal_code.startsWith(provPrefix)) return false;
        }

        if (muni && st.municipality !== muni) return false;

        if (q) {
          const matchName = st.name?.toLowerCase().includes(q);
          const matchAddr = st.address?.toLowerCase().includes(q);
          const matchLoc = st.locality?.toLowerCase().includes(q);
          const matchMuni = st.municipality?.toLowerCase().includes(q);
          if (!matchName && !matchAddr && !matchLoc && !matchMuni) return false;
        }

        if (bounds) {
          if (!bounds.contains([st.latitude, st.longitude])) {
            return false;
          }
        }

        return true;
      });

      // Calculate distance if user location is known
      if (this.userLocation.active) {
        list = list.map(st => ({
          ...st,
          userDistanceKm: calculateHaversineDistance(
            this.userLocation.lat,
            this.userLocation.lng,
            st.latitude,
            st.longitude
          ),
        }));
      }

      // Sorting
      if (this.sortBy === 'price') {
        list.sort((a, b) => getLatestPrice(a, fuelId) - getLatestPrice(b, fuelId));
      } else if (this.sortBy === 'trend_drop') {
        list.sort((a, b) => {
          const trA = getStationStats(a, fuelId).trend ?? 999;
          const trB = getStationStats(b, fuelId).trend ?? 999;
          return trA - trB; // smallest trend first (biggest drop, e.g. -0.050 before -0.010)
        });
      } else if (this.sortBy === 'trend_rise') {
        list.sort((a, b) => {
          const trA = getStationStats(a, fuelId).trend ?? -999;
          const trB = getStationStats(b, fuelId).trend ?? -999;
          return trB - trA; // largest trend first (biggest increase, e.g. +0.050 before +0.010)
        });
      } else if (this.sortBy === 'distance' && this.userLocation.active) {
        list.sort((a, b) => (a.userDistanceKm || 0) - (b.userDistanceKm || 0));
      } else if (this.sortBy === 'savings' && this.recommendations.allClosest.length > 0) {
        const scoreMap = new Map(this.recommendations.allClosest.map(c => [c.station.id, c.netScore]));
        list.sort((a, b) => (scoreMap.get(b.id) ?? -999) - (scoreMap.get(a.id) ?? -999));
      } else {
        list.sort((a, b) => getLatestPrice(a, fuelId) - getLatestPrice(b, fuelId));
      }

      return list;
    },

    /**
     * Render Leaflet map markers with clustering and dynamic readjustment
     */
    renderMarkers() {
      if (!this.map || !this.clusterGroup) return;

      this.clusterGroup.clearLayers();
      this.stationMarkersMap.clear();

      const fuelId = this.selectedFuel;
      const stats = this.provincialStats;
      const recommendedIds = new Set(this.recommendations.top3.map(r => r.station.id));

      const visibleStations = this.filteredStations;
      const markersToAdd = [];

      for (const st of visibleStations) {
        const price = getLatestPrice(st, fuelId);
        if (price === null) continue;

        const stStats = getStationStats(st, fuelId);
        const isRecommended = recommendedIds.has(st.id);

        let tierClass = 'tier-mid';
        let pinStyle = '';
        let badgeLabel = '';

        if (this.displayMode === 'trend') {
          const trend = stStats.trend;
          tierClass = 'continuous-trend';
          if (trend === null) {
            pinStyle = 'style="--pin-color: #64748b;"';
            badgeLabel = '—';
          } else {
            const trendColor = this.getContinuousTrendColor(trend);
            pinStyle = `style="--pin-color: ${trendColor};"`;
            const sign = trend < -0.0005 ? '↓ ' : trend > 0.0005 ? '↑ +' : '= ';
            badgeLabel = `${sign}${Math.abs(trend).toFixed(3)}€`;
          }
        } else {
          // Price mode
          if (isRecommended) {
            tierClass = 'tier-recommended';
          } else if (stats.min && price <= stats.min + 0.005) {
            tierClass = 'tier-cheapest';
          } else if (stats.p25 && price <= stats.p25) {
            tierClass = 'tier-low';
          } else if (stats.p75 && price >= stats.p75) {
            tierClass = 'tier-high';
          }
          badgeLabel = `${isRecommended ? '★ ' : ''}${price.toFixed(3)}€`;
        }

        const titleText = this.displayMode === 'trend'
          ? `${st.name}: ${stStats.trend != null ? (stStats.trend > 0 ? '+' : '') + stStats.trend.toFixed(3) + ' €/L (7d)' : 'Sin histórico 7d'}`
          : `${st.name}: ${price.toFixed(3)} €/L`;

        const iconHtml = `
          <div class="price-marker-pin ${tierClass}" ${pinStyle} title="${titleText}">
            ${badgeLabel}
          </div>
        `;

        const customIcon = L.divIcon({
          className: 'custom-price-marker-wrapper',
          html: iconHtml,
          iconSize: [72, 24],
          iconAnchor: [36, 28],
          popupAnchor: [0, -28],
        });

        const marker = L.marker([st.latitude, st.longitude], { icon: customIcon });
        marker.__stationPrice = price;
        marker.__stationTrend = stStats.trend;
        marker.__stationId = st.id;

        const trendColor = this.getContinuousTrendColor(stStats.trend);
        const trendBadge = stStats.trend !== null
          ? `<span class="inline-flex items-center text-xs font-bold px-2 py-0.5 rounded-full text-white shadow-xs" style="background-color: ${trendColor};">
              ${stStats.trend < -0.0005 ? '↓' : stStats.trend > 0.0005 ? '↑' : '='} ${Math.abs(stStats.trend).toFixed(3)}€ (${stStats.trendPercent > 0 ? '+' : ''}${stStats.trendPercent}%)
            </span>`
          : '';

        const popupHtml = `
          <div class="p-3 max-w-xs font-sans text-slate-800">
            <div class="flex items-start justify-between gap-2 mb-1">
              <h4 class="font-bold text-sm text-slate-900 leading-tight">${st.name}</h4>
              <span class="text-xs font-extrabold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                ${price.toFixed(3)} €/L
              </span>
            </div>
            <p class="text-xs text-slate-500 mb-1.5">${st.address}, ${st.municipality}</p>
            ${st.schedule ? `<p class="text-[11px] text-slate-400 mb-2">🕒 ${st.schedule}</p>` : ''}
            <div class="flex items-center justify-between pt-2 border-t border-slate-100 mt-2">
              ${trendBadge}
              <button
                onclick="window.__gasTrackerApp.openStationModalById('${st.id}')"
                class="text-xs font-semibold text-emerald-600 hover:text-emerald-700 hover:underline inline-flex items-center gap-1"
              >
                Ver historial →
              </button>
            </div>
          </div>
        `;

        marker.bindPopup(popupHtml);
        marker.on('click', () => {
          this.activeMobileStation = st;
        });
        markersToAdd.push(marker);
        this.stationMarkersMap.set(st.id, marker);
      }

      this.clusterGroup.addLayers(markersToAdd);
    },

    /**
     * Switch mobile navigation tab and handle map invalidation
     */
    setMobileTab(tab) {
      this.mobileTab = tab;
      if (tab === 'map') {
        this.$nextTick(() => {
          if (this.map) {
            this.map.invalidateSize();
          }
        });
      }
    },

    closeMobileStation() {
      this.activeMobileStation = null;
    },

    /**
     * Focus station on map and smoothly uncluster if needed
     */
    focusStation(station) {
      if (!this.map || !station) return;
      this.activeMobileStation = station;
      const marker = this.stationMarkersMap.get(station.id);

      if (window.innerWidth < 768) {
        this.mobileTab = 'map';
        this.$nextTick(() => {
          if (this.map) this.map.invalidateSize();
        });
      }

      if (marker && this.clusterGroup) {
        this.clusterGroup.zoomToShowLayer(marker, () => {
          marker.openPopup();
        });
      } else {
        this.map.flyTo([station.latitude, station.longitude], 15, { duration: 1.0 });
      }
    },

    /**
     * Focus map on selected municipality bounds
     */
    focusMunicipality(muniName) {
      if (!this.map || !muniName) return;
      const muniStations = this.stations.filter(s => s.municipality === muniName);
      if (muniStations.length === 0) return;

      const group = L.featureGroup(
        muniStations.map(s => L.marker([s.latitude, s.longitude]))
      );
      this.map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 14 });
    },

    /**
     * Proactive initial geolocation request on startup
     * Silently falls back to province center without warning toasts if denied
     */
    requestInitialLocation() {
      if (!('geolocation' in navigator)) {
        this.fallbackToProvinceCenter();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          this.setUserLocation(lat, lng, 'Tu ubicación actual');
        },
        error => {
          // Silent fallback on initial load if user denies or fails
          console.log('Initial location not granted, using province center silently:', error.message);
          this.fallbackToProvinceCenter();
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    },

    /**
     * Center map silently on current selected province center
     */
    fallbackToProvinceCenter() {
      const prov = this.provinces[this.selectedProvince] || this.provinces['46'];
      if (this.map && prov) {
        this.map.flyTo(prov.center, prov.zoom, { duration: 0.8 });
      }
    },

    /**
     * Manual User Geolocation trigger
     */
    locateUser() {
      if (!('geolocation' in navigator)) {
        this.showToast('Tu navegador no soporta geolocalización.', 'warning');
        this.fallbackToProvinceCenter();
        return;
      }

      this.userLocation.locating = true;
      this.showToast('Obteniendo tu ubicación actual...', 'info');

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          this.userLocation.locating = false;
          this.setUserLocation(lat, lng, 'Tu ubicación actual');
          this.showToast('Ubicación obtenida correctamente.', 'success');
        },
        error => {
          console.warn('Geolocation error:', error);
          this.userLocation.locating = false;
          let msg = 'No se pudo obtener la ubicación GPS (permiso no concedido o tiempo agotado).';
          if (error.code === error.TIMEOUT) msg = 'Tiempo de espera agotado al obtener GPS.';
          this.showToast(msg, 'warning');
          this.fallbackToProvinceCenter();
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    },

    togglePickLocationOnMap() {
      this.isPickingLocationOnMap = !this.isPickingLocationOnMap;
      if (this.isPickingLocationOnMap) {
        this.setMobileTab('map');
        this.showToast('Toca cualquier punto del mapa para fijar tu ubicación.', 'info');
      }
    },

    getPreferenceLabel() {
      const a = parseFloat(this.preferenceAlpha);
      if (a <= 0.15) return 'Prioridad: Muy cercana (recorrer lo mínimo)';
      if (a <= 0.40) return 'Prioridad: Cercana con buen precio';
      if (a <= 0.60) return 'Equilibrado: Compromiso distancia / ahorro';
      if (a <= 0.85) return 'Prioridad: Precio económico';
      return 'Prioridad: Máximo ahorro (la más barata)';
    },

    recalculateOptimization() {
      if (!this.recommendations.rawCandidates || this.recommendations.rawCandidates.length === 0) return;
      const scored = scoreStations(this.recommendations.rawCandidates, parseFloat(this.preferenceAlpha));
      this.recommendations.top3 = scored.slice(0, 3);
      this.recommendations.allClosest = scored;
      this.renderMarkers();
    },

    /**
     * Apply user location to state and map
     */
    async setUserLocation(lat, lng, label = '') {
      this.userLocation.lat = lat;
      this.userLocation.lng = lng;
      this.userLocation.active = true;
      this.userLocation.address = label;

      // Update or create user marker
      if (this.userMarker) {
        this.map.removeLayer(this.userMarker);
      }

      const userIcon = L.divIcon({
        className: 'user-location-marker-wrapper',
        html: `
          <div class="user-location-marker">
            <div class="user-location-pulse"></div>
            <div class="user-location-dot"></div>
          </div>
        `,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      this.userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(this.map);
      this.userMarker.bindPopup(`<div class="p-2 font-sans text-xs font-semibold text-slate-800">📍 ${label}</div>`);

      // Fly to user location
      this.map.flyTo([lat, lng], 13, { duration: 1.2 });

      // Calculate recommendations
      await this.computeRecommendations();
    },

    /**
     * Execute smart recommendation pipeline
     */
    async computeRecommendations() {
      if (!this.userLocation.active) return;

      this.recommendations.loading = true;
      try {
        const result = await getSmartRecommendations(
          this.stations,
          this.userLocation.lat,
          this.userLocation.lng,
          this.selectedFuel,
          parseFloat(this.preferenceAlpha)
        );

        this.recommendations.top3 = result.top3 || [];
        this.recommendations.allClosest = result.allClosest || [];
        this.recommendations.rawCandidates = result.rawCandidates || [];

        // Refresh markers to reflect recommendation badges
        this.renderMarkers();
      } catch (err) {
        console.error('Error computing recommendations:', err);
      } finally {
        this.recommendations.loading = false;
      }
    },

    /**
     * Trace driving route from user location to a destination station
     */
    async traceRoute(station) {
      if (!this.userLocation.active) {
        this.showToast('Activa tu ubicación primero para trazar una ruta.', 'info');
        this.locateUser();
        return;
      }

      this.showToast('Calculando ruta en carretera...', 'info');
      const routeData = await fetchRouteGeoJSON(
        this.userLocation.lat,
        this.userLocation.lng,
        station.latitude,
        station.longitude
      );

      if (!routeData) {
        this.showToast('No se pudo calcular la ruta en carretera.', 'warning');
        return;
      }

      this.routeLayer.clearLayers();

      const polyline = L.geoJSON(routeData.geojson, {
        style: {
          color: '#4f46e5',
          weight: 5,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round',
        },
      }).addTo(this.routeLayer);

      this.activeRouteInfo = {
        station,
        distanceKm: routeData.distanceKm,
        durationMin: routeData.durationMin,
      };

      this.map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
      this.showToast(`Ruta: ${routeData.distanceKm} km (~${routeData.durationMin} min)`, 'success');

      if (window.innerWidth < 768) {
        this.viewMode = 'map';
      }
    },

    /**
     * Clear current route
     */
    clearRoute() {
      if (this.routeLayer) {
        this.routeLayer.clearLayers();
      }
      this.activeRouteInfo = null;
    },

    /**
     * Open station detail modal and render D3 chart
     */
    openStationModal(station) {
      this.selectedStation = station;
      this.$nextTick(() => {
        const container = document.getElementById('station-history-chart');
        if (container) {
          renderStationPriceChart(container, station, this.selectedFuel);
        }
      });
    },

    openStationModalById(stationId) {
      const st = this.stations.find(s => s.id === stationId);
      if (st) this.openStationModal(st);
    },

    closeStationModal() {
      this.selectedStation = null;
    },

    /**
     * Reset map view to full selected province
     */
    resetMapZoom() {
      this.fallbackToProvinceCenter();
    },

    // Helpers for templates
    getPrice(station) {
      return getLatestPrice(station, this.selectedFuel);
    },

    getStats(station) {
      return getStationStats(station, this.selectedFuel);
    },

    formatCurrency(val) {
      return typeof val === 'number' ? `${val.toFixed(3)} €` : '—';
    },

    getContinuousTrendColor(trend) {
      const maxBound = Math.max(
        0.03,
        Math.abs(this.provincialStats?.minTrend || 0),
        Math.abs(this.provincialStats?.maxTrend || 0)
      );
      return getContinuousTrendColor(trend, maxBound);
    },
  };
}
