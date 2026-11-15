"""Read-only, server-side evidence checks; never rewrites source data."""
import argparse
import io
import json
import math
import statistics
import sys
from pathlib import Path
from lerobot_schema_check import check_file


HDF5_PROFILE = 'teleop-hdf5-v1'
HDF5_REQUIRED = ['timestamps', 'master/joint_position', 'master/eef', 'puppet/joint_position', 'puppet/eef', 'puppet/joint_effort']
HDF5_OPTIONAL = ['puppet/6f']
HDF5_RGB = ['camera_0', 'camera_1', 'camera_2', 'camera_3']
HDF5_DEPTH = ['camera_1', 'camera_2']


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


def hdf5_issue(code, message, severity='高', field=None, actual=None, expected=None):
    return {'code': code, 'severity': severity, 'message': message, 'field': field, 'actual': actual, 'expected': expected}


def decode_hdf5_image(value):
    import av
    import numpy as np
    array = np.asarray(value)
    if array.dtype == object:
        array = np.asarray(array.reshape(-1)[0])
    raw = array.reshape(-1).tobytes()
    if not raw:
        raise ValueError('图像缓冲区为空')
    with av.open(io.BytesIO(raw)) as container:
        if not container.streams.video:
            raise ValueError('图像缓冲区没有可解码视频流')
        stream = container.streams.video[0]
        frame = next(container.decode(stream))
        gray = frame.to_ndarray(format='gray')
        return {
            'codec': stream.codec_context.name,
            'pixFmt': stream.codec_context.pix_fmt,
            'width': int(frame.width),
            'height': int(frame.height),
            'mean': float(np.mean(gray)),
            'std': float(np.std(gray)),
            'zeroRatio': float(np.mean(gray == 0)),
            'nearBlackRatio': float(np.mean(gray < 8)),
        }


def check_hdf5_images(hdf, group_name, names, kind, options, issues, metrics):
    import h5py
    import numpy as np
    group = hdf.get(group_name)
    available = set(group.keys()) if group is not None else set()
    missing = [name for name in names if name not in available]
    if missing:
        cameras = ', '.join(missing)
        issues.append(hdf5_issue('missing_images', f'{kind} 缺少相机：{cameras}', field=group_name, actual=sorted(available), expected=names))
    maximum = max(1, int(options.get('maxImagesPerDataset', 200)))
    decoded = failures = 0
    dimensions = {}
    zero_ratios = []
    min_width = int(options.get('minWidth', 640))
    min_height = int(options.get('minHeight', 480))
    black_max = float(options.get('blackMeanMax', 8))
    depth_max = float(options.get('depthZeroRatioMax', 0.8))
    for name in names:
        if name not in available:
            continue
        dataset = group[name]
        if not isinstance(dataset, h5py.Dataset):
            issues.append(hdf5_issue('image_dataset_type', f'{kind}/{name} 不是数据集', field=f'{group_name}/{name}'))
            continue
        flat_buffer = dataset.ndim == 1 and dataset.dtype == np.uint8
        frames = 1 if flat_buffer or dataset.ndim == 0 else dataset.shape[0]
        for index in range(min(frames, maximum)):
            try:
                value = dataset[()] if flat_buffer or dataset.ndim == 0 else dataset[index]
                stats = decode_hdf5_image(value)
                decoded += 1
                dimensions[name] = [stats['width'], stats['height']]
                width, height = stats['width'], stats['height']
                if width < min_width or height < min_height:
                    message = f'{kind}/{name} 分辨率 {width}x{height} 低于门禁'
                    issues.append(hdf5_issue('image_resolution', message, '中', f'{group_name}/{name}', [width, height], [min_width, min_height]))
                if kind == 'rgb' and stats['mean'] <= black_max:
                    message = f'{kind}/{name} 第 {index} 帧接近全黑'
                    issues.append(hdf5_issue('black_image', message, '中', f'{group_name}/{name}', stats['mean'], f'> {black_max}'))
                if kind == 'depth':
                    zero_ratios.append(stats['zeroRatio'])
                    if stats['zeroRatio'] > depth_max:
                        message = f'{kind}/{name} 第 {index} 帧零值比例过高'
                        issues.append(hdf5_issue('depth_invalid_ratio', message, '中', f'{group_name}/{name}', stats['zeroRatio'], f'<= {depth_max}'))
            except Exception as error:
                failures += 1
                issues.append(hdf5_issue('image_decode', f'{kind}/{name} 第 {index} 帧无法解码：{error}', field=f'{group_name}/{name}'))
    metrics[f'{kind}DecodedImages'] = decoded
    metrics[f'{kind}DecodeFailures'] = failures
    metrics[f'{kind}Dimensions'] = dimensions
    if zero_ratios:
        metrics['depthZeroRatioMax'] = max(zero_ratios)


