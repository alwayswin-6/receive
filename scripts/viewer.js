"use strict";
const statusElement = document.getElementById('status');
const deviceListElement = document.getElementById('deviceList');
const rawStateElement = document.getElementById('rawState');
const refreshButton = document.getElementById('refreshBtn');
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function formatViewerBytes(size) {
    if (!size && size !== 0)
        return '';
    if (size < 1024)
        return `${size} B`;
    if (size < 1024 * 1024)
        return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
async function deleteViewerDevice(deviceId) {
    const response = await fetch('/device/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
    });
    if (!response.ok)
        throw new Error(`Delete failed: ${response.status}`);
    await refresh();
}
async function stageViewerFile(deviceId, file) {
    const response = await fetch(`/device/file?device_id=${encodeURIComponent(deviceId)}&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': file.name,
        },
        body: file,
    });
    if (!response.ok)
        throw new Error(`File stage failed: ${response.status}`);
    statusElement.textContent = `Staged ${file.name} for ${deviceId}`;
    await refresh();
}
async function putViewerFile(deviceId) {
    const response = await fetch('/device/put', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`PUT failed: ${response.status} ${body}`);
    }
    statusElement.textContent = `PUT queued for ${deviceId}`;
    await refresh();
}
async function refresh() {
    try {
        const response = await fetch('/webrtc', { cache: 'no-store' });
        if (!response.ok)
            throw new Error(`Fetch failed: ${response.status}`);
        const data = await response.json();
        const devices = data.devices || [];
        deviceListElement.innerHTML = devices.length
            ? devices.map((device) => {
                const id = device.safe_device_id || device.device_id || 'unknown';
                const title = device.device_id || id;
                const safeId = escapeHtml(id);
                const safeTitle = escapeHtml(title);
                const staged = device.staged_file?.file_name
                    ? `${escapeHtml(device.staged_file.file_name)} (${escapeHtml(formatViewerBytes(device.staged_file.size))})${device.staged_file.put_pending ? ' • PUT pending' : ' • ready'}`
                    : 'No file staged';
                return `<div class="device-card" data-device-id="${safeId}">
            <h3>${safeTitle}</h3><div class="meta">${escapeHtml(device.timestamp || 'n/a')}</div>
            <div class="meta">${escapeHtml(device.type || 'offer')} • ${escapeHtml(device.source || 'unknown')}</div>
            <img src="/device_image?device_id=${encodeURIComponent(id)}&_=${Date.now()}" alt="${safeTitle}" />
            <div class="file-row">
              <input class="file-input" type="file" data-device-id="${safeId}" />
              <div class="file-status">${staged}</div>
            </div>
            <div class="action-row">
              <button class="put-btn" type="button" data-device-id="${safeId}" ${device.staged_file?.file_name ? '' : 'disabled'}>PUT</button>
              <button class="delete-btn" type="button" data-device-id="${safeId}">Delete</button>
            </div>
          </div>`;
            }).join('')
            : '<div class="device-card"><h3>No devices</h3><div class="meta">No signaling state available yet.</div></div>';
        rawStateElement.textContent = JSON.stringify(data, null, 2);
        statusElement.textContent = devices.length ? `${devices.length} peer(s) connected` : 'Waiting for peers...';
    }
    catch (error) {
        statusElement.textContent = 'Connection error';
        rawStateElement.textContent = error instanceof Error ? error.message : String(error);
    }
}
deviceListElement.addEventListener('click', (event) => {
    const target = event.target;
    const putBtn = target.closest('.put-btn');
    if (putBtn) {
        event.preventDefault();
        event.stopPropagation();
        const deviceId = putBtn.dataset.deviceId;
        if (!deviceId)
            return;
        putBtn.disabled = true;
        putViewerFile(deviceId).catch((error) => {
            statusElement.textContent = `PUT failed: ${error instanceof Error ? error.message : String(error)}`;
            putBtn.disabled = false;
        });
        return;
    }
    const deleteBtn = target.closest('.delete-btn');
    if (!deleteBtn)
        return;
    event.preventDefault();
    event.stopPropagation();
    const deviceId = deleteBtn.dataset.deviceId;
    if (!deviceId)
        return;
    deleteBtn.disabled = true;
    deleteViewerDevice(deviceId).catch((error) => {
        statusElement.textContent = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
        deleteBtn.disabled = false;
    });
});
deviceListElement.addEventListener('change', (event) => {
    const target = event.target;
    const input = target.closest('.file-input');
    if (!input || !input.files?.length)
        return;
    const deviceId = input.dataset.deviceId;
    const file = input.files[0];
    if (!deviceId || !file)
        return;
    stageViewerFile(deviceId, file)
        .catch((error) => {
        statusElement.textContent = `File stage failed: ${error instanceof Error ? error.message : String(error)}`;
    })
        .finally(() => {
        input.value = '';
    });
});
refreshButton.addEventListener('click', refresh);
refresh();
window.setInterval(refresh, 250);
