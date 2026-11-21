/* Fushimi Inari Smart Guide — MapLibre 3D map bridge (test environment, v173 uniform rail color)
 * MapLibre owns the base-map camera (pan / zoom / pitch / bearing).
 * Existing Leaflet route panes are projected onto the same camera plane with a
 * projective transform. Leaflet marker DOM nodes are repositioned with MapLibre
 * screen coordinates so the custom SVG pins stay upright and clickable.
 */
(function () {
    "use strict";

    const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
    // 初回表示はトイレ③を中心にする（MapLibreの座標順は [経度, 緯度]）。
    const DEFAULT_CENTER = [135.77641661, 34.96794265];
    const LEAFLET_ZOOM_OFFSET = 1;
    const DEFAULT_ZOOM = 17;
    const DEFAULT_PITCH = 48;
    const NAVIGATION_PITCH = 52;
    const MAX_PITCH = 60;

    let mapLibreMap = null;
    let leafletMap = null;
    let syncLock = null;
    let loaded = false;
    let overlayFrame = 0;
    let programmaticCameraMove = false;
    let viewButton = null;
    let viewButtonHost = null;
    let isAdding3DBuildings = false;
    let loadTimeoutId = 0;
    const markerTransformCache = new WeakMap();
    const markerLayers = new Set();

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
                const projected = mapLibreMap.project([latLng.lng, latLng.lat]);
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
            const point = mapLibreMap.project([latLng.lng, latLng.lat]);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
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

    // 伏見稲荷周辺に表示される鉄道路線は、事業者名による色分けをせず
    // OpenMapTiles transportation の鉄道フィーチャーを一括で同じ色にする。
    // 外部API・Overpass・路線名ラベルには依存しない。
    const UNIFORM_RAIL_LAYER_ID = "fushimi-uniform-rail-lines";
    const UNIFORM_RAIL_COLOR = "#3979A8";
    const RAIL_SUBCLASSES = [
        "rail", "narrow_gauge", "preserved", "funicular",
        "subway", "light_rail", "monorail", "tram"
    ];

    function applyUniformRailwayStyle() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded()) return false;

        const sourceId = getVectorSourceId();
        if (!sourceId) {
            console.warn("[Fushimi Map] 鉄道路線レイヤーを追加できません。ベクタータイルソースが見つかりません。");
            return false;
        }

        const style = mapLibreMap.getStyle();
        const source = style?.sources?.[sourceId];
        if (!source || source.type !== "vector") {
            console.warn("[Fushimi Map] 鉄道路線レイヤーのソースがベクタータイルではありません。");
            return false;
        }

        const filter = [
            "all",
            ["==", "$type", "LineString"],
            ["in", "subclass", ...RAIL_SUBCLASSES]
        ];
        const width = [
            "interpolate", ["linear"], ["zoom"],
            10, 1.5,
            13, 2.2,
            15, 3.0,
            17, 4.0,
            19, 5.0
        ];

        // ベースマップ側に既存の鉄道線レイヤーがあれば、それも同じ色へ統一。
        // カスタムレイヤーは既存スタイルに該当レイヤーがない場合の補完として残す。
        let nativeRailLayerCount = 0;
        (style.layers || []).forEach((layer) => {
            if (layer.type !== "line" || layer["source-layer"] !== "transportation") return;
            const filterText = JSON.stringify(layer.filter || []).toLowerCase();
            const isRail = filterText.includes("subclass") &&
                RAIL_SUBCLASSES.some((name) => filterText.includes(`"${name}"`));
            if (!isRail) return;
            try {
                mapLibreMap.setLayoutProperty(layer.id, "visibility", "visible");
                mapLibreMap.setPaintProperty(layer.id, "line-color", UNIFORM_RAIL_COLOR);
                mapLibreMap.setPaintProperty(layer.id, "line-opacity", 1);
                mapLibreMap.setPaintProperty(layer.id, "line-width", width);
                nativeRailLayerCount += 1;
            } catch (error) {
                console.warn(`[Fushimi Map] 既存の鉄道路線レイヤーを統一色に変更できません: ${layer.id}`, error);
            }
        });

        try {
            if (!mapLibreMap.getLayer(UNIFORM_RAIL_LAYER_ID)) {
                mapLibreMap.addLayer({
                    id: UNIFORM_RAIL_LAYER_ID,
                    type: "line",
                    source: sourceId,
                    "source-layer": "transportation",
                    minzoom: 8,
                    filter,
                    layout: {
                        "visibility": "visible",
                        "line-cap": "round",
                        "line-join": "round"
                    },
                    paint: {
                        "line-color": UNIFORM_RAIL_COLOR,
                        "line-opacity": 1,
                        "line-width": width
                    }
                });
            } else {
                mapLibreMap.setFilter(UNIFORM_RAIL_LAYER_ID, filter);
                mapLibreMap.setLayoutProperty(UNIFORM_RAIL_LAYER_ID, "visibility", "visible");
                mapLibreMap.setPaintProperty(UNIFORM_RAIL_LAYER_ID, "line-color", UNIFORM_RAIL_COLOR);
                mapLibreMap.setPaintProperty(UNIFORM_RAIL_LAYER_ID, "line-opacity", 1);
                mapLibreMap.setPaintProperty(UNIFORM_RAIL_LAYER_ID, "line-width", width);
            }

            // 3D建物やベースマップの線に隠れないよう、鉄道路線を最前面に置く。
            mapLibreMap.moveLayer(UNIFORM_RAIL_LAYER_ID);
            console.info(`[Fushimi Map] 全鉄道路線を同じ色で表示: ${UNIFORM_RAIL_COLOR} (existing layers: ${nativeRailLayerCount})`);
            return true;
        } catch (error) {
            console.error("[Fushimi Map] 鉄道路線レイヤーの追加に失敗しました:", error);
            return false;
        }
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

        // 事業者別データの取得は行わず、鉄道フィーチャーをすべて同じ色で描画する。
        applyUniformRailwayStyle();
    }

    function add3DBuildings() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded() || isAdding3DBuildings) return;
        applyMapReadabilityStyle();
        if (mapLibreMap.getLayer("fushimi-3d-buildings")) {
            applyUniformRailwayStyle();
            return;
        }
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
            // 3D建物の上に全鉄道路線を同じ色で表示する。
            applyUniformRailwayStyle();
            console.info("[Fushimi Map Test] 3D building extrusion layer added.");
        } catch (error) {
            console.warn("[Fushimi Map Test] 3D buildings are unavailable in this style:", error);
        } finally {
            isAdding3DBuildings = false;
        }
    }

    function updateViewButton() {
        if (!viewButton || !mapLibreMap) return;
        const is3D = mapLibreMap.getPitch() > 8;
        viewButton.textContent = is3D ? "2D" : "3D";
        viewButton.setAttribute("aria-label", is3D ? "2D表示に切り替え" : "3D表示に切り替え");
        viewButton.title = is3D ? "真上から見る（2D）" : "斜め上から見る（3D）";
        viewButton.setAttribute("aria-pressed", String(is3D));
    }

    function createViewButton() {
        if (viewButton) return;
        const host = document.querySelector(".planner-map-section");
        if (!host) return;
        viewButtonHost = host;
        const wrapper = document.createElement("div");
        wrapper.className = "maplibre-camera-control";
        wrapper.innerHTML = '<button type="button" class="maplibre-camera-button" aria-label="2D表示に切り替え" aria-pressed="true">2D</button><span class="maplibre-camera-hint">2本指で傾き・回転</span>';
        host.appendChild(wrapper);
        viewButton = wrapper.querySelector("button");
        viewButton.addEventListener("click", function () {
            if (!mapLibreMap) return;
            const targetPitch = mapLibreMap.getPitch() > 8 ? 0 : DEFAULT_PITCH;
            programmaticCameraMove = true;
            mapLibreMap.easeTo({ pitch: targetPitch, duration: 650, essential: true });
            mapLibreMap.once("moveend", function () {
                programmaticCameraMove = false;
                updateViewButton();
            });
            window.setTimeout(function () { programmaticCameraMove = false; }, 1300);
        });
        updateViewButton();
    }

    function createMap() {
        const container = document.getElementById("maplibreBase");
        if (!container) return null;

        const retry = retryButton();
        if (retry && retry.dataset.fushimiBound !== "true") {
            retry.dataset.fushimiBound = "true";
            retry.addEventListener("click", function () {
                if (!mapLibreMap) {
                    window.location.reload();
                    return;
                }
                loaded = false;
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
                pitch: DEFAULT_PITCH,
                bearing: 0,
                maxPitch: MAX_PITCH,
                dragRotate: true,
                pitchWithRotate: true,
                touchPitch: true,
                scrollZoom: true,
                doubleClickZoom: true,
                attributionControl: { compact: false },
                renderWorldCopies: false,
                cooperativeGestures: false
            });

            function handleMapStyleReady() {
                loaded = true;
                if (loadTimeoutId) window.clearTimeout(loadTimeoutId);
                loadTimeoutId = 0;
                hideStatus();
                container.classList.add("is-maplibre-loaded");
                add3DBuildings();
                createViewButton();
                if (mapLibreMap) mapLibreMap.resize();
                scheduleOverlayProjection();
            }

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
            mapLibreMap.on("move", updateViewButton);
            mapLibreMap.on("render", updateLeafletOverlayProjection);

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
            // MapLibre's following render event updates the overlay in this same frame.
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
            // The resulting MapLibre render will project the overlay in-frame.
        }

        mapLibreMap.on("moveend", syncLeafletFromMapLibre);
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
        const point = mapLibreMap.project([Number(latLng.lng), Number(latLng.lat)]);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
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
            pitch: NAVIGATION_PITCH,
            duration,
            essential: true
        };
        const heading = Number(location.heading);
        const speed = Number(location.speed);
        const hasHeading = location.heading !== null && location.heading !== undefined && Number.isFinite(heading);
        if (hasHeading && heading >= 0 && Number.isFinite(speed) && speed > 0.8) options.bearing = heading;
        programmaticCameraMove = true;
        mapLibreMap.easeTo(options);
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, Math.max(1000, duration + 350));
    }

    function setNavigationMode(enabled) {
        if (!mapLibreMap) return;
        programmaticCameraMove = true;
        mapLibreMap.easeTo({
            pitch: enabled ? NAVIGATION_PITCH : DEFAULT_PITCH,
            bearing: enabled ? mapLibreMap.getBearing() : 0,
            duration: 550,
            essential: true
        });
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, 1500);
    }

    window.FushimiMapEngine = {
        createMap,
        bindLeaflet,
        resize,
        getMap: function () { return mapLibreMap; },
        getZoom: function () { return mapLibreMap ? mapLibreMap.getZoom() + LEAFLET_ZOOM_OFFSET : null; },
        getStyleUrl: function () { return STYLE_URL; },
        projectLatLng,
        easeToCoordinate,
        fitBounds,
        followLocation,
        setNavigationMode,
        setPitch: function (pitch) { if (mapLibreMap) mapLibreMap.easeTo({ pitch: Math.max(0, Math.min(MAX_PITCH, Number(pitch) || 0)), duration: 550 }); }
    };
})();
