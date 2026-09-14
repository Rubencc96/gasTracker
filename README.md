# gasTracker ⛽️

Un rastreador de precios de combustible (gasolina y diésel) de código abierto para estaciones de servicio (inicialmente enfocado en la provincia de Valencia y preparado para ser extensible a múltiples provincias de España). Utiliza una arquitectura **Git-Scraping** con backend en Python, frontend modular y ligero (Vite, Alpine.js, Leaflet, D3.js, Tailwind CSS), y despliegue continuo en **GitHub Pages**.

Este proyecto ha sido un intento de probar el nuevo mundo del *vibe coding* con una aplicación que pueda resultar útil.

---

## 🌟 Características Principales

1. **Pipeline de Datos Automatizado (Python)**:
   - Consulta diaria al endpoint oficial del Ministerio para la Transición Ecológica (MITECO).
   - Limpieza, sanitización y validación de precios (rango 0.50 €/L - 3.50 €/L) y coordenadas geográficas.
   - Historial rodante por estación de **7 días naturales** (`RETENTION_DAYS = 7`).
   - Cálculo por gasolinera y tipo de combustible de:
     - Precio medio (`mean_price_*`)
     - Tendencia absoluta (`trend_price_* = latest - oldest`)
     - Tendencia porcentual (`trend_percent_price_*`)
   - Exportación de un único archivo estático consolidado: `frontend/public/data/stations.json`.

2. **Frontend Moderno e Interactivo**:
   - **Pila tecnológica**: Vite + Alpine.js + Tailwind CSS + Leaflet + D3.js.
   - **Diseño Light Mode First**: Inspirado en interfaces limpias, modernas y adaptadas a móviles y escritorio.
   - **Mapa Interactivo**: Capa CartoDB Positron, marcadores HTML con badge de precio colorizado según cuartiles provinciales (`<25%` más barato, promedio, `>75%` más caro).
   - **Gráficos D3.js**: Evolución histórica de precios de los últimos 7 días con curvas suaves, gradientes y tooltips interactivos.
   - **Filtros dinámicos**: Selector de provincia (preparado para multi-provincia), selector de municipio filtrado dinámicamente, selección de combustible (Gasolina 95, Diésel A, Gasolina 98, Diésel Premium) y búsqueda por marca o calle.

3. **Algoritmo de Enrutamiento Inteligente y Optimización Multiobjetivo**:
   - Petición proactiva de geolocalización nativa mediante la API HTML5 (con soporte HTTPS en GitHub Pages, fijación manual de chincheta en el mapa 🎯 y centrado silencioso en la provincia seleccionada si no se concede permiso).
   - **Control deslizante interactivo ($\alpha \in [0, 1]$)**:
     - $\alpha = 0$: Prioriza 100% la gasolinera más cercana (mínimos km a recorrer).
     - $\alpha = 1$: Prioriza 100% la gasolinera más económica dentro del radio operativo razonable.
     - $0 < \alpha < 1$: Compromiso ponderado de utilidad:
       $$U_i(\alpha) = (1 - \alpha) \cdot S_{\text{distancia}}(i) + \alpha \cdot S_{\text{precio}}(i)$$
   - Consulta a la API de **OSRM (Open Source Routing Machine)** para obtener la **distancia de conducción real en carretera y tiempo estimado**.
   - Destaca el **Top 3 de Gasolineras Óptimas**, muestra los km adicionales a recorrer respecto a la más cercana, el ahorro neto estimado para un depósito y permite trazar la ruta en el mapa en tiempo real.

4. **Diseño Mobile-First**:
   - Pestañas inferiores de navegación en móviles (Mapa, Lista, Top Ahorro).
   - Tarjetas flotantes y botones táctiles optimizados para su uso con una mano.

5. **Automatización y Despliegue Continuo (CI/CD)**:
   - Flujo de GitHub Actions en `.github/workflows/daily-scraper.yml` y `.github/workflows/deploy.yml`.
   - Programado diariamente a las **06:25 UTC** (08:25 hora peninsular tras la actualización matutina de MITECO) y en cada `push`.
   - Ejecuta el scraper, commitea los cambios en `stations.json` si hay nuevos datos, compila el frontend con Vite y despliega automáticamente a **GitHub Pages**.

---

## 📁 Estructura del Proyecto

```text
gasTracker/
├── .github/
│   └── workflows/
│       └── deploy.yml            # Pipeline de scraping y despliegue a GH Pages
├── backend/
│   ├── __init__.py
│   └── updater.py                # Pipeline de extracción, limpieza y estadísticas
├── frontend/
│   ├── public/
│   │   └── data/
│   │       └── stations.json     # Datos consolidados de gasolineras e histórico
│   ├── src/
│   │   ├── components/
│   │   │   └── app.js            # Componente Alpine.js (estado, mapa, interacción)
│   │   ├── services/
│   │   │   ├── chart.js          # Gráficos D3.js para el histórico de 7 días
│   │   │   ├── data.js           # Servicios de carga y estadísticas provinciales
│   │   │   └── routing.js        # Haversine, OSRM y algoritmo de recomendación
│   │   ├── main.js               # Entrada principal de JavaScript
│   │   └── style.css             # Tailwind CSS y estilos de marcadores Leaflet
│   ├── index.html                # Interfaz principal de usuario
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   └── vite.config.js
├── tests/
│   └── test_updater.py           # Pruebas unitarias de la lógica del backend
├── pyproject.toml
└── README.md
```

---

## 🚀 Puesta en Marcha Local

### 1. Backend (Python)

Requisitos: Python 3.10+

```bash
# Crear entorno virtual e instalar dependencias
python3 -m venv .venv
source .venv/bin/activate
pip install requests pytest

# Ejecutar el scraper y actualizar stations.json
python backend/updater.py

# Ejecutar pruebas unitarias
pytest
```

### 2. Frontend (Node.js)

Requisitos: Node.js 18+ / 20+

```bash
cd frontend

# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
npm run dev

# Compilar para producción
npm run build
```

---

## ⚙️ Configuración en GitHub Pages

1. En el repositorio de GitHub, dirígete a **Settings** > **Pages**.
2. En la sección **Build and deployment**, selecciona como Source: **GitHub Actions**.
3. El workflow `.github/workflows/deploy.yml` se encargará automáticamente de:
   - Scrapear los precios a las 08:00 UTC.
   - Versionar los datos en Git.
   - Compilar y desplegar la aplicación a `https://<usuario>.github.io/<repositorio>/`.
