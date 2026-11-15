import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_production_check import encoded_image, write_hdf5_episode
from verify_delivery import verify

try:
    import lerobot  # noqa: F401
    HAS_OFFICIAL_LEROBOT = True
except Exception:
    HAS_OFFICIAL_LEROBOT = False


spec = importlib.util.spec_from_file_location('hdf5_sequence_convert', Path(__file__).parents[1] / 'tools' / 'hdf5_sequence_convert.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class Hdf5SequenceConversionTests(unittest.TestCase):
    @unittest.skipUnless(HAS_OFFICIAL_LEROBOT, 'official LeRobot runtime is not installed in this Python environment')
    def test_frame_directory_converts_to_official_lerobot_v3(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            session = root / '68'
            session.mkdir()
            files = [write_hdf5_episode(session, f'{index}.hdf5', index * 50, rgb, depth) for index in range(3)]
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'repoId': 'local/test-hdf5-sequence', 'episodes': [{'episodeIndex': 0, 'instruction': 'grasp the red cable connector', 'files': [{'path': str(path)} for path in files]}]}), encoding='utf-8')
            output, archive, report_path = root / 'dataset', root / 'dataset.zip', root / 'report.json'
            report = converter.convert(manifest, output, archive, report_path)
            self.assertTrue(report['ok'])
            self.assertEqual(report['formatVersion'], 'v3.0')
            self.assertEqual(report['episodes'], 1)
            self.assertEqual(report['frames'], 3)
            self.assertEqual(report['officialVerification']['status'], 'passed')
            self.assertEqual(report['officialVerification']['officialLerobotVersion'], '0.4.4')
            checked = verify(archive, 'lerobot')
            self.assertTrue(checked['ok'])
            self.assertEqual(checked['episodes'], 1)
            self.assertEqual(checked['frames'], 3)
            self.assertEqual(checked['officialVerification'], 'passed')


if __name__ == '__main__':
    unittest.main()
