"""Independent package reader: verify inventory, media decoding and trajectory layout."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile
import zipfile


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def dataset_fingerprint(root):
    result = hashlib.sha256()
    for folder in ('meta', 'data', 'videos'):
        for file in sorted((root / folder).rglob('*')):
            if not file.is_file():
                continue
            relative = file.relative_to(root).as_posix()
            result.update(relative.encode('utf-8') + b'\0')
            result.update(sha256(file).encode('ascii') + b'\0')
    return result.hexdigest()


def verify(archive, target):
    import av
    archive = Path(archive)
    with tempfile.TemporaryDirectory(prefix='delivery-verify-') as folder:
        root = Path(folder).resolve()
        with zipfile.ZipFile(archive) as package:
            if package.testzip(): raise ValueError('ZIP CRC 校验失败')
            names = package.namelist()
            if len(names) != len(set(names)): raise ValueError('ZIP 包含重复路径')
            if sum(item.file_size for item in package.infolist()) > shutil.disk_usage(root).free:
                raise ValueError('磁盘空间不足，无法独立解包验证')
            for item in package.infolist():
                destination = (root / item.filename).resolve()
                if '\\' in item.filename or not destination.is_relative_to(root) or destination == root or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('ZIP 路径无效')
                if item.is_dir(): continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with package.open(item) as source, destination.open('wb') as output:
                    shutil.copyfileobj(source, output)
        inventory = json.loads((root / 'delivery-inventory.json').read_text(encoding='utf-8'))
        listed = {entry['path'] for entry in inventory['files']}
        actual = {file.relative_to(root).as_posix() for file in root.rglob('*') if file.is_file() and file.relative_to(root).as_posix() != 'delivery-inventory.json'}
        if actual != listed: raise ValueError('产物文件与交付清单不一致')
        for entry in inventory['files']:
            file = (root / entry['path']).resolve()
            if not file.is_relative_to(root) or sha256(file) != entry['sha256']: raise ValueError('交付文件哈希不一致')
        info = json.loads((root / 'meta' / 'info.json').read_text(encoding='utf-8'))
        video_count = video_frames = 0
        media_by_episode = {}
        for file in (root / 'videos').rglob('*'):
            if not file.is_file(): continue
            frames = 0
            with av.open(str(file)) as container:
                for frame in container.decode(video=0):
                    frame.to_ndarray(format='gray')
                    frames += 1
            if not frames: raise ValueError(f'视频不能解码：{file.name}')
            video_count += 1
            video_frames += frames
            media_by_episode.setdefault(file.stem, {})[file.parent.name] = frames
        required = {'timestamp', 'episode_index', 'frame_index', 'task_index', 'action', 'observation.state'}
        version = str(info.get('codebase_version', ''))
        if target == 'lerobot' and version == 'v3.0':
            import pyarrow.parquet as pq
            official_path = root / 'official-lerobot-verification.json'
            if not official_path.is_file():
                raise ValueError('LeRobot v3.0 交付缺少官方加载验证报告')
            official = json.loads(official_path.read_text(encoding='utf-8'))
            if official.get('status') != 'passed' or official.get('offline') is not True or official.get('video_backend') != 'pyav':
                raise ValueError('LeRobot v3.0 官方加载验证未通过')
            fingerprint = dataset_fingerprint(root)
            if official.get('dataset_fingerprint') != fingerprint:
                raise ValueError('交付包数据集指纹与官方验证记录不一致')
            episode_files = sorted((root / 'meta' / 'episodes').rglob('*.parquet'))
            if not episode_files:
                raise ValueError('LeRobot v3.0 缺少 meta/episodes 数据')
            episode_rows = []
            for file in episode_files:
                episode_rows.extend(pq.read_table(file).to_pylist())
            episode_rows.sort(key=lambda row: int(row['episode_index']))
            if [int(row['episode_index']) for row in episode_rows] != list(range(len(episode_rows))):
                raise ValueError('LeRobot v3.0 Episode 索引不连续')
            data_files = sorted((root / 'data').rglob('*.parquet'))
            rows_by_episode = {}
            rows_total = 0
            for file in data_files:
                rows = pq.read_table(file).to_pylist()
                if not rows or not all(required <= row.keys() for row in rows):
                    raise ValueError('轨迹为空或缺少必需列')
                for row in rows:
                    episode = int(row['episode_index'])
                    rows_by_episode.setdefault(episode, []).append(row)
                rows_total += len(rows)
            if set(rows_by_episode) != set(range(len(episode_rows))):
                raise ValueError('轨迹 Episode 与 v3.0 元数据不一致')
            for episode, rows in rows_by_episode.items():
                expected = int(episode_rows[episode]['dataset_to_index']) - int(episode_rows[episode]['dataset_from_index'])
                if len(rows) != expected:
                    raise ValueError(f'Episode {episode} 帧数与 v3.0 元数据不一致')
                timestamps = [row['timestamp'] for row in rows]
                if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in timestamps) or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
                    raise ValueError(f'Episode {episode} 时间戳无效')
                for row in rows:
                    for field in ('action', 'observation.state'):
                        values = row[field]
                        if not isinstance(values, list) or not values or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
                            raise ValueError(f'Episode {episode} 轨迹向量无效：{field}')
            declared = {key for key, feature in info.get('features', {}).items() if feature.get('dtype') == 'video'}
            present = {file.relative_to(root / 'videos').parts[0] for file in (root / 'videos').rglob('*.mp4')}
            if declared - present:
                raise ValueError('LeRobot v3.0 缺少声明的视频视角')
            if official.get('episode_count') != len(episode_rows) or official.get('frame_count') != rows_total:
                raise ValueError('官方验证记录中的 Episode 或帧数不一致')
            return {'ok': True, 'engine': 'independent-package-reader-v2', 'format': target, 'formatVersion': version, 'episodes': len(episode_rows), 'frames': rows_total, 'videos': video_count, 'decodedVideoFrames': video_frames, 'inventoryFiles': len(listed), 'archiveSha256': sha256(archive), 'datasetFingerprint': fingerprint, 'officialVerification': 'passed', 'officialLerobotVersion': official.get('official_lerobot_version'), 'checks': ['zip-crc', 'inventory-sha256', 'v3-episode-metadata', 'v3-data-layout', 'full-video-decode', 'trajectory-reader', 'timestamp-order', 'finite-vectors', 'dataset-fingerprint', 'official-lerobot-report'], 'downstreamTrainingLoader': 'official LeRobot Dataset + DataLoader verified before packaging', 'compatibility': '官方 0.4.4 加载与 batch 冒烟通过；机器人字段语义和训练效果仍需业务验收。'}
        rows_total = episodes = 0
        for file in sorted(root.glob('**/*.parquet') if target == 'lerobot' else root.glob('*.mcap') if target == 'mcap' else root.glob('*.zarr')):
            if target == 'lerobot':
                import pyarrow.parquet as pq
                rows = pq.read_table(file).to_pylist()
            elif target == 'mcap':
                from mcap.reader import make_reader
                with file.open('rb') as stream:
                    messages = list(make_reader(stream, validate_crcs=True).iter_messages(log_time_order=False))
                rows = [json.loads(message.data) for _, _, message in messages]
                if [message.log_time for _, _, message in messages] != [round(row['timestamp'] * 1e9) for row in rows]: raise ValueError('MCAP 时间基准不一致')
            else:
                import zarr
                from urllib.parse import quote
                group = zarr.open_group(str(file), mode='r')
                columns = {name: [json.loads(v) for v in group[quote(name, safe='')][:].tolist()] if encoding == 'json' else group[quote(name, safe='')][:].tolist() for name, encoding in group.attrs['column_encodings'].items()}
                lengths = {len(values) for values in columns.values()}
                if len(lengths) != 1: raise ValueError('Zarr 列长度不一致')
                rows = [dict(zip(columns, values)) for values in zip(*columns.values())]
            if not rows or not all(required <= row.keys() for row in rows): raise ValueError('轨迹为空或缺少必需列')
            timestamps = [row['timestamp'] for row in rows]
            if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in timestamps) or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
                raise ValueError('轨迹时间戳无效')
            for row in rows:
                for field in ('action', 'observation.state'):
                    values = row[field]
                    if not isinstance(values, list) or not values or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
                        raise ValueError(f'轨迹向量无效：{field}')
            views = media_by_episode.get(file.stem, {})
            declared = {key for key, feature in info.get('features', {}).items() if feature.get('dtype') == 'video'}
            if not views or declared - views.keys(): raise ValueError('Episode 缺少声明的视频视角')
            if any(count != len(rows) for count in views.values()): raise ValueError('视频帧数与轨迹行数不一致')
            episodes += 1
            rows_total += len(rows)
        if not episodes: raise ValueError('未读取到轨迹产物')
        return {'ok': True, 'engine': 'independent-package-reader-v1', 'format': target, 'episodes': episodes, 'frames': rows_total, 'videos': video_count, 'decodedVideoFrames': video_frames, 'inventoryFiles': len(listed), 'archiveSha256': sha256(archive), 'checks': ['zip-crc', 'inventory-sha256', 'full-video-decode', 'trajectory-reader', 'timestamp-order', 'finite-vectors', 'episode-camera-frame-alignment'], 'downstreamTrainingLoader': 'not_configured', 'compatibility': '本报告验证包内结构与解码；目标训练框架和机器人字段约定仍需接收方验收。'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--target', choices=['lerobot', 'mcap', 'zarr'], required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.archive, args.target), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True))
        raise SystemExit(1)
