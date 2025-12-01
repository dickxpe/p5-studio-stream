
// Patch: Export as testSetup and testDrawPixels for grid integration
this.testSetup = function () {
    let sk = this;
    sk.statusDiv = sk.createDiv('WebSocket: connecting...');
    sk.statusDiv.style('font-family', 'monospace');
    sk.statusDiv.style('font-size', '14px');
    sk.statusDiv.position(10, sk.height + 10);

    // Use uuid/webviewuuid from p5 instance if present, else window
    sk.uuid = sk.uuid || window.uuid;
    sk.webviewuuid = sk.webviewuuid || window.webviewuuid || window.uuid;

    sk.createCanvas(sk.width, sk.height);
    sk.background(220);

    sk.ws = new window.WebSocket('ws://localhost:3001');
    sk.ws.onopen = () => {
        console.log('[WebSocket] Connection opened');
        sk.statusDiv.html('WebSocket: connected');
        sk.ws.send(JSON.stringify({
            webviewuuid: sk.webviewuuid,
            uuid: sk.uuid,
            pixels: []
        }));
    };
    sk.ws.onclose = (event) => {
        console.log('[WebSocket] Connection closed', event);
        sk.statusDiv.html('WebSocket: closed');
    };
    sk.ws.onerror = (event) => {
        console.error('[WebSocket] Error', event);
        sk.statusDiv.html('WebSocket: error');
    };
    sk.frameQueue = [];
    sk.processingFrame = false;
    sk.ws.onmessage = (event) => {
        sk.statusDiv.html('WebSocket: message received');
        let data = JSON.parse(event.data);
        if (data.uuid === sk.uuid && Array.isArray(data.pixels)) {
            sk.enqueuePixelPayload(data);
        }
    };
    if (sk.statusDiv) sk.statusDiv.html('WebSocket: setup complete');
};

this.enqueuePixelPayload = function (payload) {
    let sk = this;
    sk.frameQueue.push(payload);
    if (!sk.processingFrame) {
        sk.processingFrame = true;
        sk.flushFrameQueue();
    }
};

this.flushFrameQueue = function () {
    let sk = this;
    if (!sk.frameQueue.length) {
        sk.processingFrame = false;
        return;
    }
    const nextFrame = sk.frameQueue.shift();
    sk.applyPixelPayload(nextFrame);
    window.requestAnimationFrame(() => sk.flushFrameQueue());
};

this.applyPixelPayload = function (payload) {
    let sk = this;
    if (!payload || !Array.isArray(payload.pixels)) {
        return;
    }
    const targetWidth = sk.width;
    const targetHeight = sk.height;
    const typedPixels = payload.pixels instanceof Uint8ClampedArray
        ? payload.pixels
        : Uint8ClampedArray.from(payload.pixels);
    if (payload.region && !payload.isFullFrame) {
        const region = payload.region || {};
        const regionWidth = Number.isFinite(region.width) ? Math.max(1, Math.floor(region.width)) : 0;
        const regionHeight = Number.isFinite(region.height) ? Math.max(1, Math.floor(region.height)) : 0;
        if (!regionWidth || !regionHeight) {
            return;
        }
        const expected = regionWidth * regionHeight * 4;
        if (typedPixels.length < expected) {
            return;
        }
        let destX = Number.isFinite(region.x) ? Math.floor(region.x) : 0;
        let destY = Number.isFinite(region.y) ? Math.floor(region.y) : 0;
        if (destX >= targetWidth || destY >= targetHeight) {
            return;
        }
        if (destX < 0) destX = 0;
        if (destY < 0) destY = 0;
        try {
            const imageData = new ImageData(typedPixels, regionWidth, regionHeight);
            sk.drawingContext.putImageData(imageData, destX, destY);
        } catch (err) {
            console.warn('[Test Display] Failed to draw region payload', err);
        }
        return;
    }
    const fullWidth = Number.isFinite(payload.fullWidth) ? Math.max(1, Math.floor(payload.fullWidth)) : targetWidth;
    const fullHeight = Number.isFinite(payload.fullHeight) ? Math.max(1, Math.floor(payload.fullHeight)) : targetHeight;
    const expectedFull = fullWidth * fullHeight * 4;
    if (typedPixels.length !== expectedFull) {
        sk.loadPixels();
        const max = Math.min(sk.pixels.length, typedPixels.length);
        for (let i = 0; i < max; i++) {
            sk.pixels[i] = typedPixels[i];
        }
        sk.updatePixels();
        return;
    }
    try {
        const imageData = new ImageData(typedPixels, fullWidth, fullHeight);
        sk.drawingContext.putImageData(imageData, 0, 0);
    } catch (err) {
        sk.loadPixels();
        const max = Math.min(sk.pixels.length, typedPixels.length);
        for (let i = 0; i < max; i++) {
            sk.pixels[i] = typedPixels[i];
        }
        sk.updatePixels();
    }
};