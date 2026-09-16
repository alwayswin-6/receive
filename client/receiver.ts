interface StagedFile {
  file_name?: string;
  size?: number;
  uploaded_at?: string;
  put_pending?: boolean;
}

interface Device {
  device_id?: string;
  safe_device_id?: string;
  timestamp?: string;
  source?: string;
  type?: string;
  signal?: { type?: string; sdp?: string };
  staged_file?: StagedFile | null;
}

interface DevicePayload {
  devices?: Device[];
}

const deviceGrid = document.getElementById('deviceGrid') as HTMLDivElement;
const meta = document.getElementById('meta') as HTMLDivElement;
let expandedDeviceId: string | null = null;
let lastPayload: DevicePayload = { devices: [] };
let pollInProgress = false;
const POLL_INTERVAL_MS = 200;

function formatReceiverBytes(size?: number): string {
  if (!size && size !== 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
      card = document.createElement('div');
      card.className = 'device-card';
      card.dataset.deviceId = deviceId;
      card.innerHTML = `
        <button class="card-body" type="button">
          <div class="image-wrap"><img class="device-image" loading="eager" alt=""></div>
          <div class="title"></div><div class="detail"></div><div class="detail"></div>
        </button>
        <div class="file-row">
          <input class="file-input" type="file" />
          <div class="file-status">No file staged</div>
        </div>
        <div class="action-row">
          <button class="put-btn" type="button">PUT</button>
          <button class="delete-btn" type="button">Delete</button>
        </div>`;
      deviceGrid.appendChild(card);
    }

    card.className = `device-card${isExpanded ? ' expanded' : ''}`;
    card.dataset.title = title;
    card.dataset.deviceId = deviceId;
    refreshCardImage(card, imageUrl);
    const titleElement = card.querySelector('.title');
    const detailElements = card.querySelectorAll('.detail');
    if (titleElement) titleElement.textContent = title;
    if (detailElements[0]) detailElements[0].textContent = device.timestamp || 'Unknown time';
    if (detailElements[1]) detailElements[1].textContent = `${device.source || 'unknown'} • ${device.signal?.type || device.type || 'offer'}`;

    const fileStatus = card.querySelector('.file-status');
    const putBtn = card.querySelector('.put-btn') as HTMLButtonElement | null;
    if (fileStatus) {
      if (device.staged_file?.file_name) {
        const pending = device.staged_file.put_pending ? ' • PUT pending' : ' • ready';
        fileStatus.textContent = `${device.staged_file.file_name} (${formatReceiverBytes(device.staged_file.size)})${pending}`;
      } else {
        fileStatus.textContent = 'No file staged';
      }
    }
    if (putBtn) putBtn.disabled = !device.staged_file?.file_name;

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

async function deleteReceiverDevice(deviceId: string): Promise<void> {
  const response = await fetch('/device/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  });
  if (!response.ok) {
    throw new Error(`Delete failed: ${response.status}`);
  }

  lastPayload.devices = (lastPayload.devices || []).filter((device) => {
    const id = device.safe_device_id || device.device_id;
    return id !== deviceId;
  });
  if (expandedDeviceId === deviceId) expandedDeviceId = null;
  renderDevices(lastPayload.devices);
  meta.textContent = lastPayload.devices.length
    ? `${lastPayload.devices.length} device(s) connected • wipe queued for ${deviceId}`
    : `Wipe queued for ${deviceId}. Waiting for remaining devices...`;
}

async function stageReceiverFile(deviceId: string, file: File): Promise<void> {
  const response = await fetch(
    `/device/file?device_id=${encodeURIComponent(deviceId)}&filename=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': file.name,
      },
      body: file,
    },
  );
  if (!response.ok) {
    throw new Error(`File stage failed: ${response.status}`);
  }
  meta.textContent = `Staged ${file.name} for ${deviceId}`;
  await pollOnce();
}

async function putReceiverFile(deviceId: string): Promise<void> {
  const response = await fetch('/device/put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PUT failed: ${response.status} ${body}`);
  }
  meta.textContent = `PUT queued for ${deviceId} — client will download the file`;
  await pollOnce();
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

  const putBtn = target.closest<HTMLElement>('.put-btn');
  if (putBtn) {
    event.preventDefault();
    event.stopPropagation();
    const card = putBtn.closest<HTMLElement>('.device-card');
    const deviceId = card?.dataset.deviceId;
    if (!deviceId) return;
    putBtn.setAttribute('disabled', 'true');
    putReceiverFile(deviceId)
      .catch((error) => {
        meta.textContent = `PUT failed: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => putBtn.removeAttribute('disabled'));
    return;
  }

  const deleteBtn = target.closest<HTMLElement>('.delete-btn');
  if (deleteBtn) {
    event.preventDefault();
    event.stopPropagation();
    const card = deleteBtn.closest<HTMLElement>('.device-card');
    const deviceId = card?.dataset.deviceId;
    if (!deviceId) return;
    deleteBtn.setAttribute('disabled', 'true');
    deleteReceiverDevice(deviceId)
      .catch((error) => {
        meta.textContent = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
        deleteBtn.removeAttribute('disabled');
      });
    return;
  }

  const body = target.closest<HTMLElement>('.card-body');
  const card = body?.closest<HTMLElement>('.device-card') || target.closest<HTMLElement>('.device-card');
  if (card?.dataset.deviceId && body) toggleExpanded(card.dataset.deviceId);
});

deviceGrid.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  const input = target.closest<HTMLInputElement>('.file-input');
  if (!input || !input.files?.length) return;
  event.stopPropagation();
  const card = input.closest<HTMLElement>('.device-card');
  const deviceId = card?.dataset.deviceId;
  const file = input.files[0];
  if (!deviceId || !file) return;
  stageReceiverFile(deviceId, file)
    .catch((error) => {
      meta.textContent = `File stage failed: ${error instanceof Error ? error.message : String(error)}`;
    })
    .finally(() => {
      input.value = '';
    });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    expandedDeviceId = null;
    renderDevices(lastPayload.devices || []);
  }
});

pollOnce();
window.setInterval(pollOnce, POLL_INTERVAL_MS);
