"""Read-only LeRobot Parquet validator used by the quality platform."""
import json
import math
import os
import sys


REQUIRED = {
    "timestamp": "标量时间戳",
    "frame_index": "帧索引",
    "episode_index": "Episode 索引",
    "index": "全局索引",
    "task_index": "任务索引",
    "action": "动作向量",
    "observation.state": "观测状态向量",
}


def scalar(value):
    if hasattr(value, "as_py"):
        value = value.as_py()
    return value


def flatten(value):
    value = scalar(value)
    if isinstance(value, (list, tuple)):
        for child in value:
            yield from flatten(child)
    else:
        yield value


def check_file(path, features=None, fps=None):
    import pyarrow.parquet as pq

    parquet = pq.ParquetFile(path)
    schema = parquet.schema_arrow
    names = list(schema.names)
    fields = {field.name: str(field.type) for field in schema}
    missing = [name for name in REQUIRED if name not in fields]
    row_count = int(parquet.metadata.num_rows)
    issues = []
    findings = []
    finding_count = 0
    def finding(code, field, frame, actual, expected, message):
        nonlocal finding_count
        finding_count += 1
        if len(findings) < 100:
            findings.append({"code": code, "field": field, "row": frame, "actual": actual,
                             "expected": expected, "message": message})
        if message not in issues:
            issues.append(message)
    if row_count <= 0:
        issues.append("Parquet 没有数据行")
    if missing:
        issues.append("缺少必需列：" + ", ".join(missing))

    readable = [name for name in REQUIRED if name in fields]
    table = parquet.read(columns=readable) if readable else None
    vector_lengths = {}
    numeric_invalid = 0
    monotonic_failures = {}
    if table is not None:
        for name in ("action", "observation.state"):
            if name not in table.column_names:
                continue
            lengths = set()
            for value in table[name].to_pylist():
                item = scalar(value)
                lengths.add(len(item) if isinstance(item, (list, tuple)) else -1)
                for number in flatten(item):
                    if number is None or isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(float(number)):
                        numeric_invalid += 1
            vector_lengths[name] = sorted(lengths)
            if len(lengths) != 1 or -1 in lengths:
                issues.append(f"{name} 向量长度不一致")
        for name in readable:
            values = table[name].to_pylist()
            for row, value in enumerate(values):
                if value is None:
                    finding("null", name, row, None, "非空值", f"{name} 存在空值")
            if name in ("action", "observation.state"):
                feature = (features or {}).get(name, {})
                shape = feature.get("shape", [])
                expected = shape[0] if len(shape) == 1 else None
                for row, value in enumerate(values):
                    if expected is not None and (not isinstance(value, (list, tuple)) or len(value) != expected):
                        finding("dimension", name, row, len(value) if isinstance(value, (list, tuple)) else None, expected, f"{name} 维度与 info.json 声明不一致")
                    if any(v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in flatten(value)):
                        finding("numeric", name, row, str(value)[:160], "有限数值向量", f"{name} 含空值、非数值或非有限数值")
        for name in ("timestamp", "frame_index", "episode_index", "index", "task_index"):
            if name not in table.column_names:
                continue
            values = [scalar(value) for value in table[name].to_pylist()]
            valid = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)) and v >= 0
            for row, value in enumerate(values):
                if not valid(value) or (name != "timestamp" and int(value) != value):
                    finding("index_type", name, row, str(value), "非负时间戳" if name == "timestamp" else "非负整数", f"{name} 含非法数值")
            if any(isinstance(value, (int, float)) and not math.isfinite(float(value)) for value in values):
                numeric_invalid += 1
            if name in ("timestamp", "frame_index", "index"):
                previous = None
                failures = 0
                for row, value in enumerate(values):
                    if not valid(value):
                        previous = None
                        continue
                    if previous is not None and value <= previous:
                        failures += 1
                        finding("order", name, row, value, f"> {previous}", f"{name} 存在重复或逆序")
                    if previous is not None and name == "frame_index" and value != previous + 1:
                        finding("frame_gap", name, row, value, previous + 1, "frame_index 存在帧缺口")
                    if previous is not None and name == "timestamp" and fps and fps > 0 and abs((value - previous) - 1 / fps) > max(0.002, 0.2 / fps):
                        finding("sample_interval", name, row, value - previous, 1 / fps, "timestamp 采样间隔偏离声明 FPS")
                    previous = value
                if failures:
                    monotonic_failures[name] = failures
                    issues.append(f"{name} 存在 {failures} 处逆序")
            if name == "episode_index" and len(set(str(value) for value in values)) != 1:
                finding("mixed_episode", name, None, "多个索引", "单个 Episode 索引", "同一文件含多个 Episode 索引")
    if numeric_invalid:
        issues.append(f"发现 {numeric_invalid} 个非有限数值")
    def endpoint(index):
        if table is None or not row_count or "timestamp" not in table.column_names: return None
        value = table["timestamp"][index].as_py()
        return value if isinstance(value, (int, float)) and math.isfinite(value) else None
    return {
        "name": os.path.basename(path),
        "status": "verified" if not issues else "invalid",
        "rowCount": row_count,
        "columns": names,
        "fields": fields,
        "missing": missing,
        "vectorLengths": vector_lengths,
        "monotonicFailures": monotonic_failures,
        "issues": issues,
        "findings": findings[:100],
        "findingCount": finding_count,
        "firstTimestamp": endpoint(0),
        "lastTimestamp": endpoint(-1),
    }


def main():
    paths = [os.path.abspath(value) for value in sys.argv[1:] if value]
    if not paths:
        print(json.dumps({"ok": False, "error": "未提供 Parquet 文件"}, ensure_ascii=True))
        return 2
    try:
        results = [check_file(path) for path in paths]
    except Exception as exc:  # Keep stdout valid JSON for the Node caller.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True))
        return 2
    print(json.dumps({"ok": True, "files": results}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
