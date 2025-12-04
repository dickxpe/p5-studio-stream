
// Patch: Export as testSetup and testDrawPixels for grid integration
this.testSetup = function () {
    const sk = this;
    sk.pixelDensity(1);
    sk.createCanvas(sk.width, sk.height);
    sk.background(220);

    sk.statusDiv = sk.createDiv('WebSocket: connecting...');
    sk.statusDiv.style('font-family', 'monospace');
    sk.statusDiv.style('font-size', '14px');
    sk.statusDiv.position(10, sk.height + 10);

    sk.uuid = sk.uuid || window.uuid;
    sk.webviewuuid = sk.webviewuuid || window.webviewuuid || window.uuid;

    sk.pendingPayloads = [];
    sk.frameProcessing = false;
    sk.decoder = typeof window.TextDecoder === 'function' ? new window.TextDecoder() : null;

    const fallbackResolveWebSocketUrl = () => {
        const isHttps = window.location && window.location.protocol === 'https:';
        const protocol = isHttps ? 'wss:' : 'ws:';
        const hostname = (window.location && window.location.hostname) || 'localhost';
        let port = window.location && window.location.port;
        if (!port && (hostname === 'localhost' || hostname === '127.0.0.1')) {
            port = '3001';
        }
        const portSegment = port ? `:${port}` : '';
        return `${protocol}//${hostname}${portSegment}`;
    };
    const wsResolver = (typeof window.resolveWebSocketUrl === 'function') ? window.resolveWebSocketUrl : fallbackResolveWebSocketUrl;
    const wsTarget = wsResolver();
    sk.ws = new window.WebSocket(wsTarget);
    sk.ws.binaryType = 'arraybuffer';
    sk.ws.onopen = () => {
        sk.statusDiv.html('WebSocket: connected');
        sk.ws.send(JSON.stringify({
            webviewuuid: sk.webviewuuid,
            uuid: sk.uuid,
            pixels: []
        }));
    };
    sk.ws.onclose = () => {
        sk.statusDiv.html('WebSocket: closed');
    };
    sk.ws.onerror = () => {
        sk.statusDiv.html('WebSocket: error');
    };
    sk.ws.onmessage = (event) => {
        const dispatchPayload = (payload) => {
            if (!payload) return;
            if (Array.isArray(payload.uuids) && payload.uuids.length) {
                if (payload.uuids.includes(sk.uuid)) {
                    sk.enqueuePixelPayload({
                        uuid: sk.uuid,
                        pixels: payload.pixels,
                        region: payload.region,
                        isFullFrame: payload.isFullFrame,
                        fullWidth: payload.fullWidth,
                        fullHeight: payload.fullHeight,
                        pixelLength: payload.pixelLength
                    });
                }
                return;
            }
            if (payload.uuid === sk.uuid) {
                sk.enqueuePixelPayload(payload);
            }
        };

        if (typeof event.data === 'string') {
            try {
                const parsed = JSON.parse(event.data);
                dispatchPayload(parsed);
            } catch (err) {
                console.warn('[Test Display] Failed to parse text payload', err);
            }
            return;
        }
        if (event.data instanceof ArrayBuffer) {
            const payload = decodeBinaryFrame(event.data, sk.decoder);
            dispatchPayload(payload);
            return;
        }
        if (event.data instanceof Blob && typeof event.data.arrayBuffer === 'function') {
            event.data.arrayBuffer()
                .then((buffer) => {
                    const payload = decodeBinaryFrame(buffer, sk.decoder);
                    dispatchPayload(payload);
                })
                .catch((err) => console.warn('[Test Display] Failed to decode blob payload', err));
        }
    };

    sk.enqueuePixelPayload = function (payload) {
        if (!payload) return;
        sk.pendingPayloads.push(payload);
        if (!sk.frameProcessing) {
            sk.frameProcessing = true;
            window.requestAnimationFrame(sk.flushPendingPayloads.bind(sk));
        }
    };

    sk.flushPendingPayloads = function () {
        if (!sk.pendingPayloads.length) {
            sk.frameProcessing = false;
            return;
        }
        while (sk.pendingPayloads.length) {
            const nextPayload = sk.pendingPayloads.shift();
            sk.applyPixelPayload(nextPayload);
        }
        window.requestAnimationFrame(sk.flushPendingPayloads.bind(sk));
    };

    sk.applyPixelPayload = function (payload) {
        const rawPixels = payload && payload.pixels;
        if (payload && payload.encoding) {
            drawEncodedPayload(payload);
            return;
        }
        if (!payload || (!Array.isArray(rawPixels) && !(rawPixels instanceof Uint8Array) && !(rawPixels instanceof Uint8ClampedArray))) {
            return;
        }
        const typedPixels = rawPixels instanceof Uint8ClampedArray
            ? rawPixels
            : new Uint8ClampedArray(rawPixels);
        const ctx = sk.drawingContext;
        if (!ctx) {
            return;
        }

        const drawRegion = (region) => {
            const regionWidth = Number.isFinite(region.width) ? Math.max(1, Math.floor(region.width)) : 0;
            const regionHeight = Number.isFinite(region.height) ? Math.max(1, Math.floor(region.height)) : 0;
            if (!regionWidth || !regionHeight) return;
            try {
                const imageData = new ImageData(typedPixels, regionWidth, regionHeight);
                const destX = Number.isFinite(region.x) ? Math.floor(region.x) : 0;
                const destY = Number.isFinite(region.y) ? Math.floor(region.y) : 0;
                ctx.putImageData(imageData, destX, destY);
            } catch (err) {
                console.warn('[Test Display] Failed to draw region payload', err);
            }
        };

        if (payload.region && !payload.isFullFrame) {
            drawRegion(payload.region);
            return;
        }

        const targetWidth = sk.width;
        const targetHeight = sk.height;
        if (typedPixels.length !== targetWidth * targetHeight * 4) {
            const fullWidth = Number.isFinite(payload.fullWidth) ? Math.max(1, Math.floor(payload.fullWidth)) : targetWidth;
            const fullHeight = Number.isFinite(payload.fullHeight) ? Math.max(1, Math.floor(payload.fullHeight)) : targetHeight;
            drawRegion({ x: 0, y: 0, width: fullWidth, height: fullHeight });
            return;
        }
        sk.loadPixels();
        sk.pixels.set(typedPixels);
        sk.updatePixels();
    };

    function drawEncodedPayload(payload) {
        const ctx = sk.drawingContext;
        if (!ctx) {
            return;
        }
        const buffer = payload.pixelBuffer instanceof ArrayBuffer ? payload.pixelBuffer : (payload.pixels && payload.pixels.buffer);
        const byteOffset = payload.pixelByteOffset || (payload.pixels ? payload.pixels.byteOffset : 0) || 0;
        const byteLength = payload.pixelByteLength || (payload.pixels ? payload.pixels.byteLength : 0) || 0;
        if (!buffer || !byteLength) {
            return;
        }
        const view = new Uint8Array(buffer, byteOffset, byteLength);
        const blob = new Blob([view], { type: payload.encoding || 'image/webp' });
        const targetWidth = Number.isFinite(payload.encodedWidth) ? Math.max(1, Math.floor(payload.encodedWidth)) : sk.width;
        const targetHeight = Number.isFinite(payload.encodedHeight) ? Math.max(1, Math.floor(payload.encodedHeight)) : sk.height;
        if (typeof window.createImageBitmap === 'function') {
            window.createImageBitmap(blob).then((bitmap) => {
                try {
                    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
                } finally {
                    if (bitmap && typeof bitmap.close === 'function') {
                        bitmap.close();
                    }
                }
            }).catch(() => {
                drawEncodedPayloadFallback(ctx, blob, targetWidth, targetHeight);
            });
            return;
        }
        drawEncodedPayloadFallback(ctx, blob, targetWidth, targetHeight);
    }

    function drawEncodedPayloadFallback(ctx, blob, width, height) {
        const urlApi = typeof window.URL !== 'undefined' ? window.URL : null;
        if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof urlApi.revokeObjectURL !== 'function') {
            return;
        }
        if (typeof window.Image !== 'function') {
            return;
        }
        const url = urlApi.createObjectURL(blob);
        const img = new window.Image();
        const cleanup = () => {
            try {
                urlApi.revokeObjectURL(url);
            } catch (err) { }
        };
        img.onload = () => {
            try {
                ctx.drawImage(img, 0, 0, width, height);
            } finally {
                cleanup();
            }
        };
        img.onerror = cleanup;
        img.src = url;
    }

    function decodeBinaryFrame(buffer, decoder) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) {
            return null;
        }
        const headerLength = new DataView(buffer, 0, 4).getUint32(0, false);
        const totalHeaderBytes = 4 + headerLength;
        if (buffer.byteLength < totalHeaderBytes) {
            return null;
        }
        const headerBytes = new Uint8Array(buffer, 4, headerLength);
        let headerText;
        if (decoder) {
            headerText = decoder.decode(headerBytes);
        } else {
            headerText = String.fromCharCode.apply(null, headerBytes);
        }
        let metadata;
        try {
            metadata = JSON.parse(headerText);
        } catch (err) {
            console.warn('[Test Display] Failed to parse binary header', err);
            return null;
        }
        const pixelBytesLength = buffer.byteLength - totalHeaderBytes;
        metadata.pixels = new Uint8ClampedArray(buffer, totalHeaderBytes, pixelBytesLength);
        metadata.pixelBuffer = buffer;
        metadata.pixelByteOffset = totalHeaderBytes;
        metadata.pixelByteLength = pixelBytesLength;
        metadata.pixelLength = pixelBytesLength;
        return metadata;
    }
};
