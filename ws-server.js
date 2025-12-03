// WebSocket server for per-canvas pixel updates
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'uuids.db');
const db = new sqlite3.Database(dbPath);

// Map: webviewuuid -> { uuid -> ws }
// Map: webviewuuid -> { uuid -> { display: ws, senders: Set<ws> } }
const canvasSockets = new Map();
const displayBatchCache = new Map();
const reusableUuidArrays = [];
const UUID_ARRAY_POOL_LIMIT = 128;
const webviewMetadataCache = new Map();
const WEBVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const lastFrameTimestamps = new Map();

const wss = new WebSocket.Server({
    port: 3001,
    perMessageDeflate: false
});

wss.on('connection', (ws) => {
    ws.displayRegistrations = new Set();
    ws.senderRegistrations = new Set();
    console.log('[WS] New client connected');

    ws.on('message', async (message) => {
        try {
            const data = parseIncomingMessage(message);
            if (!data) {
                console.log('[WS] Received unrecognized payload type');
                return;
            }
            if (!isValidPayload(data)) {
                console.log('[WS] Message missing required fields:', data);
                return;
            }
            const webviewuuid = data.webviewuuid;
            const senderId = data.senderId || 'none';
            const targetUuids = getTargetUuids(data);
            if (!targetUuids.length) {
                console.log('[WS] No valid UUID targets in payload');
                return;
            }
            const isDisplayRegistration = isDisplayHandshake(data);

            if (isDisplayRegistration) {
                const uuid = targetUuids[0];
                const entry = ensureEntry(webviewuuid, uuid);
                const key = makeKey(webviewuuid, uuid);
                if (entry.display && entry.display !== ws) {
                    try {
                        entry.display.close(1000, 'Display replaced');
                    } catch (err) {
                        console.warn(`[${webviewuuid}/${uuid}] Failed to close previous display`, err);
                    }
                }
                entry.display = ws;
                ws.displayRegistrations.add(key);
                console.log(`[${webviewuuid}/${uuid}] Display client registered`);
                return;
            }

            const typedPixels = normalizePixels(data.pixels);
            const region = sanitizeRegion(data.region, typedPixels.length);
            const webviewMeta = await getWebviewMetadata(webviewuuid);
            if (!webviewMeta) {
                console.log(`[${webviewuuid}] Skipping payload: metadata not found`);
                return;
            }
            const encodingMeta = extractEncodingMetadata(data);
            const headerBase = {
                region,
                isFullFrame: !!data.isFullFrame,
                fullWidth: typeof data.fullWidth === 'number' ? data.fullWidth : webviewMeta.width,
                fullHeight: typeof data.fullHeight === 'number' ? data.fullHeight : webviewMeta.height,
                pixelLength: typedPixels.length,
                frameTimestamp: Date.now(),
                encoding: encodingMeta.encoding,
                encodedWidth: encodingMeta.encodedWidth,
                encodedHeight: encodingMeta.encodedHeight,
                lossy: encodingMeta.lossy
            };

            displayBatchCache.clear();

            targetUuids.forEach((uuid) => {
                const entry = ensureEntry(webviewuuid, uuid);
                const key = makeKey(webviewuuid, uuid);
                if (!entry.senders.has(ws)) {
                    entry.senders.add(ws);
                    ws.senderRegistrations.add(key);
                    console.log(`[${webviewuuid}/${uuid}] Sender client registered (senderId: ${senderId})`);
                }
                const displayWs = entry.display;
                if (displayWs && displayWs.readyState === WebSocket.OPEN) {
                    let batch = displayBatchCache.get(displayWs);
                    if (!batch) {
                        batch = reusableUuidArrays.length ? reusableUuidArrays.pop() : [];
                        displayBatchCache.set(displayWs, batch);
                    }
                    batch.push(uuid);
                } else {
                    console.log(`[${webviewuuid}/${uuid}] No display client to send pixel data`);
                }
            });

            displayBatchCache.forEach((uuidsForDisplay, displayWs) => {
                if (!uuidsForDisplay.length) {
                    releaseUuidArray(uuidsForDisplay);
                    return;
                }
                const deltaMap = {};
                uuidsForDisplay.forEach((uuid) => {
                    const computedDelta = computeDeltaMs(webviewuuid, uuid, headerBase.frameTimestamp);
                    const senderDelta = extractSenderDelta(data, uuid);
                    deltaMap[uuid] = typeof senderDelta === 'number' ? senderDelta : computedDelta;
                });
                const firstDelta = deltaMap[uuidsForDisplay[0]] ?? 0;
                const header = {
                    ...headerBase,
                    uuids: uuidsForDisplay,
                    deltas: deltaMap,
                    deltaMs: firstDelta
                };
                const frameBuffer = encodeBinaryFrame(header, typedPixels);
                displayWs.send(frameBuffer, { binary: true, compress: false });
                console.log(`[${webviewuuid}] Pixel data sent to display client for ${uuidsForDisplay.length} canvas(es) (${typedPixels.length} bytes${region ? ', region' : ', full frame'})`);
                releaseUuidArray(uuidsForDisplay);
            });
            displayBatchCache.clear();
        } catch (e) {
            console.error('[WS] Failed to parse message:', e);
            try {
                ws.send(JSON.stringify({ error: 'Invalid message format' }));
            } catch (sendErr) {
                console.warn('[WS] Failed to send error response', sendErr);
            }
        }
    });

    ws.on('close', (code, reason) => {
        cleanupConnection(ws, code, reason);
    });
});

