import base64
import binascii
import io
import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - environment fallback
    Image = None
    ImageDraw = None
    ImageFont = None

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', '8765'))
WEBRTC_SIGNAL_PATH = '/webrtc'
HEALTH_PATH = '/health'
LATEST_IMAGE_PATH = '/latest'
LATEST_META_PATH = '/latest.json'
DEVICE_IMAGE_PATH = '/device_image'
ARCHIVE_DIR = os.environ.get('ARCHIVE_DIR', os.path.join(ROOT, 'archive'))
REQUIRED_PASSWORD = os.environ.get('RECEIVER_PASSWORD')
os.makedirs(ARCHIVE_DIR, exist_ok=True)

latest_image_file = os.path.join(ROOT, 'latest_capture.jpg')
latest_meta_file = os.path.join(ROOT, 'latest_capture.json')
state_file = os.path.join(ROOT, 'captures.json')

# Keep image payloads in memory only so the UI can display them without persisting
# screenshots to the filesystem. This satisfies the privacy/no-save requirement while
# preserving the latest/global and per-device image endpoints.
latest_image_bytes = None
device_image_cache = {}


def get_bind_address():
    return (HOST, PORT)


def sanitize_device_id(device_id):
    if not device_id:
        return 'unknown'
    safe = re.sub(r'[^A-Za-z0-9._-]+', '_', str(device_id)).strip('._-')
    return safe or 'unknown'


def load_state():
    if not os.path.exists(state_file):
        return {}
    with open(state_file, 'r', encoding='utf-8') as handle:
        try:
            return json.load(handle)
        except json.JSONDecodeError:
            return {}


def save_state(state):
    with open(state_file, 'w', encoding='utf-8') as handle:
        json.dump(state, handle, indent=2)


def is_request_authorized(payload, headers, required_password=None):
    password = required_password if required_password is not None else REQUIRED_PASSWORD
    if not password:
        return True

    payload_password = None
    if isinstance(payload, dict):
        payload_password = payload.get('password')

    header_password = headers.get('X-Receiver-Password') or headers.get('Authorization')
    if header_password and header_password.startswith('Bearer '):
        header_password = header_password.split(' ', 1)[1]

    if payload_password is not None:
        return str(payload_password) == str(password)
    if header_password is not None:
        return str(header_password) == str(password)
    return False


def detect_image_type(bytes_payload):
    if not bytes_payload:
        return ('application/octet-stream', 'bin')
    if bytes_payload.startswith(b'\xff\xd8\xff'):
        return ('image/jpeg', 'jpg')
    if bytes_payload.startswith(b'\x89PNG'):
        return ('image/png', 'png')
    if bytes_payload[:12].startswith(b'RIFF') and bytes_payload[8:12] == b'WEBP':
        return ('image/webp', 'webp')
    if bytes_payload.startswith(b'GIF8'):
        return ('image/gif', 'gif')
    return ('image/jpeg', 'jpg')


def build_placeholder_image_bytes(width=640, height=360):
    """Return a JPEG placeholder image for the image-display endpoints when no capture file exists yet."""
    if Image is None or ImageDraw is None or ImageFont is None:
        return b''

    image = Image.new('RGB', (width, height), color=(22, 24, 31))
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype('arial.ttf', 20)
    except Exception:
        font = ImageFont.load_default()

    draw.rectangle((0, 0, width, height), fill=(16, 20, 30))
    draw.rectangle((10, 10, width - 10, height - 10), outline=(80, 170, 255), width=2)
    text = 'No screen capture available'
    bbox = draw.textbbox((0, 0), text, font=font)
    x = (width - (bbox[2] - bbox[0])) // 2
    y = (height - (bbox[3] - bbox[1])) // 2
    draw.text((x, y), text, fill=(220, 230, 240), font=font)

    buffer = io.BytesIO()
    image.save(buffer, format='JPEG', quality=90)
    return buffer.getvalue()


