// WebSocket server for per-canvas pixel updates
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'uuids.db');
const db = new sqlite3.Database(dbPath);

// Map: webviewuuid -> { uuid -> ws }
// Map: webviewuuid -> { uuid -> { display: ws, senders: Set<ws> } }
const canvasSockets = new Map();

const wss = new WebSocket.Server({ port: 3001 });

wss.on('connection', (ws) => {
    ws.displayRegistrations = new Set();
    ws.senderRegistrations = new Set();
    console.log('[WS] New client connected');

    ws.on('message', (message) => {
        const msgStr = (typeof message === 'string') ? message : message.toString();
        try {
            const data = JSON.parse(msgStr);
            if (!isValidPayload(data)) {
                console.log('[WS] Message missing required fields:', data);
                return;
            }
            const webviewuuid = data.webviewuuid;
            const uuid = normalizeUuid(data.uuid);
            const senderId = data.senderId || 'none';
            const entry = ensureEntry(webviewuuid, uuid);
            const key = makeKey(webviewuuid, uuid);
            const isDisplayRegistration = isDisplayHandshake(data);

            if (isDisplayRegistration) {
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

            if (!entry.senders.has(ws)) {
                entry.senders.add(ws);
                ws.senderRegistrations.add(key);
                console.log(`[${webviewuuid}/${uuid}] Sender client registered (senderId: ${senderId})`);
            }

            const displayWs = entry.display;
            if (displayWs && displayWs.readyState === WebSocket.OPEN) {
                const typedPixels = normalizePixels(data.pixels);
                const region = sanitizeRegion(data.region, typedPixels.length);
                const header = {
                    uuid,
                    region,
                    isFullFrame: !!data.isFullFrame,
                    fullWidth: typeof data.fullWidth === 'number' ? data.fullWidth : undefined,
                    fullHeight: typeof data.fullHeight === 'number' ? data.fullHeight : undefined,
                    pixelLength: typedPixels.length
                };
                const frameBuffer = encodeBinaryFrame(header, typedPixels);
                displayWs.send(frameBuffer, { binary: true });
                console.log(`[${webviewuuid}/${uuid}] Pixel data sent to display client (${typedPixels.length} bytes${region ? ', region' : ', full frame'})`);
            } else {
                console.log(`[${webviewuuid}/${uuid}] No display client to send pixel data`);
            }
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
    return data &&
        typeof data.webviewuuid === 'string' &&
        (typeof data.uuid === 'string' || typeof data.uuid === 'number') &&
        Array.isArray(data.pixels);
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
