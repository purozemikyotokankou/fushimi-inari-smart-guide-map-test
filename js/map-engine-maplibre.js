/* Fushimi Inari Smart Guide — MapLibre 3D map bridge (v190 unrestricted map pan)
 * MapLibre owns the base-map camera (pan / zoom; pitch and bearing stay fixed).
 * Existing Leaflet vector panes are projected onto the same camera plane with a
 * projective transform. Visible spot pins use one isolated proxy per marker; the
 * original Leaflet marker nodes remain hidden to prevent duplicate paint trails.
 */
(function () {
    "use strict";

    const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
    // 初回表示はトイレ③を中心にする（MapLibreの座標順は [経度, 緯度]）。
    const DEFAULT_CENTER = [135.777558305, 34.968021325]; // 新池とトイレ③の中点
    const LEAFLET_ZOOM_OFFSET = 1;
    const DEFAULT_ZOOM = 17;
    // 3D表示は常時ON。角度を固定し、表示切替時のカメラ移動をなくす。
    const FIXED_PITCH = 54;
    const TERRAIN_SOURCE_ID = "fushimi-terrain-dem";
    const HILLSHADE_LAYER_ID = "fushimi-terrain-hillshade";
    const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
    // 地図を自由に移動できるよう、DEMソースにも地理的なboundsを設定しない。
    // 3D標高は表示位置に応じて必要なタイルを読み込む。
    // Terrainとhillshadeは別ソースにし、MapLibre推奨の描画品質を保つ。
    const HILLSHADE_SOURCE_ID = "fushimi-terrain-hillshade-dem";
    const TERRAIN_ATTRIBUTION = 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen / AWS Terrain Tiles</a>';

    let mapLibreMap = null;
    let leafletMap = null;
    let syncLock = null;
    let loaded = false;
    let overlayFrame = 0;
    let programmaticCameraMove = false;
    let fixed3DBadge = null;
    let terrainEnabled = false;
    let isAdding3DBuildings = false;
    let loadTimeoutId = 0;
    const markerLayers = new Set();
    const markerProxyEntries = new Map();
    let markerOverlayContainer = null;
    let markerPaneObserver = null;
    const MARKER_PROJECTION_LAYER_ID = "fushimi-marker-projection-reference";
    let markerProjectionMatrix = null;
    let statusHideTimer = 0;

    // Route geometry is rendered by MapLibre itself so it follows the DEM surface.
    // Leaflet keeps a hidden copy only for its existing bounds / navigation logic.
    const ROUTE_SOURCE_ID = "fushimi-native-route-source";
    const ROUTE_BASE_LAYER_ID = "fushimi-native-route-base";
    const ROUTE_BEAM_LAYER_ID = "fushimi-native-route-beam";
    let activeRouteGeoJSON = null;
    let activeRouteStyle = { color: "#FF9900", beamColor: "#FFFFFF" };
    let routeBeamFrame = 0;
    let routeBeamStart = 0;
    let routeBeamLastPaint = 0;

    // First paint is held back until MapLibre has enabled terrain and loaded the
    // initial DEM tile. This prevents a flat-map flash followed by a 3D snap.
    let styleReadyForCurrentStyle = false;
    let terrainReadyPollTimer = 0;
    let terrainReadyStartedAt = 0;
    let terrainInitialIdleSeen = false;
    const TERRAIN_FIRST_FRAME_TIMEOUT_MS = 24000;

    const status = () => document.getElementById("maplibreStatus");
    const statusText = () => document.getElementById("maplibreStatusText");
    const retryButton = () => document.getElementById("maplibreRetry");

    function showStatus(message, canRetry) {
        const node = status();
        if (!node) return;
        if (statusHideTimer) {
            window.clearTimeout(statusHideTimer);
            statusHideTimer = 0;
        }
        if (statusText()) statusText().textContent = message;
        if (retryButton()) retryButton().hidden = !canRetry;
        node.setAttribute("aria-label", message || "伏見稲荷の地図を読み込んでいます");
        node.classList.remove("is-leaving");
        node.hidden = false;
        node.classList.toggle("is-error", !!canRetry);
    }

    function hideStatus() {
        const node = status();
        if (!node || node.hidden) return;
        if (statusHideTimer) window.clearTimeout(statusHideTimer);
        node.classList.add("is-leaving");
        statusHideTimer = window.setTimeout(() => {
            node.hidden = true;
            node.classList.remove("is-leaving");
            statusHideTimer = 0;
        }, 300);
    }

    function setMapSurfaceReady(ready) {
        const mapContainer = document.getElementById("maplibreBase");
        const mapRoot = document.getElementById("map");
        mapContainer?.classList.toggle("is-maplibre-3d-ready", !!ready);
        mapRoot?.classList.toggle("is-maplibre-3d-ready", !!ready);
        if (ready) {
            hideStatus();
            if (fixed3DBadge && terrainEnabled) {
                fixed3DBadge.textContent = "3D地形 表示中";
                fixed3DBadge.title = "標高タイルの読み込みが完了しました";
                fixed3DBadge.hidden = false;
            }
            scheduleOverlayProjection();
        }
    }

    function notifyUserMapGesture() {
        if (programmaticCameraMove) return;
        window.dispatchEvent(new CustomEvent("fushimi:map-user-moved"));
    }

    function solveLinearSystem(matrix, vector) {
        const size = vector.length;
        const rows = matrix.map((row, index) => row.concat(vector[index]));

        for (let column = 0; column < size; column += 1) {
            let pivot = column;
            for (let row = column + 1; row < size; row += 1) {
                if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
            }
            if (Math.abs(rows[pivot][column]) < 1e-11) return null;
            if (pivot !== column) [rows[pivot], rows[column]] = [rows[column], rows[pivot]];

            const divisor = rows[column][column];
            for (let j = column; j <= size; j += 1) rows[column][j] /= divisor;

            for (let row = 0; row < size; row += 1) {
                if (row === column) continue;
                const factor = rows[row][column];
                if (!factor) continue;
                for (let j = column; j <= size; j += 1) rows[row][j] -= factor * rows[column][j];
            }
        }
        return rows.map((row) => row[size]);
    }

    function solveHomography(sourcePoints, targetPoints) {
        const matrix = [];
        const vector = [];
        for (let i = 0; i < 4; i += 1) {
            const x = sourcePoints[i].x;
            const y = sourcePoints[i].y;
            const u = targetPoints[i].x;
            const v = targetPoints[i].y;
            matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
            vector.push(u);
            matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
            vector.push(v);
        }
        const h = solveLinearSystem(matrix, vector);
        if (!h || h.some((value) => !Number.isFinite(value))) return null;
        if (h.some((value) => Math.abs(value) > 1e4)) return null;
        return h;
    }

    function homographyToCssMatrix(h) {
        // CSS matrix3d uses column-major order. This embeds a 2D projective
        // homography in the z=0 plane, matching MapLibre's pitched Mercator view.
        const values = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, 1];
        return `matrix3d(${values.map((value) => Number(value.toFixed(10))).join(",")})`;
    }

    function addMarkerProjectionReferenceLayer() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded() || mapLibreMap.getLayer(MARKER_PROJECTION_LAYER_ID)) return;
        try {
            mapLibreMap.addLayer({
                id: MARKER_PROJECTION_LAYER_ID,
                type: "custom",
                renderingMode: "3d",
                onAdd: function () {},
                render: function (_gl, matrixOrArgs) {
                    // MapLibre 5.x supplies the Mercator-to-clip matrix directly;
                    // newer builds wrap it in defaultProjectionData.mainMatrix.
                    const matrix = matrixOrArgs && matrixOrArgs.length === 16
                        ? matrixOrArgs
                        : (matrixOrArgs?.defaultProjectionData?.mainMatrix || matrixOrArgs?.modelViewProjectionMatrix);
                    if (matrix && matrix.length === 16) markerProjectionMatrix = new Float64Array(matrix);
                },
                onRemove: function () { markerProjectionMatrix = null; }
            });
        } catch (error) {
            console.warn("[Fushimi Map] Terrain-aware marker projection layer unavailable:", error);
            markerProjectionMatrix = null;
        }
    }

    function projectCoordinate(lng, lat) {
        if (!mapLibreMap) return null;
        const mercator = window.maplibregl?.MercatorCoordinate;
        if (terrainEnabled && markerProjectionMatrix && mercator && typeof mercator.fromLngLat === "function") {
            try {
                const elevation = mapLibreMap.queryTerrainElevation([lng, lat]);
                const altitude = Number.isFinite(elevation) ? elevation : 0;
                const coordinate = mercator.fromLngLat([lng, lat], altitude);
                const m = markerProjectionMatrix;
                const clipX = m[0] * coordinate.x + m[4] * coordinate.y + m[8] * coordinate.z + m[12];
                const clipY = m[1] * coordinate.x + m[5] * coordinate.y + m[9] * coordinate.z + m[13];
                const clipW = m[3] * coordinate.x + m[7] * coordinate.y + m[11] * coordinate.z + m[15];
                if (Number.isFinite(clipW) && Math.abs(clipW) > 1e-8) {
                    const width = mapLibreMap.getContainer().clientWidth;
                    const height = mapLibreMap.getContainer().clientHeight;
                    const x = (clipX / clipW + 1) * 0.5 * width;
                    const y = (1 - clipY / clipW) * 0.5 * height;
                    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
                }
            } catch (_) {
                // DEM tiles may not be ready yet. Fall through to sea-level projection.
            }
        }
        const point = mapLibreMap.project([lng, lat]);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    }

    function ensureMarkerOverlay() {
        if (!leafletMap) return null;
        const host = leafletMap.getContainer();
        if (markerOverlayContainer && markerOverlayContainer.parentNode === host) return markerOverlayContainer;
        markerOverlayContainer = document.createElement("div");
        markerOverlayContainer.className = "fushimi-marker-overlay";
        markerOverlayContainer.setAttribute("aria-label", "Map markers");
        markerOverlayContainer.style.cssText = [
            "position:absolute", "inset:0", "z-index:680", "overflow:visible",
            "pointer-events:none", "transform:none", "contain:layout style"
        ].join(";");
        host.appendChild(markerOverlayContainer);
        return markerOverlayContainer;
    }

    function concealLeafletMarkerElement(element) {
        if (!element) return;
        // Leaflet keeps this original node for its marker lifecycle and event state,
        // but only the isolated proxy is allowed to paint on the 3D map.
        element.style.setProperty("visibility", "hidden", "important");
        element.style.setProperty("opacity", "0", "important");
        element.style.setProperty("pointer-events", "none", "important");
        element.style.setProperty("transition", "none", "important");
    }

    function removeMarkerProxy(layer) {
        const entry = markerProxyEntries.get(layer);
        if (entry?.element?.parentNode) entry.element.parentNode.removeChild(entry.element);
        markerProxyEntries.delete(layer);
    }

    function createMarkerProxy(layer, sourceIcon) {
        const overlay = ensureMarkerOverlay();
        if (!overlay || !sourceIcon) return null;
        const element = sourceIcon.cloneNode(true);
        element.classList.add("fushimi-marker-proxy");
        element.removeAttribute("id");
        element.style.setProperty("visibility", "visible", "important");
        element.style.setProperty("opacity", "1", "important");
        element.style.setProperty("pointer-events", layer.options?.interactive === false ? "none" : "auto", "important");
        element.style.transition = "none";
        element.style.animation = "none";
        element.style.willChange = "auto";
        element.style.transform = "none";
        element.style.webkitTransform = "none";
        element.setAttribute("aria-hidden", "false");
        if (sourceIcon.title) element.title = sourceIcon.title;
        if (sourceIcon.getAttribute("aria-label")) element.setAttribute("aria-label", sourceIcon.getAttribute("aria-label"));

        const stopMapGesture = (event) => event.stopPropagation();
        ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick"].forEach((type) => {
            element.addEventListener(type, stopMapGesture, { passive: true });
        });
        element.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (layer.options?.interactive === false) return;
            layer.fire("click", { latlng: layer.getLatLng(), originalEvent: event });
        });
        element.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (layer.options?.interactive === false) return;
            layer.fire("click", { latlng: layer.getLatLng(), originalEvent: event });
        });
        overlay.appendChild(element);
        const entry = { source: sourceIcon, element };
        markerProxyEntries.set(layer, entry);
        return entry;
    }

    function updateMarkerProxy(layer) {
        if (!layer) return;
        const sourceIcon = layer._icon;
        if (!sourceIcon || !sourceIcon.isConnected) {
            concealLeafletMarkerElement(sourceIcon);
            concealLeafletMarkerElement(layer._shadow);
            removeMarkerProxy(layer);
            return;
        }
        concealLeafletMarkerElement(sourceIcon);
        concealLeafletMarkerElement(layer._shadow);

        let entry = markerProxyEntries.get(layer);
        if (!entry || entry.source !== sourceIcon || !entry.element?.isConnected) {
            removeMarkerProxy(layer);
            entry = createMarkerProxy(layer, sourceIcon);
            if (!entry) return;
        }

        const proxy = entry.element;
        // Keep dynamic marker classes (selected/viewed/railway) and pane ordering
        // in sync with the source while leaving Leaflet's moving DOM node invisible.
        if (proxy.className !== `${sourceIcon.className} fushimi-marker-proxy`) {
            proxy.className = `${sourceIcon.className} fushimi-marker-proxy`;
        }
        const sourceComputedStyle = getComputedStyle(sourceIcon);
        proxy.style.width = sourceIcon.style.width || sourceComputedStyle.width || "46px";
        proxy.style.height = sourceIcon.style.height || sourceComputedStyle.height || "46px";
        proxy.style.marginLeft = sourceIcon.style.marginLeft || sourceComputedStyle.marginLeft || "";
        proxy.style.marginTop = sourceIcon.style.marginTop || sourceComputedStyle.marginTop || "";
        proxy.style.setProperty("pointer-events", layer.options?.interactive === false ? "none" : "auto", "important");

        const latLng = layer.getLatLng();
        const point = projectCoordinate(latLng.lng, latLng.lat);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            // Never leave a proxy at its cloned Leaflet position or at a previous
            // camera position. It becomes visible again only after a valid current
            // MapLibre projection is available.
            proxy.style.setProperty("visibility", "hidden", "important");
            proxy.style.setProperty("opacity", "0", "important");
            return;
        }
        proxy.style.setProperty("visibility", "visible", "important");
        proxy.style.setProperty("opacity", "1", "important");
        proxy.style.left = `${Number(point.x.toFixed(2))}px`;
        proxy.style.top = `${Number(point.y.toFixed(2))}px`;
        proxy.style.transform = "none";
        proxy.style.webkitTransform = "none";

        const paneName = layer.options?.pane || "markerPane";
        const pane = leafletMap?.getPane(paneName);
        const paneZ = Number.parseInt(pane ? getComputedStyle(pane).zIndex : "600", 10) || 600;
        const localZ = Number.parseInt(sourceIcon.style.zIndex || "0", 10) || 0;
        const isViewing = sourceIcon.classList.contains("planner-marker-viewing") ||
            !!sourceIcon.querySelector(".custom-map-marker.is-viewing");
        proxy.style.setProperty("z-index", String(isViewing ? 2100000000 : paneZ * 100000 + localZ), "important");
    }

    function updateLeafletOverlayProjection() {
        if (!loaded || !mapLibreMap || !leafletMap || !window.L) return;
        const size = leafletMap.getSize();
        if (!size || size.x < 2 || size.y < 2) return;

        const corners = [
            window.L.point(0, 0),
            window.L.point(size.x, 0),
            window.L.point(size.x, size.y),
            window.L.point(0, size.y)
        ];
        const sourcePoints = [];
        const targetPoints = [];

        try {
            corners.forEach((containerPoint) => {
                const latLng = leafletMap.containerPointToLatLng(containerPoint);
                const layerPoint = leafletMap.latLngToLayerPoint(latLng);
                const projected = projectCoordinate(latLng.lng, latLng.lat);
                if (!projected) throw new Error("MapLibre projection returned an invalid point.");
                sourcePoints.push({ x: layerPoint.x, y: layerPoint.y });
                targetPoints.push({ x: projected.x, y: projected.y });
            });
        } catch (error) {
            console.warn("[Fushimi Map Test] Overlay projection skipped:", error);
            return;
        }

        if (targetPoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return;
        const h = solveHomography(sourcePoints, targetPoints);
        if (!h) return;
        const transform = homographyToCssMatrix(h);

        const panes = leafletMap.getPanes();
        const mapPane = panes.mapPane || leafletMap._mapPane;
        if (mapPane && (mapPane.style.transform !== "none" || mapPane.style.webkitTransform !== "none")) {
            // Keep Leaflet's parent pan transform neutral; child panes are projected directly.
            mapPane.style.transformOrigin = "0 0";
            mapPane.style.webkitTransformOrigin = "0 0";
            mapPane.style.transform = "none";
            mapPane.style.webkitTransform = "none";
        }

        Object.entries(panes).forEach(([name, pane]) => {
            if (!pane || name === "mapPane" || name === "tilePane") return;
            const containsMarkers = !!pane.querySelector?.(".leaflet-marker-icon, .leaflet-marker-shadow");
            const nextTransform = containsMarkers ? "none" : transform;
            if (pane._fushimiProjectionTransform !== nextTransform) {
                pane.style.transformOrigin = "0 0";
                pane.style.webkitTransformOrigin = "0 0";
                pane.style.transform = nextTransform;
                pane.style.webkitTransform = nextTransform;
                pane._fushimiProjectionTransform = nextTransform;
            }
        });

        // Leaflet's own marker DOM is never moved on screen. A single isolated
        // proxy overlay owns all visible marker pixels, so old positions cannot
        // remain behind when MapLibre and Leaflet update on different frames.
        markerLayers.forEach(updateMarkerProxy);
    }

    function scheduleOverlayProjection() {
        if (overlayFrame) return;
        overlayFrame = window.requestAnimationFrame(function () {
            overlayFrame = 0;
            updateLeafletOverlayProjection();
        });
    }

    function getVectorSourceId() {
        const sources = (mapLibreMap && mapLibreMap.getStyle() && mapLibreMap.getStyle().sources) || {};
        const entries = Object.entries(sources);
        const preferred = entries.find(([id, source]) => source && source.type === "vector" && id === "openmaptiles");
        if (preferred) return preferred[0];
        const openFreeMap = entries.find(([id, source]) => source && source.type === "vector" && /openfreemap|openmaptiles/i.test(`${id} ${source.url || ""}`));
        if (openFreeMap) return openFreeMap[0];
        const anyVectorSource = entries.find(([, source]) => source && source.type === "vector");
        return anyVectorSource ? anyVectorSource[0] : null;
    }

    function applyMapReadabilityStyle() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded()) return;
        const layers = mapLibreMap.getStyle()?.layers || [];
        layers.forEach((layer) => {
            // 地図上の地名・施設名などの文字ラベルだけを非表示にする。
            // POIアイコンや道路・建物の形状は残す。
            if (layer.type === "symbol" && layer.layout && layer.layout["text-field"] !== undefined) {
                try { mapLibreMap.setLayoutProperty(layer.id, "visibility", "none"); } catch (_) {}
            }

        });

    }

    function add3DBuildings() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded() || isAdding3DBuildings) return;
        applyMapReadabilityStyle();
        if (mapLibreMap.getLayer("fushimi-3d-buildings")) return;
        const sourceId = getVectorSourceId();
        if (!sourceId) {
            console.warn("[Fushimi Map Test] The Positron style did not expose a vector source for 3D buildings.");
            return;
        }

        isAdding3DBuildings = true;
        try {
            const styleLayers = mapLibreMap.getStyle().layers || [];
            const firstLabel = styleLayers.find((layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"]);
            mapLibreMap.addLayer({
                id: "fushimi-3d-buildings",
                type: "fill-extrusion",
                source: sourceId,
                "source-layer": "building",
                minzoom: 15,
                filter: ["all", ["has", "render_height"], ["!=", ["get", "hide_3d"], true]],
                paint: {
                    "fill-extrusion-color": [
                        "interpolate", ["linear"], ["get", "render_height"],
                        0, "#e6e3de", 12, "#d5d1ca", 45, "#c3beb6", 120, "#b2ada5"
                    ],
                    "fill-extrusion-height": [
                        "interpolate", ["linear"], ["zoom"],
                        15, 0,
                        16, ["coalesce", ["get", "render_height"], 0]
                    ],
                    "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
                    "fill-extrusion-opacity": 0.86,
                    "fill-extrusion-vertical-gradient": true
                }
            }, firstLabel ? firstLabel.id : undefined);
            console.info("[Fushimi Map Test] 3D building extrusion layer added.");
        } catch (error) {
            console.warn("[Fushimi Map Test] 3D buildings are unavailable in this style:", error);
        } finally {
            isAdding3DBuildings = false;
        }
    }

    function addTerrainSourcesIfNeeded() {
        if (!mapLibreMap) throw new Error("地図がまだ準備できていません。");
        if (!document.querySelector('link[data-fushimi-terrain-preconnect]')) {
            const preconnect = document.createElement("link");
            preconnect.rel = "preconnect";
            preconnect.href = "https://s3.amazonaws.com";
            preconnect.crossOrigin = "anonymous";
            preconnect.dataset.fushimiTerrainPreconnect = "true";
            document.head.appendChild(preconnect);
        }

        // DEMソースに地理的な境界を設けず、パンした先の標高タイルも読み込めるようにする。
        if (!mapLibreMap.getSource(TERRAIN_SOURCE_ID)) {
            mapLibreMap.addSource(TERRAIN_SOURCE_ID, {
                type: "raster-dem",
                tiles: [TERRAIN_TILE_URL],
                tileSize: 256,
                minzoom: 0,
                maxzoom: 15,
                encoding: "terrarium",
                attribution: TERRAIN_ATTRIBUTION
            });
        }
        if (!mapLibreMap.getSource(HILLSHADE_SOURCE_ID)) {
            mapLibreMap.addSource(HILLSHADE_SOURCE_ID, {
                type: "raster-dem",
                tiles: [TERRAIN_TILE_URL],
                tileSize: 256,
                minzoom: 0,
                maxzoom: 15,
                encoding: "terrarium",
                attribution: TERRAIN_ATTRIBUTION
            });
        }

        if (!mapLibreMap.getLayer(HILLSHADE_LAYER_ID)) {
            const layers = mapLibreMap.getStyle()?.layers || [];
            const firstLineOrSymbol = layers.find((layer) => layer.type === "line" || layer.type === "symbol");
            mapLibreMap.addLayer({
                id: HILLSHADE_LAYER_ID,
                type: "hillshade",
                source: HILLSHADE_SOURCE_ID,
                paint: {
                    "hillshade-exaggeration": 0.34,
                    "hillshade-shadow-color": "#68716d",
                    "hillshade-highlight-color": "#fff8e9",
                    "hillshade-illumination-direction": 335
                }
            }, firstLineOrSymbol ? firstLineOrSymbol.id : undefined);
        } else {
            mapLibreMap.setLayoutProperty(HILLSHADE_LAYER_ID, "visibility", "visible");
        }
    }

    function createFixed3DBadge() {
        if (fixed3DBadge) return;
        const host = document.querySelector(".planner-map-section");
        if (!host) return;
        const badge = document.createElement("div");
        badge.className = "maplibre-fixed-3d-badge";
        badge.hidden = true; // 読み込み中は文字バッジを出さず、鳥居ピクトグラムだけを見せる。
        badge.textContent = "3D地形 表示中";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-label", "伏見稲荷周辺の3D地形を表示しています");
        badge.style.cssText = [
            "position:absolute",
            "z-index:880",
            "top:calc(100px + env(safe-area-inset-top))",
            "left:10px",
            "padding:8px 11px",
            "border:1px solid rgba(255,255,255,.88)",
            "border-radius:13px",
            "background:rgba(255,255,255,.82)",
            "box-shadow:0 6px 18px rgba(0,0,0,.10), inset 0 1px 0 rgba(255,255,255,.95)",
            "backdrop-filter:blur(14px) saturate(1.15)",
            "-webkit-backdrop-filter:blur(14px) saturate(1.15)",
            "color:#4b5963",
            "font:700 10px/1.2 -apple-system,BlinkMacSystemFont,sans-serif",
            "letter-spacing:.04em",
            "pointer-events:none",
            "user-select:none"
        ].join(";");
        host.appendChild(badge);
        fixed3DBadge = badge;
    }

    let terrainEnableScheduled = false;
    let terrainEnableAttempts = 0;
    let terrainEnableTimer = 0;

    function waitForInitialTerrainFrame() {
        if (!mapLibreMap || !terrainEnabled) return;
        if (terrainReadyPollTimer) window.clearTimeout(terrainReadyPollTimer);
        terrainReadyStartedAt = Date.now();
        terrainInitialIdleSeen = false;
        mapLibreMap.once("idle", function () {
            terrainInitialIdleSeen = true;
        });

        const check = () => {
            terrainReadyPollTimer = 0;
            if (!mapLibreMap || !terrainEnabled) return;
            let elevation = null;
            try {
                elevation = mapLibreMap.queryTerrainElevation(mapLibreMap.getCenter());
            } catch (_) {
                elevation = null;
            }
            let demSourceLoaded = false;
            try {
                demSourceLoaded = typeof mapLibreMap.isSourceLoaded === "function"
                    ? mapLibreMap.isSourceLoaded(TERRAIN_SOURCE_ID)
                    : terrainInitialIdleSeen;
            } catch (_) {
                demSourceLoaded = false;
            }
            if (terrainInitialIdleSeen && demSourceLoaded && Number.isFinite(elevation)) {
                window.requestAnimationFrame(() => {
                    if (!mapLibreMap || !terrainEnabled) return;
                    setMapSurfaceReady(true);
                    console.info("[Fushimi Map] First visible map frame is terrain-enabled (3D-first startup).");
                });
                return;
            }
            if (Date.now() - terrainReadyStartedAt >= TERRAIN_FIRST_FRAME_TIMEOUT_MS) {
                markTerrainFailure(new Error("初回の標高タイル読み込みがタイムアウトしました。"));
                return;
            }
            terrainReadyPollTimer = window.setTimeout(check, 220);
        };
        check();
    }

    function markTerrainFailure(error) {
        terrainEnabled = false;
        terrainEnableScheduled = false;
        if (terrainEnableTimer) window.clearTimeout(terrainEnableTimer);
        if (terrainReadyPollTimer) window.clearTimeout(terrainReadyPollTimer);
        terrainEnableTimer = 0;
        terrainReadyPollTimer = 0;
        console.warn("[Fushimi Map] Fixed 3D terrain could not be enabled:", error);
        createFixed3DBadge();
        if (fixed3DBadge) {
            fixed3DBadge.textContent = "3D地形 読込失敗";
            fixed3DBadge.title = error && error.message ? error.message : String(error || "unknown error");
            fixed3DBadge.hidden = false;
        }
        // DEMが使えない場合だけ、傾斜カメラのベースマップへフォールバックする。
        setMapSurfaceReady(true);
        showStatus("3D地形を読み込めませんでした。地図は表示しています。通信環境を確認して再読み込みしてください。", true);
    }

    function enableFixedTerrain() {
        if (!mapLibreMap || !loaded || terrainEnabled || terrainEnableScheduled) return;
        terrainEnableScheduled = true;
        terrainEnableAttempts = 0;

        // style.loadイベント直後はMapLibre内部のStyle更新が完了していない場合がある。
        // V176で動作していたDEMソース構成を使い、Styleが完全に準備できるまで短く待ってから登録する。
        const attempt = () => {
            terrainEnableTimer = 0;
            if (!mapLibreMap || !loaded || terrainEnabled) {
                terrainEnableScheduled = false;
                return;
            }

            if (typeof mapLibreMap.isStyleLoaded === "function" && !mapLibreMap.isStyleLoaded()) {
                terrainEnableAttempts += 1;
                if (terrainEnableAttempts <= 30) {
                    terrainEnableTimer = window.setTimeout(attempt, 150);
                    return;
                }
                markTerrainFailure(new Error("地図スタイルの準備が完了しませんでした。"));
                return;
            }

            try {
                addTerrainSourcesIfNeeded();
                mapLibreMap.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.35 });
                terrainEnabled = true;
                terrainEnableScheduled = false;
                createFixed3DBadge();
                if (fixed3DBadge) {
                    fixed3DBadge.textContent = "3D地形 読込中…";
                    fixed3DBadge.title = "標高タイルを読み込んでいます";
                    fixed3DBadge.hidden = true;
                }
                console.info("[Fushimi Map] Fixed 3D terrain enabled; waiting for the initial DEM-backed idle frame.");
                waitForInitialTerrainFrame();
                scheduleOverlayProjection();
            } catch (error) {
                // Style切替の瞬間に当たったエラーだけは、次のフレームで再試行する。
                if (mapLibreMap && typeof mapLibreMap.isStyleLoaded === "function" && !mapLibreMap.isStyleLoaded() && terrainEnableAttempts < 30) {
                    terrainEnableAttempts += 1;
                    terrainEnableTimer = window.setTimeout(attempt, 150);
                    return;
                }
                markTerrainFailure(error);
            }
        };

        window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
    }

    function routeGradientAt(progress, beamColor = activeRouteStyle.beamColor) {
        const center = Math.max(0.055, Math.min(0.945, progress));
        const start = Math.max(0.001, center - 0.042);
        const end = Math.min(0.999, center + 0.042);
        return [
            "interpolate", ["linear"], ["line-progress"],
            0, "rgba(255,255,255,0)",
            start, "rgba(255,255,255,0)",
            center, beamColor,
            end, "rgba(255,255,255,0)",
            1, "rgba(255,255,255,0)"
        ];
    }

    function stopRouteBeamAnimation() {
        if (routeBeamFrame) window.cancelAnimationFrame(routeBeamFrame);
        routeBeamFrame = 0;
        routeBeamStart = 0;
        routeBeamLastPaint = 0;
    }

    function paintRouteBeam(timestamp) {
        routeBeamFrame = 0;
        if (!activeRouteGeoJSON || !mapLibreMap || !mapLibreMap.getLayer(ROUTE_BEAM_LAYER_ID)) return;
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

        // 28fps is visually smooth while avoiding a continuous 60fps style update.
        if (timestamp - routeBeamLastPaint < 35) {
            routeBeamFrame = window.requestAnimationFrame(paintRouteBeam);
            return;
        }
        routeBeamLastPaint = timestamp;
        if (!routeBeamStart) routeBeamStart = timestamp;
        const phase = ((timestamp - routeBeamStart) % 3000) / 3000;
        const center = 0.055 + phase * 0.89;
        try {
            mapLibreMap.setPaintProperty(ROUTE_BEAM_LAYER_ID, "line-gradient", routeGradientAt(center));
        } catch (error) {
            console.warn("[Fushimi Map] Route beam animation paused:", error);
            return;
        }
        routeBeamFrame = window.requestAnimationFrame(paintRouteBeam);
    }

    function ensureNativeRouteLayers() {
        if (!mapLibreMap || !loaded || !mapLibreMap.isStyleLoaded()) return false;
        try {
            if (!mapLibreMap.getSource(ROUTE_SOURCE_ID)) {
                mapLibreMap.addSource(ROUTE_SOURCE_ID, {
                    type: "geojson",
                    lineMetrics: true,
                    data: activeRouteGeoJSON || { type: "FeatureCollection", features: [] }
                });
            }
            if (!mapLibreMap.getLayer(ROUTE_BASE_LAYER_ID)) {
                mapLibreMap.addLayer({
                    id: ROUTE_BASE_LAYER_ID,
                    type: "line",
                    source: ROUTE_SOURCE_ID,
                    layout: {
                        "line-cap": "round",
                        "line-join": "round",
                        "visibility": "visible"
                    },
                    paint: {
                        "line-color": activeRouteStyle.color,
                        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 4.2, 17, 6.4, 19, 7.2],
                        "line-opacity": 1,
                        "line-blur": 0.18
                    }
                });
            }
            if (!mapLibreMap.getLayer(ROUTE_BEAM_LAYER_ID)) {
                mapLibreMap.addLayer({
                    id: ROUTE_BEAM_LAYER_ID,
                    type: "line",
                    source: ROUTE_SOURCE_ID,
                    layout: {
                        "line-cap": "round",
                        "line-join": "round",
                        "visibility": "visible"
                    },
                    paint: {
                        "line-gradient": routeGradientAt(0.18),
                        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.3, 17, 3.6, 19, 4.0],
                        "line-opacity": 0.98,
                        "line-blur": 0.15
                    }
                });
            }
            // Existing layers can survive while the style is reused; always apply
            // the current planner.js route color so changing ROUTE_COLOR takes effect.
            mapLibreMap.setPaintProperty(ROUTE_BASE_LAYER_ID, "line-color", activeRouteStyle.color);
            mapLibreMap.setPaintProperty(ROUTE_BEAM_LAYER_ID, "line-gradient", routeGradientAt(0.18));
            return true;
        } catch (error) {
            console.warn("[Fushimi Map] Native terrain route layers could not be created:", error);
            return false;
        }
    }

    function normalizeRouteCoordinates(latLngs) {
        if (!Array.isArray(latLngs)) return [];
        const coordinates = [];
        latLngs.forEach((point) => {
            const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
            const lng = Number(Array.isArray(point) ? point[1] : (point?.lng ?? point?.lon));
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
            const next = [lng, lat];
            const previous = coordinates[coordinates.length - 1];
            if (!previous || Math.abs(previous[0] - lng) > 1e-9 || Math.abs(previous[1] - lat) > 1e-9) coordinates.push(next);
        });
        return coordinates.length >= 2 ? coordinates : [];
    }

    function setRouteCoordinates(latLngs, style = {}) {
        const coordinates = normalizeRouteCoordinates(latLngs);
        if (coordinates.length < 2) return false;
        const requestedColor = String(style.color || "#FF9900").trim();
        const requestedBeamColor = String(style.beamColor || "#FFFFFF").trim();
        const isValidColor = (value) => {
            try { return !!(window.CSS && window.CSS.supports && window.CSS.supports("color", value)); }
            catch (_) { return false; }
        };
        activeRouteStyle = {
            color: isValidColor(requestedColor) ? requestedColor : "#FF9900",
            beamColor: isValidColor(requestedBeamColor) ? requestedBeamColor : "#FFFFFF"
        };
        activeRouteGeoJSON = {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                properties: { kind: "walking-route" },
                geometry: { type: "LineString", coordinates }
            }]
        };
        // A route can be requested before remote map tiles/style have finished
        // loading. Keep its geometry queued; handleMapStyleReady() will create
        // the native terrain layers and restore it as soon as the style is ready.
        if (!mapLibreMap) return false;
        if (!loaded || !mapLibreMap.isStyleLoaded()) return true;
        if (!ensureNativeRouteLayers()) return false;
        try {
            mapLibreMap.getSource(ROUTE_SOURCE_ID).setData(activeRouteGeoJSON);
            stopRouteBeamAnimation();
            if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
                routeBeamFrame = window.requestAnimationFrame(paintRouteBeam);
            } else {
                mapLibreMap.setPaintProperty(ROUTE_BEAM_LAYER_ID, "line-gradient", ["interpolate", ["linear"], ["line-progress"], 0, activeRouteStyle.beamColor, 1, activeRouteStyle.beamColor]);
            }
            return true;
        } catch (error) {
            console.warn("[Fushimi Map] Native route could not be displayed:", error);
            return false;
        }
    }

    function clearRouteCoordinates() {
        stopRouteBeamAnimation();
        activeRouteGeoJSON = null;
        activeRouteStyle = { color: "#FF9900", beamColor: "#FFFFFF" };
        if (!mapLibreMap || !loaded || !mapLibreMap.isStyleLoaded()) return;
        try {
            const source = mapLibreMap.getSource(ROUTE_SOURCE_ID);
            if (source) source.setData({ type: "FeatureCollection", features: [] });
        } catch (error) {
            console.warn("[Fushimi Map] Native route cleanup warning:", error);
        }
    }

    function restoreNativeRouteAfterStyleLoad() {
        if (!activeRouteGeoJSON) return;
        if (!ensureNativeRouteLayers()) return;
        try {
            mapLibreMap.getSource(ROUTE_SOURCE_ID).setData(activeRouteGeoJSON);
            if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
                stopRouteBeamAnimation();
                routeBeamFrame = window.requestAnimationFrame(paintRouteBeam);
            }
        } catch (error) {
            console.warn("[Fushimi Map] Route restore after style reload failed:", error);
        }
    }

    // MapLibreの地図操作を常時有効にする。
    // 地図の表示範囲を固定せず、パン・ズームはユーザーに任せる。
    // 3Dの初期角度(54度)と北向きは維持する。
    function enableFreeMapMovement() {
        if (!mapLibreMap) return;
        try { mapLibreMap.setMaxBounds(null); } catch (_) {}
        try { mapLibreMap.dragPan?.enable?.(); } catch (_) {}
        try { mapLibreMap.scrollZoom?.enable?.(); } catch (_) {}
        try { mapLibreMap.doubleClickZoom?.enable?.(); } catch (_) {}
        try { mapLibreMap.touchZoomRotate?.enable?.(); } catch (_) {}
        try { mapLibreMap.touchZoomRotate?.disableRotation?.(); } catch (_) {}
        try { mapLibreMap.touchPitch?.disable?.(); } catch (_) {}
        try { mapLibreMap.dragRotate?.disable?.(); } catch (_) {}
        try { mapLibreMap.keyboard?.disableRotation?.(); } catch (_) {}

        const root = mapLibreMap.getContainer?.();
        const canvasContainer = mapLibreMap.getCanvasContainer?.();
        const canvas = mapLibreMap.getCanvas?.();
        if (root) root.style.pointerEvents = "auto";
        if (canvasContainer) {
            canvasContainer.style.pointerEvents = "auto";
            canvasContainer.style.touchAction = "none";
        }
        if (canvas) {
            canvas.style.pointerEvents = "auto";
            canvas.style.touchAction = "none";
            canvas.style.cursor = "grab";
        }
    }

    function createMap() {
        const container = document.getElementById("maplibreBase");
        if (!container) return null;
        // MapLibre's canvas is absolutely positioned, so its host needs an explicit
        // full-map size; without this the canvas can initialize at zero height.
        container.style.position = "absolute";
        container.style.inset = "0";
        container.style.width = "100%";
        container.style.height = "100%";
        container.style.zIndex = "0";
        container.style.overflow = "hidden";

        const retry = retryButton();
        if (retry && retry.dataset.fushimiBound !== "true") {
            retry.dataset.fushimiBound = "true";
            retry.addEventListener("click", function () {
                if (!mapLibreMap) {
                    window.location.reload();
                    return;
                }
                loaded = false;
                styleReadyForCurrentStyle = false;
                terrainEnabled = false;
                terrainEnableScheduled = false;
                terrainEnableAttempts = 0;
                terrainInitialIdleSeen = false;
                if (terrainEnableTimer) window.clearTimeout(terrainEnableTimer);
                if (terrainReadyPollTimer) window.clearTimeout(terrainReadyPollTimer);
                terrainEnableTimer = 0;
                terrainReadyPollTimer = 0;
                setMapSurfaceReady(false);
                if (fixed3DBadge) {
                    fixed3DBadge.textContent = "3D地形 読込中…";
                    fixed3DBadge.hidden = true;
                }
                showStatus("3D地形を準備してから地図を表示します…", false);
                if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
                mapLibreMap.setStyle(STYLE_URL);
                loadTimeoutId = window.setTimeout(function () {
                    if (!loaded) showStatus("地図を読み込めません。通信環境を確認してください。", true);
                }, 18000);
            });
        }

        if (!window.maplibregl || typeof window.maplibregl.Map !== "function") {
            showStatus("新しい地図エンジンを読み込めませんでした。通信環境を確認してください。", true);
            return null;
        }

        try {
            setMapSurfaceReady(false);
            showStatus("3D地形を準備してから地図を表示します…", false);
            if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
            mapLibreMap = new window.maplibregl.Map({
                container,
                style: STYLE_URL,
                center: DEFAULT_CENTER,
                zoom: DEFAULT_ZOOM - LEAFLET_ZOOM_OFFSET,
                minZoom: -1,
                maxZoom: 18 - LEAFLET_ZOOM_OFFSET,
                // 地図の移動範囲は固定しない。地形DEMにもboundsを設けない。
                maxBounds: null,
                dragPan: true,
                scrollZoom: true,
                doubleClickZoom: true,
                touchZoomRotate: true,
                pitch: FIXED_PITCH,
                bearing: 0,
                minPitch: FIXED_PITCH,
                maxPitch: FIXED_PITCH,
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                attributionControl: { compact: false },
                renderWorldCopies: false,
                cooperativeGestures: false,
                // High-DPI端末でのGPU描画負荷を抑え、初回表示を軽くする。
                pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
                // 使わないズーム階層のタイルを抱え込みすぎない。
                maxTileCacheZoomLevels: 4,
                // ラベル衝突フェードを省略（このアプリでは地名テキストを非表示）。
                fadeDuration: 0,
                cancelPendingTileRequestsWhileZooming: true
            });
            enableFreeMapMovement();

            function handleMapStyleReady() {
                if (!mapLibreMap || !mapLibreMap.isStyleLoaded()) return;
                if (styleReadyForCurrentStyle) {
                    restoreNativeRouteAfterStyleLoad();
                    return;
                }
                styleReadyForCurrentStyle = true;
                loaded = true;
                if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
                loadTimeoutId = 0;
                container.classList.add("is-maplibre-loaded");
                showStatus("3D地形を準備しています…", false);
                add3DBuildings();
                addMarkerProjectionReferenceLayer();
                // スタイル再読込後もドラッグ移動・ズームを必ず有効化する。
                enableFreeMapMovement();
                enableFixedTerrain();
                restoreNativeRouteAfterStyleLoad();
                if (mapLibreMap) mapLibreMap.resize();
                scheduleOverlayProjection();
            }

            // 3D角度と北向きを固定。ピンチズーム・ドラッグ移動は引き続き使用可能。
            enableFreeMapMovement();

            mapLibreMap.on("load", function () {
                handleMapStyleReady();
                console.info("[Fushimi Map Test] OpenFreeMap style loaded; terrain is prepared before the first visible map frame.");
            });

            // style.load also fires after setStyle(); using it for readiness
            // makes the in-page retry button work after an initial style failure.
            mapLibreMap.on("style.load", handleMapStyleReady);

            mapLibreMap.on("error", function (event) {
                const message = event && event.error && event.error.message;
                console.warn("[Fushimi Map Test] MapLibre error:", message || event);
            });
            loadTimeoutId = window.setTimeout(function () {
                if (!loaded) showStatus("3Dマップを読み込めません。通信環境を確認して再読み込みしてください。", true);
            }, 18000);

            const mapRoot = document.getElementById("map");
            mapLibreMap.on("movestart", function () {
                mapRoot?.classList.add("is-camera-moving");
            });
            mapLibreMap.on("moveend", function () {
                mapRoot?.classList.remove("is-camera-moving");
            });
            mapLibreMap.on("dragstart", notifyUserMapGesture);
            mapLibreMap.on("rotatestart", notifyUserMapGesture);
            mapLibreMap.on("pitchstart", notifyUserMapGesture);
            mapLibreMap.on("zoomstart", notifyUserMapGesture);
            mapLibreMap.on("move", scheduleOverlayProjection);
            mapLibreMap.on("render", scheduleOverlayProjection);
            mapLibreMap.on("resize", scheduleOverlayProjection);
            mapLibreMap.on("terrain", scheduleOverlayProjection);
            mapLibreMap.on("idle", scheduleOverlayProjection);

            return mapLibreMap;
        } catch (error) {
            console.error("[Fushimi Map Test] MapLibre initialization failed:", error);
            showStatus("このブラウザでは新しい地図を起動できませんでした。WebGL対応ブラウザか通信環境を確認して再読み込みしてください。", true);
            return null;
        }
    }

    function bindLeaflet(leaflet) {
        leafletMap = leaflet;
        if (!mapLibreMap || !leafletMap) return false;
        ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"].forEach((name) => {
            const handler = leafletMap[name];
            if (handler && typeof handler.disable === "function") handler.disable();
        });
        const tilePane = leafletMap.getPanes()?.tilePane;
        if (tilePane) tilePane.style.display = "none";
        leafletMap.getContainer().style.background = "transparent";
        // Disable Leaflet's own marker zoom animation. MapLibre is the only visible
        // camera and markerProxy overlay is the only visible marker renderer.
        leafletMap.options.zoomAnimation = false;
        leafletMap.options.markerZoomAnimation = false;
        leafletMap.options.fadeAnimation = false;
        ensureMarkerOverlay();

        markerLayers.clear();
        markerProxyEntries.forEach((entry) => entry.element?.remove());
        markerProxyEntries.clear();
        leafletMap.eachLayer((layer) => {
            if (layer instanceof window.L.Marker) {
                markerLayers.add(layer);
                layer.on("move", scheduleOverlayProjection);
                concealLeafletMarkerElement(layer._icon);
                concealLeafletMarkerElement(layer._shadow);
            }
        });
        leafletMap.on("layeradd", (event) => {
            if (event.layer instanceof window.L.Marker) {
                markerLayers.add(event.layer);
                event.layer.on("move", scheduleOverlayProjection);
                concealLeafletMarkerElement(event.layer._icon);
                concealLeafletMarkerElement(event.layer._shadow);
                scheduleOverlayProjection();
            }
        });
        leafletMap.on("layerremove", (event) => {
            if (event.layer instanceof window.L.Marker) {
                markerLayers.delete(event.layer);
                event.layer.off("move", scheduleOverlayProjection);
                removeMarkerProxy(event.layer);
            }
        });

        // setIcon() replaces a marker DOM node without firing layeradd. Watch only
        // marker panes so the isolated proxy is rebuilt immediately after a swap.
        if (markerPaneObserver) markerPaneObserver.disconnect();
        if (typeof MutationObserver !== "undefined") {
            markerPaneObserver = new MutationObserver((records) => {
                records.forEach((record) => {
                    record.addedNodes.forEach((node) => {
                        if (node && node.nodeType === 1 && node.classList?.contains("leaflet-marker-icon")) {
                            concealLeafletMarkerElement(node);
                        }
                    });
                });
                scheduleOverlayProjection();
            });
            ["markerPane", "plannerNumberPane", "plannerCurrentPane"].forEach((name) => {
                const pane = leafletMap.getPane(name);
                if (pane) markerPaneObserver.observe(pane, { childList: true });
            });
        }

        function closeEnough(a, b) {
            return Math.abs(a - b) < 0.000001;
        }

        function syncLeafletFromMapLibre() {
            if (syncLock === "leaflet") return;
            const center = mapLibreMap.getCenter();
            const zoom = mapLibreMap.getZoom() + LEAFLET_ZOOM_OFFSET;
            const current = leafletMap.getCenter();
            if (closeEnough(current.lat, center.lat) &&
                closeEnough(current.lng, center.lng) &&
                Math.abs(leafletMap.getZoom() - zoom) < 0.005) return;
            syncLock = "maplibre";
            try {
                leafletMap.setView([center.lat, center.lng], zoom, { animate: false });
            } finally {
                syncLock = null;
            }
            // Camera movement schedules the overlay projection once per animation frame.
        }

        function syncMapLibreFromLeaflet() {
            if (syncLock === "maplibre") return;
            const center = leafletMap.getCenter();
            const zoom = leafletMap.getZoom() - LEAFLET_ZOOM_OFFSET;
            const current = mapLibreMap.getCenter();
            if (closeEnough(current.lat, center.lat) &&
                closeEnough(current.lng, center.lng) &&
                Math.abs(mapLibreMap.getZoom() - zoom) < 0.005) return;
            syncLock = "leaflet";
            try {
                // Omitted pitch/bearing preserve the current MapLibre 3D camera.
                mapLibreMap.jumpTo({ center: [center.lng, center.lat], zoom });
            } finally {
                syncLock = null;
            }
            // The MapLibre move event schedules the matching overlay projection.
        }

        // Sync on every camera frame, not only moveend. Otherwise the 3D base map
        // moves during a drag while Leaflet's vector overlays retain the old center.
        mapLibreMap.on("move", syncLeafletFromMapLibre);
        leafletMap.on("move", syncMapLibreFromLeaflet);
        leafletMap.on("moveend zoomend viewreset resize layeradd layerremove", scheduleOverlayProjection);

        // The MapLibre canvas is inside the Leaflet container; its native click
        // already bubbles to Leaflet. Avoid dispatching duplicate background clicks.

        syncLeafletFromMapLibre();
        scheduleOverlayProjection();
        window.setTimeout(function () { if (mapLibreMap) mapLibreMap.resize(); scheduleOverlayProjection(); }, 250);
        return true;
    }

    function resize() {
        if (mapLibreMap) mapLibreMap.resize();
        scheduleOverlayProjection();
    }

    function projectLatLng(latLng) {
        if (!mapLibreMap || !latLng) return null;
        const point = projectCoordinate(Number(latLng.lng), Number(latLng.lat));
        return point ? { x: point.x, y: point.y } : null;
    }

    function getCameraOffsetForPoint(targetPoint) {
        const canvas = mapLibreMap.getCanvas();
        const width = canvas.clientWidth || canvas.width;
        const height = canvas.clientHeight || canvas.height;
        const desiredX = Number.isFinite(targetPoint?.x) ? Math.max(0, Math.min(width, targetPoint.x)) : width * 0.5;
        const desiredY = Number.isFinite(targetPoint?.y) ? Math.max(0, Math.min(height, targetPoint.y)) : height * 0.5;
        // A temporary offset places the chosen coordinate in the visible area
        // without changing MapLibre's persistent viewport padding.
        return [desiredX - width * 0.5, desiredY - height * 0.5];
    }

    function easeToCoordinate(latLng, targetPoint, zoom, duration = 700) {
        if (!mapLibreMap || !Array.isArray(latLng) || latLng.length < 2) return false;
        const coordinate = [Number(latLng[1]), Number(latLng[0])];
        if (!coordinate.every(Number.isFinite)) return false;
        const targetZoom = Number.isFinite(Number(zoom)) ? Number(zoom) - LEAFLET_ZOOM_OFFSET : mapLibreMap.getZoom();
        const animationDuration = Math.max(0, Number(duration) || 0);
        const options = { center: coordinate, zoom: targetZoom, offset: getCameraOffsetForPoint(targetPoint), duration: animationDuration, essential: true };
        programmaticCameraMove = true;
        if (animationDuration === 0) mapLibreMap.jumpTo(options);
        else mapLibreMap.easeTo(options);
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, Math.max(900, animationDuration + 250));
        return true;
    }

    function fitBounds(bounds, options = {}) {
        if (!mapLibreMap || !bounds) return false;
        const animationDuration = Number.isFinite(options.duration) ? options.duration : 650;
        programmaticCameraMove = true;
        mapLibreMap.fitBounds(bounds, {
            padding: options.padding || { top: 100, right: 56, bottom: 180, left: 56 },
            maxZoom: Number.isFinite(options.maxZoom) ? options.maxZoom - LEAFLET_ZOOM_OFFSET : 16,
            duration: animationDuration,
            essential: true
        });
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, Math.max(1000, animationDuration + 350));
        return true;
    }

    function followLocation(location) {
        if (!mapLibreMap || !location) return;
        const coordinate = [Number(location.lng), Number(location.lat)];
        if (!coordinate.every(Number.isFinite)) return;
        const duration = Number.isFinite(location.duration) ? location.duration : 650;
        const options = {
            center: coordinate,
            zoom: Number.isFinite(location.zoom) ? location.zoom - LEAFLET_ZOOM_OFFSET : mapLibreMap.getZoom(),
            offset: getCameraOffsetForPoint(location.targetPoint),
            pitch: FIXED_PITCH,
            bearing: 0,
            duration,
            essential: true
        };
        programmaticCameraMove = true;
        mapLibreMap.easeTo(options);
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, Math.max(1000, duration + 350));
    }

    function setNavigationMode() {
        // 案内開始・終了時もカメラ角度を変えない（酔い防止）。
        if (!mapLibreMap) return;
        if (Math.abs(mapLibreMap.getPitch() - FIXED_PITCH) > 0.1 || Math.abs(mapLibreMap.getBearing()) > 0.1) {
            programmaticCameraMove = true;
            mapLibreMap.jumpTo({ pitch: FIXED_PITCH, bearing: 0 });
            programmaticCameraMove = false;
            scheduleOverlayProjection();
        }
    }

    window.FushimiMapEngine = {
        createMap,
        bindLeaflet,
        resize,
        getMap: function () { return mapLibreMap; },
        getZoom: function () { return mapLibreMap ? mapLibreMap.getZoom() + LEAFLET_ZOOM_OFFSET : null; },
        getStyleUrl: function () { return STYLE_URL; },
        projectLatLng,
        setRouteCoordinates,
        clearRouteCoordinates,
        easeToCoordinate,
        fitBounds,
        followLocation,
        setNavigationMode,
        // 互換用API。外部から角度変更を要求されても固定角度を維持する。
        setPitch: function () { setNavigationMode(); }
    };
})();
