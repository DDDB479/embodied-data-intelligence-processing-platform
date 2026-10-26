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


def check_file(path):
    import pyarrow.parquet as pq

    parquet = pq.ParquetFile(path)
    schema = parquet.schema_arrow
    names = list(schema.names)
    fields = {field.name: str(field.type) for field in schema}
    missing = [name for name in REQUIRED if name not in fields]
    row_count = int(parquet.metadata.num_rows)
    issues = []
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
                    if isinstance(number, (int, float)) and not math.isfinite(float(number)):
                        numeric_invalid += 1
            vector_lengths[name] = sorted(lengths)
            if len(lengths) != 1 or -1 in lengths:
                issues.append(f"{name} 向量长度不一致")
        for name in ("timestamp", "frame_index", "episode_index"):
            if name not in table.column_names:
                continue
            values = [scalar(value) for value in table[name].to_pylist()]
            if any(isinstance(value, (int, float)) and not math.isfinite(float(value)) for value in values):
                numeric_invalid += 1
            if name in ("timestamp", "frame_index"):
                previous = None
                failures = 0
                for value in values:
                    if previous is not None and value < previous:
                        failures += 1
                    previous = value
                if failures:
                    monotonic_failures[name] = failures
                    issues.append(f"{name} 存在 {failures} 处逆序")
    if numeric_invalid:
        issues.append(f"发现 {numeric_invalid} 个非有限数值")
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
