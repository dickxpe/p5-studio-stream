
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
    sk.latestPayload = null;
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
    const payload = sk.latestPayload;
    sk.latestPayload = null;
    sk.applyPixelPayload(payload);
    window.requestAnimationFrame(() => sk.flushLatestPayload());
};

this.applyPixelPayload = function (payload) {
    let sk = this;
    const rawPixels = payload && payload.pixels;
    const isArray = Array.isArray(rawPixels);
    const isTypedArray = rawPixels instanceof Uint8Array || rawPixels instanceof Uint8ClampedArray;
    if (!payload || (!isArray && !isTypedArray)) {
        return;
    }
    const typedPixels = rawPixels instanceof Uint8ClampedArray
        ? rawPixels
        : Uint8ClampedArray.from(rawPixels);
    const targetWidth = sk.width;
    const targetHeight = sk.height;
    const targetStride = targetWidth * 4;
    const writeRegion = (srcWidth, srcHeight, offsetX, offsetY) => {
        const expected = srcWidth * srcHeight * 4;
        if (typedPixels.length !== expected) {
            console.warn('[Test Display] Region payload length mismatch', expected, typedPixels.length);
            return false;
        }
        let destX = Number.isFinite(offsetX) ? Math.floor(offsetX) : 0;
        let destY = Number.isFinite(offsetY) ? Math.floor(offsetY) : 0;
        const srcWidthClamped = Math.max(1, Math.floor(srcWidth));
        const srcHeightClamped = Math.max(1, Math.floor(srcHeight));
        if (destX >= targetWidth || destY >= targetHeight) {
            return false;
        }
        let srcOffsetX = 0;
        let srcOffsetY = 0;
        if (destX < 0) {
            srcOffsetX = -destX;
            destX = 0;
        }
        if (destY < 0) {
            srcOffsetY = -destY;
            destY = 0;
        }
        const copyWidth = Math.min(srcWidthClamped - srcOffsetX, targetWidth - destX);
        const copyHeight = Math.min(srcHeightClamped - srcOffsetY, targetHeight - destY);
        if (copyWidth <= 0 || copyHeight <= 0) {
            return false;
        }
        const srcStride = srcWidthClamped * 4;
        sk.loadPixels();
        for (let row = 0; row < copyHeight; row++) {
            const srcIndex = ((srcOffsetY + row) * srcStride) + (srcOffsetX * 4);
            const destIndex = ((destY + row) * targetStride) + (destX * 4);
            const rowSlice = typedPixels.subarray(srcIndex, srcIndex + copyWidth * 4);
            sk.pixels.set(rowSlice, destIndex);
        }
        sk.updatePixels();
        return true;
    };

    if (payload.region && !payload.isFullFrame) {
        const region = payload.region || {};
        const regionWidth = Number.isFinite(region.width) ? Math.max(1, Math.floor(region.width)) : 0;
        const regionHeight = Number.isFinite(region.height) ? Math.max(1, Math.floor(region.height)) : 0;
        if (!regionWidth || !regionHeight) {
            return;
        }
        writeRegion(regionWidth, regionHeight, region.x, region.y);
        return;
    }

    const fullWidth = Number.isFinite(payload.fullWidth) ? Math.max(1, Math.floor(payload.fullWidth)) : targetWidth;
    const fullHeight = Number.isFinite(payload.fullHeight) ? Math.max(1, Math.floor(payload.fullHeight)) : targetHeight;
    if (fullWidth === targetWidth && fullHeight === targetHeight && typedPixels.length === sk.width * sk.height * 4) {
        sk.loadPixels();
        sk.pixels.set(typedPixels);
        sk.updatePixels();
        return;
    }
    writeRegion(fullWidth, fullHeight, 0, 0);
};