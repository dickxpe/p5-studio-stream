/*
 * Sample p5 sender sketch that transmits only changed pixels.
 * Replace TARGET_WEBVIEWUUID with your own value.
 */
const DEFAULT_UUIDS = Array.from({ length: 100 }, (_, i) => String(i));
const WS_ADDRESS = 'ws://localhost:3001';
const TARGET_WEBVIEWUUID = 'testuuid';
const TARGET_FPS = 30;
const senderId = Math.random().toString(36).slice(2);
let lastFrameSentAt = 0;
let lastPixels = null;
let ws = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 1000;
let targetUUIDs = [...DEFAULT_UUIDS];

async function refreshUUIDs() {
    try {
        const resp = await fetch(`/uuids/${TARGET_WEBVIEWUUID}`);
        if (!resp.ok) {
            throw new Error(`Unexpected status ${resp.status}`);
        }
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
            targetUUIDs = data.map((value) => String(value));
            console.log(`[Sender] Loaded ${targetUUIDs.length} UUIDs from server`);
            return;
        }
        console.warn('[Sender] UUID response empty, falling back to defaults');
    } catch (err) {
        console.warn('[Sender] Failed to load UUIDs, using defaults', err);
    }
    targetUUIDs = [...DEFAULT_UUIDS];
}

const myShape = {
    x: 100,
    y: 50,
    w: 50,
    h: 50,
    c: 250
};

function connectWS() {
    if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        try { ws.close(); } catch (e) { }
    }
    ws = new WebSocket(WS_ADDRESS);
    ws.onopen = () => {
        console.log('[Sender] Multiplex socket opened');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };
    ws.onclose = (evt) => {
        console.log('[Sender] Multiplex socket closed', evt.code, evt.reason);
        ws = null;
        scheduleReconnect();
    };
    ws.onerror = (err) => {
        console.warn('[Sender] Multiplex socket error', err);
    };
    ws.onmessage = (event) => {
        console.log('[Sender] Message from server:', event.data);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWS();
    }, RECONNECT_DELAY_MS);
}

function setup() {
    pixelDensity(1);
    createCanvas(200, 200);
    background(255);
    refreshUUIDs().finally(connectWS);

    p5.tween.manager.addTween(myShape, 'tween1')
        .addMotions([
            { key: 'y', target: height },
            { key: 'w', target: 30 },
            { key: 'h', target: 80 },
        ], 600, 'easeInQuad')
        .addMotions([
            { key: 'w', target: 100 },
            { key: 'h', target: 10 },
        ], 120)
        .addMotions([
            { key: 'w', target: 10 },
            { key: 'h', target: 100 },
        ], 100)
        .addMotions([
            { key: 'w', target: 50 },
            { key: 'h', target: 50 },
            { key: 'y', target: 100 }
        ], 500, 'easeOutQuad')
        .onLoop((tween) => myShape.c = random(0, 255))
        .startLoop();
}

function draw() {
    if (frameCount % 2 === 0) {
        background(250);
        noStroke();
        fill(myShape.c, 125, 125);
        ellipse(myShape.x, myShape.y, myShape.w, myShape.h);
    }
    sendPixelsIfNeeded();

}

function sendPixelsIfNeeded() {
    if (!isSocketOpen()) return;
    const now = performance.now();
    const minInterval = 1000 / TARGET_FPS;
    if (now - lastFrameSentAt < minInterval) {
        return;
    }
    loadPixels();
    const current = new Uint8ClampedArray(pixels);
    if (!lastPixels) {
        lastPixels = current.slice();
        transmitPayload({ isFullFrame: true, pixels: current });
        lastFrameSentAt = now;
        return;
    }
    const diff = extractDirtyRegion(current, lastPixels, width, height);
    if (!diff) {
        return;
    }
    lastPixels = current.slice();
    transmitPayload(diff);
    lastFrameSentAt = now;
}

function transmitPayload(diff) {
    if (!isSocketOpen() || targetUUIDs.length === 0) return;
    const serializedPixels = Array.from(diff.pixels);
    const basePayload = {
        webviewuuid: TARGET_WEBVIEWUUID,
        senderId,
        pixels: serializedPixels,
        isFullFrame: !!diff.isFullFrame,
        fullWidth: width,
        fullHeight: height
    };
    if (diff.region) {
        basePayload.region = diff.region;
    }
    targetUUIDs.forEach((uuid) => {
        const payload = { ...basePayload, uuid };
        ws.send(JSON.stringify(payload));
    });
}

function isSocketOpen() {
    return ws && ws.readyState === WebSocket.OPEN;
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
