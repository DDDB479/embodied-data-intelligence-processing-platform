import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import pyarrow as pa
import pyarrow.parquet as pq

spec = importlib.util.spec_from_file_location('delivery_convert', Path(__file__).parents[1] / 'tools' / 'delivery_convert.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


def fixture(root):
    source = root / 'source'
    (source / 'meta').mkdir(parents=True)
    (source / 'meta' / 'info.json').write_text(json.dumps({'codebase_version': 'v2.1', 'fps': 20, 'features': {'observation.images.head': {'dtype': 'video'}}}), encoding='utf-8')
    (source / 'meta' / 'tasks.jsonl').write_text('{"task_index":0,"task":"old instruction"}\n', encoding='utf-8')
    folder = source / 'data' / 'chunk-000'
    folder.mkdir(parents=True)
    video_folder = source / 'videos' / 'chunk-000' / 'observation.images.head'
    video_folder.mkdir(parents=True)
    for episode in range(2):
        table = pa.table({'timestamp': [0., .05, .1], 'frame_index': [0, 1, 2], 'episode_index': [episode]*3, 'task_index': [0]*3, 'index': [episode*3, episode*3+1, episode*3+2], 'action': [[1., 2.], [3., 4.], [5., 6.]], 'observation.state': [[0., 1.]]*3, 'extra/text': ['a', 'b', 'c'], 'optional': [None, None, None]})
        pq.write_table(table, folder / f'episode_{episode:06d}.parquet')
        import av
        import numpy as np
        with av.open(str(video_folder / f'episode_{episode:06d}.mp4'), mode='w') as output:
            stream = output.add_stream('mpeg4', rate=20)
            stream.width, stream.height, stream.pix_fmt = 640, 480, 'yuv420p'
            for index in range(3):
                pixels = np.full((480, 640, 3), 70 + episode * 20 + index * 30, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(pixels, format='rgb24')
                for packet in stream.encode(frame): output.mux(packet)
            for packet in stream.encode(): output.mux(packet)
    annotations = root / 'annotations.jsonl'
    annotations.write_text(''.join(json.dumps({'episode_index': i, 'instruction': 'approved task'}) + '\n' for i in range(2)), encoding='utf-8')
    return source, annotations


class DeliveryConversionTests(unittest.TestCase):
    def test_formats_roundtrip_and_preserve_source_media_and_instructions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, annotations = fixture(root)
            source_task_hash = converter.digest(source / 'meta' / 'tasks.jsonl')
            for target in ('mcap', 'zarr', 'lerobot'):
                with self.subTest(target=target):
                    output = root / target
                    result = converter.convert(source, output, target, annotations)
                    self.assertEqual(result['frames'], 6)
                    self.assertEqual(result['episodes'], 2)
                    self.assertEqual(len(result['media']), 2)
                    self.assertTrue(result['ok'])
                    self.assertEqual(result['archiveSha256'], converter.digest(Path(result['archive'])))
                    with zipfile.ZipFile(result['archive']) as archive:
                        self.assertIsNone(archive.testzip())
                        self.assertEqual(json.loads(archive.read('meta/tasks.jsonl'))['task'], 'approved task')
                        for media in result['media']:
                            self.assertEqual(archive.read(media['path']), (source / media['path']).read_bytes())
                    if target == 'mcap':
                        from mcap.reader import make_reader
                        with (output / 'episode_000000.mcap').open('rb') as stream:
                            messages = list(make_reader(stream, validate_crcs=True).iter_messages())
                        self.assertEqual(len(messages), 3)
                        self.assertEqual(json.loads(messages[-1][2].data)['action'], [5., 6.])
                        self.assertEqual(messages[-1][2].log_time, 100000000)
                    elif target == 'zarr':
                        import zarr
                        group = zarr.open_group(str(output / 'episode_000000.zarr'), mode='r')
                        self.assertEqual(group['action'].shape, (3, 2))
                        self.assertEqual(group['action'][:].tolist(), [[1., 2.], [3., 4.], [5., 6.]])
                        self.assertEqual(group.attrs['instruction'], 'approved task')
            self.assertEqual(converter.digest(source / 'meta' / 'tasks.jsonl'), source_task_hash)

    def test_missing_camera_fails_without_publishing_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, annotations = fixture(root)
            (source / 'videos' / 'chunk-000' / 'observation.images.head' / 'episode_000001.mp4').unlink()
            with self.assertRaisesRegex(ValueError, 'Missing declared camera'):
                converter.convert(source, root / 'mcap', 'mcap', annotations)
            self.assertFalse((root / 'mcap').exists())
            self.assertFalse((root / 'mcap.zip').exists())

    def test_timestamp_reversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, annotations = fixture(root)
            file = source / 'data' / 'chunk-000' / 'episode_000000.parquet'
            table = pq.read_table(file)
            table = table.set_column(table.column_names.index('timestamp'), 'timestamp', pa.array([0., .1, .05]))
            pq.write_table(table, file)
            with self.assertRaisesRegex(ValueError, 'timestamps'):
                converter.convert(source, root / 'zarr', 'zarr', annotations)
            self.assertFalse((root / 'zarr.zip').exists())


if __name__ == '__main__':
    unittest.main()
