import base64
import io
import os
import sys
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from receiver_server import decode_image_payload, is_request_authorized


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


class RenderDeploymentContractTests(unittest.TestCase):
    def test_render_manifest_does_not_force_fixed_port_and_uses_python_start_command(self):
        manifest_path = Path(__file__).resolve().parents[1] / 'render.yaml'
        text = manifest_path.read_text(encoding='utf-8')

        self.assertIn('startCommand: "python receiver_server.py"', text)
        self.assertNotIn('key: PORT', text)


if __name__ == '__main__':
    unittest.main()
