/*
 * Fushimi Inari Smart Guide — experimental pedestrian dead reckoning.
 * Optional sensor-assisted positioning. Permission is requested from the navigation-start
 * tap when the browser requires it. Unsupported/denied sensors silently fall back to GPS.
 * Output is a short-term estimate, not a GPS fix; drift accumulates with every step.
 */
(function () {
    "use strict";
    let active = false;
    let lastPosition = null;
    let headingDegrees = null;
    let headingSource = "none";
    let stepCount = 0;
    let lastStepAt = 0;
    let gravityMagnitude = 9.81;
    let smoothedSignal = 0;
    let armed = true;
    let lastStepInterval = 0;
    let lastEmitted = 0;
    const listeners = { motion: null, orientation: null, orientationAbsolute: null };

    function normalizeHeading(value) {
        if (!Number.isFinite(value)) return null;
        return ((value % 360) + 360) % 360;
    }

    function smoothHeading(next) {
        const value = normalizeHeading(next);
        if (value === null) return;
        if (headingDegrees === null) {
            headingDegrees = value;
            return;
        }
        const diff = ((value - headingDegrees + 540) % 360) - 180;
        headingDegrees = normalizeHeading(headingDegrees + diff * 0.22);
    }

    function readOrientation(event) {
        if (!event) return;
        const rawWebkitHeading = event.webkitCompassHeading;
        const webkitHeading = Number(rawWebkitHeading);
        if (rawWebkitHeading !== null && rawWebkitHeading !== undefined && Number.isFinite(webkitHeading)) {
            smoothHeading(webkitHeading);
            headingSource = "webkitCompassHeading";
            return;
        }
        const rawAlpha = event.alpha;
        const alpha = Number(rawAlpha);
        if (rawAlpha !== null && rawAlpha !== undefined && Number.isFinite(alpha) && (event.absolute === true || event.type === "deviceorientationabsolute")) {
            const screenAngle = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0) || 0;
            smoothHeading(360 - alpha + screenAngle);
            headingSource = "absolute-alpha";
        }
    }

    function metersToCoordinate(position, meters, heading) {
        const radians = heading * Math.PI / 180;
        const northMeters = Math.cos(radians) * meters;
        const eastMeters = Math.sin(radians) * meters;
        const lat = position.lat + northMeters / 111320;
        const lng = position.lng + eastMeters / (111320 * Math.max(0.15, Math.cos(position.lat * Math.PI / 180)));
        return { lat, lng };
    }

    function estimateStride(intervalMs) {
        // Generic adult walking stride estimate. Individual gait varies; this is approximate.
        if (intervalMs > 0 && intervalMs < 430) return 0.72;
        if (intervalMs > 0 && intervalMs > 850) return 0.56;
        return 0.64;
    }

    function emitPosition() {
        if (!active || !lastPosition || headingDegrees === null) return;
        const anchorAccuracy = Number(lastPosition.accuracy || 12);
        const accuracy = Math.min(90, Math.max(anchorAccuracy, 12 + stepCount * 0.18));
        const detail = {
            lat: lastPosition.lat,
            lng: lastPosition.lng,
            heading: headingDegrees,
            accuracy,
            steps: stepCount,
            source: "pdr-estimate",
            headingSource
        };
        window.dispatchEvent(new CustomEvent("fushimi:pdr-position", { detail }));
    }

    function readMotion(event) {
        if (!active || !event) return;
        const acceleration = event.accelerationIncludingGravity || event.acceleration;
        if (!acceleration) return;
        const x = Number(acceleration.x || 0);
        const y = Number(acceleration.y || 0);
        const z = Number(acceleration.z || 0);
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (!Number.isFinite(magnitude)) return;
        const hasGravity = !!event.accelerationIncludingGravity;
        if (hasGravity) {
            gravityMagnitude = gravityMagnitude * 0.92 + magnitude * 0.08;
        }
        const rawSignal = hasGravity ? magnitude - gravityMagnitude : magnitude;
        smoothedSignal = smoothedSignal * 0.68 + rawSignal * 0.32;
        const now = Date.now();
        if (smoothedSignal < 0.24) armed = true;
        if (!armed || smoothedSignal < 1.05 || now - lastStepAt < 300) return;

        armed = false;
        const interval = lastStepAt ? now - lastStepAt : 0;
        if (interval > 0 && interval < 2000) lastStepInterval = interval;
        lastStepAt = now;
        stepCount += 1;
        if (headingDegrees === null || !lastPosition) return;

        const moved = metersToCoordinate(lastPosition, estimateStride(lastStepInterval), headingDegrees);
        lastPosition = { ...lastPosition, ...moved };
        if (now - lastEmitted > 120) {
            lastEmitted = now;
            emitPosition();
        }
    }

    function supportsMotion() {
        return ("DeviceMotionEvent" in window) || ("ondevicemotion" in window);
    }

    function supportsOrientation() {
        return ("DeviceOrientationEvent" in window) || ("ondeviceorientation" in window);
    }

    function supportsSensors() {
        // Motion is the minimum requirement for step detection. Heading can be
        // supplied by the compass when available or by GPS course as a fallback.
        return supportsMotion();
    }

    async function requestPermission() {
        if (!supportsMotion()) return { granted: false, orientationGranted: false };
        if (!window.isSecureContext && location.hostname !== "localhost") {
            return { granted: false, orientationGranted: false };
        }
        try {
            // Invoke all platform permission methods before awaiting so iOS keeps
            // the transient user activation from the navigation-start tap.
            const tasks = [];
            let motionTaskIndex = -1;
            let orientationTaskIndex = -1;
            if (typeof window.DeviceMotionEvent?.requestPermission === "function") {
                motionTaskIndex = tasks.length;
                try { tasks.push(Promise.resolve(window.DeviceMotionEvent.requestPermission())); }
                catch (error) { tasks.push(Promise.reject(error)); }
            }
            if (supportsOrientation() && typeof window.DeviceOrientationEvent?.requestPermission === "function") {
                orientationTaskIndex = tasks.length;
                try { tasks.push(Promise.resolve(window.DeviceOrientationEvent.requestPermission())); }
                catch (error) { tasks.push(Promise.reject(error)); }
            }
            const results = await Promise.allSettled(tasks);
            const statusAt = (index) => index < 0 ? "granted" :
                (results[index]?.status === "fulfilled" ? results[index].value : "denied");
            const motionGranted = statusAt(motionTaskIndex) === "granted";
            const orientationGranted = statusAt(orientationTaskIndex) === "granted";
            return { granted: motionGranted, orientationGranted };
        } catch (error) {
            console.debug("Optional walking sensors unavailable; using GPS only.", error);
            return { granted: false, orientationGranted: false };
        }
    }

    function start(seed) {
        const lat = Number(seed?.lat);
        const lng = Number(seed?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        stop();
        lastPosition = { lat, lng, accuracy: Number(seed?.accuracy || 20) };
        headingDegrees = null;
        headingSource = "none";
        if (seed?.heading !== null && seed?.heading !== undefined && Number.isFinite(Number(seed.heading))) headingDegrees = normalizeHeading(Number(seed.heading));
        stepCount = 0;
        lastStepAt = 0;
        lastStepInterval = 0;
        gravityMagnitude = 9.81;
        smoothedSignal = 0;
        armed = true;
        active = true;
        listeners.motion = readMotion;
        listeners.orientation = readOrientation;
        listeners.orientationAbsolute = readOrientation;
        window.addEventListener("devicemotion", listeners.motion, { passive: true });
        window.addEventListener("deviceorientation", listeners.orientation, { passive: true });
        window.addEventListener("deviceorientationabsolute", listeners.orientationAbsolute, { passive: true });
        return true;
    }

    function reanchor(position) {
        const lat = Number(position?.lat);
        const lng = Number(position?.lng);
        if (!active || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        lastPosition = { lat, lng, accuracy: Number(position.accuracy || 15) };
        if (position.heading !== null && position.heading !== undefined && Number.isFinite(Number(position.heading))) smoothHeading(Number(position.heading));
        return true;
    }

    function stop() {
        if (listeners.motion) window.removeEventListener("devicemotion", listeners.motion);
        if (listeners.orientation) window.removeEventListener("deviceorientation", listeners.orientation);
        if (listeners.orientationAbsolute) window.removeEventListener("deviceorientationabsolute", listeners.orientationAbsolute);
        listeners.motion = listeners.orientation = listeners.orientationAbsolute = null;
        active = false;
    }

    window.FushimiWalkingPDR = {
        requestPermission,
        start,
        stop,
        reanchor,
        isSupported: supportsSensors,
        isRunning: () => active,
        getPosition: () => lastPosition ? { ...lastPosition, heading: headingDegrees, steps: stepCount } : null
    };
})();
