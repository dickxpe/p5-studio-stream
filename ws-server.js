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
    let webviewuuid = null;
    let uuid = null;
    let isDisplay = false;
    console.log('[WS] New client connected');

    ws.on('message', (message) => {
        // Convert Buffer to string if necessary
        let msgStr = (typeof message === 'string') ? message : message.toString();
        // console.log(`[RAW MESSAGE]`, msgStr);
        try {
            const data = JSON.parse(msgStr);
            const senderId = data.senderId || 'none';
            if (
                typeof data.webviewuuid === 'string' &&
                (typeof data.uuid === 'string' || typeof data.uuid === 'number') &&
                Array.isArray(data.pixels)
            ) {
                webviewuuid = data.webviewuuid;
                uuid = data.uuid;
                // Register this socket
                if (!canvasSockets.has(webviewuuid)) {
                    canvasSockets.set(webviewuuid, new Map());
                    console.log(`[${webviewuuid}] New webviewuuid registered`);
                }
                const uuidMap = canvasSockets.get(webviewuuid);
                if (!uuidMap.has(uuid)) {
                    uuidMap.set(uuid, { display: ws, senders: new Set() });
                    isDisplay = true;
                    console.log(`[${webviewuuid}/${uuid}] Display client registered`);
                } else {
                    const senderSet = uuidMap.get(uuid).senders;
                    if (!senderSet.has(ws)) {
                        senderSet.add(ws);
                        console.log(`[${webviewuuid}/${uuid}] Sender client registered (senderId: ${senderId})`);
                    }
                }
                // If this is a sender, forward to display
                if (!isDisplay) {
                    const displayWs = uuidMap.get(uuid).display;
                    if (displayWs && displayWs.readyState === WebSocket.OPEN) {
                        displayWs.send(JSON.stringify({ uuid, pixels: data.pixels }));
                        console.log(`[${webviewuuid}/${uuid}] Pixel data sent to display client (${data.pixels.length} values)`);
                    } else {
                        console.log(`[${webviewuuid}/${uuid}] No display client to send pixel data`);
                    }
                } else {
                    console.log(`[${webviewuuid}/${uuid}] Display client ready and waiting for pixel data`);
                }
            } else {
                console.log(`[WS] Message missing required fields:`, data);
            }
        } catch (e) {
            console.error('[WS] Failed to parse message:', e);
            ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
    });

    ws.on('close', (code, reason) => {
        let role = isDisplay ? 'Display' : 'Sender';
        console.log(`[${webviewuuid}/${uuid}] ${role} client disconnected (code: ${code}, reason: ${reason})`);
        if (webviewuuid && uuid && canvasSockets.has(webviewuuid)) {
            const uuidMap = canvasSockets.get(webviewuuid);
            if (isDisplay) {
                uuidMap.delete(uuid);
            } else if (uuidMap.has(uuid)) {
                uuidMap.get(uuid).senders.delete(ws);
            }
            if (uuidMap.size === 0) {
                canvasSockets.delete(webviewuuid);
            }
        }
    });
});

console.log('WebSocket server running on ws://localhost:3001');
