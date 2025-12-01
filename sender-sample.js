/*
 * Sample p5 sender sketch that transmits only changed pixels.
 * Replace TARGET_UUID and TARGET_WEBVIEWUUID with your own values.
 */
let ws;
const WS_ADDRESS = 'ws://localhost:3001';
const TARGET_UUID = 'replace_me';
const TARGET_WEBVIEWUUID = 'replace_me';
const TARGET_FPS = 15;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
const senderId = Math.random().toString(36).slice(2);
let reconnectTimeout = null;
let reconnecting = false;
let lastFrameSentAt = 0;
let lastSentPixels = null;
let pendingPayload = null;
let throttleTimer = null;

function connectWS() {
    if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        try { ws.close(); } catch (e) { }
        ws = null;
    }
    ws = new WebSocket(WS_ADDRESS);
    ws.onopen = () => {
        reconnecting = false;
        console.log('[Sender] WebSocket opened');
        lastFrameSentAt = 0;
        lastSentPixels = null;
    };
    ws.onclose = () => {
        if (!reconnecting) {
            reconnecting = true;
            reconnectTimeout = setTimeout(connectWS, 3000);
        }
        console.log('[Sender] WebSocket closed');
    };
    ws.onerror = (err) => {
        console.log('[Sender] WebSocket error', err);
    };
    ws.onmessage = (event) => {
        console.log('[Sender] Message from server:', event.data);
    };
}

function setup() {
    pixelDensity(1);
    createCanvas(1280, 720);
    background(255);
    connectWS();
}

function draw() {
    if (frameCount % 60 === 0) {
        background(random(255), random(255), random(255));
    }
    sendPixelsIfNeeded();
}

function sendPixelsIfNeeded() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    loadPixels();
    const current = new Uint8ClampedArray(pixels);
    if (!lastSentPixels) {
        queuePayload({ isFullFrame: true, pixels: current, frameSnapshot: current });
        return;
    }
    const diff = extractDirtyRegion(current, lastSentPixels, width, height);
    if (!diff) {
        return;
    }
    diff.frameSnapshot = current;
    queuePayload(diff);
}

function queuePayload(diff) {
    pendingPayload = diff;
    scheduleFlush();
}

function scheduleFlush() {
    if (throttleTimer) return;
    const now = performance.now();
    const wait = Math.max(0, FRAME_INTERVAL - (now - lastFrameSentAt));
    if (wait <= 0) {
        flushPendingPixels();
        return;
    }
    throttleTimer = setTimeout(() => {
        throttleTimer = null;
        flushPendingPixels();
    }, wait);
}

function flushPendingPixels() {
    if (!pendingPayload) {
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingPayload = null;
        return;
    }
    const payload = pendingPayload;
    pendingPayload = null;
    transmitPayload(payload);
    lastFrameSentAt = performance.now();
    if (pendingPayload) {
        scheduleFlush();
    }
}

function transmitPayload(diff) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = {
        webviewuuid: TARGET_WEBVIEWUUID,
        uuid: TARGET_UUID,
        senderId,
        pixels: Array.from(diff.pixels),
        isFullFrame: !!diff.isFullFrame,
        fullWidth: width,
        fullHeight: height
    };
    if (diff.region) {
        payload.region = diff.region;
    }
    ws.send(JSON.stringify(payload));
    if (diff.frameSnapshot) {
        lastSentPixels = diff.frameSnapshot;
    }
}

function extractDirtyRegion(current, previous, canvasWidth, canvasHeight) {
    let minX = canvasWidth;
    let minY = canvasHeight;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < current.length; i += 4) {
        if (
            current[i] !== previous[i] ||
            current[i + 1] !== previous[i + 1] ||
            current[i + 2] !== previous[i + 2] ||
            current[i + 3] !== previous[i + 3]
        ) {
            const pixelIndex = i / 4;
            const x = pixelIndex % canvasWidth;
            const y = Math.floor(pixelIndex / canvasWidth);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX === -1 || maxY === -1) {
        return null;
    }
    const regionWidth = maxX - minX + 1;
    const regionHeight = maxY - minY + 1;
    const rowStride = regionWidth * 4;
    const regionPixels = new Uint8ClampedArray(regionWidth * regionHeight * 4);
    for (let row = 0; row < regionHeight; row++) {
        const srcIndex = ((minY + row) * canvasWidth + minX) * 4;
        const destIndex = row * rowStride;
        regionPixels.set(current.subarray(srcIndex, srcIndex + rowStride), destIndex);
    }
    const coversFullFrame = minX === 0 && minY === 0 && maxX === canvasWidth - 1 && maxY === canvasHeight - 1;
    return {
        region: coversFullFrame ? null : { x: minX, y: minY, width: regionWidth, height: regionHeight },
        pixels: coversFullFrame ? current : regionPixels,
        isFullFrame: coversFullFrame
    };
}
