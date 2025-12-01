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
const TILE_SIZE = 8;
const MAX_TILE_RATIO = 0.6; // Fall back to full frame if >60% pixels change
const MAX_TILE_COUNT = 200; // Or if too many tiles would be sent

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
    const diff = extractDirtyTiles(current, lastPixels, width, height);
    if (!diff) {
        return;
    }
    lastPixels = current.slice();
    transmitPayload(diff);
    lastFrameSentAt = now;
}

function transmitPayload(diff) {
    if (!isSocketOpen() || targetUUIDs.length === 0 || !diff) return;
    if (diff.isFullFrame) {
        sendPayloadToAll(diff.pixels, null, true);
        return;
    }
    if (!Array.isArray(diff.tiles) || diff.tiles.length === 0) {
        return;
    }
    diff.tiles.forEach((tile) => {
        sendPayloadToAll(tile.pixels, tile.region, false);
    });
}

function isSocketOpen() {
    return ws && ws.readyState === WebSocket.OPEN;
}

function sendPayloadToAll(pixelsArray, region, isFullFrame) {
    const serializedPixels = Array.from(pixelsArray);
    const basePayload = {
        webviewuuid: TARGET_WEBVIEWUUID,
        senderId,
        uuids: targetUUIDs.slice(),
        pixels: serializedPixels,
        isFullFrame,
        fullWidth: width,
        fullHeight: height
    };
    if (region) {
        basePayload.region = region;
    }
    ws.send(JSON.stringify(basePayload));
}

function extractDirtyTiles(current, previous, canvasWidth, canvasHeight) {
    const tilesX = Math.ceil(canvasWidth / TILE_SIZE);
    const tilesY = Math.ceil(canvasHeight / TILE_SIZE);
    const totalPixels = canvasWidth * canvasHeight;
    const changedTiles = [];
    let changedPixels = 0;

    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const startX = tx * TILE_SIZE;
            const startY = ty * TILE_SIZE;
            const tileWidth = Math.min(TILE_SIZE, canvasWidth - startX);
            const tileHeight = Math.min(TILE_SIZE, canvasHeight - startY);
            if (tileWidth <= 0 || tileHeight <= 0) {
                continue;
            }
            if (tileIsDirty(current, previous, canvasWidth, startX, startY, tileWidth, tileHeight)) {
                const pixels = copyRegionPixels(current, canvasWidth, startX, startY, tileWidth, tileHeight);
                changedTiles.push({
                    region: { x: startX, y: startY, width: tileWidth, height: tileHeight },
                    pixels
                });
                changedPixels += tileWidth * tileHeight;
            }
        }
    }

    if (!changedTiles.length) {
        return null;
    }

    const changeRatio = changedPixels / totalPixels;
    if (changeRatio >= MAX_TILE_RATIO || changedTiles.length > MAX_TILE_COUNT) {
        return { isFullFrame: true, pixels: current };
    }

    return { isFullFrame: false, tiles: changedTiles };
}

function tileIsDirty(current, previous, canvasWidth, startX, startY, regionWidth, regionHeight) {
    for (let y = 0; y < regionHeight; y++) {
        const baseIndex = ((startY + y) * canvasWidth + startX) * 4;
        for (let x = 0; x < regionWidth; x++) {
            const idx = baseIndex + x * 4;
            if (
                current[idx] !== previous[idx] ||
                current[idx + 1] !== previous[idx + 1] ||
                current[idx + 2] !== previous[idx + 2] ||
                current[idx + 3] !== previous[idx + 3]
            ) {
                return true;
            }
        }
    }
    return false;
}

function copyRegionPixels(sourcePixels, canvasWidth, startX, startY, regionWidth, regionHeight) {
    const buffer = new Uint8ClampedArray(regionWidth * regionHeight * 4);
    const rowStride = regionWidth * 4;
    for (let row = 0; row < regionHeight; row++) {
        const srcIndex = ((startY + row) * canvasWidth + startX) * 4;
        const destIndex = row * rowStride;
        buffer.set(sourcePixels.subarray(srcIndex, srcIndex + rowStride), destIndex);
    }
    return buffer;
}