def check_hdf5(path, options):
    import h5py
    import numpy as np
    path = Path(path)
    issues, limitations, datasets = [], [], {}
    metrics = {'nonFiniteValues': 0, 'constantDatasets': [], 'optionalConstantDatasets': [], 'sampleCount': 0}
    try:
        handle = h5py.File(path, 'r')
    except Exception as error:
        issue = hdf5_issue('hdf5_open', f'HDF5 无法打开：{error}')
        return {'status': 'invalid', 'profile': HDF5_PROFILE, 'issues': [issue], 'limitations': [], 'metrics': metrics, 'datasets': {}, 'timestamps': []}
    with handle as hdf:
        known = HDF5_REQUIRED + HDF5_OPTIONAL
        present = [name for name in known if name in hdf]
        if not present:
            limitation = '未识别到遥操 HDF5 所需数据集，未执行语义质检'
            return {'status': 'not_supported', 'profile': None, 'issues': [], 'limitations': [limitation], 'metrics': metrics, 'datasets': {}, 'timestamps': []}
        missing = [name for name in HDF5_REQUIRED if name not in hdf]
        if missing:
            missing_text = ', '.join(missing)
            issues.append(hdf5_issue('missing_dataset', f'缺少必需数据集：{missing_text}', field=missing))
        values = {}
        for name in known:
            if name not in hdf or not isinstance(hdf[name], h5py.Dataset):
                continue
            dataset = hdf[name]
            datasets[name] = {'shape': list(dataset.shape), 'dtype': str(dataset.dtype)}
            try:
                value = np.asarray(dataset[()])
                values[name] = value
                if name == 'timestamps':
                    continue
                if value.dtype.kind not in 'iuf':
                    issues.append(hdf5_issue('dataset_dtype', f'{name} 不是数值数据集', field=name, actual=str(value.dtype), expected='int/float'))
                    continue
                invalid = int(np.size(value) - np.count_nonzero(np.isfinite(value)))
                metrics['nonFiniteValues'] += invalid
                if invalid:
                    issues.append(hdf5_issue('non_finite', f'{name} 含 {invalid} 个 NaN 或 Inf', field=name, actual=invalid, expected=0))
                if value.size and np.all(value == 0):
                    metrics['constantDatasets'].append(name)
            except Exception as error:
                issues.append(hdf5_issue('dataset_read', f'{name} 读取失败：{error}', field=name))
        if 'master/joint_position' in values and 'puppet/joint_position' in values:
            master = values['master/joint_position']
            puppet = values['puppet/joint_position']
            if master.shape != puppet.shape:
                issues.append(hdf5_issue('joint_shape', '主从关节位置维度不一致', field='joint_position', actual=list(master.shape), expected=list(puppet.shape)))
        if 'master/eef' in values and 'puppet/eef' in values:
            master = values['master/eef']
            puppet = values['puppet/eef']
            if master.shape != puppet.shape:
                issues.append(hdf5_issue('eef_shape', '主从末端位姿维度不一致', field='eef', actual=list(master.shape), expected=list(puppet.shape)))
        timestamps = []
        if 'timestamps' in values:
            timestamps = [float(value) for value in np.asarray(values['timestamps']).reshape(-1).tolist()]
            metrics['sampleCount'] = len(timestamps)
            if not timestamps:
                issues.append(hdf5_issue('empty_timestamps', 'timestamps 没有有效记录', field='timestamps'))
            elif any(not math.isfinite(value) or value < 0 for value in timestamps):
                issues.append(hdf5_issue('invalid_timestamp', 'timestamps 含负数、NaN 或 Inf', field='timestamps', actual=timestamps[:10], expected='非负有限数'))
        optional_constant = [name for name in metrics['constantDatasets'] if name in HDF5_OPTIONAL]
        blocking_constant = [name for name in metrics['constantDatasets'] if name not in HDF5_OPTIONAL]
        metrics['optionalConstantDatasets'] = optional_constant
        if optional_constant:
            names = ', '.join(optional_constant)
            limitations.append(f'可选通道 {names} 在样本中未启用或恒为零，已按 teleop-hdf5-v1 配置标记为不适用')
        if blocking_constant:
            names = ', '.join(blocking_constant)
            message = f'检测到恒定数据集：{names}，需确认是否为未使用通道'
            issues.append(hdf5_issue('constant_dataset', message, '中', field=blocking_constant))
        check_hdf5_images(hdf, 'observations/rgb_images', HDF5_RGB, 'rgb', options, issues, metrics)
        check_hdf5_images(hdf, 'observations/depth_images', HDF5_DEPTH, 'depth', options, issues, metrics)
        if not list(hdf.attrs.keys()):
            limitations.append('HDF5 未提供关节单位、相机内参/外参或时间戳单位元数据，物理量和跨模态标定仅能记录，不能最终判定')
        high = any(item['severity'] == '高' for item in issues)
        status = 'invalid' if high else 'warning' if issues else 'verified'
        return {
            'status': status,
            'profile': HDF5_PROFILE,
            'issues': issues,
            'limitations': limitations,
            'metrics': metrics,
            'datasets': datasets,
            'timestamps': timestamps,
        }


