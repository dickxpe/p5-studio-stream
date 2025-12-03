const FRAME_QUEUE_LIMIT = 8;

class PixelBufferPool {
    constructor(maxPerBucket = 32) {
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

const pixelPool = new PixelBufferPool();

const state = {
    canvas: null,
    ctx: null,
    queue: [],
    rafHandle: null,
    flushing: false,
    width: 0,
    height: 0
};

self.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') {
        return;
    }
    if (data.type === 'init') {
        handleInit(data);
        return;
    }
    if (data.type === 'frame') {
        enqueueFrame(data);
    }
};

function handleInit(payload) {
    state.canvas = payload.canvas;
    state.width = payload.width || state.width;
    state.height = payload.height || state.height;
    if (state.canvas) {
        state.canvas.width = state.width;
        state.canvas.height = state.height;
        state.ctx = state.canvas.getContext('2d', { alpha: true, desynchronized: true });
        if (state.ctx) {
            state.ctx.imageSmoothingEnabled = false;
        }
    }
}

function enqueueFrame(payload) {
    coalescePending(payload);
    state.queue.push(payload);
    enforceQueueLimit();
    scheduleFlush();
}

function scheduleFlush() {
    if (state.flushing) {
        return;
    }
    if (!state.rafHandle) {
        const raf = typeof self.requestAnimationFrame === 'function'
            ? self.requestAnimationFrame.bind(self)
            : (cb) => self.setTimeout(cb, 16);
        state.rafHandle = raf(flushQueue);
    }
}

function flushQueue() {
    state.rafHandle = null;
    if (state.flushing) {
        return;
    }
    state.flushing = true;
    drainQueue();
}

function drainQueue() {
    while (state.queue.length) {
        const payload = state.queue.shift();
        const maybePromise = drawPayload(payload);
        if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.finally(() => {
                state.flushing = false;
                scheduleFlush();
            });
            return;
        }
    }
    state.flushing = false;
}

function drawPayload(payload) {
    const ctx = state.ctx;
    if (!ctx || !payload) {
        return;
    }
    if (payload.encoding) {
        return drawEncodedFrame(payload, ctx);
    }
    const pixelArray = buildPixelArray(payload);
    if (!pixelArray || !pixelArray.length) {
        return;
    }
    const region = payload.region && payload.region.width && payload.region.height ? payload.region : null;
    const targetWidth = Number.isFinite(payload.fullWidth) ? Math.max(1, payload.fullWidth) : state.width;
    const targetHeight = Number.isFinite(payload.fullHeight) ? Math.max(1, payload.fullHeight) : state.height;
    const fullFramePixelCount = targetWidth * targetHeight * 4;
    const isFullFrame = Boolean(payload.isFullFrame) || pixelArray.length === fullFramePixelCount;

    if (isFullFrame && typeof createImageBitmap === 'function' && typeof ctx.transferFromImageBitmap === 'function') {
        return drawFullFrameViaBitmap(pixelArray, targetWidth, targetHeight, ctx);
    }
    if (isFullFrame) {
        drawFullFrameViaPutImageData(pixelArray, targetWidth, targetHeight, ctx);
        return;
    }
    if (region) {
        drawRegion(ctx, pixelArray, region, targetWidth, targetHeight);
    }
}

function enforceQueueLimit() {
    while (state.queue.length > FRAME_QUEUE_LIMIT) {
        state.queue.shift();
    }
}

function coalescePending(newPayload) {
    const key = buildQueueKey(newPayload);
    if (!key) {
        return;
    }
    for (let i = state.queue.length - 1; i >= 0; i--) {
        if (buildQueueKey(state.queue[i]) === key) {
            state.queue.splice(i, 1);
            break;
        }
    }
}

function buildQueueKey(payload) {
    if (!payload) {
        return null;
    }
    if (payload.isFullFrame || !payload.region) {
        return 'full';
    }
    const region = payload.region;
    const x = Number.isFinite(region.x) ? Math.floor(region.x) : 0;
    const y = Number.isFinite(region.y) ? Math.floor(region.y) : 0;
    const w = Number.isFinite(region.width) ? Math.max(1, Math.floor(region.width)) : 0;
    const h = Number.isFinite(region.height) ? Math.max(1, Math.floor(region.height)) : 0;
    if (!w || !h) {
        return null;
    }
    return `r:${x},${y},${w},${h}`;
}

function buildPixelArray(payload) {
    if (payload.buffer instanceof ArrayBuffer) {
        const byteOffset = payload.byteOffset || 0;
        const byteLength = payload.byteLength || payload.pixelLength || 0;
        if (!byteLength) {
            return null;
        }
        return new Uint8ClampedArray(payload.buffer, byteOffset, byteLength);
    }
    if (payload.pixels instanceof Uint8ClampedArray) {
        return payload.pixels;
    }
    if (payload.pixels instanceof Uint8Array) {
        return new Uint8ClampedArray(payload.pixels.buffer, payload.pixels.byteOffset, payload.pixels.byteLength);
    }
    if (Array.isArray(payload.pixels)) {
        return new Uint8ClampedArray(payload.pixels);
    }
    return null;
}

