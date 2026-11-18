import importlib.util
import hashlib
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
            frame_files = [{'path': str(path), 'relativePath': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]
            manifest.write_text(json.dumps({'repoId': 'local/test-hdf5-sequence', 'episodes': [{'episodeIndex': 0, 'relativePath': '68', 'instruction': 'grasp the red cable connector', 'files': frame_files}]}), encoding='utf-8')
            output, archive, report_path = root / 'dataset', root / 'dataset.zip', root / 'report.json'
            report = converter.convert(manifest, output, archive, report_path)
            self.assertTrue(report['ok'])
            self.assertEqual(report['formatVersion'], 'v3.0')
            self.assertEqual(report['episodes'], 1)
            self.assertEqual(report['frames'], 3)
            self.assertTrue(report['sourceNumericConsistency']['checked'])
            self.assertEqual(report['officialVerification']['status'], 'passed')
            self.assertEqual(report['officialVerification']['officialLerobotVersion'], '0.4.4')
            checked = verify(archive, 'lerobot')
            self.assertTrue(checked['ok'])
            self.assertEqual(checked['episodes'], 1)
            self.assertEqual(checked['frames'], 3)
            self.assertEqual(checked['officialVerification'], 'passed')
            source_index = json.loads((output / 'hdf5-source-index.json').read_text(encoding='utf-8'))
            self.assertTrue(all(row['episodeRelativePath'] == '68' for row in source_index['sourceFiles']))
            self.assertTrue(all(row['frameRelativePath'].endswith('.hdf5') for row in source_index['sourceFiles']))
            self.assertNotIn(str(root), json.dumps(source_index, ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