def check_hdf5_sequence(members, options, asset_id=None):
    reports = []
    timestamps = []
    issues = []
    limitations = []
    datasets = {}
    metrics = {
        'sampleCount': 0, 'fileCount': len(members), 'nonFiniteValues': 0,
        'constantDatasets': [], 'optionalConstantDatasets': [],
        'rgbDecodedImages': 0, 'rgbDecodeFailures': 0,
        'depthDecodedImages': 0, 'depthDecodeFailures': 0,
    }
    failed_files = []
    for member_index, member in enumerate(members):
        report = check_hdf5(Path(member['path']), options)
        reports.append(report)
        timestamps.extend(report.get('timestamps') or [])
        metrics['sampleCount'] += int(report.get('metrics', {}).get('sampleCount', 0))
        metrics['nonFiniteValues'] += int(report.get('metrics', {}).get('nonFiniteValues', 0))
        for key in ('rgbDecodedImages', 'rgbDecodeFailures', 'depthDecodedImages', 'depthDecodeFailures'):
            metrics[key] += int(report.get('metrics', {}).get(key, 0))
        metrics['constantDatasets'] = sorted(set(metrics['constantDatasets'] + report.get('metrics', {}).get('constantDatasets', [])))
        metrics['optionalConstantDatasets'] = sorted(set(metrics['optionalConstantDatasets'] + report.get('metrics', {}).get('optionalConstantDatasets', [])))
        datasets.update(report.get('datasets') or {})
        limitations.extend(report.get('limitations') or [])
        if report.get('status') in ('invalid', 'not_supported', 'warning'):
            failed_files.append({'relativePath': member.get('relativePath'), 'status': report.get('status')})
        for issue in report.get('issues') or []:
            issues.append({**issue, 'file': member.get('relativePath')})
        if (member_index + 1) % 25 == 0 or member_index + 1 == len(members):
            print('PROGRESS ' + json.dumps({'assetId': asset_id, 'completed': member_index + 1, 'total': len(members)}), file=sys.stderr, flush=True)

    unique_issues = []
    seen = set()
    for issue in issues:
        key = (issue.get('code'), issue.get('field'), issue.get('message'))
        if key in seen:
            continue
        seen.add(key)
        unique_issues.append(issue)
        if len(unique_issues) >= 200:
            break
    sequence = {}
    if timestamps:
        deltas = [right - left for left, right in zip(timestamps, timestamps[1:])]
        positive = [value for value in deltas if value > 0]
        expected = (statistics.median(positive) if len(positive) >= 4 else min(positive)) if positive else None
        threshold = max(float(options.get('gapAbsoluteMs', 100)), expected * float(options.get('gapFactor', 2.5))) if expected else None
        gaps = [{'index': index, 'delta': value} for index, value in enumerate(deltas) if threshold and value > threshold]
        if len(set(timestamps)) != len(timestamps):
            unique_issues.insert(0, hdf5_issue('duplicate_timestamp', '采集序列存在重复时间戳', field='timestamps', actual=len(timestamps) - len(set(timestamps)), expected=0))
        if gaps:
            unique_issues.insert(0, hdf5_issue('timestamp_gap', f'采集序列存在 {len(gaps)} 个时间缺口，最大 {max(item["delta"] for item in gaps)} ms', '中', field='timestamps', actual=len(gaps), expected=0))
        sequence = {
            'fileCount': len(timestamps), 'start': timestamps[0], 'end': timestamps[-1],
            'expectedIntervalMs': expected, 'observedFps': round(1000 / expected, 3) if expected else None,
            'gapThresholdMs': threshold, 'gapCount': len(gaps), 'gapRatio': len(gaps) / max(1, len(deltas)),
            'maxGapMs': max([item['delta'] for item in gaps], default=0), 'gaps': gaps[:100],
        }
    recognized = [report for report in reports if report.get('status') != 'not_supported']
    if not recognized:
        status = 'not_supported'
    elif any(report.get('status') == 'invalid' for report in recognized) or any(item.get('severity') == '高' for item in unique_issues):
        status = 'invalid'
    elif unique_issues or any(report.get('status') == 'warning' for report in recognized):
        status = 'warning'
    else:
        status = 'verified'
    return {
        'status': status, 'profile': 'matching_cable_frames_v1',
        'issues': unique_issues, 'limitations': sorted(set(limitations)), 'metrics': metrics,
        'datasets': datasets, 'timestamps': timestamps, 'sequence': sequence,
        'failedFiles': failed_files[:100], 'failedFileCount': len(failed_files),
    }