async function drawFullFrameViaBitmap(pixelArray, width, height, ctx) {
    try {
        const imageData = new ImageData(pixelArray, width, height);
        const bitmap = await createImageBitmap(imageData);
        ctx.transferFromImageBitmap(bitmap);
        if (typeof bitmap.close === 'function') {
            bitmap.close();
        }
    } catch (err) {
        drawFullFrameViaPutImageData(pixelArray, width, height, ctx);
    }
}

function drawFullFrameViaPutImageData(pixelArray, width, height, ctx) {
    try {
        const imageData = new ImageData(pixelArray, width, height);
        ctx.putImageData(imageData, 0, 0);
    } catch (err) {
        // noop: degradation path
    }
}

function drawRegion(ctx, pixelArray, region, targetWidth, targetHeight) {
    const regionWidth = Number.isFinite(region.width) ? Math.max(1, Math.floor(region.width)) : 0;
    const regionHeight = Number.isFinite(region.height) ? Math.max(1, Math.floor(region.height)) : 0;
    if (!regionWidth || !regionHeight) {
        return;
    }
    const expected = regionWidth * regionHeight * 4;
    if (pixelArray.length !== expected) {
        return;
    }
    let destX = Number.isFinite(region.x) ? Math.floor(region.x) : 0;
    let destY = Number.isFinite(region.y) ? Math.floor(region.y) : 0;
    let srcOffsetX = 0;
    let srcOffsetY = 0;
    if (destX < 0) {
        srcOffsetX = Math.min(regionWidth, -destX);
        destX = 0;
    }
    if (destY < 0) {
        srcOffsetY = Math.min(regionHeight, -destY);
        destY = 0;
    }
    const copyWidth = Math.min(regionWidth - srcOffsetX, targetWidth - destX);
    const copyHeight = Math.min(regionHeight - srcOffsetY, targetHeight - destY);
    if (copyWidth <= 0 || copyHeight <= 0) {
        return;
    }
    let payload = pixelArray;
    let borrowed = false;
    if (srcOffsetX || srcOffsetY || copyWidth !== regionWidth || copyHeight !== regionHeight) {
        payload = pixelPool.acquire(copyWidth * copyHeight * 4);
        borrowed = true;
        const srcStride = regionWidth * 4;
        for (let row = 0; row < copyHeight; row++) {
            const srcIndex = ((srcOffsetY + row) * srcStride) + (srcOffsetX * 4);
            const destIndex = row * copyWidth * 4;
            payload.set(pixelArray.subarray(srcIndex, srcIndex + copyWidth * 4), destIndex);
        }
    }
    try {
        const imageData = new ImageData(payload, copyWidth, copyHeight);
        ctx.putImageData(imageData, destX, destY);
    } finally {
        if (borrowed) {
            pixelPool.release(payload);
        }
    }
}

function getByteView(payload) {
    if (!payload) {
        return null;
    }
    if (payload.buffer instanceof ArrayBuffer) {
        const byteOffset = payload.byteOffset || payload.pixelByteOffset || 0;
        const byteLength = payload.byteLength || payload.pixelByteLength || payload.pixelLength || 0;
        if (byteLength > 0) {
            return new Uint8Array(payload.buffer, byteOffset, byteLength);
        }
    }
    if (payload.pixels instanceof Uint8Array || payload.pixels instanceof Uint8ClampedArray) {
        return new Uint8Array(payload.pixels.buffer, payload.pixels.byteOffset, payload.pixels.byteLength);
    }
    return null;
}

function drawEncodedFrame(payload, ctx) {
    const mimeType = typeof payload.encoding === 'string' && payload.encoding.length ? payload.encoding : 'image/webp';
    const width = Number.isFinite(payload.encodedWidth)
        ? Math.max(1, Math.floor(payload.encodedWidth))
        : (Number.isFinite(payload.fullWidth) ? Math.max(1, Math.floor(payload.fullWidth)) : state.width);
    const height = Number.isFinite(payload.encodedHeight)
        ? Math.max(1, Math.floor(payload.encodedHeight))
        : (Number.isFinite(payload.fullHeight) ? Math.max(1, Math.floor(payload.fullHeight)) : state.height);
    const view = getByteView(payload);
    if (!view || !view.byteLength) {
        return;
    }
    const blob = new Blob([view], { type: mimeType });
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob).then((bitmap) => {
            try {
                ctx.drawImage(bitmap, 0, 0, width, height);
            } finally {
                if (bitmap && typeof bitmap.close === 'function') {
                    bitmap.close();
                }
            }
        }).catch(() => { });
    }
}
