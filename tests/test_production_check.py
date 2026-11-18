import json
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

import pyarrow as pa
import pyarrow.parquet as pq
import av
import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
from production_check import inspect
from production_check import check_hdf5, check_umi_session
from lerobot_schema_check import check_file
from verify_delivery import verify
from test_delivery_convert import fixture, converter


def encoded_image(root, name, codec, pix_fmt, frame_format):
    path = root / name
    shape = (480, 640, 1) if frame_format == 'gray' else (480, 640, 3)
    with av.open(str(path), mode='w', format='image2') as output:
        stream = output.add_stream(codec, rate=1)
        stream.width = 640
        stream.height = 480
        stream.pix_fmt = pix_fmt
        frame = av.VideoFrame.from_ndarray(np.full(shape, 128, dtype=np.uint8), format=frame_format)
        for packet in stream.encode(frame): output.mux(packet)
        for packet in stream.encode(): output.mux(packet)
    return path.read_bytes()


def write_hdf5_episode(directory, name, timestamp, rgb, depth, non_finite=False):
    path = directory / name
    with h5py.File(path, 'w') as hdf:
        hdf.create_dataset('timestamps', data=np.array([timestamp], dtype=np.int32))
        for field, length in [('master/joint_position', 16), ('master/eef', 28), ('puppet/joint_position', 16), ('puppet/eef', 28), ('puppet/joint_effort', 16)]:
            values = np.arange(length, dtype=np.float32)
            if non_finite: values[0] = np.nan
            hdf.create_dataset(field, data=values)
        hdf.create_dataset('puppet/6f', data=np.zeros(12, dtype=np.float32))
        rgb_group = hdf.create_group('observations/rgb_images')
        depth_group = hdf.create_group('observations/depth_images')
        for index in range(4): rgb_group.create_dataset(f'camera_{index}', data=np.frombuffer(rgb, dtype=np.uint8))
        for index in (1, 2): depth_group.create_dataset(f'camera_{index}', data=np.frombuffer(depth, dtype=np.uint8))
    return path


def write_umi_session(directory):
    import csv
    frames = 12
    paths = {key: directory / relative for key, relative in {
        'metadata': 'single_hand/Metadata/metadata.json', 'uiMetadata': 'Metadata/ui_backend_metadata.json',
        'pcMetadata': 'single_hand/Metadata/pc_metadata.json', 'jointMetadata': 'single_hand/Metadata/pc_joint_metadata.json',
        'video': 'single_hand/RGB_Images/video.mp4', 'rgbTimestamps': 'single_hand/RGB_Images/timestamps.csv',
        'trajectory': 'single_hand/Merged_Trajectory/merged_trajectory.txt', 'vive': 'single_hand/Merged_Trajectory/vut_raw.csv',
        'clamp': 'single_hand/Clamp_Data/clamp_timebase.csv', 'clampTum': 'single_hand/Clamp_Data/clamp_data_tum.txt',
    }.items()}
    for path in paths.values(): path.parent.mkdir(parents=True, exist_ok=True)
    paths['metadata'].write_text(json.dumps({'config': {'project_config_snapshot': {'capture': {'task_name': 'task-umi'}}}}), encoding='utf-8')
    paths['uiMetadata'].write_text(json.dumps({'session_id': 'session-test', 'task_name': 'task-umi', 'quality_status': 'pass', 'can_process': True, 'capture_status': 'completed'}), encoding='utf-8')
    paths['pcMetadata'].write_text('{}', encoding='utf-8')
    paths['jointMetadata'].write_text('{}', encoding='utf-8')
    paths['trajectory'].write_text('\n'.join(f'{index / 40} 0 0 0 0 0 0 1' for index in range(frames)), encoding='utf-8')
    paths['clampTum'].write_text('0 0 0 0', encoding='utf-8')
    base = 1_000_000_000
    with paths['rgbTimestamps'].open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream); writer.writerow(['frame_id', 'timestamp_ns'])
        for index in range(frames): writer.writerow([index, base + round(index * 25_000_000)])
    with paths['vive'].open('w', encoding='utf-8', newline='') as stream:
        fields = ['timestamp_ns', 'vut_monotonic_ns', 'device_id', 'serial', 'state', 'x_m', 'y_m', 'z_m', 'qx', 'qy', 'qz', 'qw', 'vx_mps', 'vy_mps', 'vz_mps', 'wx_radps', 'wy_radps', 'wz_radps', 'flags']
        writer = csv.DictWriter(stream, fieldnames=fields); writer.writeheader()
        for index in range(frames * 3):
            writer.writerow({'timestamp_ns': base - 10_000_000 + round(index * 8_333_333), 'vut_monotonic_ns': index, 'device_id': 1, 'serial': 'test', 'state': 2, 'x_m': index / 1000, 'y_m': 0, 'z_m': 0, 'qx': 0, 'qy': 0, 'qz': 0, 'qw': 1, 'vx_mps': 0, 'vy_mps': 0, 'vz_mps': 0, 'wx_radps': 0, 'wy_radps': 0, 'wz_radps': 0, 'flags': 0})
    with paths['clamp'].open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream); writer.writerow(['sample_id', 'timestamp_ns', 'monotonic_ns', 'value'])
        for index in range(frames * 2): writer.writerow([index, base - 5_000_000 + round(index * 16_666_666), index, 50 + index % 10])
    with av.open(str(paths['video']), mode='w') as output:
        stream = output.add_stream('mpeg4', rate=40); stream.width = 640; stream.height = 480; stream.pix_fmt = 'yuv420p'
        for index in range(frames):
            frame = av.VideoFrame.from_ndarray(np.full((480, 640, 3), 40 + index, dtype=np.uint8), format='rgb24')
            for packet in stream.encode(frame): output.mux(packet)
        for packet in stream.encode(): output.mux(packet)
    return paths


