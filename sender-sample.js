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
let targetUUID = DEFAULT_UUIDS[0] || '0';
let lastKeyframeSentAt = 0;
let lossyCanvas = null;
let lossyCtx = null;
let lossyEncodingInFlight = false;
let lossyImageData = null;
const TILE_SIZE = 8;
const MAX_TILE_RATIO = 0.6; // Fall back to full frame if >60% pixels change
const MAX_TILE_COUNT = 200; // Or if too many tiles would be sent
const PIXEL_POOL_MAX_BUCKET = 24;
const MAX_TILE_SEND_PER_FRAME = 6; // Clamp number of regional packets so the display queue doesn't drop most of them
const KEYFRAME_INTERVAL_MS = 3000; // Force periodic full frames to heal any missed tiles
const LOSSY_SEND_DEFAULTS = {
    enabled: false,
    mimeType: 'image/webp',
    quality: 0.7,
    minDimension: 48
};

if (typeof window !== 'undefined') {
    if (typeof window.enableLossySend === 'undefined') {
        window.enableLossySend = true;
    }
    if (typeof window.lossySendOptions === 'undefined') {
        window.lossySendOptions = {
            quality: 0.6,
            mimeType: 'image/webp'
        };
    }
}
const textEncoder = new TextEncoder();

class Uint8ClampedArrayPool {
    constructor(maxPerBucket = PIXEL_POOL_MAX_BUCKET) {
        this.maxPerBucket = maxPerBucket;
        this.buckets = new Map();
    }

    acquire(length) {
        if (!Number.isFinite(length) || length <= 0) {
            return new Uint8ClampedArray(0);
        }
        const key = length;
        const bucket = this.buckets.get(key);
        if (bucket && bucket.length) {
            return bucket.pop();
        }
        return new Uint8ClampedArray(length);
    }

    release(buffer) {
        if (!(buffer instanceof Uint8ClampedArray)) {
            return;
        }
        const length = buffer.length;
        if (!length) {
            return;
        }
        const bucket = this.buckets.get(length) || [];
        if (bucket.length >= this.maxPerBucket) {
            return;
        }
        bucket.push(buffer);
        this.buckets.set(length, bucket);
    }
}

const pixelPool = new Uint8ClampedArrayPool();

async function refreshUUIDs() {
    try {
        const resp = await fetch("/uuids/" + TARGET_WEBVIEWUUID);
        if (!resp.ok) {
            throw new Error("Unexpected status " + resp.status);
        }
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
            const parsed = data
                .map((value) => {
                    if (typeof value === 'string') return value;
                    if (value && typeof value.uuid === 'string') return value.uuid;
                    return '';
                })
                .filter((entry) => typeof entry === 'string' && entry.length > 0);
            if (parsed.length) {
                targetUUID = parsed[0];
                console.log("[Sender] Loaded target UUID " + targetUUID + " from server");
                return;
            }
        }
        console.warn("[Sender] UUID response empty, falling back to default");
    } catch (err) {
        console.warn("[Sender] Failed to load UUID, using default", err);
    }
    targetUUID = DEFAULT_UUIDS[0] || '0';
}

const myShape = {
    x: 50,
    y: 50,
    w: 50,
    h: 50,
    c: 0
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
    createCanvas(100, 100);
    colorMode(HSB, 360, 100, 100);
    background(0, 100, 100);
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
        .onLoop((tween) => myShape.c = random(0, 360))
        .startLoop();
}

function draw() {
    background(frameCount % 360);
    noStroke();
    fill(myShape.c, 125, 125);
    ellipse(myShape.x, myShape.y, myShape.w, myShape.h);
    sendPixelsIfNeeded();

}

