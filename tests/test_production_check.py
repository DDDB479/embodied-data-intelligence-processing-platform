import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
from production_check import inspect
from lerobot_schema_check import check_file
from verify_delivery import verify
from test_delivery_convert import fixture, converter


class ProductionChecks(unittest.TestCase):
    def test_real_media_and_numeric_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _ = fixture(root)
            parquet = source / 'data/chunk-000/episode_000000.parquet'
            table = pq.read_table(parquet)
            table = table.set_column(table.column_names.index('timestamp'), 'timestamp', pa.array([float('nan'), 0.1, 0.05]))
            table = table.set_column(table.column_names.index('action'), 'action', pa.array([[1.0, 2.0], [3.0], [4.0, float('inf')]]))
            pq.write_table(table, parquet)
            result = check_file(parquet, {'action': {'shape': [2]}}, 20)
            self.assertEqual(result['status'], 'invalid')
            self.assertIsNone(result['firstTimestamp'])
            self.assertTrue(any(item.get('row') == 2 for item in result['findings']))
            json.dumps(result, allow_nan=False)
            assets = [{'id': str(index), 'bundleId': 'B', 'relativePath': file.relative_to(source).as_posix(), 'path': str(file), 'role': 'trajectory' if file.suffix == '.parquet' else 'meta' if 'meta' in file.parts else 'media'} for index, file in enumerate(source.rglob('*')) if file.is_file()]
            report = inspect({'assets': assets})
            videos = [entry['media'] for entry in report['files'] if 'media' in entry]
            self.assertEqual(len(videos), 2)
            self.assertTrue(all(video['frames'] == 3 and video['status'] == 'verified' for video in videos))
            json.dumps(report, allow_nan=False)

    def test_corrupt_video_is_a_failed_check(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'bad.mp4'
            file.write_bytes(b'not a decodable video')
            result = inspect({'assets': [{'id': 'V', 'relativePath': 'videos/bad.mp4', 'path': str(file), 'role': 'media'}]})
            self.assertIn('error', result['files'][0])

    def test_independent_reader_rejects_tampering_and_missing_inventory_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, annotations = fixture(root)
            report = converter.convert(source, root / 'mcap', 'mcap', annotations)
            checked = verify(report['archive'], 'mcap')
            self.assertEqual(checked['decodedVideoFrames'], 6)
            damaged = root / 'damaged.zip'
            with zipfile.ZipFile(report['archive']) as original, zipfile.ZipFile(damaged, 'w') as output:
                for entry in original.infolist():
                    data = original.read(entry)
                    if entry.filename.endswith('.mcap'): data += b'changed'
                    output.writestr(entry.filename, data)
            with self.assertRaisesRegex(ValueError, '哈希'):
                verify(damaged, 'mcap')


if __name__ == '__main__':
    unittest.main()