console.log('WebSocket server running on ws://localhost:3001');

function sanitizeRegion(region, pixelLength) {
    if (!region || typeof region !== 'object') return null;
    const totalPixels = (pixelLength && pixelLength % 4 === 0) ? pixelLength / 4 : null;
    let width = Number.isFinite(region.width) ? region.width : null;
    let height = Number.isFinite(region.height) ? region.height : null;

    if (totalPixels && (!width || !height)) {
        if (!width && height) {
            width = totalPixels / height;
        } else if (!height && width) {
            height = totalPixels / width;
        } else if (!width && !height) {
            // Assume square region if both dimensions missing
            const side = Math.sqrt(totalPixels);
            width = side;
            height = side;
        }
    }

    if (!width || !height || width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    const x = Number.isFinite(region.x) ? region.x : 0;
    const y = Number.isFinite(region.y) ? region.y : 0;
    return { x, y, width, height };
}

function isValidPayload(data) {
    const hasPixels = Array.isArray(data && data.pixels)
        || data.pixels instanceof Uint8Array
        || data.pixels instanceof Uint8ClampedArray
        || Buffer.isBuffer(data && data.pixels);
    if (!data || typeof data.webviewuuid !== 'string' || !hasPixels) {
        return false;
    }
    const hasSingle = typeof data.uuid === 'string' || typeof data.uuid === 'number';
    const hasBatch = Array.isArray(data.uuids) && data.uuids.length > 0;
    return hasSingle || hasBatch;
}

function parseIncomingMessage(message) {
    if (typeof message === 'string') {
        return JSON.parse(message);
    }
    if (Buffer.isBuffer(message)) {
        const binary = decodeBinaryEnvelope(message);
        if (binary) {
            return binary;
        }
        try {
            return JSON.parse(message.toString('utf8'));
        } catch (err) {
            return null;
        }
    }
    if (message instanceof ArrayBuffer) {
        const view = Buffer.from(message);
        const binary = decodeBinaryEnvelope(view);
        if (binary) {
            return binary;
        }
        try {
            return JSON.parse(Buffer.from(message).toString('utf8'));
        } catch (err) {
            return null;
        }
    }
    if (message && typeof message.toString === 'function') {
        try {
            return JSON.parse(message.toString());
        } catch (err) {
            return null;
        }
    }
    return null;
}

function normalizeUuid(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(Math.trunc(value));
    }
    if (typeof value === 'string') {
        return value;
    }
    return '';
}

