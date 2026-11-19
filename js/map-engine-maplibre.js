/* Fushimi Inari Smart Guide — MapLibre 3D map bridge (test environment)
 * MapLibre owns the base-map camera (pan / zoom / pitch / bearing).
 * Existing Leaflet route panes are projected onto the same camera plane with a
 * projective transform. Leaflet marker DOM nodes are repositioned with MapLibre
 * screen coordinates so the custom SVG pins stay upright and clickable.
 */
(function () {
    "use strict";

    const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
    const DEFAULT_CENTER = [135.77865108489644, 34.96788994013442];
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
        if (mapPane) {
            // Leaflet stores its pan offset on mapPane. Each child pane is now
            // transformed directly from Leaflet layer coordinates into the
            // MapLibre screen plane, so the parent transform must be neutral.
            mapPane.style.transformOrigin = "0 0";
            mapPane.style.webkitTransformOrigin = "0 0";
            mapPane.style.transform = "none";
            mapPane.style.webkitTransform = "none";
        }

        Object.entries(panes).forEach(([name, pane]) => {
            if (!pane || name === "mapPane" || name === "tilePane") return;
            const containsMarkers = !!pane.querySelector?.(".leaflet-marker-icon, .leaflet-marker-shadow");
            pane.style.transformOrigin = "0 0";
            pane.style.webkitTransformOrigin = "0 0";
            pane.style.transform = containsMarkers ? "none" : transform;
            pane.style.webkitTransform = containsMarkers ? "none" : transform;
        });

        // Keep SVG pins upright rather than flattening them into the ground plane.
        // Their anchor positions still use the exact MapLibre camera projection.
        Object.values(leafletMap._layers || {}).forEach((layer) => {
            if (!(layer instanceof window.L.Marker) || !layer._icon) return;
            const latLng = layer.getLatLng();
            const point = mapLibreMap.project([latLng.lng, latLng.lat]);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            window.L.DomUtil.setPosition(layer._icon, window.L.point(point.x, point.y));
            if (layer._shadow) window.L.DomUtil.setPosition(layer._shadow, window.L.point(point.x, point.y));
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
        return openFreeMap ? openFreeMap[0] : null;
    }

    function add3DBuildings() {
        if (!mapLibreMap || !mapLibreMap.isStyleLoaded() || isAdding3DBuildings) return;
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

        if (!window.maplibregl || typeof window.maplibregl.Map !== "function") {
            showStatus("新しい地図エンジンを読み込めませんでした。通信環境を確認してください。", true);
            return null;
        }

        try {
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

            mapLibreMap.on("load", function () {
                loaded = true;
                hideStatus();
                container.classList.add("is-maplibre-loaded");
                add3DBuildings();
                createViewButton();
                if (mapLibreMap) mapLibreMap.resize();
                scheduleOverlayProjection();
                console.info("[Fushimi Map Test] MapLibre 3D + OpenFreeMap Positron loaded.");
            });

            mapLibreMap.on("style.load", function () {
                add3DBuildings();
            });

            mapLibreMap.on("error", function (event) {
                const message = event && event.error && event.error.message;
                console.warn("[Fushimi Map Test] MapLibre error:", message || event);
                if (!loaded) showStatus("地図データを読み込めません。通信環境を確認して再読み込みしてください。", true);
            });

            mapLibreMap.on("dragstart", notifyUserMapGesture);
            mapLibreMap.on("rotatestart", notifyUserMapGesture);
            mapLibreMap.on("pitchstart", notifyUserMapGesture);
            mapLibreMap.on("move", updateViewButton);
            mapLibreMap.on("render", scheduleOverlayProjection);

            const retry = retryButton();
            if (retry) {
                retry.addEventListener("click", function () {
                    showStatus("地図を再読み込みしています…", false);
                    if (mapLibreMap) mapLibreMap.setStyle(STYLE_URL);
                });
            }
            return mapLibreMap;
        } catch (error) {
            console.error("[Fushimi Map Test] MapLibre initialization failed:", error);
            showStatus("このブラウザでは新しい地図を起動できませんでした。WebGL対応ブラウザで開いてください。", false);
            return null;
        }
    }

    function bindLeaflet(leaflet) {
        leafletMap = leaflet;
        if (!mapLibreMap || !leafletMap) return false;

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
                Math.abs(leafletMap.getZoom() - zoom) < 0.005) {
                scheduleOverlayProjection();
                return;
            }
            syncLock = "maplibre";
            try {
                leafletMap.setView([center.lat, center.lng], zoom, { animate: false });
            } finally {
                syncLock = null;
            }
            scheduleOverlayProjection();
        }

        function syncMapLibreFromLeaflet() {
            if (syncLock === "maplibre") return;
            const center = leafletMap.getCenter();
            const zoom = leafletMap.getZoom() - LEAFLET_ZOOM_OFFSET;
            const current = mapLibreMap.getCenter();
            if (closeEnough(current.lat, center.lat) &&
                closeEnough(current.lng, center.lng) &&
                Math.abs(mapLibreMap.getZoom() - zoom) < 0.005) {
                scheduleOverlayProjection();
                return;
            }
            syncLock = "leaflet";
            try {
                // Omitted pitch/bearing preserve the current MapLibre 3D camera.
                mapLibreMap.jumpTo({ center: [center.lng, center.lat], zoom });
            } finally {
                syncLock = null;
            }
            scheduleOverlayProjection();
        }

        mapLibreMap.on("move", syncLeafletFromMapLibre);
        leafletMap.on("move", syncMapLibreFromLeaflet);
        leafletMap.on("moveend zoomend viewreset resize layeradd layerremove", scheduleOverlayProjection);

        // Re-emit a background tap as a Leaflet map click so old dismissal logic remains intact.
        mapLibreMap.on("click", function (event) {
            if (!leafletMap || !window.L) return;
            const rect = leafletMap.getContainer().getBoundingClientRect();
            const original = event.originalEvent || null;
            const point = original && Number.isFinite(original.clientX)
                ? window.L.point(original.clientX - rect.left, original.clientY - rect.top)
                : leafletMap.latLngToContainerPoint([event.lngLat.lat, event.lngLat.lng]);
            leafletMap.fire("click", {
                latlng: window.L.latLng(event.lngLat.lat, event.lngLat.lng),
                containerPoint: point,
                layerPoint: leafletMap.containerPointToLayerPoint(point),
                originalEvent: original
            });
        });

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

    function followLocation(location) {
        if (!mapLibreMap || !location) return;
        const options = {
            center: [Number(location.lng), Number(location.lat)],
            pitch: NAVIGATION_PITCH,
            duration: 520,
            essential: true
        };
        const heading = Number(location.heading);
        const speed = Number(location.speed);
        const hasHeading = location.heading !== null && location.heading !== undefined && Number.isFinite(heading);
        if (hasHeading && heading >= 0 && speed > 0.8) options.bearing = heading;
        programmaticCameraMove = true;
        mapLibreMap.easeTo(options);
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, 1500);
    }

    function setNavigationMode(enabled) {
        if (!mapLibreMap) return;
        programmaticCameraMove = true;
        mapLibreMap.easeTo({ pitch: enabled ? NAVIGATION_PITCH : DEFAULT_PITCH, duration: 550, essential: true });
        mapLibreMap.once("moveend", function () { programmaticCameraMove = false; });
        window.setTimeout(function () { programmaticCameraMove = false; }, 1500);
    }

    window.FushimiMapEngine = {
        createMap,
        bindLeaflet,
        resize,
        getMap: function () { return mapLibreMap; },
        getStyleUrl: function () { return STYLE_URL; },
        projectLatLng,
        followLocation,
        setNavigationMode,
        setPitch: function (pitch) { if (mapLibreMap) mapLibreMap.easeTo({ pitch: Math.max(0, Math.min(MAX_PITCH, Number(pitch) || 0)), duration: 550 }); }
    };
})();
