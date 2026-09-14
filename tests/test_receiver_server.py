import base64
import io
import os
import sys
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from receiver_server import build_placeholder_image_bytes, decode_image_payload, is_request_authorized, normalize_webrtc_signal


class DecodeImagePayloadTests(unittest.TestCase):
    def test_decompresses_special_character_map(self):
        image_payload = {
            'data': '@',
            'compression_map': {
                '@': 'SGVsbG8gd29ybGQ=',
            },
            'chunk_size': 4,
        }

        decoded = decode_image_payload(image_payload)

        self.assertEqual(decoded, b'Hello world')

    def test_decodes_webp_base64_payload(self):
        buffer = io.BytesIO()
        Image.new('RGB', (2, 2), color=(255, 0, 0)).save(buffer, format='WEBP')
        webp_bytes = buffer.getvalue()
        payload = {
            'user': {'device_id': 'device-1', 'name': 'ignored'},
            'frame': {'encoding': 'webp-base64', 'width': 2, 'height': 2, 'format': 'webp'},
            'image': {'data': base64.b64encode(webp_bytes).decode('ascii')},
        }

        decoded = decode_image_payload(payload)

        self.assertIsNotNone(decoded)
        self.assertTrue(decoded.startswith(b'\xff\xd8\xff'))


class AuthorizationTests(unittest.TestCase):
    def test_allows_request_without_password_requirement(self):
        self.assertTrue(is_request_authorized({}, {}, required_password=None))

    def test_allows_matching_password(self):
        self.assertTrue(is_request_authorized({'password': 'secret'}, {}, required_password='secret'))

    def test_rejects_wrong_password(self):
        self.assertFalse(is_request_authorized({'password': 'wrong'}, {}, required_password='secret'))


class WebRtcSignalTests(unittest.TestCase):
    def test_normalizes_web_rtc_offer_payload(self):
        signal = normalize_webrtc_signal({
            'type': 'offer',
            'sdp': 'v=0\r\nexample-sdp',
            'device_id': 'device-1',
        })

        self.assertEqual(signal['type'], 'offer')
        self.assertEqual(signal['device_id'], 'device-1')
        self.assertIn('sdp', signal)
        self.assertIn('created_at', signal)


class WebRtcOnlyTransportTests(unittest.TestCase):
    def test_backend_rejects_legacy_upload_route_and_exposes_webrtc_route_only(self):
        server_path = Path(__file__).resolve().parents[1] / 'receiver_server.py'
        text = server_path.read_text(encoding='utf-8')

        self.assertIn("WEBRTC_SIGNAL_PATH = '/webrtc'", text)
        self.assertNotIn("UPLOAD_PATH = '/upload'", text)


class FrontendWebRtcContractTests(unittest.TestCase):
    def test_frontend_defaults_to_webrtc_route_and_not_legacy_upload_path(self):
        app_path = Path(__file__).resolve().parents[2] / 'frontend' / 'screen_capture_app.py'
        text = app_path.read_text(encoding='utf-8')

        self.assertIn("DEFAULT_RECEIVER = 'https://receive.onrender.com/webrtc'", text)
        self.assertNotIn("/upload", text)


class BackendJsonDisplayContractTests(unittest.TestCase):
    def test_serve_json_uses_webrtc_device_records_and_drops_image_url_shape(self):
        server_path = Path(__file__).resolve().parents[1] / 'receiver_server.py'
        text = server_path.read_text(encoding='utf-8')

        self.assertIn("if entry.get('format') == 'webrtc':", text)
        self.assertNotIn("image_url", text)


class DisplayFallbackContractTests(unittest.TestCase):
    def test_placeholder_image_bytes_are_valid_jpeg(self):
        data = build_placeholder_image_bytes()
        self.assertTrue(data.startswith(b'\xff\xd8\xff'))


class FrontendBuildScriptContractTests(unittest.TestCase):
    def test_build_bat_stops_and_removes_locked_screen_capture_executable_before_pyinstaller(self):
        build_bat = Path(__file__).resolve().parents[2] / 'frontend' / 'build.bat'
        text = build_bat.read_text(encoding='utf-8')

        self.assertIn("taskkill /F /IM screen_capture_app.exe", text)
        self.assertIn("rmdir /s /q dist", text)
        self.assertIn("PyInstaller", text)


class RenderDeploymentContractTests(unittest.TestCase):
    def test_render_manifest_does_not_force_fixed_port_and_uses_python_start_command(self):
        manifest_path = Path(__file__).resolve().parents[1] / 'render.yaml'
        text = manifest_path.read_text(encoding='utf-8')

        self.assertIn('startCommand: "python receiver_server.py"', text)
        self.assertNotIn('key: PORT', text)


if __name__ == '__main__':
    unittest.main()
