"""Convert TeleUMI session directories to an official LeRobot v3.0 dataset."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
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

CAMERA_KEY = 'observation.images.camera_0'
STATE_NAMES = ['vive_x', 'vive_y', 'vive_z', 'vive_qx', 'vive_qy', 'vive_qz', 'vive_qw', 'gripper']


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_csv(path: Path) -> list[dict]:
    with Path(path).open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def numeric(rows: list[dict], key: str):
    import numpy as np
    values = np.asarray([float(row[key]) for row in rows], dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError(f'Non-finite values in {key}')
    return values


def inspect_video(path: Path):
    import av
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate or 0)
        if fps <= 0:
            raise ValueError(f'Video FPS is invalid: {path}')
        return {'width': int(stream.width), 'height': int(stream.height), 'fps': fps}


def feature_definitions(width: int, height: int):
    return {
        'observation.state': {'dtype': 'float32', 'shape': (len(STATE_NAMES),), 'names': STATE_NAMES},
        'action': {'dtype': 'float32', 'shape': (len(STATE_NAMES),), 'names': STATE_NAMES},
        'source.timestamp_ms': {'dtype': 'float32', 'shape': (1,), 'names': None},
        CAMERA_KEY: {'dtype': 'video', 'shape': (height, width, 3), 'names': ['height', 'width', 'channels']},
    }


def interpolate(source_time, source_values, target_time):
    import numpy as np
    source_time = np.asarray(source_time, dtype=np.float64)
    target_time = np.asarray(target_time, dtype=np.float64)
    values = np.asarray(source_values, dtype=np.float64)
    if values.ndim == 1:
        return np.interp(target_time, source_time, values)
    return np.stack([np.interp(target_time, source_time, values[:, index]) for index in range(values.shape[1])], axis=1)


def normalized_quaternions(pose):
    import numpy as np
    result = np.asarray(pose, dtype=np.float64).copy()
    quaternion = result[:, 3:7]
    norm = np.linalg.norm(quaternion, axis=1)
    if np.any(norm < 1e-8):
        raise ValueError('A synchronized VIVE quaternion has zero norm')
    result[:, 3:7] = quaternion / norm[:, None]
    return result


def load_episode_arrays(required: dict):
    import numpy as np
    rgb = read_csv(required['rgbTimestamps'])
    vive = read_csv(required['vive'])
    clamp = read_csv(required['clamp'])
    rgb_time = np.asarray([float(row['timestamp_ns']) for row in rgb], dtype=np.float64)
    vive_time = np.asarray([float(row['timestamp_ns']) for row in vive], dtype=np.float64)
    clamp_time = np.asarray([float(row['timestamp_ns']) for row in clamp], dtype=np.float64)
    if len(rgb_time) < 2 or len(vive_time) < 2 or len(clamp_time) < 2:
        raise ValueError('RGB, VIVE and clamp series must all contain at least two samples')
    for name, values in [('RGB', rgb_time), ('VIVE', vive_time), ('clamp', clamp_time)]:
        if not np.isfinite(values).all() or np.any(np.diff(values) <= 0):
            raise ValueError(f'{name} timestamps must be finite and strictly increasing')
    pose = np.asarray([[float(row[key]) for key in ('x_m', 'y_m', 'z_m', 'qx', 'qy', 'qz', 'qw')] for row in vive], dtype=np.float64)
    grip = np.asarray([float(row['value']) for row in clamp], dtype=np.float64)
    if not np.isfinite(pose).all() or not np.isfinite(grip).all():
        raise ValueError('UMI trajectory contains non-finite values')
    pose = normalized_quaternions(interpolate(vive_time, pose, rgb_time))
    gripper = interpolate(clamp_time, grip, rgb_time)
    state = np.column_stack([pose, gripper]).astype(np.float32)
    action = np.vstack([state[1:], state[-1:]])
    return rgb_time, state, action


def build_dataset(manifest: dict, output: Path):
    import av
    import numpy as np
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    episodes = manifest.get('episodes') or []
    if not episodes:
        raise ValueError('UMI delivery manifest has no episodes')
    first_video = inspect_video(Path(episodes[0]['required']['video']))
    fps = first_video['fps']
    fps_value = int(round(fps))
    if fps_value <= 0 or abs(fps - fps_value) > 0.01:
        raise ValueError(f'UMI delivery requires an integer camera FPS, got {fps}')
    if output.exists():
        if not output.is_dir() or any(output.iterdir()):
            raise FileExistsError(f'Output directory is not empty: {output}')
        output.rmdir()
    output.parent.mkdir(parents=True, exist_ok=True)
    dataset = LeRobotDataset.create(
        repo_id=manifest.get('repoId') or 'local/umi-sessions', root=output, fps=fps_value,
        features=feature_definitions(first_video['width'], first_video['height']),
        robot_type='umi_single_hand', video_backend='pyav', vcodec='h264',
        image_writer_processes=0, image_writer_threads=0, batch_encoding_size=1,
        streaming_encoding=True,
    )
    total_frames = sum(len(read_csv(episode['required']['rgbTimestamps'])) for episode in episodes)
    completed = 0
    episode_records, annotation_lines, source_records, camera_records = [], [], [], []
    for output_index, episode in enumerate(episodes):
        instruction = str(episode.get('instruction') or '').strip()
        if not instruction:
            raise ValueError(f'Episode {episode.get("episodeIndex")} has no approved instruction')
        required = episode['required']
        rgb_time, state, action = load_episode_arrays(required)
        video_info = inspect_video(Path(required['video']))
        if abs(video_info['fps'] - fps) > 0.05 or video_info['width'] != first_video['width'] or video_info['height'] != first_video['height']:
            raise ValueError(f'Episode {episode.get("episodeIndex")} video format differs from the first episode')
        frame_count = 0
        with av.open(str(required['video'])) as container:
            for frame_index, decoded in enumerate(container.decode(video=0)):
                if frame_index >= len(rgb_time):
                    raise ValueError(f'Episode {episode.get("episodeIndex")} video has more frames than RGB timestamps')
                image = decoded.to_ndarray(format='rgb24')
                dataset.add_frame({
                    'task': instruction,
                    'observation.state': state[frame_index],
                    'action': action[frame_index],
                    'source.timestamp_ms': np.asarray([(rgb_time[frame_index] - rgb_time[0]) / 1e6], dtype=np.float32),
                    CAMERA_KEY: image,
                })
                frame_count += 1
                completed += 1
                if completed % 100 == 0 or completed == total_frames:
                    print('PROGRESS ' + json.dumps({'completed': completed, 'total': total_frames, 'stage': 'encode'}), file=sys.stderr, flush=True)
        if frame_count != len(rgb_time):
            raise ValueError(f'Episode {episode.get("episodeIndex")} has {frame_count} video frames but {len(rgb_time)} RGB timestamps')
        dataset.save_episode(parallel_encoding=False)
        episode_records.append({'episode_index': output_index, 'source_session': episode.get('sessionId'), 'length': frame_count, 'instruction': instruction})
        annotation_lines.append({'episode_index': output_index, 'instruction': instruction})
        source_records.append({'episodeIndex': output_index, 'sourceEpisodeIndex': int(episode.get('episodeIndex', output_index)), 'sessionId': episode.get('sessionId'), 'files': episode.get('files', [])})
        camera_records.append({'episodeIndex': output_index, 'required': required})
    (output / 'annotations.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in annotation_lines), encoding='utf-8')
    (output / 'umi-source-index.json').write_text(json.dumps({'schemaVersion': 1, 'profile': 'umi-session-v1', 'fps': fps, 'episodes': episode_records, 'sourceFiles': source_records, 'source': camera_records}, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return {'episodes': len(episode_records), 'frames': completed, 'fps': fps_value, 'cameras': [CAMERA_KEY], 'annotations': annotation_lines}


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
        raise FileExistsError(f'Delivery archive already exists: {archive}')
    summary = build_dataset(manifest, output)
    print('PROGRESS ' + json.dumps({'completed': summary['frames'], 'total': summary['frames'], 'stage': 'verify'}), file=sys.stderr, flush=True)
    verification = verify_v30(output)
    verification.update({'source_format': 'umi-session-v1', 'source_manifest': str(manifest_path), 'target_format_version': 'v3.0'})
    (output / 'official-lerobot-verification.json').write_text(json.dumps(json_safe(verification), ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    report = {
        'ok': True, 'format': 'lerobot', 'formatVersion': 'v3.0', 'schema': 'lerobot-v3', **summary,
        'validation': 'official-lerobot-v3-loader+video-frame+datachannel-smoke',
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
    (output / 'DELIVERY.md').write_text('# TeleUMI to LeRobot v3.0\n\nEach source session is one Episode. VIVE pose and gripper samples are interpolated to RGB frame timestamps. observation.state is the synchronized current state and action is the next state. One RGB camera is encoded into the dataset.\n', encoding='utf-8')
    write_inventory(output)
    print('PROGRESS ' + json.dumps({'completed': summary['frames'], 'total': summary['frames'], 'stage': 'package'}), file=sys.stderr, flush=True)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as package:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                package.write(file, file.relative_to(output).as_posix())
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise ValueError('ZIP integrity validation failed')
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
