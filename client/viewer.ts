interface Device {
  device_id?: string;
  safe_device_id?: string;
  timestamp?: string;
  source?: string;
  type?: string;
}

const statusElement = document.getElementById('status') as HTMLSpanElement;
const deviceListElement = document.getElementById('deviceList') as HTMLDivElement;
const rawStateElement = document.getElementById('rawState') as HTMLDivElement;
const refreshButton = document.getElementById('refreshBtn') as HTMLButtonElement;

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/webrtc', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const data = await response.json() as { devices?: Device[] };
    const devices = data.devices || [];
    deviceListElement.innerHTML = devices.length
      ? devices.map((device) => {
          const id = device.safe_device_id || device.device_id || 'unknown';
          const title = device.device_id || id;
          return `<button class="device-card" type="button" data-device-id="${id}">
            <h3>${title}</h3><div class="meta">${device.timestamp || 'n/a'}</div>
            <div class="meta">${device.type || 'offer'} • ${device.source || 'unknown'}</div>
            <img src="/device_image?device_id=${encodeURIComponent(id)}&_=${Date.now()}" alt="${title}" />
          </button>`;
        }).join('')
      : '<div class="device-card"><h3>No devices</h3><div class="meta">No signaling state available yet.</div></div>';
    rawStateElement.textContent = JSON.stringify(data, null, 2);
    statusElement.textContent = devices.length ? `${devices.length} peer(s) connected` : 'Waiting for peers...';
  } catch (error) {
    statusElement.textContent = 'Connection error';
    rawStateElement.textContent = error instanceof Error ? error.message : String(error);
  }
}

refreshButton.addEventListener('click', refresh);
refresh();
window.setInterval(refresh, 1000);
