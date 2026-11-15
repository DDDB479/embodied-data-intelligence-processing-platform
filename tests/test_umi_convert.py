import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_production_check import write_umi_session
from verify_delivery import verify

try:
    import lerobot  # noqa: F401
    HAS_OFFICIAL_LEROBOT = True
except Exception:
    HAS_OFFICIAL_LEROBOT = False


spec = importlib.util.spec_from_file_location('umi_convert', Path(__file__).parents[1] / 'tools' / 'umi_convert.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class UmiConversionTests(unittest.TestCase):
    @unittest.skipUnless(HAS_OFFICIAL_LEROBOT, 'official LeRobot runtime is not installed in this Python environment')
    def test_umi_session_converts_to_official_lerobot_v3(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session = root / 'session_00001'
            required = write_umi_session(session)
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({
                'repoId': 'local/test-umi',
                'episodes': [{
                    'episodeIndex': 0,
                    'sessionId': 'session_00001',
                    'instruction': 'insert the cable connector',
                    'required': {key: str(path) for key, path in required.items()},
                    'files': [{'path': str(path), 'role': key, 'size': path.stat().st_size} for key, path in required.items()],
                }],
            }), encoding='utf-8')
            output, archive, report_path = root / 'dataset', root / 'dataset.zip', root / 'report.json'
            report = converter.convert(manifest, output, archive, report_path)
            self.assertTrue(report['ok'])
            self.assertEqual(report['formatVersion'], 'v3.0')
            self.assertEqual(report['episodes'], 1)
            self.assertEqual(report['frames'], 12)
            self.assertEqual(report['officialVerification']['status'], 'passed')
            self.assertEqual(report['officialVerification']['officialLerobotVersion'], '0.4.4')
            checked = verify(archive, 'lerobot')
            self.assertTrue(checked['ok'])
            self.assertEqual(checked['episodes'], 1)
            self.assertEqual(checked['frames'], 12)
            self.assertEqual(checked['officialVerification'], 'passed')


if __name__ == '__main__':
    unittest.main()