function getTargetUuids(data) {
    if (Array.isArray(data.uuids) && data.uuids.length > 0) {
        return data.uuids
            .map(normalizeUuid)
            .filter((val) => typeof val === 'string' && val.length > 0);
    }
    const single = normalizeUuid(data.uuid);
    return single ? [single] : [];
}

function normalizePixels(raw) {
    if (!raw) {
        return new Uint8Array(0);
    }
    if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
        return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (Array.isArray(raw)) {
        return Uint8Array.from(raw);
    }
    if (Buffer.isBuffer(raw)) {
        return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    return new Uint8Array(0);
}

function encodeBinaryFrame(header, pixelArray) {
    const headerJson = JSON.stringify(header);
    const headerBuf = Buffer.from(headerJson, 'utf8');
    const pixelView = pixelArray instanceof Uint8Array ? pixelArray : new Uint8Array(pixelArray || []);
    const pixelBuf = Buffer.from(pixelView.buffer, pixelView.byteOffset, pixelView.byteLength);
    const frame = Buffer.allocUnsafe(4 + headerBuf.length + pixelBuf.length);
    frame.writeUInt32BE(headerBuf.length, 0);
    headerBuf.copy(frame, 4);
    if (pixelBuf.length > 0) {
        pixelBuf.copy(frame, 4 + headerBuf.length);
    }
    return frame;
}

function getWebviewMetadata(webviewuuid) {
    const cached = webviewMetadataCache.get(webviewuuid);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < WEBVIEW_CACHE_TTL_MS) {
        return Promise.resolve(cached.value);
    }
    return new Promise((resolve) => {
        db.get('SELECT rows, columns, width, height FROM webviews WHERE webviewuuid = ?', [webviewuuid], (err, row) => {
            if (err || !row) {
                webviewMetadataCache.delete(webviewuuid);
                return resolve(null);
            }
            const value = {
                rows: row.rows || 10,
                columns: row.columns || 10,
                width: row.width || 100,
                height: row.height || 100
            };
            webviewMetadataCache.set(webviewuuid, { value, timestamp: Date.now() });
            resolve(value);
        });
    });
}

function releaseUuidArray(arr) {
    if (!arr) {
        return;
    }
    arr.length = 0;
    if (reusableUuidArrays.length < UUID_ARRAY_POOL_LIMIT) {
        reusableUuidArrays.push(arr);
    }
}

function decodeBinaryEnvelope(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return null;
    }
    const headerLength = buffer.readUInt32BE(0);
    const totalHeaderBytes = 4 + headerLength;
    if (buffer.length < totalHeaderBytes) {
        return null;
    }
    const headerJson = buffer.subarray(4, totalHeaderBytes).toString('utf8');
    let metadata;
    try {
        metadata = JSON.parse(headerJson);
    } catch (err) {
        console.warn('[WS] Failed to parse binary sender header', err);
        return null;
    }
    const pixelBytes = buffer.length - totalHeaderBytes;
    const pixelSlice = pixelBytes > 0 ? buffer.subarray(totalHeaderBytes) : Buffer.alloc(0);
    metadata.pixels = new Uint8Array(pixelSlice.buffer, pixelSlice.byteOffset, pixelSlice.byteLength);
    return metadata;
}

function isDisplayHandshake(data) {
    return Array.isArray(data.pixels) && data.pixels.length === 0 && !data.senderId;
}

function makeKey(webviewuuid, uuid) {
    return JSON.stringify({ webviewuuid, uuid });
}

function splitKey(key) {
    try {
        return JSON.parse(key);
    } catch (err) {
        return { webviewuuid: null, uuid: null };
    }
}

function ensureEntry(webviewuuid, uuid) {
    if (!canvasSockets.has(webviewuuid)) {
        canvasSockets.set(webviewuuid, new Map());
        console.log(`[${webviewuuid}] New webviewuuid registered`);
    }
    const uuidMap = canvasSockets.get(webviewuuid);
    if (!uuidMap.has(uuid)) {
        uuidMap.set(uuid, { display: null, senders: new Set() });
        console.log(`[${webviewuuid}/${uuid}] Slot initialized`);
    }
    return uuidMap.get(uuid);
}

