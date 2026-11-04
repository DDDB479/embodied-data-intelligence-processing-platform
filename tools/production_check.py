"""Read-only, server-side evidence checks; never rewrites source data."""
import argparse
import json
import math
from pathlib import Path
from lerobot_schema_check import check_file


def check_video(path, options):
    import av
    import numpy as np
    count = black = frozen = 0
    findings = []
    previous = previous_pts = None
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError("没有视频轨道")
        stream = container.streams.video[0]
        fps = float(stream.average_rate) if stream.average_rate else None
        first = last = None
        for frame in container.decode(stream):
            time = float(frame.time) if frame.time is not None else None
            if time is not None:
                first = time if first is None else first
                last = time
                if previous_pts is not None and time <= previous_pts and len(findings) < 100:
                    findings.append({"code": "video_pts", "row": count, "time": time, "actual": time, "expected": f"> {previous_pts}", "message": "视频时间戳重复或逆序"})
                previous_pts = time
            pixels = frame.to_ndarray(format="gray")
            # These are review candidates, not proof the task failed.
            if float(np.mean(pixels)) <= options.get("blackMeanMax", 8):
                black += 1
            small = pixels[::max(1, pixels.shape[0] // 64), ::max(1, pixels.shape[1] // 64)].astype(float)
            if previous is not None and small.shape == previous.shape and float(np.mean(np.abs(small - previous))) <= options.get("freezeDifferenceMax", 0.15):
                frozen += 1
            previous = small
            count += 1
        duration = (last - first + 1 / fps) if first is not None and last is not None and fps else None
        if not count or not duration or duration <= 0:
            raise ValueError("视频无法解码出有效帧和时长")
        if black / count >= options.get("blackRatioMax", 0.95):
            findings.append({"code": "black_frames", "actual": black / count, "expected": f"< {options.get('blackRatioMax', 0.95)}", "message": "黑屏候选比例超过阈值，需人工查看"})
        if frozen / max(1, count - 1) >= options.get("freezeRatioMax", 0.98) and count >= 10:
            findings.append({"code": "frozen_frames", "actual": frozen / max(1, count - 1), "expected": f"< {options.get('freezeRatioMax', 0.98)}", "message": "静止或冻结候选比例超过阈值，需人工查看"})
        return {"status": "invalid" if findings else "verified", "decoder": "pyav", "frames": count, "width": stream.width, "height": stream.height, "fps": fps, "duration": duration, "blackFrames": black, "frozenFrames": frozen, "findings": findings, "issues": [item['message'] for item in findings]}


def inspect(manifest):
    assets, options = manifest['assets'], manifest.get('settings', {})
    info = {}
    for asset in assets:
        if asset.get('role') == 'meta' and Path(asset['relativePath']).name == 'info.json':
            try:
                info[asset.get('bundleId')] = json.loads(Path(asset['path']).read_text(encoding='utf-8-sig'))
            except Exception:
                pass  # The corresponding metadata result below records the parse failure.
    results = []
    for asset in assets:
        result = {"id": asset['id'], "relativePath": asset['relativePath']}
        try:
            path = Path(asset['path'])
            extension = Path(asset['relativePath']).suffix.lower()
            metadata = info.get(asset.get('bundleId'), {})
            if asset.get('role') == 'trajectory' and extension == '.parquet':
                result['schema'] = check_file(path, metadata.get('features'), metadata.get('fps'))
            elif extension in ('.mp4', '.mov', '.webm', '.avi'):
                result['media'] = check_video(path, options)
            elif extension in ('.json', '.jsonl'):
                fields, count = set(), 0
                with path.open(encoding='utf-8-sig') as stream:
                    if extension == '.jsonl':
                        for line in stream:
                            if not line.strip(): continue
                            value = json.loads(line)
                            if not isinstance(value, dict): raise ValueError('JSONL 每行必须是对象')
                            fields.update(value.keys())
                            count += 1
                        if not count: raise ValueError('JSONL 没有记录')
                    else:
                        value = json.load(stream)
                        if not isinstance(value, (dict, list)): raise ValueError('JSON 根节点必须是对象或数组')
                        count = len(value) if isinstance(value, list) else 1
                        for record in value if isinstance(value, list) else [value]:
                            if isinstance(record, dict): fields.update(record.keys())
                result['structure'] = {"status": "verified", "fields": sorted(fields), "recordCount": count}
            else:
                result['structure'] = {"status": "not_supported", "issues": ["该格式没有配置完整解析器，需接入解析器后复检"]}
        except Exception as error:
            result['error'] = str(error)
        results.append(result)
    # Match by declared bundle, Episode stem and view; never assume a camera count.
    by_id = {item['id']: item for item in results}
    for asset in assets:
        report = by_id[asset['id']]
        if 'media' not in report: continue
        metadata = info.get(asset.get('bundleId'), {})
        matches = [other for other in assets if other.get('bundleId') == asset.get('bundleId') and other.get('role') == 'trajectory' and Path(other['relativePath']).stem == Path(asset['relativePath']).stem]
        if len(matches) != 1: continue
        trajectory = by_id[matches[0]['id']].get('schema', {})
        fps = metadata.get('fps')
        if isinstance(fps, (int, float)) and fps > 0 and trajectory.get('rowCount'):
            actual, expected = report['media']['duration'], trajectory['rowCount'] / fps
            tolerance = max(options.get('durationToleranceSeconds', 0.1), 2 / fps)
            if abs(actual - expected) > tolerance:
                report['media']['findings'].append({"code": "duration_alignment", "actual": actual, "expected": expected, "tolerance": tolerance, "message": "视频与轨迹时长偏差超过阈值"})
                report['media']['issues'].append("视频与轨迹时长偏差超过阈值")
                report['media']['status'] = 'invalid'
    return {"ok": True, "engine": "production-evidence-v1", "files": results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(json.loads(Path(args.manifest).read_text(encoding='utf-8'))), ensure_ascii=True, allow_nan=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=True))
        raise SystemExit(1)