async function sendPixelsIfNeeded() {
    if (!isSocketOpen()) return;
    const now = performance.now();
    const minInterval = 1000 / TARGET_FPS;
    if (now - lastFrameSentAt < minInterval) {
        return;
    }
    const deltaMs = lastFrameSentAt > 0 ? Math.max(0, now - lastFrameSentAt) : 0;
    loadPixels();
    const pixelSource = pixels instanceof Uint8ClampedArray ? pixels : new Uint8ClampedArray(pixels);
    if (!pixelSource.length) {
        return;
    }
    const current = pixelPool.acquire(pixelSource.length);
    current.set(pixelSource);

    if (!lastPixels) {
        transmitPayload({ isFullFrame: true, pixels: current }, deltaMs);
        lastPixels = current;
        lastFrameSentAt = now;
        return;
    }

    let diff = extractDirtyTiles(current, lastPixels, width, height);
    if (!diff) {
        pixelPool.release(lastPixels);
        lastPixels = current;
        return;
    }

    const keyframeDue = now - lastKeyframeSentAt >= KEYFRAME_INTERVAL_MS;
    if (!diff.isFullFrame && keyframeDue) {
        diff = { isFullFrame: true, pixels: current };
    }


    const shouldUseLossy = shouldUseLossyEncoding(diff, width, height);
    if (shouldUseLossy && lossyEncodingInFlight) {
        pixelPool.release(lastPixels);
        lastPixels = current;
        return;
    }

    let usedLossy = false;
    try {
        if (shouldUseLossy) {
            lossyEncodingInFlight = true;
            usedLossy = await transmitLossyFullFrame(current, width, height, deltaMs);
        } else {
            transmitPayload(diff, deltaMs);
        }
    } catch (err) {
        console.warn('[Sender] Failed to transmit frame', err);
    } finally {
        if (shouldUseLossy) {
            lossyEncodingInFlight = false;
        }
    }

    releaseDiffTiles(diff);
    pixelPool.release(lastPixels);
    lastPixels = current;
    lastFrameSentAt = now;
    if (diff.isFullFrame || usedLossy) {
        lastKeyframeSentAt = now;
    }
}

function transmitPayload(diff, deltaMs) {
    if (!isSocketOpen() || !targetUUID || !diff) return;
    if (diff.isFullFrame) {
        sendPayloadToTarget(diff.pixels, null, true, deltaMs);
        return;
    }
    if (!Array.isArray(diff.tiles) || diff.tiles.length === 0) {
        return;
    }
    let firstTile = true;
    diff.tiles.forEach((tile) => {
        const tileDelta = firstTile ? deltaMs : 0;
        sendPayloadToTarget(tile.pixels, tile.region, false, tileDelta);
        firstTile = false;
    });
}

function isSocketOpen() {
    return ws && ws.readyState === WebSocket.OPEN;
}

function sendPayloadToTarget(pixelsArray, region, isFullFrame, deltaMs, metadataOverrides) {
    if (!targetUUID) {
        return;
    }
    const typedPixels = toUint8ArrayView(pixelsArray);
    const header = {
        webviewuuid: TARGET_WEBVIEWUUID,
        senderId,
        uuid: targetUUID,
        isFullFrame,
        fullWidth: width,
        fullHeight: height,
        pixelLength: typedPixels.byteLength,
        deltaMs: normalizeDelta(deltaMs)
    };
    if (region) {
        header.region = region;
    }
    if (metadataOverrides && typeof metadataOverrides === 'object') {
        Object.keys(metadataOverrides).forEach((key) => {
            const value = metadataOverrides[key];
            if (typeof value !== 'undefined') {
                header[key] = value;
            }
        });
    }
    const frame = buildBinaryFrame(header, typedPixels);
    ws.send(frame);
}

function normalizeDelta(value) {
    if (!Number.isFinite(value) || value < 0) {
        return 0;
    }
    return Math.min(2000, value);
}

function resolveLossyOptions() {
    const options = { ...LOSSY_SEND_DEFAULTS };
    if (typeof window !== 'undefined') {
        if (typeof window.enableLossySend !== 'undefined') {
            options.enabled = Boolean(window.enableLossySend);
        }
        if (window.lossySendOptions && typeof window.lossySendOptions === 'object') {
            const overrides = window.lossySendOptions;
            if (typeof overrides.enabled !== 'undefined') {
                options.enabled = Boolean(overrides.enabled);
            }
            if (typeof overrides.mimeType === 'string' && overrides.mimeType.length) {
                options.mimeType = overrides.mimeType;
            }
            if (typeof overrides.quality === 'number' && Number.isFinite(overrides.quality)) {
                options.quality = overrides.quality;
            }
            if (typeof overrides.minDimension === 'number' && Number.isFinite(overrides.minDimension)) {
                options.minDimension = overrides.minDimension;
            }
        }
    }
    options.minDimension = Math.max(16, Math.floor(options.minDimension || LOSSY_SEND_DEFAULTS.minDimension || 32));
    options.quality = Math.min(1, Math.max(0.1, options.quality));
    return options;
}

