"use strict";
const payloadOutput = document.getElementById('payloadOutput');
const createOfferButton = document.getElementById('createOfferBtn');
createOfferButton.addEventListener('click', async () => {
    const deviceId = `browser-peer-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
        type: 'offer',
        deviceId,
        sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n',
        createdAt: new Date().toISOString(),
        source: 'browser-peer',
        user: { device_id: deviceId },
    };
    payloadOutput.value = JSON.stringify(payload, null, 2);
    try {
        const response = await fetch('/webrtc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        payloadOutput.value += `\n\nSERVER RESPONSE:\n${JSON.stringify(await response.json(), null, 2)}`;
    }
    catch (error) {
        payloadOutput.value += `\n\nERROR:\n${error instanceof Error ? error.message : String(error)}`;
    }
});
