const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const peerState = new Map();
const deviceImageCache = new Map();
let latestImageBytes = null;

function sanitizeDeviceId(value) {
  const raw = String(value ?? 'unknown');
  return raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '') || 'unknown';
}

function isValidSignalType(value) {
  const type = String(value ?? 'offer').toLowerCase();
  return ['offer', 'answer', 'candidate', 'ping'].includes(type);
}

function normalizeSignal(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = isValidSignalType(payload.type) ? String(payload.type).toLowerCase() : 'offer';
  const deviceId = payload.deviceId || payload.device_id || payload.user?.device_id || 'unknown';
  const normalized = {
    type,
    deviceId: String(deviceId),
    safeDeviceId: sanitizeDeviceId(deviceId),
    targetDeviceId: payload.targetDeviceId || payload.target_device_id || null,
    source: payload.source || 'webrtc-signal',
    createdAt: payload.createdAt || payload.created_at || new Date().toISOString(),
  };

  if (payload.sdp) normalized.sdp = String(payload.sdp);
  if (payload.candidate) normalized.candidate = payload.candidate;
  if (payload.candidates) normalized.candidates = payload.candidates;
  if (payload.answer) normalized.answer = payload.answer;
  if (payload.offer) normalized.offer = payload.offer;

  return normalized;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;

    req.on('data', (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw || '{}');
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
}

function upsertPeer(deviceId, signal) {
  const safeId = sanitizeDeviceId(signal.targetDeviceId || deviceId);
  const current = peerState.get(safeId) || {
    deviceId: safeId,
    safeDeviceId: safeId,
    source: 'webrtc-signal',
    createdAt: new Date().toISOString(),
    offer: null,
    answer: null,
    candidates: []
  };

  if (signal.type === 'offer') current.offer = signal;
  if (signal.type === 'answer') current.answer = signal;
  if (signal.type === 'candidate') {
    current.candidates = current.candidates || [];
    current.candidates.push(signal.candidate || signal);
  }

  if (signal.type === 'offer' || !signal.targetDeviceId) {
    current.deviceId = signal.deviceId || current.deviceId;
  }
  current.safeDeviceId = safeId;
  current.source = current.offer?.source || signal.source || current.source;
  current.createdAt = signal.createdAt || current.createdAt;
  current.updatedAt = new Date().toISOString();

  peerState.set(safeId, current);
  return current;
}

function buildDeviceList() {
  return Array.from(peerState.values()).map((entry) => ({
    device_id: entry.deviceId,
    safe_device_id: entry.safeDeviceId,
    timestamp: entry.updatedAt || entry.createdAt,
    source: entry.source,
    format: 'webrtc',
    encoding: 'sdp',
    type: entry.offer?.type || entry.answer?.type || 'offer',
    sdp: entry.offer?.sdp || entry.answer?.sdp || null,
    signal: entry.offer || entry.answer || { type: 'offer' },
    answer: entry.answer || null,
    candidates: entry.candidates || []
  }));
}

async function handleSignalRequest(req, res) {
  let body = '{}';
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: String(error.message) });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid JSON payload' });
    return;
  }

  const signal = normalizeSignal(payload);
  if (!signal) {
    sendJson(res, 400, { error: 'Unable to normalize WebRTC signal' });
    return;
  }

  const peer = upsertPeer(signal.deviceId, signal);
  sendJson(res, 200, {
    status: 'ok',
    method: 'webrtc',
    deviceId: signal.deviceId,
    safeDeviceId: signal.safeDeviceId,
    signalType: signal.type,
    peer: {
      deviceId: peer.deviceId,
      safeDeviceId: peer.safeDeviceId,
      candidates: peer.candidates || []
    }
  });
}

async function handleUpload(req, res, url) {
  const params = new URLSearchParams(url.search);
  const deviceId = params.get('device_id') || 'unknown';
  const bodyChunks = [];

  try {
    for await (const chunk of req) {
      bodyChunks.push(chunk);
      if (Buffer.concat(bodyChunks).length > 20 * 1024 * 1024) {
        throw new Error('Image payload too large');
      }
    }
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const bytes = Buffer.concat(bodyChunks);
  if (!bytes.length) {
    sendJson(res, 400, { error: 'Missing image bytes' });
    return;
  }

  latestImageBytes = bytes;
  deviceImageCache.set(sanitizeDeviceId(deviceId), bytes);
  upsertPeer(deviceId, {
    type: 'ping',
    deviceId: String(deviceId),
    targetDeviceId: null,
    source: 'http-upload',
    createdAt: new Date().toISOString()
  });

  sendJson(res, 200, {
    status: 'ok',
    method: 'upload',
    deviceId,
    safeDeviceId: sanitizeDeviceId(deviceId)
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', method: 'webrtc' });
    return;
  }

  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/receiver.html')) {
    sendFile(res, path.join(ROOT, 'receiver.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && (requestUrl.pathname === '/viewer.html' || requestUrl.pathname === '/viewer')) {
    sendFile(res, path.join(ROOT, 'viewer.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && (requestUrl.pathname === '/browser-peer.html' || requestUrl.pathname === '/browser-peer')) {
    sendFile(res, path.join(ROOT, 'browser-peer.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && /^\/scripts\/[A-Za-z0-9._-]+\.js$/.test(requestUrl.pathname)) {
    sendFile(res, path.join(ROOT, requestUrl.pathname), 'application/javascript; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/webrtc') {
    sendJson(res, 200, { devices: buildDeviceList() });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/latest') {
    if (!latestImageBytes) {
      sendJson(res, 404, { error: 'No capture available yet' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(latestImageBytes);
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/device_image') {
    const deviceId = requestUrl.searchParams.get('device_id') || 'unknown';
    const image = deviceImageCache.get(sanitizeDeviceId(deviceId)) || latestImageBytes;
    if (!image) {
      sendJson(res, 404, { error: 'No capture available for that device' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(image);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/webrtc') {
    handleSignalRequest(req, res);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/upload') {
    handleUpload(req, res, requestUrl);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebRTC signaling server listening on http://0.0.0.0:${PORT}`);
});