function shouldUseLossyEncoding(diff, frameWidth, frameHeight) {
    if (!diff || !diff.isFullFrame) {
        return false;
    }
    if (!diff.pixels || !diff.pixels.length) {
        return false;
    }
    const options = resolveLossyOptions();
    if (!options.enabled) {
        return false;
    }
    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) {
        return false;
    }
    if (frameWidth < options.minDimension || frameHeight < options.minDimension) {
        return false;
    }
    if (typeof OffscreenCanvas === 'undefined' && (typeof document === 'undefined' || typeof document.createElement !== 'function')) {
        return false;
    }
    return true;
}

function ensureLossyCanvasContext(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    const targetWidth = Math.max(1, Math.floor(width));
    const targetHeight = Math.max(1, Math.floor(height));
    if (!lossyCanvas) {
        if (typeof OffscreenCanvas === 'function') {
            lossyCanvas = new OffscreenCanvas(targetWidth, targetHeight);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            lossyCanvas = document.createElement('canvas');
        }
    }
    if (!lossyCanvas) {
        return null;
    }
    if (lossyCanvas.width !== targetWidth) {
        lossyCanvas.width = targetWidth;
    }
    if (lossyCanvas.height !== targetHeight) {
        lossyCanvas.height = targetHeight;
    }
    if (!lossyCtx) {
        lossyCtx = lossyCanvas.getContext('2d');
    }
    if (!lossyCtx) {
        return null;
    }
    if (!lossyImageData || lossyImageData.width !== targetWidth || lossyImageData.height !== targetHeight) {
        try {
            lossyImageData = lossyCtx.createImageData(targetWidth, targetHeight);
        } catch (err) {
            try {
                lossyImageData = new ImageData(targetWidth, targetHeight);
            } catch (err2) {
                lossyImageData = null;
            }
        }
    }
    return lossyCtx;
}

function canvasToBlob(canvas, mimeType, quality) {
    if (!canvas) {
        return Promise.resolve(null);
    }
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type: mimeType, quality });
    }
    if (typeof canvas.toBlob === 'function') {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((blob) => resolve(blob || null), mimeType, quality);
            } catch (err) {
                reject(err);
            }
        });
    }
    return Promise.resolve(null);
}

