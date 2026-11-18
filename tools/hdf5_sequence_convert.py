"""Build and verify an official LeRobot v3.0 dataset from frame-wise HDF5 episodes."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import time
import zipfile

from official_lerobot import json_safe, verify_v30


os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_DATASETS_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

CAMERAS = [f'observation.images.camera_{index}' for index in range(4)]
DEPTH_CAMERAS = ['camera_1', 'camera_2']
STATE_FIELD = 'puppet/joint_position'
ACTION_FIELD = 'master/joint_position'


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_numeric(handle, field: str, width: int):
    import numpy as np
    if field not in handle:
        raise ValueError(f'缺少字段 /{field}')
    values = np.asarray(handle[field][()], dtype=np.float32).reshape(-1)
    if values.size != width:
        raise ValueError(f'/{field} 维度为 {values.size}，期望 {width}')
    if not np.isfinite(values).all():
        raise ValueError(f'/{field} 包含 NaN 或 Inf')
    return values


def decode_rgb(raw, field: str, expected_shape=None):
    import av
    import numpy as np
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(bytes(raw))).convert('RGB')
        array = np.asarray(image, dtype=np.uint8)
    except Exception:
        try:
            with av.open(io.BytesIO(bytes(raw))) as container:
                frame = next(container.decode(video=0))
                array = frame.to_ndarray(format='rgb24')
        except Exception as error:
            raise ValueError(f'{field} 图像无法解码：{error}') from error
    if expected_shape and tuple(array.shape) != tuple(expected_shape):
        raise ValueError(f'{field} 图像尺寸发生变化：期望 {expected_shape}，实际 {array.shape}')
    return array


def validate_depth(raw, field: str):
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(bytes(raw)))
        image.load()
    except Exception as error:
        raise ValueError(f'{field} 深度图无法解码：{error}') from error


def image_buffer(dataset):
    import numpy as np
    if dataset.ndim == 1 and dataset.dtype == np.uint8:
        return dataset[()]
    if dataset.ndim == 0:
        return dataset[()]
    return dataset[0]


def feature_definitions(shapes):
    features = {
        'observation.state': {'dtype': 'float32', 'shape': (16,), 'names': [f'puppet_joint_{index}' for index in range(16)]},
        'action': {'dtype': 'float32', 'shape': (16,), 'names': [f'master_joint_{index}' for index in range(16)]},
        'observation.eef': {'dtype': 'float32', 'shape': (28,), 'names': [f'puppet_eef_{index}' for index in range(28)]},
        'master.eef': {'dtype': 'float32', 'shape': (28,), 'names': [f'master_eef_{index}' for index in range(28)]},
        'observation.joint_effort': {'dtype': 'float32', 'shape': (16,), 'names': [f'joint_effort_{index}' for index in range(16)]},
        'observation.force_torque': {'dtype': 'float32', 'shape': (12,), 'names': [f'force_torque_{index}' for index in range(12)]},
        'source.timestamp_ms': {'dtype': 'float32', 'shape': (1,), 'names': None},
    }
    for key, shape in shapes.items():
        features[key] = {'dtype': 'video', 'shape': shape, 'names': ['height', 'width', 'channels']}
    return features


def inspect_first_frame(path: Path):
    import h5py
    shapes = {}
    with h5py.File(path, 'r') as handle:
        for index, key in enumerate(CAMERAS):
            raw = image_buffer(handle[f'observations/rgb_images/camera_{index}'])
            image = decode_rgb(raw, key)
            shapes[key] = tuple(int(value) for value in image.shape)
        if 'timestamps' not in handle:
            raise ValueError(f'{path.name} 缺少 /timestamps')
    return shapes


def infer_fps(episodes):
    timestamps = []
    for episode in episodes:
        import h5py
        for file in episode['files']:
            with h5py.File(file['path'], 'r') as handle:
                value = float(handle['timestamps'][0])
            timestamps.append(value)
            if len(timestamps) >= 200:
                break
        if len(timestamps) >= 200:
            break
    deltas = [right - left for left, right in zip(timestamps, timestamps[1:]) if right > left]
    if not deltas:
        raise ValueError('无法从 HDF5 时间戳推断 FPS')
    deltas.sort()
    step = deltas[len(deltas) // 2]
    fps = round(1000.0 / step)
    if fps <= 0:
        raise ValueError('推断出的 FPS 无效')
    return fps, step


NUMERIC_SOURCE_FIELDS = (
    'observation.state', 'action', 'observation.eef', 'master.eef',
    'observation.joint_effort', 'observation.force_torque', 'source.timestamp_ms',
)


def verify_numeric_consistency(output: Path, expectations: list[dict]) -> dict:
    import numpy as np
    import pyarrow.parquet as pq

    data_files = sorted((output / 'data').rglob('*.parquet'))
    if not data_files:
        raise ValueError('LeRobot 输出没有可供数值回读的 Parquet 文件')
    expected = {(int(item['episode_index']), int(item['frame_index'])): item['values'] for item in expectations}
    seen = set()
    mismatches = []
    for file in data_files:
        table = pq.read_table(file, columns=['episode_index', 'frame_index', *NUMERIC_SOURCE_FIELDS]).to_pydict()
        for index, (episode_index, frame_index) in enumerate(zip(table['episode_index'], table['frame_index'])):
            key = (int(episode_index), int(frame_index))
            source = expected.get(key)
            if source is None:
                mismatches.append({'episode_index': key[0], 'frame_index': key[1], 'field': 'row', 'message': '输出存在源清单之外的帧'})
                continue
            if key in seen:
                mismatches.append({'episode_index': key[0], 'frame_index': key[1], 'field': 'row', 'message': '输出帧索引重复'})
                continue
            seen.add(key)
            for field in NUMERIC_SOURCE_FIELDS:
                actual = np.asarray(table[field][index], dtype=np.float32).reshape(-1)
                wanted = np.asarray(source[field], dtype=np.float32).reshape(-1)
                if actual.shape != wanted.shape or not np.allclose(actual, wanted, rtol=0, atol=1e-6):
                    mismatches.append({
                        'episode_index': key[0], 'frame_index': key[1], 'field': field,
                        'message': '源值与输出 Parquet 不一致', 'actual': actual[:16].tolist(), 'expected': wanted[:16].tolist(),
                    })
                    if len(mismatches) >= 20:
                        break
        if len(mismatches) >= 20:
            break
    missing = len(expected) - len(seen)
    if missing:
        mismatches.append({'field': 'row', 'message': f'输出缺少 {missing} 个源帧'})
    if mismatches:
        raise ValueError(f'源数值与输出不一致：{json.dumps(mismatches[:20], ensure_ascii=False)}')
    return {'checked': True, 'frameCount': len(expected), 'fields': list(NUMERIC_SOURCE_FIELDS), 'mismatches': 0}


def build_dataset(manifest: dict, output: Path):
    import h5py
    import numpy as np
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    episodes = manifest.get('episodes') or []
    if not episodes:
        raise ValueError('交付清单没有 Episode')
    for episode in episodes:
        if not str(episode.get('instruction') or '').strip():
            raise ValueError(f"Episode {episode.get('episodeIndex')} 缺少已审核任务指令")
        if not episode.get('files'):
            raise ValueError(f"Episode {episode.get('episodeIndex')} 没有 HDF5 帧")
    fps, step_ms = infer_fps(episodes)
    shapes = inspect_first_frame(Path(episodes[0]['files'][0]['path']))
    if output.exists():
        if not output.is_dir() or any(output.iterdir()):
            raise FileExistsError(f'输出目录已有内容：{output}')
        output.rmdir()
    output.parent.mkdir(parents=True, exist_ok=True)
    dataset = LeRobotDataset.create(
        repo_id=manifest.get('repoId') or 'local/hdf5-sequence', root=output, fps=fps,
        features=feature_definitions(shapes), robot_type='dual_arm_teleoperation',
        video_backend='pyav', vcodec='h264', image_writer_processes=0,
        image_writer_threads=0, batch_encoding_size=1, streaming_encoding=True,
    )
    episode_records, annotation_lines, source_records, numeric_expectations = [], [], [], []
    total_frames = sum(len(episode['files']) for episode in episodes)
    completed_frames = 0
    for output_index, episode in enumerate(episodes):
        instruction = str(episode['instruction']).strip()
        previous_ms = None
        for frame_index, file_record in enumerate(episode['files']):
            file_path = Path(file_record['path'])
            if not file_path.is_file():
                raise FileNotFoundError(f'HDF5 帧文件不存在：{file_path}')
            source_bytes = file_path.read_bytes()
            source_sha256 = hashlib.sha256(source_bytes).hexdigest()
            expected_sha256 = str(file_record.get('sha256') or '').strip()
            if expected_sha256 and source_sha256 != expected_sha256:
                raise ValueError(f'{file_path.name} 源 SHA-256 已变化，禁止使用旧交付清单')
            with h5py.File(io.BytesIO(source_bytes), 'r') as handle:
                source_ms = float(handle['timestamps'][0])
                if not np.isfinite(source_ms) or source_ms < 0:
                    raise ValueError(f'{file_path.name} 时间戳无效')
                if previous_ms is not None and source_ms <= previous_ms:
                    raise ValueError(f'{file_path.name} 时间戳未严格递增')
                previous_ms = source_ms
                numeric_values = {
                    'task': instruction,
                    'observation.state': read_numeric(handle, STATE_FIELD, 16),
                    'action': read_numeric(handle, ACTION_FIELD, 16),
                    'observation.eef': read_numeric(handle, 'puppet/eef', 28),
                    'master.eef': read_numeric(handle, 'master/eef', 28),
                    'observation.joint_effort': read_numeric(handle, 'puppet/joint_effort', 16),
                    'observation.force_torque': read_numeric(handle, 'puppet/6f', 12),
                    'source.timestamp_ms': np.asarray([source_ms], dtype=np.float32),
                }
                numeric_expectations.append({ 'episode_index': output_index, 'frame_index': frame_index, 'values': {key: value for key, value in numeric_values.items() if key != 'task'} })
                frame = numeric_values
                for camera_index, camera_key in enumerate(CAMERAS):
                    raw = image_buffer(handle[f'observations/rgb_images/camera_{camera_index}'])
                    frame[camera_key] = decode_rgb(raw, camera_key, shapes[camera_key])
                for depth_key in DEPTH_CAMERAS:
                    field = f'observations/depth_images/{depth_key}'
                    if field not in handle:
                        raise ValueError(f'{file_path.name} 缺少 /{field}')
                    validate_depth(image_buffer(handle[field]), depth_key)
                dataset.add_frame(frame)
            source_records.append({
                'episodeIndex': int(episode['episodeIndex']), 'episodeRelativePath': str(episode.get('relativePath') or '').replace('\\', '/').strip('/'),
                'frameIndex': frame_index, 'frameRelativePath': str(file_record.get('relativePath') or file_path.name).replace('\\', '/').strip('/'),
                'sha256': source_sha256,
            })
            completed_frames += 1
            if completed_frames % 50 == 0 or completed_frames == total_frames:
                print('PROGRESS ' + json.dumps({'completed': completed_frames, 'total': total_frames, 'stage': 'encode'}), file=sys.stderr, flush=True)
        dataset.save_episode(parallel_encoding=False)
        episode_records.append({'episode_index': output_index, 'source_episode_index': int(episode['episodeIndex']), 'length': len(episode['files']), 'instruction': instruction})
        annotation_lines.append({'episode_index': output_index, 'instruction': instruction})
    dataset.finalize()
    (output / 'annotations.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in annotation_lines), encoding='utf-8')
    numeric_consistency = verify_numeric_consistency(output, numeric_expectations)
    (output / 'hdf5-source-index.json').write_text(json.dumps({'schemaVersion': 1, 'fps': fps, 'timestampStepMs': step_ms, 'episodes': episode_records, 'sourceFiles': source_records}, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'episodes': len(episode_records), 'frames': sum(item['length'] for item in episode_records), 'fps': fps, 'cameras': CAMERAS, 'annotations': annotation_lines, 'sourceNumericConsistency': numeric_consistency}


def write_inventory(root: Path):
    files = []
    for file in sorted(root.rglob('*')):
        if file.is_file() and file.name != 'delivery-inventory.json':
            files.append({'path': file.relative_to(root).as_posix(), 'sha256': digest(file), 'bytes': file.stat().st_size})
    (root / 'delivery-inventory.json').write_text(json.dumps({'version': 1, 'files': files}, indent=2), encoding='utf-8')


def convert(manifest_path: Path, output: Path, archive: Path, report_path: Path):
    started = time.perf_counter()
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if archive.exists():
        raise FileExistsError(f'交付 ZIP 已存在：{archive}')
    summary = build_dataset(manifest, output)
    print('PROGRESS ' + json.dumps({'completed': summary['frames'], 'total': summary['frames'], 'stage': 'verify'}), file=sys.stderr, flush=True)
    verification = verify_v30(output)
    verification.update({'source_format': 'hdf5-frame-sequence', 'source_manifest': str(manifest_path), 'target_format_version': 'v3.0'})
    (output / 'official-lerobot-verification.json').write_text(json.dumps(json_safe(verification), ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    report = {
        'ok': True, 'format': 'lerobot', 'formatVersion': 'v3.0', 'schema': 'lerobot-v3',
        **summary, 'validation': 'official-lerobot-v3-loader+frame-decode+datachannel-smoke',
        'officialVerification': {
            'status': verification.get('status'), 'officialLerobotVersion': verification.get('official_lerobot_version'),
            'episodeCount': verification.get('episode_count'), 'frameCount': verification.get('frame_count'),
            'videoKeys': verification.get('video_keys'), 'sampleCount': verification.get('sample_count'),
            'batchShapes': verification.get('batch_shapes'), 'datasetFingerprint': verification.get('dataset_fingerprint'),
            'evidence': 'official-lerobot-verification.json',
        },
        'downstreamTrainingLoader': 'official LeRobot Dataset + DataLoader verified before packaging',
        'elapsedSeconds': round(time.perf_counter() - started, 3),
    }
    (output / 'conversion-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    shutil.copy2(Path(__file__).with_name('read_delivery.py'), output / 'read_delivery.py')
    (output / 'DELIVERY.md').write_text('# HDF5 sequence to LeRobot v3.0\n\nMaster joint position is action; puppet joint position is observation.state. Four RGB cameras are re-encoded to H.264. Two depth sources are validated but remain in the original HDF5 files. Hardware synchronization is not claimed.\n', encoding='utf-8')
    write_inventory(output)
    print('PROGRESS ' + json.dumps({'completed': summary['frames'], 'total': summary['frames'], 'stage': 'package'}), file=sys.stderr, flush=True)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as package:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                package.write(file, file.relative_to(output).as_posix())
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise ValueError('ZIP 完整性校验失败')
    report.update({'directory': str(output), 'archive': str(archive), 'archiveSha256': digest(archive), 'archiveBytes': archive.stat().st_size})
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(convert(args.manifest.resolve(), args.output.resolve(), args.archive.resolve(), args.report.resolve()), ensure_ascii=True))
        return 0
    except Exception as error:
        result = {'ok': False, 'error': str(error), 'type': type(error).__name__}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
