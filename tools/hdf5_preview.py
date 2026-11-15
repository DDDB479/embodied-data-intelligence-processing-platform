"""Generate memory-bounded per-camera MP4 previews for frame-wise HDF5 episodes."""
from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import sys
import time
import uuid


CAMERA_KEYS = [f'camera_{index}' for index in range(4)]
CAMERA_FEATURES = [f'observation.images.{key}' for key in CAMERA_KEYS]


def image_buffer(dataset):
    import numpy as np
    if dataset.ndim == 1 and dataset.dtype == np.uint8:
        return dataset[()]
    if dataset.ndim == 0:
        return dataset[()]
    return dataset[0]


def decode_rgb(raw, field: str):
    import av
    import numpy as np
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(bytes(raw))).convert('RGB')
        return np.asarray(image, dtype=np.uint8)
    except Exception:
        try:
            with av.open(io.BytesIO(bytes(raw))) as container:
                return next(container.decode(video=0)).to_ndarray(format='rgb24')
        except Exception as error:
            raise ValueError(f'{field} 图像无法解码：{error}') from error


def resize_rgb(array, max_width: int):
    from PIL import Image
    height, width = array.shape[:2]
    scale = min(1.0, max_width / max(1, width))
    target_width = max(2, int(round(width * scale / 2)) * 2)
    target_height = max(2, int(round(height * scale / 2)) * 2)
    if (target_width, target_height) == (width, height):
        return array
    return Image.fromarray(array).resize((target_width, target_height), Image.Resampling.LANCZOS)


def infer_fps(frames):
    import h5py
    timestamps = []
    for frame in frames[:200]:
        with h5py.File(frame['path'], 'r') as handle:
            timestamps.append(float(handle['timestamps'][0]))
    deltas = sorted(right - left for left, right in zip(timestamps, timestamps[1:]) if right > left)
    if not deltas:
        return 20.0
    step = deltas[len(deltas) // 2]
    fps = round(1000.0 / step, 6)
    return fps if math.isfinite(fps) and fps > 0 else 20.0


def write_thumb(image, path: Path):
    from PIL import Image
    if isinstance(image, Image.Image):
        image.save(path, format='JPEG', quality=82, optimize=True)
    else:
        Image.fromarray(image).save(path, format='JPEG', quality=82, optimize=True)


def build_preview(manifest_path: Path, output: Path, metadata_path: Path, max_width: int, crf: int):
    import av
    import h5py
    import numpy as np
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    frames = manifest.get('frames') or []
    if not frames:
        raise ValueError('预览清单没有 HDF5 帧')
    total = len(frames)
    fps = infer_fps(frames)
    staging = output.with_name(f"{output.name}.partial-{uuid.uuid4().hex[:8]}")
    if output.exists():
        shutil.rmtree(output)
    for stale in output.parent.glob(f'{output.name}.partial-*'):
        shutil.rmtree(stale, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    containers, streams, dimensions = [], [], []
    started = time.perf_counter()
    thumbnail_indexes = {0: 'first', total // 2: 'middle', total - 1: 'last'}
    try:
        with h5py.File(frames[0]['path'], 'r') as first:
            for key in CAMERA_KEYS:
                image = resize_rgb(decode_rgb(image_buffer(first[f'observations/rgb_images/{key}']), key), max_width)
                dimensions.append((image.width, image.height) if hasattr(image, 'width') else (image.shape[1], image.shape[0]))
        for index, key in enumerate(CAMERA_KEYS):
            container = av.open(str(staging / f'{key}.mp4'), mode='w', format='mp4')
            stream = container.add_stream('libx264', rate=Fraction(str(round(fps, 6))))
            stream.width, stream.height, stream.pix_fmt = dimensions[index][0], dimensions[index][1], 'yuv420p'
            stream.options = {'crf': str(max(18, min(35, int(crf)))), 'preset': 'veryfast', 'tune': 'zerolatency'}
            stream.codec_context.thread_count = 1
            containers.append(container)
            streams.append(stream)
        for frame_index, record in enumerate(frames):
            with h5py.File(record['path'], 'r') as handle:
                images = []
                for camera_index, key in enumerate(CAMERA_KEYS):
                    image = resize_rgb(decode_rgb(image_buffer(handle[f'observations/rgb_images/{key}']), key), max_width)
                    images.append(image)
                for camera_index, image in enumerate(images):
                    pixels = np.asarray(image, dtype=np.uint8) if not hasattr(image, 'mode') else np.asarray(image.convert('RGB'), dtype=np.uint8)
                    video_frame = av.VideoFrame.from_ndarray(pixels, format='rgb24')
                    video_frame.pts = frame_index
                    for packet in streams[camera_index].encode(video_frame):
                        containers[camera_index].mux(packet)
                thumbnail_name = thumbnail_indexes.get(frame_index)
                if thumbnail_name:
                    write_thumb(images[0], staging / f'{thumbnail_name}.jpg')
            completed = frame_index + 1
            if completed % 20 == 0 or completed == total:
                print('PROGRESS ' + json.dumps({'completed': completed, 'total': total}), file=sys.stderr, flush=True)
        for index, stream in enumerate(streams):
            for packet in stream.encode():
                containers[index].mux(packet)
        for container in containers:
            container.close()
        containers.clear()
        cameras = []
        for index, key in enumerate(CAMERA_KEYS):
            file = staging / f'{key}.mp4'
            cameras.append({'id': key, 'feature': CAMERA_FEATURES[index], 'file': file.name, 'width': dimensions[index][0], 'height': dimensions[index][1], 'bytes': file.stat().st_size})
        metadata = {
            'schemaVersion': 1, 'profile': 'hdf5-episode-preview-v1', 'assetId': manifest.get('assetId'),
            'fingerprint': manifest.get('fingerprint'), 'fps': fps, 'frameCount': total,
            'durationSeconds': round(total / fps, 3), 'maxWidth': max_width, 'crf': crf,
            'cameras': cameras, 'thumbnails': ['first.jpg', 'middle.jpg', 'last.jpg'],
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'elapsedSeconds': round(time.perf_counter() - started, 3),
        }
        (staging / 'preview.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = metadata_path.with_suffix(metadata_path.suffix + '.tmp')
        temporary.write_text(json.dumps({**metadata, 'directory': str(output)}, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(metadata_path)
        return {**metadata, 'directory': str(output)}
    except Exception:
        for container in containers:
            try:
                container.close()
            except Exception:
                pass
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--max-width', type=int, default=640)
    parser.add_argument('--crf', type=int, default=28)
    args = parser.parse_args()
    try:
        result = build_preview(args.manifest.resolve(), args.output.resolve(), args.metadata.resolve(), max(320, min(960, args.max_width)), args.crf)
        print(json.dumps({'ok': True, **result}, ensure_ascii=True))
        return 0
    except Exception as error:
        failure = {'ok': False, 'error': str(error), 'type': type(error).__name__}
        args.metadata.parent.mkdir(parents=True, exist_ok=True)
        args.metadata.write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(failure, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
