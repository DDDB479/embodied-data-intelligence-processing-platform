"""Generate a browser-compatible H.264 preview for a TeleUMI session video."""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
from pathlib import Path
import shutil
import sys
import time
import uuid


def resize_rgb(array, max_width: int):
    from PIL import Image
    height, width = array.shape[:2]
    scale = min(1.0, max_width / max(1, width))
    target_width = max(2, int(round(width * scale / 2)) * 2)
    target_height = max(2, int(round(height * scale / 2)) * 2)
    if (target_width, target_height) == (width, height):
        return Image.fromarray(array)
    return Image.fromarray(array).resize((target_width, target_height), Image.Resampling.LANCZOS)


def build_preview(manifest_path: Path, output: Path, metadata_path: Path, max_width: int, crf: int):
    import av
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    source = Path(manifest['video'])
    if not source.is_file():
        raise FileNotFoundError(f'UMI video does not exist: {source}')
    fps = float(manifest.get('fps') or 0)
    if fps <= 0:
        raise ValueError('UMI preview requires a positive FPS')
    staging = output.with_name(f'{output.name}.partial-{uuid.uuid4().hex[:8]}')
    for stale in output.parent.glob(f'{output.name}.partial-*'):
        shutil.rmtree(stale, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    destination = staging / 'camera_0.mp4'
    started = time.perf_counter()
    frame_count = 0
    thumbnails = {}
    expected = int(manifest.get('frameCount') or 0)
    container = av.open(str(destination), mode='w', format='mp4')
    stream = None
    try:
        with av.open(str(source)) as input_container:
            input_stream = input_container.streams.video[0]
            scale = min(1.0, max_width / max(1, input_stream.width))
            width = max(2, int(round(input_stream.width * scale / 2)) * 2)
            height = max(2, int(round(input_stream.height * scale / 2)) * 2)
            stream = container.add_stream('libx264', rate=Fraction(str(round(fps, 6))))
            stream.width, stream.height, stream.pix_fmt = width, height, 'yuv420p'
            stream.options = {'crf': str(max(18, min(35, int(crf)))), 'preset': 'ultrafast', 'tune': 'zerolatency'}
            stream.time_base = Fraction(1, round(fps))
            thumbnail_indexes = {0: 'first', expected // 2: 'middle', max(0, expected - 1): 'last'} if expected else {0: 'first'}
            for frame in input_container.decode(input_stream):
                thumbnail_name = thumbnail_indexes.get(frame_count)
                if thumbnail_name:
                    thumbnails[thumbnail_name] = resize_rgb(frame.to_ndarray(format='rgb24'), max_width)
                output_frame = frame.reformat(width=width, height=height, format='yuv420p')
                output_frame.time_base = Fraction(1, round(fps))
                output_frame.pts = frame_count
                for packet in stream.encode(output_frame):
                    container.mux(packet)
                frame_count += 1
                if frame_count % 50 == 0 or (expected and frame_count == expected):
                    print('PROGRESS ' + json.dumps({'completed': frame_count, 'total': expected or frame_count}), file=sys.stderr, flush=True)
        if stream is None or not frame_count:
            raise ValueError('UMI video contains no decodable frames')
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()
    if expected and frame_count != expected:
        raise ValueError(f'UMI preview decoded {frame_count} frames, expected {expected}')
    available = [thumbnails.get(name) for name in ('first', 'middle', 'last') if thumbnails.get(name)]
    for name in ('first', 'middle', 'last'):
        image = thumbnails.get(name) or (available[0] if available else None)
        if image: image.save(staging / f'{name}.jpg', format='JPEG', quality=82, optimize=True)
    metadata = {
        'schemaVersion': 1, 'profile': 'umi-session-preview-v1', 'assetId': manifest.get('assetId'),
        'fingerprint': manifest.get('fingerprint'), 'fps': fps, 'frameCount': frame_count,
        'durationSeconds': round(frame_count / fps, 3), 'maxWidth': max_width, 'crf': crf,
        'cameras': [{'id': 'camera_0', 'feature': 'observation.images.camera_0', 'file': destination.name, 'width': width, 'height': height, 'bytes': destination.stat().st_size}],
        'thumbnails': ['first.jpg', 'middle.jpg', 'last.jpg'], 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'elapsedSeconds': round(time.perf_counter() - started, 3), 'sourceCodec': 'browser-incompatible-transcoded-to-h264',
    }
    (staging / 'preview.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    if output.exists(): shutil.rmtree(output)
    staging.rename(output)
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = metadata_path.with_suffix(metadata_path.suffix + '.tmp')
    temporary.write_text(json.dumps({**metadata, 'directory': str(output)}, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(metadata_path)
    return {**metadata, 'directory': str(output)}


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