async function transmitLossyFullFrame(pixelArray, width, height, deltaMs) {
    const options = resolveLossyOptions();
    const ctx = ensureLossyCanvasContext(width, height);
    if (!ctx || !lossyCanvas || !pixelArray) {
        sendPayloadToTarget(pixelArray, null, true, deltaMs);
        return false;
    }
    const expectedLength = Math.max(1, Math.floor(width)) * Math.max(1, Math.floor(height)) * 4;
    if (pixelArray.length !== expectedLength) {
        sendPayloadToTarget(pixelArray, null, true, deltaMs);
        return false;
    }
    if (!lossyImageData || lossyImageData.width !== lossyCanvas.width || lossyImageData.height !== lossyCanvas.height) {
        try {
            lossyImageData = ctx.createImageData(lossyCanvas.width, lossyCanvas.height);
        } catch (err) {
            lossyImageData = null;
        }
    }
    let workingImageData = lossyImageData;
    if (!workingImageData) {
        try {
            workingImageData = new ImageData(lossyCanvas.width, lossyCanvas.height);
        } catch (err) {
            workingImageData = null;
        }
    }
    if (!workingImageData) {
        sendPayloadToTarget(pixelArray, null, true, deltaMs);
        return false;
    }
    workingImageData.data.set(pixelArray);
    ctx.putImageData(workingImageData, 0, 0);
    let blob;
    try {
        blob = await canvasToBlob(lossyCanvas, options.mimeType, options.quality);
    } catch (err) {
        blob = null;
    }
    if (!blob) {
        sendPayloadToTarget(pixelArray, null, true, deltaMs);
        return false;
    }
    let arrayBuffer;
    try {
        arrayBuffer = await blob.arrayBuffer();
    } catch (err) {
        arrayBuffer = null;
    }
    if (!arrayBuffer) {
        sendPayloadToTarget(pixelArray, null, true, deltaMs);
        return false;
    }
    const byteView = new Uint8Array(arrayBuffer);
    sendPayloadToTarget(byteView, null, true, deltaMs, {
        encoding: options.mimeType,
        encodedWidth: width,
        encodedHeight: height,
        lossy: true
    });
    return true;
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

    if (changedTiles.length > MAX_TILE_SEND_PER_FRAME) {
        const merged = mergeTilesIntoBoundingRegion(changedTiles, current, canvasWidth, canvasHeight);
        if (merged) {
            releaseDiffTiles({ tiles: changedTiles });
            return { isFullFrame: false, tiles: [merged] };
        }
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
    const buffer = pixelPool.acquire(regionWidth * regionHeight * 4);
    const rowStride = regionWidth * 4;
    for (let row = 0; row < regionHeight; row++) {
        const srcIndex = ((startY + row) * canvasWidth + startX) * 4;
        const destIndex = row * rowStride;
        buffer.set(sourcePixels.subarray(srcIndex, srcIndex + rowStride), destIndex);
    }
    return buffer;
}

function mergeTilesIntoBoundingRegion(tiles, sourcePixels, canvasWidth, canvasHeight) {
    if (!Array.isArray(tiles) || !tiles.length) {
        return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    tiles.forEach((tile) => {
        if (!tile || !tile.region) {
            return;
        }
        const { x = 0, y = 0, width = 0, height = 0 } = tile.region;
        if (width <= 0 || height <= 0) {
            return;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }
    const mergedWidth = Math.max(1, Math.min(canvasWidth, Math.floor(maxX - minX)));
    const mergedHeight = Math.max(1, Math.min(canvasHeight, Math.floor(maxY - minY)));
    if (!mergedWidth || !mergedHeight) {
        return null;
    }
    const originX = Math.max(0, Math.floor(minX));
    const originY = Math.max(0, Math.floor(minY));
    const pixels = copyRegionPixels(sourcePixels, canvasWidth, originX, originY, mergedWidth, mergedHeight);
    return {
        region: {
            x: originX,
            y: originY,
            width: mergedWidth,
            height: mergedHeight
        },
        pixels
    };
}

function releaseDiffTiles(diff) {
    if (!diff || diff.isFullFrame || !Array.isArray(diff.tiles)) {
        return;
    }
    diff.tiles.forEach((tile) => {
        if (tile && tile.pixels) {
            pixelPool.release(tile.pixels);
        }
    });
}

function toUint8ArrayView(source) {
    if (source instanceof Uint8Array) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (source instanceof Uint8ClampedArray) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (source instanceof ArrayBuffer) {
        return new Uint8Array(source);
    }
    if (Array.isArray(source)) {
        return Uint8Array.from(source);
    }
    if (source && typeof source.buffer === 'object') {
        try {
            return new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength || source.length || 0);
        } catch (err) {
            return new Uint8Array(0);
        }
    }
    return new Uint8Array(0);
}

function buildBinaryFrame(metadata, pixelArray) {
    const headerBytes = textEncoder.encode(JSON.stringify(metadata));
    const totalBytes = 4 + headerBytes.length + pixelArray.byteLength;
    const buffer = new ArrayBuffer(totalBytes);
    const view = new DataView(buffer);
    view.setUint32(0, headerBytes.length, false);
    const headerDest = new Uint8Array(buffer, 4, headerBytes.length);
    headerDest.set(headerBytes);
    if (pixelArray.byteLength) {
        const pixelDest = new Uint8Array(buffer, 4 + headerBytes.length, pixelArray.byteLength);
        pixelDest.set(pixelArray);
    }
    return buffer;
}