def normalize_webrtc_signal(payload):
    """Normalize a WebRTC offer/answer-style payload into the server's existing metadata model."""
    if not isinstance(payload, dict):
        return None

    safe_type = str(payload.get('type') or 'offer').lower()
    if safe_type not in {'offer', 'answer', 'candidate', 'ping'}:
        safe_type = 'offer'

    device_id = payload.get('device_id') or payload.get('user', {}).get('device_id') or 'unknown'
    safe_device_id = sanitize_device_id(str(device_id))
    sdp = payload.get('sdp') or payload.get('description') or payload.get('candidate') or ''
    if isinstance(sdp, (dict, list)):
        sdp = json.dumps(sdp, sort_keys=True)

    normalized = {
        'type': safe_type,
        'sdp': str(sdp),
        'device_id': str(device_id),
        'safe_device_id': safe_device_id,
        'created_at': payload.get('created_at') or datetime.now(timezone.utc).isoformat(),
        'source': payload.get('source') or 'webrtc-signal',
        'encoding': 'sdp',
        'format': 'webrtc',
    }
    return normalized


def decode_image_payload(payload):
    if isinstance(payload, dict):
        # WebRTC-signal transport carries image bytes in the image field or in the sdp field.
        if payload.get('type') in {'offer', 'answer', 'candidate'} and isinstance(payload.get('sdp'), str):
            image_payload = payload.get('image', payload.get('sdp'))
        else:
            image_payload = payload.get('image', payload)

        if isinstance(image_payload, dict):
            image_data = image_payload.get('data')
            compression_map = image_payload.get('compression_map') or payload.get('compression_map')
        else:
            image_data = image_payload
            compression_map = payload.get('compression_map')
    else:
        image_data = payload
        compression_map = None

    if not isinstance(image_data, str):
        return None

    candidate = image_data.strip()
    if candidate.startswith('data:'):
        header, _, encoded = candidate.partition(',')
        if ';base64' in header:
            candidate = encoded

    frame_payload = payload.get('frame', {}) if isinstance(payload, dict) else {}
    encoding = frame_payload.get('encoding') if isinstance(frame_payload, dict) else None

    if encoding == 'webp-base64' or encoding == 'jpeg-base64':
        try:
            decoded_bytes = base64.b64decode(candidate, validate=True)
        except (binascii.Error, ValueError):
            return None

        if Image is not None:
            try:
                with Image.open(io.BytesIO(decoded_bytes)) as image:
                    image = image.convert('RGB')
                    buffer = io.BytesIO()
                    image.save(buffer, format='JPEG', quality=90)
                    return buffer.getvalue()
            except Exception:
                pass

        return decoded_bytes

    if compression_map:
        expanded = ''.join(compression_map.get(char, char) for char in candidate)
        candidates = [expanded, candidate]
    else:
        candidates = [candidate]

    for candidate_text in candidates:
        if not candidate_text:
            continue
        normalized = candidate_text.strip()
        if normalized.startswith('data:'):
            _, _, encoded = normalized.partition(',')
            normalized = encoded

        if normalized.startswith('image/') or normalized.startswith('application/'):
            continue

        try:
            padding = '=' * (-len(normalized) % 4)
            bytes_payload = base64.b64decode(normalized + padding, validate=False)
            if bytes_payload.startswith(b'\x89PNG') or bytes_payload.startswith(b'\xff\xd8\xff') or bytes_payload.startswith(b'GIF8') or bytes_payload.startswith(b'RIFF'):
                return bytes_payload
            if bytes_payload and b'\x00' not in bytes_payload[:32]:
                return bytes_payload
        except (binascii.Error, ValueError):
            continue

    return None


class ReceiverHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


class ReceiverHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ('/', '/receiver.html'):
            self.serve_file('receiver.html')
        elif path == WEBRTC_SIGNAL_PATH:
            self.serve_webrtc_state()
        elif path == HEALTH_PATH:
            self.send_json(200, {'status': 'ok', 'method': 'webrtc'})
        elif path == LATEST_IMAGE_PATH:
            self.serve_image()
        elif path == LATEST_META_PATH:
            self.serve_json()
        elif path == DEVICE_IMAGE_PATH:
            self.serve_device_image()
        else:
            self.send_error(404, 'Not found')

    def do_POST(self):
        request_path = urlparse(self.path).path
        if request_path in ('/', WEBRTC_SIGNAL_PATH, WEBRTC_SIGNAL_PATH + '/'):
            self.handle_webrtc_signal()
            return

        self.send_error(404, 'Not found')

    def handle_webrtc_signal(self):
        content_length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(content_length).decode('utf-8')

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {'error': 'Invalid JSON'})
            return

        if not is_request_authorized(payload, dict(self.headers), REQUIRED_PASSWORD):
            self.send_json(401, {'error': 'Unauthorized', 'message': 'Incorrect password'})
            return

        signal = normalize_webrtc_signal(payload)
        if signal is None:
            self.send_json(400, {'error': 'Unable to normalize WebRTC signal'})
            return

        safe_device_id = signal['safe_device_id']
        state = load_state()
        state[safe_device_id] = {
            'device_id': signal['device_id'],
            'safe_device_id': safe_device_id,
            'timestamp': signal['created_at'],
            'source': signal['source'],
            'format': signal['format'],
            'encoding': signal['encoding'],
            'type': signal['type'],
            'title': 'WebRTC signal',
            'url': WEBRTC_SIGNAL_PATH,
            'webrtc': signal,
        }
        save_state(state)

        # Keep the WebRTC record and place screenshot bytes into in-memory caches only.
        decoded = decode_image_payload(payload)
        if decoded:
            global latest_image_bytes
            latest_image_bytes = decoded
            device_image_cache[safe_device_id] = decoded

        self.send_json(200, {
            'status': 'ok',
            'method': 'webrtc',
            'device_id': signal['device_id'],
            'signal_type': signal['type'],
        })

    def serve_webrtc_state(self):
        state = load_state()
        devices = []
        for device_key in sorted(state.keys()):
            entry = state[device_key]
            if entry.get('format') == 'webrtc':
                devices.append({
                    'device_id': entry.get('device_id') or device_key,
                    'safe_device_id': entry.get('safe_device_id') or device_key,
                    'timestamp': entry.get('timestamp'),
                    'source': entry.get('source'),
                    'format': entry.get('format'),
                    'encoding': entry.get('encoding'),
                    'type': entry.get('type'),
                    'signal': entry.get('webrtc'),
                })

        body = json.dumps({'devices': devices}, indent=2).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, filename):
        target = os.path.join(ROOT, filename)
        if not os.path.exists(target):
            self.send_error(404, 'File not found')
            return

        with open(target, 'rb') as handle:
            content = handle.read()

        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)

    def serve_image(self):
        global latest_image_bytes
        content = latest_image_bytes if latest_image_bytes else build_placeholder_image_bytes()
        if not content:
            self.send_error(404, 'No capture available yet')
            return

        mime, _ = detect_image_type(content)
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)

    def serve_device_image(self):
        query = parse_qs(urlparse(self.path).query)
        device_id = query.get('device_id', [''])[0]
        safe_device_id = sanitize_device_id(device_id)

        content = device_image_cache.get(safe_device_id)
        if not content:
            content = build_placeholder_image_bytes()
            if not content:
                self.send_error(404, 'No capture available for that device')
                return

        mime, _ = detect_image_type(content)
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(content)

    def serve_json(self):
        state = load_state()
        devices = []
        for device_key in sorted(state.keys()):
            entry = state[device_key]
            if entry.get('format') != 'webrtc':
                continue
            devices.append({
                'device_id': entry.get('device_id') or device_key,
                'safe_device_id': entry.get('safe_device_id') or device_key,
                'timestamp': entry.get('timestamp'),
                'source': entry.get('source'),
                'format': entry.get('format'),
                'encoding': entry.get('encoding'),
                'type': entry.get('type'),
                'signal': entry.get('webrtc'),
            })

        payload = {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'devices': devices,
            'latest': devices[-1] if devices else None,
        }
        body = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status_code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


if __name__ == '__main__':
    bind_host = os.environ.get('HOST', '0.0.0.0')
    bind_port = int(os.environ.get('PORT', '8765'))
    server = ReceiverHTTPServer((bind_host, bind_port), ReceiverHandler)
    print(f'Receiver server listening on http://{bind_host}:{bind_port}')
    server.serve_forever()