function getEntry(webviewuuid, uuid) {
    if (!canvasSockets.has(webviewuuid)) return null;
    return canvasSockets.get(webviewuuid).get(uuid) || null;
}

function cleanupEntry(webviewuuid, uuid) {
    if (!canvasSockets.has(webviewuuid)) return;
    const uuidMap = canvasSockets.get(webviewuuid);
    const entry = uuidMap.get(uuid);
    if (!entry) return;
    if (!entry.display && entry.senders.size === 0) {
        uuidMap.delete(uuid);
        if (uuidMap.size === 0) {
            canvasSockets.delete(webviewuuid);
        }
    }
}

function cleanupConnection(ws, code, reason) {
    ws.displayRegistrations.forEach((key) => {
        const { webviewuuid, uuid } = splitKey(key);
        if (!webviewuuid || typeof uuid === 'undefined') {
            return;
        }
        const entry = getEntry(webviewuuid, uuid);
        if (entry && entry.display === ws) {
            entry.display = null;
            console.log(`[${webviewuuid}/${uuid}] Display client disconnected (code: ${code}, reason: ${reason})`);
            cleanupEntry(webviewuuid, uuid);
        }
    });
    ws.senderRegistrations.forEach((key) => {
        const { webviewuuid, uuid } = splitKey(key);
        if (!webviewuuid || typeof uuid === 'undefined') {
            return;
        }
        const entry = getEntry(webviewuuid, uuid);
        if (entry && entry.senders.has(ws)) {
            entry.senders.delete(ws);
            console.log(`[${webviewuuid}/${uuid}] Sender client disconnected (code: ${code}, reason: ${reason})`);
            cleanupEntry(webviewuuid, uuid);
        }
    });
}

function extractEncodingMetadata(payload) {
    if (!payload || typeof payload !== 'object') {
        return { encoding: undefined, encodedWidth: undefined, encodedHeight: undefined, lossy: undefined };
    }
    const encoding = typeof payload.encoding === 'string' && payload.encoding.length ? payload.encoding : undefined;
    const encodedWidth = Number.isFinite(payload.encodedWidth) ? payload.encodedWidth : undefined;
    const encodedHeight = Number.isFinite(payload.encodedHeight) ? payload.encodedHeight : undefined;
    const lossy = payload.lossy ? true : undefined;
    return { encoding, encodedWidth, encodedHeight, lossy };
}

function computeDeltaMs(webviewuuid, uuid, nowTs) {
    const key = `${webviewuuid}:${uuid}`;
    const previous = lastFrameTimestamps.get(key);
    lastFrameTimestamps.set(key, nowTs);
    if (!previous || !Number.isFinite(previous)) {
        return 0;
    }
    const delta = nowTs - previous;
    return delta >= 0 ? delta : 0;
}

function extractSenderDelta(payload, uuid) {
    if (!payload) {
        return null;
    }
    const normalizedUuid = normalizeUuidKey(uuid);
    if (payload.deltas && typeof payload.deltas === 'object') {
        if (normalizedUuid && Object.prototype.hasOwnProperty.call(payload.deltas, normalizedUuid)) {
            const candidate = sanitizeDeltaMs(payload.deltas[normalizedUuid]);
            if (candidate !== null) {
                return candidate;
            }
        }
        if (typeof uuid !== 'undefined' && Object.prototype.hasOwnProperty.call(payload.deltas, uuid)) {
            const candidate = sanitizeDeltaMs(payload.deltas[uuid]);
            if (candidate !== null) {
                return candidate;
            }
        }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'deltaMs')) {
        const candidate = sanitizeDeltaMs(payload.deltaMs);
        if (candidate !== null) {
            return candidate;
        }
    }
    return null;
}

function sanitizeDeltaMs(value) {
    if (!Number.isFinite(value)) {
        return null;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 5000) {
        return 5000;
    }
    return value;
}

function normalizeUuidKey(value) {
    if (typeof value === 'string' && value.length) {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(Math.trunc(value));
    }
    return null;
}