def umi_issue(code, message, severity='高', field=None, actual=None, expected=None):
    return {'code': code, 'message': message, 'severity': severity, 'field': field, 'actual': actual, 'expected': expected}


def read_csv_rows(file_path):
    import csv
    with Path(file_path).open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def numeric_series(rows, field):
    values = []
    for index, row in enumerate(rows):
        try:
            value = float(row[field])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f'Invalid numeric field {field} at row {index + 2}') from error
        if not math.isfinite(value):
            raise ValueError(f'Non-finite numeric field {field} at row {index + 2}')
        values.append(value)
    return values


def series_metrics(values):
    if not values:
        return {'count': 0, 'first': None, 'last': None, 'spanSeconds': 0, 'hz': None, 'maxGapMs': None, 'nonMonotonic': 0}
    gaps = [(right - left) / 1e6 for left, right in zip(values, values[1:])]
    span = (values[-1] - values[0]) / 1e9 if len(values) > 1 else 0
    return {
        'count': len(values), 'first': values[0], 'last': values[-1], 'spanSeconds': span,
        'hz': (len(values) - 1) / span if span > 0 else None,
        'maxGapMs': max(gaps, default=0), 'nonMonotonic': sum(value <= 0 for value in gaps),
    }


def check_umi_session(asset, options):
    import numpy as np
    required = asset.get('required') or {}
    issues, limitations = [], []
    missing = [role for role, file in required.items() if not Path(file).is_file()]
    if missing:
        raise ValueError(f'Missing required UMI files: {", ".join(missing)}')
    metadata = json.loads(Path(required['metadata']).read_text(encoding='utf-8'))
    ui = json.loads(Path(required['uiMetadata']).read_text(encoding='utf-8'))
    rgb_rows = read_csv_rows(required['rgbTimestamps'])
    vive_rows = read_csv_rows(required['vive'])
    clamp_rows = read_csv_rows(required['clamp'])
    rgb = numeric_series(rgb_rows, 'timestamp_ns')
    vive_time = numeric_series(vive_rows, 'timestamp_ns')
    clamp_time = numeric_series(clamp_rows, 'timestamp_ns')
    clamp_value = numeric_series(clamp_rows, 'value')
    quaternions = np.asarray([[float(row[key]) for key in ('qx', 'qy', 'qz', 'qw')] for row in vive_rows], dtype=np.float64)
    if not np.isfinite(quaternions).all():
        raise ValueError('VIVE quaternion contains NaN or Inf')
    quaternion_norm = np.linalg.norm(quaternions, axis=1)
    video = check_video(Path(required['video']), options.get('video', options))
    rgb_metrics = series_metrics(rgb)
    vive_metrics = series_metrics(vive_time)
    clamp_metrics = series_metrics(clamp_time)
    start_offset_ms = (vive_time[0] - rgb[0]) / 1e6
    end_offset_ms = (vive_time[-1] - rgb[-1]) / 1e6
    settings = options.get('umi', options)

    if str(ui.get('capture_status') or '') != 'completed':
        issues.append(umi_issue('capture_status', f'Capture did not complete: {ui.get("capture_status") or "unknown"}', field='capture_status', expected='completed'))
    if str(ui.get('quality_status') or '').lower() != 'pass':
        issues.append(umi_issue('source_quality', f'TeleUMI source quality status is {ui.get("quality_status") or "unknown"}', severity='中', field='quality_status', expected='pass'))
    if ui.get('can_process') is not True:
        limitations.append('TeleUMI source metadata reports can_process=false; source workflow meaning must be confirmed before training use.')
    if len(rgb_rows) != video.get('frames'):
        issues.append(umi_issue('camera_frame_count', 'RGB timestamp rows do not match decoded video frames', field='RGB_Images/timestamps.csv', actual=len(rgb_rows), expected=video.get('frames')))
    if rgb_metrics['nonMonotonic']:
        issues.append(umi_issue('camera_timestamp_order', 'RGB timestamps are not strictly increasing', field='RGB_Images/timestamps.csv', actual=rgb_metrics['nonMonotonic'], expected=0))
    if vive_metrics['nonMonotonic']:
        issues.append(umi_issue('vive_timestamp_order', 'VIVE timestamps are not strictly increasing', field='vut_raw.csv', actual=vive_metrics['nonMonotonic'], expected=0))
    if clamp_metrics['nonMonotonic']:
        issues.append(umi_issue('clamp_timestamp_order', 'Clamp timestamps are not strictly increasing', field='clamp_timebase.csv', actual=clamp_metrics['nonMonotonic'], expected=0))
    if not (float(settings.get('minCameraFps', 35)) <= float(rgb_metrics['hz'] or 0) <= float(settings.get('maxCameraFps', 45))):
        issues.append(umi_issue('camera_fps', 'RGB camera FPS is outside the accepted range', field='RGB_Images/timestamps.csv', actual=rgb_metrics['hz'], expected=[settings.get('minCameraFps', 35), settings.get('maxCameraFps', 45)]))
    if not (float(settings.get('minViveHz', 80)) <= float(vive_metrics['hz'] or 0) <= float(settings.get('maxViveHz', 150))):
        issues.append(umi_issue('vive_frequency', 'VIVE sample frequency is outside the accepted range', severity='中', field='vut_raw.csv', actual=vive_metrics['hz'], expected=[settings.get('minViveHz', 80), settings.get('maxViveHz', 150)]))
    if float(vive_metrics['maxGapMs'] or 0) > float(settings.get('maxViveGapMs', 70)):
        issues.append(umi_issue('vive_gap', 'VIVE contains a timestamp gap above the threshold', severity='中', field='vut_raw.csv', actual=vive_metrics['maxGapMs'], expected=f'<= {settings.get("maxViveGapMs", 70)} ms'))
    if not (float(settings.get('minClampHz', 50)) <= float(clamp_metrics['hz'] or 0) <= float(settings.get('maxClampHz', 70))):
        issues.append(umi_issue('clamp_frequency', 'Gripper sample frequency is outside the accepted range', severity='中', field='clamp_timebase.csv', actual=clamp_metrics['hz'], expected=[settings.get('minClampHz', 50), settings.get('maxClampHz', 70)]))
    if float(clamp_metrics['maxGapMs'] or 0) > float(settings.get('maxClampGapMs', 50)):
        issues.append(umi_issue('clamp_gap', 'Gripper contains a timestamp gap above the threshold', severity='中', field='clamp_timebase.csv', actual=clamp_metrics['maxGapMs'], expected=f'<= {settings.get("maxClampGapMs", 50)} ms'))
    if float(quaternion_norm.min()) < float(settings.get('minQuaternionNorm', 0.98)) or float(quaternion_norm.max()) > float(settings.get('maxQuaternionNorm', 1.02)):
        issues.append(umi_issue('quaternion_norm', 'VIVE quaternion norm is outside tolerance', field='vut_raw.csv', actual=[float(quaternion_norm.min()), float(quaternion_norm.max())], expected=[settings.get('minQuaternionNorm', 0.98), settings.get('maxQuaternionNorm', 1.02)]))
    if min(clamp_value) < float(settings.get('minClampValue', 0)) or max(clamp_value) > float(settings.get('maxClampValue', 100)):
        issues.append(umi_issue('clamp_range', 'Gripper values are outside 0..100', field='clamp_timebase.csv', actual=[min(clamp_value), max(clamp_value)], expected=[settings.get('minClampValue', 0), settings.get('maxClampValue', 100)]))
    if abs(start_offset_ms) > float(settings.get('maxStartOffsetMs', 100)):
        issues.append(umi_issue('sync_start', 'RGB and VIVE start times are not synchronized', field='timestamps', actual=start_offset_ms, expected=f'<= {settings.get("maxStartOffsetMs", 100)} ms'))
    if abs(end_offset_ms) > float(settings.get('maxEndOffsetMs', 100)):
        issues.append(umi_issue('sync_end', 'RGB and VIVE end times are not synchronized', field='timestamps', actual=end_offset_ms, expected=f'<= {settings.get("maxEndOffsetMs", 100)} ms'))
    if video.get('status') == 'invalid':
        issues.extend(umi_issue(f'video_{item.get("code", "invalid")}', item.get('message', 'Video check failed')) for item in video.get('findings', []))

    status = 'invalid' if any(item.get('severity') == '高' for item in issues) else 'warning' if issues else 'verified'
    metrics = {
        'cameraFrames': rgb_metrics['count'], 'cameraFps': rgb_metrics['hz'], 'cameraSpanSeconds': rgb_metrics['spanSeconds'], 'cameraMaxGapMs': rgb_metrics['maxGapMs'],
        'viveSamples': vive_metrics['count'], 'viveHz': vive_metrics['hz'], 'viveMaxGapMs': vive_metrics['maxGapMs'],
        'clampSamples': clamp_metrics['count'], 'clampHz': clamp_metrics['hz'], 'clampMaxGapMs': clamp_metrics['maxGapMs'],
        'quaternionNormMin': float(quaternion_norm.min()), 'quaternionNormMax': float(quaternion_norm.max()),
        'clampMin': min(clamp_value), 'clampMax': max(clamp_value), 'video': video,
    }
    return {
        'status': status, 'profile': 'umi-session-v1', 'sessionId': asset.get('sessionId'),
        'taskName': asset.get('taskName'), 'issues': issues, 'limitations': limitations, 'metrics': metrics,
        'sync': {'startOffsetMs': start_offset_ms, 'endOffsetMs': end_offset_ms}, 'sourceQualityStatus': ui.get('quality_status'), 'canProcess': ui.get('can_process'),
    }