class ProductionChecks(unittest.TestCase):
    def test_umi_session_checks_alignment_and_numeric_channels(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = write_umi_session(Path(directory))
            asset = {'sessionId': 'session-test', 'taskName': 'task-umi', 'required': {key: str(value) for key, value in paths.items()}}
            result = check_umi_session(asset, {'video': {'minWidth': 640, 'minHeight': 480, 'blackRatioMax': .95, 'freezeRatioMax': .98}, 'umi': {}})
            self.assertEqual(result['status'], 'verified', json.dumps(result, ensure_ascii=False))
            self.assertEqual(result['metrics']['cameraFrames'], 12)
            self.assertAlmostEqual(result['metrics']['viveHz'], 120, delta=1)
            self.assertAlmostEqual(result['metrics']['clampHz'], 60, delta=1)
            self.assertLessEqual(abs(result['sync']['startOffsetMs']), 100)

    def test_hdf5_profile_checks_numeric_images_and_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            session = root / 'session'
            session.mkdir()
            paths = [write_hdf5_episode(session, f'{index}.hdf5', timestamp, rgb, depth) for index, timestamp in enumerate([0, 50, 400])]
            assets = [{'id': str(index), 'bundleId': 'B', 'relativePath': f'session/{index}.hdf5', 'path': str(path), 'role': 'trajectory'} for index, path in enumerate(paths)]
            report = inspect({'assets': assets, 'settings': {'hdf5': {'gapAbsoluteMs': 100, 'minWidth': 640, 'minHeight': 480}}})
            for item in report['files']:
                self.assertEqual(item['hdf5']['profile'], 'teleop-hdf5-v1')
                self.assertEqual(item['hdf5']['metrics']['rgbDecodedImages'], 4)
                self.assertEqual(item['hdf5']['metrics']['depthDecodedImages'], 2)
                self.assertIn('puppet/6f', item['hdf5']['metrics']['constantDatasets'])
                self.assertIn('puppet/6f', item['hdf5']['metrics']['optionalConstantDatasets'])
                self.assertFalse(any(issue['code'] == 'constant_dataset' for issue in item['hdf5']['issues']))
                self.assertEqual(item['hdf5']['sequence']['gapCount'], 1)
            json.dumps(report, allow_nan=False)

    def test_hdf5_non_finite_value_is_a_data_defect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            path = write_hdf5_episode(root, 'bad.hdf5', 0, rgb, depth, non_finite=True)
            result = check_hdf5(path, {})
            self.assertEqual(result['status'], 'invalid')
            self.assertTrue(any(item['code'] == 'non_finite' for item in result['issues']))

    def test_hdf5_frame_directory_is_checked_as_one_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            session = root / '68'
            session.mkdir()
            paths = [write_hdf5_episode(session, f'{index}.hdf5', timestamp, rgb, depth) for index, timestamp in enumerate([0, 50, 400])]
            members = [{'relativePath': path.name, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]
            report = inspect({'assets': [{'id': 'sequence', 'bundleId': 'B', 'relativePath': '68', 'path': str(session), 'role': 'trajectory', 'members': members}], 'settings': {'hdf5': {'gapAbsoluteMs': 100, 'minWidth': 640, 'minHeight': 480}}})
            result = report['files'][0]
            self.assertEqual(result['hdf5']['profile'], 'matching_cable_frames_v1')
            self.assertEqual(result['hdf5']['status'], 'invalid')
            self.assertEqual(result['hdf5']['metrics']['sampleCount'], 3)
            self.assertEqual(result['hdf5']['metrics']['rgbDecodedImages'], 12)
            self.assertEqual(result['hdf5']['metrics']['depthDecodedImages'], 6)
            self.assertEqual(result['hdf5']['sequence']['gapCount'], 1)
            self.assertEqual(result['structure']['recordCount'], 3)
            json.dumps(report, allow_nan=False)

    def test_hdf5_source_hash_mismatch_is_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            path = write_hdf5_episode(root, 'frame.hdf5', 0, rgb, depth)
            result = check_hdf5(path, {}, '0' * 64)
            self.assertEqual(result['status'], 'invalid')
            self.assertTrue(any(item['code'] == 'source_sha256' for item in result['issues']))

    def test_hdf5_timestamp_reversal_and_cadence_drift_are_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            session = root / '68'
            session.mkdir()
            paths = [write_hdf5_episode(session, f'{index}.hdf5', timestamp, rgb, depth) for index, timestamp in enumerate([0, 50, 40, 111])]
            members = [{'relativePath': path.name, 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]
            report = inspect({'assets': [{'id': 'sequence', 'bundleId': 'B', 'relativePath': '68', 'path': str(session), 'role': 'trajectory', 'members': members}], 'settings': {'hdf5': {'gapAbsoluteMs': 100, 'cadenceToleranceMs': 10, 'minWidth': 640, 'minHeight': 480}}})
            item = report['files'][0]['hdf5']
            self.assertEqual(item['status'], 'invalid')
            self.assertTrue(any(issue['code'] == 'timestamp_order' for issue in item['issues']))
            self.assertGreater(item['sequence']['cadenceDeviationCount'], 0)

    def test_unknown_hdf5_profile_is_capability_blocked_not_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'unknown.hdf5'
            with h5py.File(path, 'w') as hdf:
                hdf.create_dataset('other', data=np.arange(4))
            result = check_hdf5(path, {})
            self.assertEqual(result['status'], 'not_supported')
            self.assertFalse(result['issues'])

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
            self.assertEqual(result['taskIndices'], [0])
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
