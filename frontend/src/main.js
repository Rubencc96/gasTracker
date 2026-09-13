import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './style.css';

import Alpine from 'alpinejs';
import { gasApp } from './components/app.js';

// Register Alpine component
Alpine.data('gasApp', gasApp);

// Mount Alpine to window
window.Alpine = Alpine;
Alpine.start();