def enrich_hdf5_sequences(assets, reports, options):
    groups = {}
    for asset in assets:
        if asset.get('members'):
            continue
        report = reports.get(asset['id'], {}).get('hdf5')
        if not report or report.get('status') == 'not_supported' or not report.get('timestamps'):
            continue
        relative = Path(asset['relativePath'])
        key = f'{asset.get("bundleId") or "bundle"}:{relative.parent.as_posix()}'
        groups.setdefault(key, {'bundleId': asset.get('bundleId'), 'directory': relative.parent.as_posix(), 'items': []})
        groups[key]['items'].append({'assetId': asset['id'], 'relativePath': asset['relativePath'], 'timestamp': report['timestamps'][0]})
    for key, group in groups.items():
        group['items'].sort(key=lambda item: item['timestamp'])
        timestamps = [item['timestamp'] for item in group['items']]
        deltas = [right - left for left, right in zip(timestamps, timestamps[1:])]
        positive = [value for value in deltas if value > 0]
        expected = (statistics.median(positive) if len(positive) >= 4 else min(positive)) if positive else None
        threshold = max(float(options.get('gapAbsoluteMs', 100)), expected * float(options.get('gapFactor', 2.5))) if expected else None
        gaps = [{'from': group['items'][index]['relativePath'], 'to': group['items'][index + 1]['relativePath'], 'delta': value} for index, value in enumerate(deltas) if threshold and value > threshold]
        sequence_issues = []
        if len(set(timestamps)) != len(timestamps):
            sequence_issues.append(hdf5_issue('duplicate_timestamp', '采集序列存在重复时间戳', field='timestamps', actual=len(timestamps) - len(set(timestamps)), expected=0))
        if gaps:
            maximum = max(item['delta'] for item in gaps)
            sequence_issues.append(hdf5_issue('timestamp_gap', f'采集序列存在 {len(gaps)} 个时间缺口，最大 {maximum} ms', '中', field='timestamps', actual=len(gaps), expected=0))
        summary = {
            'key': key,
            'bundleId': group.get('bundleId'),
            'directory': group['directory'],
            'fileCount': len(timestamps),
            'start': timestamps[0],
            'end': timestamps[-1],
            'expectedIntervalMs': expected,
            'observedFps': round(1000 / expected, 3) if expected else None,
            'gapThresholdMs': threshold,
            'gapCount': len(gaps),
            'gapRatio': len(gaps) / max(1, len(deltas)),
            'maxGapMs': max([item['delta'] for item in gaps], default=0),
            'gaps': gaps[:100],
            'issues': sequence_issues,
        }
        for item in group['items']:
            reports[item['assetId']]['hdf5']['sequence'] = summary


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
            if asset.get('umi'):
                result['umi'] = check_umi_session(asset['umi'], options)
                result['structure'] = {
                    'status': 'not_supported' if result['umi']['status'] == 'not_supported' else 'verified',
                    'profile': result['umi'].get('profile'), 'recordCount': result['umi'].get('metrics', {}).get('cameraFrames', 0),
                    'issues': [item['message'] for item in result['umi'].get('issues', [])],
                }
            elif asset.get('role') == 'trajectory' and asset.get('members'):
                result['hdf5'] = check_hdf5_sequence(asset['members'], options.get('hdf5', options), asset.get('id'))
                structure_status = 'not_supported' if result['hdf5']['status'] == 'not_supported' else 'verified'
                result['structure'] = {'status': structure_status, 'profile': result['hdf5'].get('profile'), 'recordCount': result['hdf5']['metrics'].get('sampleCount', 0), 'issues': [item['message'] for item in result['hdf5'].get('issues', [])]}
            elif asset.get('role') == 'trajectory' and extension in ('.h5', '.hdf5'):
                result['hdf5'] = check_hdf5(path, options.get('hdf5', options))
                structure_status = 'not_supported' if result['hdf5']['status'] == 'not_supported' else 'verified'
                result['structure'] = {'status': structure_status, 'profile': result['hdf5'].get('profile'), 'recordCount': result['hdf5']['metrics'].get('sampleCount', 0), 'issues': [item['message'] for item in result['hdf5'].get('issues', [])]}
            elif asset.get('role') == 'trajectory' and extension == '.parquet':
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
    enrich_hdf5_sequences(assets, by_id, options.get('hdf5', options))
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
