
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
    sk.ws.onmessage = (event) => {
        console.log('[WebSocket] Message received:', event.data);
        sk.statusDiv.html('WebSocket: message received');
        let data = JSON.parse(event.data);
        console.log('[Display] Local uuid:', sk.uuid, '| Received uuid:', data.uuid);
        if (typeof sk.output === 'function') sk.output("Received data for UUID: " + data.uuid);
        if (data.uuid === sk.uuid && Array.isArray(data.pixels)) {
            console.log('[Display] testDrawPixels called with array of length:', data.pixels.length);
            sk.testDrawPixels(data.pixels);
        } else {
            if (data.uuid !== sk.uuid) {
                console.warn('[Display] UUID mismatch: local', sk.uuid, 'vs received', data.uuid);
            }
            if (!Array.isArray(data.pixels)) {
                console.warn('[Display] Received pixels is not an array:', data.pixels);
            }
        }
    };
    if (sk.statusDiv) sk.statusDiv.html('WebSocket: setup complete');
};

this.testDrawPixels = function (pixelsArr) {
    let sk = this;
    console.log('[testDrawPixels] Called with array length:', pixelsArr.length, '| canvas pixels length:', sk.pixels.length);
    sk.loadPixels();
    for (let i = 0; i < sk.pixels.length && i < pixelsArr.length; i++) {
        sk.pixels[i] = pixelsArr[i];
    }
    sk.updatePixels();
    console.log('[testDrawPixels] updatePixels called');
};