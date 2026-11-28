/* Fushimi Inari Smart Guide — optional pedestrian dead-reckoning sensors (V206)
 * Motion/compass sensors are used only after an explicit user action and only
 * while navigation is active. This module estimates steps and device heading;
 * route-constrained position integration lives in planner.js.
 */
(function () {
    "use strict";

    const state = {
        attached: false,
        permissionGranted: false,
        motionAvailable: false,
        orientationAvailable: false,
        onStep: null,
        onHeading: null,
        onStatus: null,
        lastStepAt: 0,
        peakLatched: false,
        lowPassMagnitude: 9.81,
        lastHeading: null,
        stepLengthMeters: 0.70,
        motionEvents: 0,
        orientationEvents: 0
    };

    function report(status, detail) {
        if (typeof state.onStatus === "function") {
            try { state.onStatus(status, detail || ""); } catch (_) {}
        }
    }

    function normalizeHeading(value) {
        if (!Number.isFinite(value)) return null;
        return ((value % 360) + 360) % 360;
    }

    function onOrientation(event) {
        state.orientationEvents += 1;
        let heading = null;

        // iOS Safari exposes a calibrated compass heading directly.
        if (Number.isFinite(Number(event.webkitCompassHeading))) {
            heading = Number(event.webkitCompassHeading);
        } else if (event.absolute === true && Number.isFinite(Number(event.alpha))) {
            // W3C absolute orientation: alpha is measured counter-clockwise from north.
            heading = 360 - Number(event.alpha);
        }

        heading = normalizeHeading(heading);
        if (heading === null) return;
        state.lastHeading = heading;
        if (typeof state.onHeading === "function") {
            try { state.onHeading(heading); } catch (_) {}
        }
        if (state.orientationEvents === 1) report("ready", "方角センサーを検出しました");
    }

    function onMotion(event) {
        state.motionEvents += 1;
        const linear = event.acceleration;
        const gravity = event.accelerationIncludingGravity;
        let magnitude = null;
        let useLinear = false;

        if (linear && [linear.x, linear.y, linear.z].every(Number.isFinite)) {
            magnitude = Math.hypot(linear.x, linear.y, linear.z);
            useLinear = true;
        } else if (gravity && [gravity.x, gravity.y, gravity.z].every(Number.isFinite)) {
            magnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
        }
        if (!Number.isFinite(magnitude)) return;

        const now = performance.now();
        if (useLinear) {
            // Linear acceleration already excludes gravity. A short peak latch
            // avoids counting a single footfall several times.
            if (magnitude < 0.42) state.peakLatched = false;
            if (magnitude > 1.15 && !state.peakLatched && now - state.lastStepAt >= 360) {
                state.peakLatched = true;
                state.lastStepAt = now;
                if (typeof state.onStep === "function") {
                    try { state.onStep(state.stepLengthMeters, state.lastHeading); } catch (_) {}
                }
            }
        } else {
            // With gravity included, remove the slowly changing gravity baseline.
            state.lowPassMagnitude = state.lowPassMagnitude * 0.92 + magnitude * 0.08;
            const dynamicAcceleration = Math.abs(magnitude - state.lowPassMagnitude);
            if (dynamicAcceleration < 0.22) state.peakLatched = false;
            if (dynamicAcceleration > 0.78 && !state.peakLatched && now - state.lastStepAt >= 360) {
                state.peakLatched = true;
                state.lastStepAt = now;
                if (typeof state.onStep === "function") {
                    try { state.onStep(state.stepLengthMeters, state.lastHeading); } catch (_) {}
                }
            }
        }

        if (state.motionEvents === 1) report("ready", "歩行センサーを検出しました");
    }

    function attach() {
        if (state.attached) return;
        window.addEventListener("devicemotion", onMotion, { passive: true });
        window.addEventListener("deviceorientationabsolute", onOrientation, { passive: true });
        window.addEventListener("deviceorientation", onOrientation, { passive: true });
        state.attached = true;
        report("listening", "端末の歩行・方角センサーを確認しています");
    }

    async function requestPermission() {
        if (window.isSecureContext === false) {
            report("unsupported", "センサー利用にはHTTPS接続が必要です。GitHub PagesのHTTPSで開いてください");
            return { granted: false, reason: "insecure-context" };
        }
        const Motion = window.DeviceMotionEvent;
        const Orientation = window.DeviceOrientationEvent;
        if (!Motion && !Orientation) {
            report("unsupported", "この端末・ブラウザはモーションセンサーに対応していません");
            return { granted: false, reason: "unsupported" };
        }

        try {
            const requests = [];
            if (Motion && typeof Motion.requestPermission === "function") {
                requests.push(Promise.resolve(Motion.requestPermission()));
            }
            if (Orientation && typeof Orientation.requestPermission === "function") {
                requests.push(Promise.resolve(Orientation.requestPermission()));
            }
            const results = await Promise.all(requests);
            if (results.some(value => value !== "granted")) {
                report("denied", "センサーの利用が許可されませんでした。GPSで案内を続けます");
                return { granted: false, reason: "denied" };
            }
            state.permissionGranted = true;
            attach();
            report("listening", "センサーを起動しました。歩行を検出しています");
            return { granted: true };
        } catch (error) {
            report("denied", "センサーを起動できませんでした。GPSで案内を続けます");
            return { granted: false, reason: "error", error };
        }
    }

    function start(callbacks) {
        const options = callbacks || {};
        state.onStep = typeof options.onStep === "function" ? options.onStep : state.onStep;
        state.onHeading = typeof options.onHeading === "function" ? options.onHeading : state.onHeading;
        state.onStatus = typeof options.onStatus === "function" ? options.onStatus : state.onStatus;
        if (state.permissionGranted) attach();
        return state.permissionGranted;
    }

    function stop() {
        if (state.attached) {
            window.removeEventListener("devicemotion", onMotion);
            window.removeEventListener("deviceorientationabsolute", onOrientation);
            window.removeEventListener("deviceorientation", onOrientation);
        }
        state.attached = false;
        state.onStep = null;
        state.onHeading = null;
        state.onStatus = null;
        state.lastStepAt = 0;
        state.peakLatched = false;
        state.motionEvents = 0;
        state.orientationEvents = 0;
        state.lastHeading = null;
    }

    window.FushimiPDR = {
        requestPermission,
        start,
        stop,
        isActive: () => state.attached,
        getHeading: () => state.lastHeading,
        getStepLength: () => state.stepLengthMeters,
        setStepLength: value => {
            const length = Number(value);
            if (Number.isFinite(length)) state.stepLengthMeters = Math.max(0.45, Math.min(0.95, length));
        }
    };

    // V208: Start MapLibre automatically when planner.js creates its Leaflet map.
    // The previous page loaded the MapLibre engine but never called createMap(),
    // leaving #maplibreBase empty until a user ran the method manually in DevTools.
    function installMapEngineAutoStart() {
        const leaflet = window.L;
        const engine = window.FushimiMapEngine;

        if (!leaflet || typeof leaflet.map !== "function" || !engine ||
            typeof engine.createMap !== "function" || typeof engine.bindLeaflet !== "function") {
            // Deferred scripts normally make these available before this module,
            // but retain a one-shot fallback for unusual loading conditions.
            window.addEventListener("DOMContentLoaded", installMapEngineAutoStart, { once: true });
            return;
        }

        if (leaflet.map.__fushimiMapEngineAutoStart === true) return;

        const originalMapFactory = leaflet.map;
        function wrappedMapFactory() {
            const args = arguments;
            const leafletMap = originalMapFactory.apply(this, args);
            const target = typeof args[0] === "string"
                ? document.getElementById(args[0])
                : args[0];

            // This hook is only for the planner's main map; other Leaflet maps
            // remain untouched.
            if (!target || target.id !== "map") return leafletMap;

            const startMapLibre = function () {
                try {
                    const mapLibreMap = engine.getMap?.() || engine.createMap();
                    if (!mapLibreMap) {
                        console.error("[Fushimi Map] Automatic MapLibre startup failed; Leaflet fallback remains available.");
                        return;
                    }

                    const bound = engine.bindLeaflet(leafletMap);
                    if (!bound) {
                        console.error("[Fushimi Map] MapLibre was created, but Leaflet overlay binding failed.");
                        return;
                    }

                    // This class activates the existing V183+ CSS that hides
                    // the old raster tile pane and displays the MapLibre canvas.
                    target.classList.add("maplibre-active");
                    engine.resize?.();
                    leafletMap.invalidateSize?.({ pan: false });

                    console.info("[Fushimi Map] MapLibre automatically created and connected to Leaflet.");
                    window.dispatchEvent(new CustomEvent("fushimi:map-engine-ready", {
                        detail: { map: mapLibreMap, leafletMap }
                    }));
                } catch (error) {
                    console.error("[Fushimi Map] Automatic map startup failed:", error);
                }
            };

            // Run after planner.js finishes its chained L.map(...).setView(...)
            // call, so both map engines begin from the same initial coordinates.
            if (typeof queueMicrotask === "function") {
                queueMicrotask(startMapLibre);
            } else {
                Promise.resolve().then(startMapLibre);
            }

            return leafletMap;
        }

        wrappedMapFactory.__fushimiMapEngineAutoStart = true;
        wrappedMapFactory.__fushimiOriginalFactory = originalMapFactory;
        leaflet.map = wrappedMapFactory;
    }

    installMapEngineAutoStart();
})();
