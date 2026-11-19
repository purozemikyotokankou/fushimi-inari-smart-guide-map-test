/* Fushimi Inari Smart Guide — MapLibre basemap bridge (test environment)
 * MapLibre renders the vector basemap. Existing Leaflet markers, route geometry,
 * popups, and spot interactions remain as a transparent compatibility overlay.
 * Camera gestures are handled by MapLibre and mirrored into Leaflet so overlays
 * stay aligned. Pitch and rotation are intentionally locked until all overlays
 * are migrated to native MapLibre layers.
 */
(function () {
    "use strict";

    const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
    const DEFAULT_CENTER = [135.77865108489644, 34.96788994013442];
    // MapLibre GL uses 512px world tiles while Leaflet uses 256px tiles.
    // One MapLibre zoom level lower matches the same visible scale.
    const LEAFLET_ZOOM_OFFSET = 1;
    const DEFAULT_ZOOM = 17;

    let mapLibreMap = null;
    let leafletMap = null;
    let syncLock = null;
    let loaded = false;

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
        window.dispatchEvent(new CustomEvent("fushimi:map-user-moved"));
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
                pitch: 0,
                bearing: 0,
                maxPitch: 0,
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                scrollZoom: true,
                doubleClickZoom: true,
                attributionControl: { compact: false },
                renderWorldCopies: false,
                cooperativeGestures: false
            });

            if (mapLibreMap.dragRotate) mapLibreMap.dragRotate.disable();
            if (mapLibreMap.touchZoomRotate && mapLibreMap.touchZoomRotate.disableRotation) {
                mapLibreMap.touchZoomRotate.disableRotation();
            }

            mapLibreMap.on("load", function () {
                loaded = true;
                hideStatus();
                container.classList.add("is-maplibre-loaded");
                if (mapLibreMap) mapLibreMap.resize();
                console.info("[Fushimi Map Test] MapLibre + OpenFreeMap Positron loaded.");
            });

            mapLibreMap.on("error", function (event) {
                const message = event && event.error && event.error.message;
                console.warn("[Fushimi Map Test] MapLibre error:", message || event);
                if (!loaded) {
                    showStatus("地図データを読み込めません。通信環境を確認して再読み込みしてください。", true);
                }
            });

            mapLibreMap.on("dragstart", notifyUserMapGesture);
            mapLibreMap.on("rotatestart", notifyUserMapGesture);
            mapLibreMap.on("pitchstart", notifyUserMapGesture);

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
                Math.abs(leafletMap.getZoom() - zoom) < 0.005) return;
            syncLock = "maplibre";
            try {
                leafletMap.setView([center.lat, center.lng], zoom, { animate: false });
            } finally {
                syncLock = null;
            }
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
                mapLibreMap.jumpTo({ center: [center.lng, center.lat], zoom, bearing: 0, pitch: 0 });
            } finally {
                syncLock = null;
            }
        }

        mapLibreMap.on("move", syncLeafletFromMapLibre);
        leafletMap.on("move", syncMapLibreFromLeaflet);
        leafletMap.on("resize", function () {
            if (mapLibreMap) mapLibreMap.resize();
        });

        // A background tap from the MapLibre canvas is re-emitted as a Leaflet
        // click so existing dismiss/selection behavior keeps working.
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
        window.setTimeout(function () { if (mapLibreMap) mapLibreMap.resize(); }, 250);
        return true;
    }

    function resize() {
        if (mapLibreMap) mapLibreMap.resize();
    }

    window.FushimiMapEngine = {
        createMap,
        bindLeaflet,
        resize,
        getMap: function () { return mapLibreMap; },
        getStyleUrl: function () { return STYLE_URL; }
    };
})();
