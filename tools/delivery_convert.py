"""Convert a materialized LeRobot dataset to MCAP/Zarr and verify the result."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import quote
import zipfile

OFFICIAL_LEROBOT_VERSION = '0.4.4'


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def find_official_python(root):
    candidates = [
        os.environ.get('LEROBOT_OFFICIAL_PYTHON'),
        root / 'runtime' / 'lerobot' / 'Scripts' / 'python.exe',
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate).resolve()
    return None


def run_official_lerobot(dataset, official_python, official_tool):
    official_python = Path(official_python).resolve()
    official_tool = Path(official_tool).resolve()
    if not official_python.is_file():
        raise ValueError('Official LeRobot 0.4.4 runtime is missing; install tools/lerobot-runtime before generating a training package')
    if not official_tool.is_file():
        raise ValueError('Official LeRobot conversion tool is missing')
    output = dataset.parent / f'{dataset.name}-official-v30'
    report = dataset.parent / f'{dataset.name}-official-report.json'
    environment = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                   'HF_HUB_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'}
    process = subprocess.run(
        [str(official_python), str(official_tool), 'convert', '--dataset', str(dataset),
         '--output', str(output), '--report', str(report)],
        cwd=str(official_tool.parent.parent), env=environment, capture_output=True,
        text=True, encoding='utf-8', errors='replace', timeout=1800000,
    )
    payload = None
    for line in reversed(process.stdout.splitlines()):
        if line.strip().startswith('{'):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                pass
    if process.returncode or not payload or payload.get('ok') is not True:
        detail = payload.get('error') if isinstance(payload, dict) else ''
        raise ValueError(f"Official LeRobot validation failed: {detail or process.stderr[-2000:] or process.stdout[-2000:]}")
    if str(payload.get('official_lerobot_version')) != OFFICIAL_LEROBOT_VERSION:
        raise ValueError(f"Official LeRobot version mismatch: expected {OFFICIAL_LEROBOT_VERSION}, got {payload.get('official_lerobot_version') or 'unknown'}")
    shutil.rmtree(dataset)
    output.rename(dataset)
    shutil.copy2(report, dataset / 'official-lerobot-verification.json')
    report.unlink(missing_ok=True)
    return payload


def convert(source, output, target, annotations, evidence=None, official_python=None, official_tool=None):
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq

    source = Path(source).resolve()
    output = Path(output).resolve()
    if target not in ('mcap', 'zarr', 'lerobot'):
        raise ValueError('Unsupported delivery target')
    if output.exists():
        raise ValueError('Output already exists')
    info = json.loads((source / 'meta' / 'info.json').read_text(encoding='utf-8'))
    if not str(info.get('codebase_version', '')).lstrip('v').startswith('2.'):
        raise ValueError('Only LeRobot v2.x sources are supported')
    files = sorted((source / 'data').rglob('*.parquet'))
    if not files:
        raise ValueError('No Parquet trajectory files found')
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.conversion-', dir=output.parent))
    archive = None
    try:
        shutil.copytree(source / 'meta', staging / 'meta')
        media = []
        for file in sorted((source / 'videos').rglob('*')):
            if file.is_file():
                relative = file.relative_to(source)
                dest = staging / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, dest)
                expected = digest(file)
                if digest(dest) != expected:
                    raise ValueError(f'Media checksum mismatch: {relative}')
                media.append({'path': relative.as_posix(), 'sha256': expected, 'size': file.stat().st_size})
        shutil.copyfile(annotations, staging / 'annotations.jsonl')
        annotated = [json.loads(line) for line in Path(annotations).read_text(encoding='utf-8').splitlines() if line.strip()]
        instructions = {int(row['episode_index']): row['instruction'] for row in annotated}
        rows_total = 0
        source_hashes = []
        task_map = {}
        instruction_tasks = {}
        seen_episodes = set()
        for file in files:
            table = pq.read_table(file)
            rows = table.to_pylist()
            if not rows:
                raise ValueError(f'Empty episode: {file.name}')
            required = {'timestamp', 'episode_index', 'frame_index', 'task_index', 'action', 'observation.state'}
            if not required.issubset(table.column_names):
                raise ValueError(f'Missing required trajectory columns: {file.name}')
            episode = int(rows[0]['episode_index'])
            if episode in seen_episodes:
                raise ValueError(f'Duplicate episode index: {episode}')
            seen_episodes.add(episode)
            if any(int(row['episode_index']) != episode for row in rows):
                raise ValueError('An episode file contains mixed episode indices')
            if episode not in instructions:
                raise ValueError(f'No approved instruction for episode {episode}')
            instruction = str(instructions[episode]).strip()
            if not instruction:
                raise ValueError(f'Empty approved instruction for episode {episode}')
            task_index = instruction_tasks.setdefault(instruction, len(instruction_tasks))
            task_map[task_index] = instruction
            task_column = table['task_index']
            table = table.set_column(table.column_names.index('task_index'), 'task_index', pa.array([task_index] * len(rows), type=task_column.type))
            rows = table.to_pylist()
            timestamps = [float(row['timestamp']) for row in rows]
            if any(not math.isfinite(t) or t < 0 for t in timestamps) or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
                raise ValueError(f'Invalid/non-increasing timestamps: {file.name}')
            canonical = [encode(row) for row in rows]
            source_hashes.append({'path': file.relative_to(source).as_posix(), 'sha256': digest(file)})
            views = [item['path'] for item in media if Path(item['path']).stem == file.stem]
            expected_views = [name for name, feature in info.get('features', {}).items() if feature.get('dtype') == 'video']
            if any(not any(Path(video).parent.name == view for video in views) for view in expected_views):
                raise ValueError(f'Missing declared camera video for episode {episode}')
            episode_meta = {'episode_index': episode, 'instruction': instruction, 'task_index': task_index, 'videos': views, 'time_origin': 'episode-relative-seconds', 'source_columns': table.column_names}
            if target == 'mcap':
                from mcap.writer import Writer
                from mcap.reader import make_reader
                dest = staging / (file.stem + '.mcap')
                with dest.open('wb') as stream:
                    writer = Writer(stream, enable_crcs=True)
                    writer.start(profile='embodied-json')
                    schema = writer.register_schema('LeRobotFrame', 'jsonschema', encode({'type': 'object'}).encode())
                    channel = writer.register_channel(f'/episodes/{episode}/frames', 'json', schema)
                    writer.add_metadata('episode', {'json': encode(episode_meta)})
                    for index, (row, timestamp) in enumerate(zip(canonical, timestamps)):
                        time_ns = round(timestamp * 1_000_000_000)
                        writer.add_message(channel, time_ns, row.encode('utf-8'), time_ns, index)
                    writer.finish()
                with dest.open('rb') as stream:
                    messages = list(make_reader(stream, validate_crcs=True).iter_messages(log_time_order=False))
                    restored = [message.data.decode('utf-8') for _, _, message in messages]
                    if restored != canonical or [m.log_time for _, _, m in messages] != [round(t * 1e9) for t in timestamps]:
                        raise ValueError('MCAP round-trip validation failed')
            elif target == 'zarr':
                import zarr
                from numcodecs import VLenUTF8
                dest = staging / (file.stem + '.zarr')
                group = zarr.open_group(str(dest), mode='w')
                group.attrs.update(episode_meta)
                column_encodings = {}
                for name in table.column_names:
                    values = table[name].to_pylist()
                    try:
                        array = np.asarray(values)
                    except ValueError:
                        array = np.asarray(values, dtype=object)
                    key = quote(name, safe='')
                    if array.dtype.kind in 'biuf' and array.ndim in (1, 2) and array.size:
                        group.create_dataset(key, data=array, chunks=(min(len(values), 1024),) + array.shape[1:])
                        column_encodings[name] = 'numeric'
                    else:
                        array = np.asarray([encode(value) for value in values], dtype=object)
                        group.create_dataset(key, data=array, object_codec=VLenUTF8(), chunks=(min(len(values), 1024),))
                        column_encodings[name] = 'json'
                group.attrs['column_encodings'] = column_encodings
                reopened = zarr.open_group(str(dest), mode='r')
                restored = [{} for _ in rows]
                for name, encoding in column_encodings.items():
                    values = reopened[quote(name, safe='')][:].tolist()
                    for row, value in zip(restored, values):
                        row[name] = json.loads(value) if encoding == 'json' else value
                if [encode(row) for row in restored] != canonical:
                    raise ValueError('Zarr round-trip validation failed')
            else:
                dest = staging / file.relative_to(source)
                dest.parent.mkdir(parents=True, exist_ok=True)
                pq.write_table(table, dest)
                reopened = pq.read_table(dest)
                if reopened.to_pylist() != rows or reopened.column_names != table.column_names:
                    raise ValueError('LeRobot normalized task_index round-trip failed')
            rows_total += len(rows)
        (staging / 'meta' / 'tasks.jsonl').write_text(''.join(encode({'task_index': index, 'task': task}) + '\n' for index, task in sorted(task_map.items())), encoding='utf-8')
        info['total_tasks'] = len(task_map)
        (staging / 'meta' / 'info.json').write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
        official = None
        if target == 'lerobot':
            official = run_official_lerobot(staging, official_python or find_official_python(Path(__file__).resolve().parents[1]), official_tool or Path(__file__).with_name('official_lerobot.py'))
        report = {'ok': True, 'format': target, 'formatVersion': 'v3.0' if target == 'lerobot' else None, 'schema': 'embodied-json' if target == 'mcap' else 'zarr-v2-columns' if target == 'zarr' else 'lerobot-v3', 'episodes': len(files), 'frames': rows_total, 'media': media, 'sourceFiles': source_hashes, 'taskNormalization': 'instruction-to-task-index', 'validation': 'official-lerobot-v3-loader+round-trip-all-columns-and-media-sha256' if target == 'lerobot' else 'round-trip-all-columns-and-media-sha256', 'videoMode': 'official-lerobot-v3-video-shards' if target == 'lerobot' else 'original-files-with-relative-references', 'rosCompatible': False, 'officialVerification': None if not official else {'status': official.get('status'), 'officialLerobotVersion': official.get('official_lerobot_version'), 'episodeCount': official.get('episode_count'), 'frameCount': official.get('frame_count'), 'videoKeys': official.get('video_keys'), 'sampleCount': official.get('sample_count'), 'batchShapes': official.get('batch_shapes'), 'datasetFingerprint': official.get('dataset_fingerprint'), 'evidence': 'official-lerobot-verification.json'}}
        (staging / 'conversion-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        if evidence:
            shutil.copyfile(evidence, staging / 'acceptance-evidence.json')
        shutil.copyfile(Path(__file__).with_name('read_delivery.py'), staging / 'read_delivery.py')
        (staging / 'DELIVERY.md').write_text(
            '# Delivery contract\n\n'
            f'Format: {target}. ' + ('LeRobot dataset v3.0, verified by official LeRobot 0.4.4 Dataset and DataLoader.\n\n' if target == 'lerobot' else 'LeRobot source layout: v2.x.\n\n') +
            'MCAP uses embodied-json messages with episode-relative timestamps in nanoseconds; it is not a ROS bag. '
            'Zarr uses per-episode column arrays and column_encodings metadata. Original videos remain separate files.\n\n'
            'Run `python read_delivery.py <unpacked-directory>` to read a sample. '
            'Install the dependencies listed by the platform. This example does not certify compatibility with a target training framework.\n', encoding='utf-8')
        inventory = [{'path': file.relative_to(staging).as_posix(), 'sha256': digest(file), 'bytes': file.stat().st_size}
                     for file in sorted(staging.rglob('*')) if file.is_file()]
        (staging / 'delivery-inventory.json').write_text(json.dumps({'version': 1, 'files': inventory}, indent=2), encoding='utf-8')
        archive = output.with_suffix('.zip')
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as package:
            for file in sorted(staging.rglob('*')):
                if file.is_file():
                    package.write(file, file.relative_to(staging).as_posix())
        with zipfile.ZipFile(archive) as package:
            if package.testzip() is not None:
                raise ValueError('ZIP integrity validation failed')
        staging.rename(output)
        return {**report, 'directory': str(output), 'archive': str(archive), 'archiveSha256': digest(archive), 'archiveBytes': archive.stat().st_size}
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        if archive and archive.exists():
            archive.unlink()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--target', choices=['lerobot', 'mcap', 'zarr'], required=True)
    parser.add_argument('--annotations', required=True)
    parser.add_argument('--evidence')
    parser.add_argument('--official-python')
    parser.add_argument('--official-tool')
    args = parser.parse_args()
    try:
        print(json.dumps(convert(args.source, args.output, args.target, args.annotations, args.evidence, args.official_python, args.official_tool), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True))
        raise SystemExit(1)
