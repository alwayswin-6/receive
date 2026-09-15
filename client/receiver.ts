interface Device {
  device_id?: string;
  safe_device_id?: string;
  timestamp?: string;
  source?: string;
  type?: string;
  signal?: { type?: string; sdp?: string };
}

interface DevicePayload {
  devices?: Device[];
}

const deviceGrid = document.getElementById('deviceGrid') as HTMLDivElement;
const meta = document.getElementById('meta') as HTMLDivElement;
let expandedDeviceId: string | null = null;
let lastPayload: DevicePayload = { devices: [] };
let pollInProgress = false;
const POLL_INTERVAL_MS = 500;

function refreshCardImage(card: HTMLElement, imageUrl: string): void {
  const image = card.querySelector('img.device-image') as HTMLImageElement | null;
  if (!image) return;

  const nextImage = new Image();
  nextImage.onload = () => {
    image.src = nextImage.src;
    image.alt = card.dataset.title || 'device image';
  };
  nextImage.src = `${imageUrl}&_=${Date.now()}`;
}

function renderDevices(devices: Device[]): void {
  if (!devices.length) {
    deviceGrid.innerHTML = '<div class="empty-state">No WebRTC screens have been received yet.</div>';
    return;
  }

  const existingCards = new Map(
    Array.from(deviceGrid.querySelectorAll<HTMLElement>('.device-card')).map((card) => [card.dataset.deviceId, card]),
  );
  let previousCard: HTMLElement | null = null;

  devices.forEach((device) => {
    const deviceId = device.safe_device_id || device.device_id || 'unknown';
    const title = device.device_id || device.safe_device_id || 'Unknown device';
    const isExpanded = expandedDeviceId === deviceId;
    const imageUrl = `/device_image?device_id=${encodeURIComponent(deviceId)}`;
    let card = existingCards.get(deviceId);

    if (!card) {
      card = document.createElement('button');
      (card as HTMLButtonElement).type = 'button';
      card.className = 'device-card';
      card.dataset.deviceId = deviceId;
      card.innerHTML = `
        <div class="image-wrap"><img class="device-image" loading="eager" alt=""></div>
        <div class="title"></div><div class="detail"></div><div class="detail"></div>`;
      deviceGrid.appendChild(card);
    }

    card.className = `device-card${isExpanded ? ' expanded' : ''}`;
    card.dataset.title = title;
    refreshCardImage(card, imageUrl);
    const titleElement = card.querySelector('.title');
    const detailElements = card.querySelectorAll('.detail');
    if (titleElement) titleElement.textContent = title;
    if (detailElements[0]) detailElements[0].textContent = device.timestamp || 'Unknown time';
    if (detailElements[1]) detailElements[1].textContent = `${device.source || 'unknown'} • ${device.signal?.type || device.type || 'offer'}`;

    if (previousCard) deviceGrid.insertBefore(card, previousCard.nextSibling);
    else deviceGrid.insertBefore(card, deviceGrid.firstChild);
    previousCard = card;
    existingCards.delete(deviceId);
  });

  existingCards.forEach((card) => card.remove());
}

function toggleExpanded(deviceId: string): void {
  expandedDeviceId = expandedDeviceId === deviceId ? null : deviceId;
  renderDevices(lastPayload.devices || []);
}

async function pollOnce(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const response = await fetch('/webrtc', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    lastPayload = await response.json() as DevicePayload;
    const devices = lastPayload.devices || [];
    renderDevices(devices);
    meta.textContent = devices.length
      ? `${devices.length} WebRTC device${devices.length === 1 ? '' : 's'} connected • Latest: ${devices[devices.length - 1].timestamp || 'n/a'}`
      : 'Waiting for WebRTC signals...';
  } catch (error) {
    meta.textContent = `Waiting for WebRTC signals... ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    pollInProgress = false;
  }
}

deviceGrid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const card = target.closest<HTMLElement>('.device-card');
  if (card?.dataset.deviceId) toggleExpanded(card.dataset.deviceId);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    expandedDeviceId = null;
    renderDevices(lastPayload.devices || []);
  }
});

pollOnce();
window.setInterval(pollOnce, POLL_INTERVAL_MS);
