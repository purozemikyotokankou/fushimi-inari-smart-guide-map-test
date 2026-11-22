/* Fushimi Inari Smart Guide — MapLibre 3D map bridge (v182 terrain-aware pins + native route)
 * MapLibre owns the base-map camera (pan / zoom; pitch and bearing stay fixed).
 * Existing Leaflet route panes are projected onto the same camera plane with a
 * projective transform. Leaflet marker DOM nodes are repositioned with MapLibre
 * screen coordinates so the custom SVG pins stay upright and clickable.
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
    // 標高データの取得範囲は制限しない。前版で読み込み不具合が出た範囲制限を撤回。
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
    const markerTransformCache = new WeakMap();
    const markerLayers = new Set();
    const MARKER_PROJECTION_LAYER_ID = "fushimi-marker-projection-reference";
    let markerProjectionMatrix = null;

    // Route geometry is rendered by MapLibre itself so it follows the DEM surface.
    // Leaflet keeps a hidden copy only for its existing bounds / navigation logic.
    const ROUTE_SOURCE_ID = "fushimi-native-route-source";
    const ROUTE_BASE_LAYER_ID = "fushimi-native-route-base";
    const ROUTE_BEAM_LAYER_ID = "fushimi-native-route-beam";
    let activeRouteGeoJSON = null;
    let routeBeamFrame = 0;
    let routeBeamStart = 0;
    let routeBeamLastPaint = 0;

    const status = () => document.getElementById("maplibreStatus");
    const statusText = () => document.getElementById("maplibreStatusText");
    const retryButton = () => document.getElementById("maplibreRetry");

    function showStatus(message, canRetry) {
        const node = status();
        if (!node) return;
        if (statusText()) statusText().textContent = message;
        if (retryButton()) retryButton().hidden = !canRetry;
        node.hidden = false;
        node.classList.toggle("is-error", !!canRetry);
    }

    function hideStatus() {
        const node = status();
        if (node) node.hidden = true;
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

        // Sub-pixel translate3d avoids Leaflet's integer-pixel rounding during 3D movement.
        // Track marker layers separately so every camera frame does not scan
        // hundreds of unrelated route polylines and overlay layers.
        markerLayers.forEach((layer) => {
            if (!layer || !layer._icon) return;
            const latLng = layer.getLatLng();
            const point = projectCoordinate(latLng.lng, latLng.lat);
            if (!point) return;
            const applyPosition = (element) => {
                if (!element) return;
                const x = Number(point.x.toFixed(2));
                const y = Number(point.y.toFixed(2));
                const value = `translate3d(${x}px, ${y}px, 0)`;
                if (markerTransformCache.get(element) !== value || element.style.transform !== value) {
                    element.style.transform = value;
                    element.style.webkitTransform = value;
                    element.style.willChange = "transform";
                    element.style.backfaceVisibility = "hidden";
                    element.style.webkitBackfaceVisibility = "hidden";
                    markerTransformCache.set(element, value);
                }
                element._leaflet_pos = window.L.point(point.x, point.y);
            };
            applyPosition(layer._icon);
            applyPosition(layer._shadow);
        });
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

        // V176で動作していた標高ソース構成に戻す。読み込み範囲・ズーム範囲を限定しない。
        // Terrain用とHillshade用を分け、MapLibreの描画品質を維持する。
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
        badge.textContent = "3D地形 固定表示";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-label", "伏見稲荷周辺の3D地形を固定表示しています");
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

    function markTerrainFailure(error) {
        terrainEnabled = false;
        terrainEnableScheduled = false;
        if (terrainEnableTimer) window.clearTimeout(terrainEnableTimer);
        terrainEnableTimer = 0;
        console.warn("[Fushimi Map] Fixed 3D terrain could not be enabled:", error);
        createFixed3DBadge();
        if (fixed3DBadge) {
            fixed3DBadge.textContent = "3D地形 読込失敗";
            fixed3DBadge.title = error && error.message ? error.message : String(error || "unknown error");
        }
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
                    fixed3DBadge.textContent = "3D地形 固定表示";
                    fixed3DBadge.title = "AWS Terrain Tiles の標高データを使用しています";
                }
                console.info("[Fushimi Map] Fixed 3D terrain enabled (same DEM source layout as V176).");
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

    function routeGradientAt(progress) {
        const center = Math.max(0.055, Math.min(0.945, progress));
        const start = Math.max(0.001, center - 0.042);
        const end = Math.min(0.999, center + 0.042);
        return [
            "interpolate", ["linear"], ["line-progress"],
            0, "rgba(255,255,255,0)",
            start, "rgba(255,255,255,0)",
            center, "rgba(255,255,255,0.98)",
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
                        "line-color": "#FF9900",
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

    function setRouteCoordinates(latLngs) {
        const coordinates = normalizeRouteCoordinates(latLngs);
        if (coordinates.length < 2) return false;
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
                mapLibreMap.setPaintProperty(ROUTE_BEAM_LAYER_ID, "line-gradient", ["interpolate", ["linear"], ["line-progress"], 0, "rgba(255,255,255,.75)", 1, "rgba(255,255,255,.75)"]);
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
                terrainEnabled = false;
                terrainEnableScheduled = false;
                terrainEnableAttempts = 0;
                if (terrainEnableTimer) window.clearTimeout(terrainEnableTimer);
                terrainEnableTimer = 0;
                if (fixed3DBadge) fixed3DBadge.textContent = "3D地形 読込中…";
                showStatus("3Dマップを再読み込みしています…", false);
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
            showStatus("3Dマップを読み込んでいます…", false);
            if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
            mapLibreMap = new window.maplibregl.Map({
                container,
                style: STYLE_URL,
                center: DEFAULT_CENTER,
                zoom: DEFAULT_ZOOM - LEAFLET_ZOOM_OFFSET,
                minZoom: -1,
                maxZoom: 18 - LEAFLET_ZOOM_OFFSET,
                pitch: FIXED_PITCH,
                bearing: 0,
                minPitch: FIXED_PITCH,
                maxPitch: FIXED_PITCH,
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                scrollZoom: true,
                doubleClickZoom: true,
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

            function handleMapStyleReady() {
                loaded = true;
                if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
                loadTimeoutId = 0;
                hideStatus();
                container.classList.add("is-maplibre-loaded");
                add3DBuildings();
                addMarkerProjectionReferenceLayer();
                enableFixedTerrain();
                restoreNativeRouteAfterStyleLoad();
                if (mapLibreMap) mapLibreMap.resize();
                scheduleOverlayProjection();
            }

            // 3D角度と北向きを固定。ピンチズーム・ドラッグ移動は引き続き使用可能。
            mapLibreMap.dragRotate?.disable?.();
            mapLibreMap.touchZoomRotate?.disableRotation?.();
            mapLibreMap.touchPitch?.disable?.();
            mapLibreMap.keyboard?.disableRotation?.();

            mapLibreMap.on("load", function () {
                handleMapStyleReady();
                console.info("[Fushimi Map Test] MapLibre 3D + OpenFreeMap Positron loaded.");
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

        // Register only marker layers. Route lines and other Leaflet overlays
        // are transformed as panes and do not need per-marker DOM positioning.
        markerLayers.clear();
        leafletMap.eachLayer((layer) => {
            if (layer instanceof window.L.Marker) markerLayers.add(layer);
        });
        leafletMap.on("layeradd", (event) => {
            if (event.layer instanceof window.L.Marker) markerLayers.add(event.layer);
        });
        leafletMap.on("layerremove", (event) => {
            if (event.layer instanceof window.L.Marker) markerLayers.delete(event.layer);
        });

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
