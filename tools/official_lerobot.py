"""Convert and verify a local LeRobot v2.1 dataset with official LeRobot v3.0 tooling."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

OFFICIAL_LEROBOT_VERSION = "0.4.4"
TARGET_DATASET_VERSION = "v3.0"


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def read_json(path: Path) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line_number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"JSONL line {line_number} must be an object: {path}")
        rows.append(value)
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows), encoding="utf-8")


def json_safe(value):
    import numpy as np
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def infer_arrow_feature(arrow_type, sample_value=None) -> dict:
    import pyarrow as pa
    if pa.types.is_list(arrow_type) or pa.types.is_fixed_size_list(arrow_type):
        value_type = arrow_type.value_type
        size = int(arrow_type.list_size) if pa.types.is_fixed_size_list(arrow_type) else (len(sample_value) if isinstance(sample_value, (list, tuple)) else None)
        if not size:
            raise ValueError(f"Cannot infer list feature width from type {arrow_type}")
        if pa.types.is_floating(value_type):
            return {"dtype": "float32", "shape": [size], "names": None}
        if pa.types.is_integer(value_type):
            return {"dtype": "int64", "shape": [size], "names": None}
        raise ValueError(f"Unsupported list feature type: {arrow_type}")
    if pa.types.is_floating(arrow_type):
        return {"dtype": "float32", "shape": [1], "names": None}
    if pa.types.is_integer(arrow_type):
        return {"dtype": "int64", "shape": [1], "names": None}
    if pa.types.is_boolean(arrow_type):
        return {"dtype": "bool", "shape": [1], "names": None}
    if pa.types.is_string(arrow_type) or pa.types.is_large_string(arrow_type):
        return {"dtype": "string", "shape": [1], "names": None}
    raise ValueError(f"Unsupported parquet feature type: {arrow_type}")


def inspect_video_feature(path: Path, fps: float) -> dict:
    import av
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        frame = next(container.decode(video=0))
        array = frame.to_ndarray(format="rgb24")
        height, width = array.shape[:2]
        codec = stream.codec_context.codec.canonical_name
        pix_fmt = stream.codec_context.pix_fmt
    return {
        "dtype": "video", "shape": [height, width, 3], "names": ["height", "width", "channels"],
        "info": {"video.height": height, "video.width": width, "video.codec": codec,
                 "video.pix_fmt": pix_fmt, "video.is_depth_map": False, "video.fps": fps,
                 "video.channels": 3, "has_audio": False},
    }


def arrow_type_for_feature(feature: dict):
    import pyarrow as pa
    dtype = str(feature.get("dtype", ""))
    shape = [int(value) for value in feature.get("shape", [1])]
    scalar = {"float32": pa.float32(), "float64": pa.float64(), "int64": pa.int64(),
              "int32": pa.int32(), "bool": pa.bool_(), "string": pa.string()}
    if dtype not in scalar:
        raise ValueError(f"Unsupported feature dtype: {dtype}")
    if len(shape) == 1 and shape[0] == 1:
        return scalar[dtype]
    if len(shape) == 1:
        return pa.list_(scalar[dtype], list_size=shape[0])
    raise ValueError(f"Unsupported feature shape for v2.1 normalization: {shape}")


def normalize_v21_tables(dataset: Path, features: dict) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq
    for file in sorted((dataset / "data").rglob("*.parquet")):
        source = pq.read_table(file)
        columns, names = [], []
        for name, feature in features.items():
            if feature.get("dtype") == "video" or name not in source.column_names:
                continue
            target_type = arrow_type_for_feature(feature)
            columns.append(source[name].cast(target_type) if source[name].type != target_type else source[name])
            names.append(name)
        if not columns:
            raise ValueError(f"Parquet has no declared feature columns: {file}")
        pq.write_table(pa.table(dict(zip(names, columns))), file)


def scalar_stats(values) -> dict:
    import numpy as np
    array = np.asarray(values)
    if array.dtype.kind not in "biuf":
        raise ValueError("Statistic generation only supports numeric columns")
    if array.ndim == 1:
        return {
            "min": [float(np.min(array))], "max": [float(np.max(array))],
            "mean": [float(np.mean(array))], "std": [float(np.std(array))],
            "count": [int(array.shape[0])],
        }
    flat = array.reshape(array.shape[0], -1)
    return {
        "min": np.min(flat, axis=0).tolist(), "max": np.max(flat, axis=0).tolist(),
        "mean": np.mean(flat, axis=0).tolist(), "std": np.std(flat, axis=0).tolist(),
        "count": [int(array.shape[0])],
    }


def video_stats(path: Path) -> dict:
    import av
    import numpy as np
    channel_values = []
    frame_count = 0
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError(f"Video has no video stream: {path}")
        for frame in container.decode(video=0):
            pixels = frame.to_ndarray(format="rgb24").reshape(-1, 3).astype("float32") / 255.0
            channel_values.append([pixels.min(axis=0), pixels.max(axis=0), pixels.mean(axis=0), pixels.std(axis=0)])
            frame_count += 1
    if not frame_count:
        raise ValueError(f"Video has no decodable frame: {path}")
    values = np.asarray(channel_values)
    result = {
        "min": values[:, 0, :].min(axis=0).reshape(3, 1, 1).tolist(),
        "max": values[:, 1, :].max(axis=0).reshape(3, 1, 1).tolist(),
        "mean": values[:, 2, :].mean(axis=0).reshape(3, 1, 1).tolist(),
        "std": values[:, 3, :].mean(axis=0).reshape(3, 1, 1).tolist(),
        "count": [frame_count],
    }
    return result


def ensure_v21_metadata(dataset: Path) -> dict:
    import pyarrow.parquet as pq
    info_path = dataset / "meta" / "info.json"
    if not info_path.is_file():
        raise ValueError("LeRobot source is missing meta/info.json")
    info = read_json(info_path)
    version = str(info.get("codebase_version", ""))
    if not version.lstrip("v").startswith("2."):
        raise ValueError(f"Official conversion expects LeRobot v2.x, got {version or 'unknown'}")
    features = info.get("features")
    if not isinstance(features, dict):
        raise ValueError("meta/info.json has no feature definition")
    data_files = sorted((dataset / "data").rglob("*.parquet"))
    if not data_files:
        raise ValueError("LeRobot source has no data/**/*.parquet files")
    tasks_path = dataset / "meta" / "tasks.jsonl"
    tasks_rows = read_jsonl(tasks_path) if tasks_path.is_file() else []
    tasks = {int(row["task_index"]): str(row.get("task", "")) for row in tasks_rows}
    first_table = pq.read_table(data_files[0])
    for name, field in zip(first_table.column_names, first_table.schema):
        sample_value = first_table[name][0].as_py() if first_table.num_rows else None
        if name not in features:
            try:
                features[name] = infer_arrow_feature(field.type, sample_value)
            except ValueError:
                continue
        elif "shape" not in features[name]:
            if features[name].get("dtype") == "video":
                matches = sorted((dataset / "videos").glob(f"*/{name}/*.mp4"))
                if not matches:
                    raise ValueError(f"No video files found for feature {name}")
                features[name].update(inspect_video_feature(matches[0], float(info.get("fps") or 20)))
            else:
                try:
                    features[name].update(infer_arrow_feature(field.type, sample_value))
                except ValueError:
                    features.pop(name, None)
    for name, feature in features.items():
        if feature.get("dtype") == "video" and "shape" not in feature:
            matches = sorted((dataset / "videos").glob(f"*/{name}/*.mp4"))
            if not matches:
                raise ValueError(f"No video files found for feature {name}")
            feature.update(inspect_video_feature(matches[0], float(info.get("fps") or 20)))
    episode_count = len(data_files)
    total_frames = sum(int(pq.ParquetFile(file).metadata.num_rows) for file in data_files)
    video_keys = [name for name, feature in features.items() if feature.get("dtype") == "video"]
    info.update({
        "robot_type": str(info.get("robot_type") or "unknown"),
        "total_episodes": int(info.get("total_episodes") or episode_count),
        "total_frames": int(info.get("total_frames") or total_frames),
        "total_tasks": int(info.get("total_tasks") or len(tasks)),
        "total_videos": int(info.get("total_videos") or len(video_keys) * episode_count),
        "total_chunks": int(info.get("total_chunks") or 1), "chunks_size": int(info.get("chunks_size") or 1000),
        "splits": info.get("splits") or {"train": f"0:{episode_count}"},
        "data_path": info.get("data_path") or "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path": info.get("video_path") or ("videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4" if video_keys else None),
        "features": features,
    })
    normalize_v21_tables(dataset, features)
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    episodes = {}
    episode_paths = dataset / "meta" / "episodes.jsonl"
    if episode_paths.is_file():
        for row in read_jsonl(episode_paths):
            index = int(row.get("episode_index"))
            episodes[index] = row
    stats_path = dataset / "meta" / "episodes_stats.jsonl"
    stats = {}
    if stats_path.is_file():
        for row in read_jsonl(stats_path):
            stats[int(row["episode_index"])] = row.get("stats", {})
    for file in data_files:
        table = pq.read_table(file)
        if not table.num_rows:
            raise ValueError(f"Empty LeRobot episode: {file}")
        if "episode_index" not in table.column_names:
            raise ValueError(f"Missing episode_index: {file}")
        episode_indices = {int(value) for value in table["episode_index"].to_pylist()}
        if len(episode_indices) != 1:
            raise ValueError(f"One parquet file must contain one episode: {file}")
        index = episode_indices.pop()
        if index not in episodes:
            task_indices = sorted({int(value) for value in table["task_index"].to_pylist()}) if "task_index" in table.column_names else []
            episodes[index] = {"episode_index": index, "length": int(table.num_rows), "tasks": [tasks[item] for item in task_indices if tasks.get(item)]}
        if index not in stats:
            episode_stats = {}
            video_keys = [name for name, feature in features.items() if feature.get("dtype") == "video"]
            for name in table.column_names:
                if name in video_keys:
                    continue
                try:
                    episode_stats[name] = scalar_stats(table[name].to_pylist())
                except (TypeError, ValueError):
                    continue
            for name in video_keys:
                matches = sorted((dataset / "videos").glob(f"*/{name}/episode_{index:06d}.mp4"))
                if matches:
                    episode_stats[name] = video_stats(matches[0])
                else:
                    raise ValueError(f"Missing video for episode {index}: {name}")
            stats[index] = episode_stats
    if not episodes:
        raise ValueError("LeRobot source has no episode metadata")
    write_jsonl(dataset / "meta" / "episodes.jsonl", [episodes[index] for index in sorted(episodes)])
    write_jsonl(dataset / "meta" / "episodes_stats.jsonl", [{"episode_index": index, "stats": stats[index]} for index in sorted(stats)])
    return info


def dataset_fingerprint(dataset: Path) -> str:
    result = hashlib.sha256()
    for folder in ("meta", "data", "videos"):
        for file in sorted((dataset / folder).rglob("*")):
            if not file.is_file():
                continue
            relative = file.relative_to(dataset).as_posix()
            result.update(relative.encode("utf-8") + b"\0")
            result.update(digest(file).encode("ascii") + b"\0")
    return result.hexdigest()


def verify_v30(dataset: Path, batch_size: int = 2) -> dict:
    import numpy as np
    import torch
    import datasets
    import lerobot
    from torch.utils.data import DataLoader
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    import pyarrow.parquet as pq

    started = time.perf_counter()
    info = read_json(dataset / "meta" / "info.json")
    if info.get("codebase_version") != TARGET_DATASET_VERSION:
        raise ValueError(f"Official loader requires LeRobot {TARGET_DATASET_VERSION}, got {info.get('codebase_version')}")
    episode_files = sorted((dataset / "meta" / "episodes").rglob("*.parquet"))
    if not episode_files:
        raise ValueError("LeRobot v3.0 output has no meta/episodes parquet files")
    episode_rows = []
    for file in episode_files:
        episode_rows.extend(pq.read_table(file).to_pylist())
    episode_rows.sort(key=lambda row: int(row["episode_index"]))
    if [int(row["episode_index"]) for row in episode_rows] != list(range(len(episode_rows))):
        raise ValueError("Episode indices are not contiguous from zero")

    loaded = LeRobotDataset(repo_id="local/embodied-dataset", root=dataset, video_backend="pyav", download_videos=False)
    video_keys = [name for name, feature in info.get("features", {}).items() if feature.get("dtype") == "video"]
    expected_frames = int(info.get("total_frames", -1))
    if len(loaded) != expected_frames or int(loaded.meta.total_episodes) != len(episode_rows):
        raise ValueError(f"Official loader count mismatch: frames={len(loaded)}/{expected_frames}, episodes={loaded.meta.total_episodes}/{len(episode_rows)}")
    if info.get("splits") != {"train": f"0:{len(episode_rows)}"}:
        raise ValueError(f"Expected all episodes in train split, got {info.get('splits')}")

    samples = []
    for episode in episode_rows:
        start, end = int(episode["dataset_from_index"]), int(episode["dataset_to_index"])
        for row in sorted({start, (start + end - 1) // 2, end - 1}):
            item = loaded[row]
            for field in ("action", "observation.state"):
                tensor = item[field]
                if not torch.isfinite(tensor).all():
                    raise ValueError(f"Official sample contains non-finite {field} at frame {row}")
            image_samples = {}
            for key in video_keys:
                image = item[key]
                if not isinstance(image, torch.Tensor) or image.ndim != 3 or image.shape[0] != 3:
                    raise ValueError(f"Official video tensor shape is invalid for {key} at frame {row}")
                if not torch.isfinite(image).all():
                    raise ValueError(f"Official video tensor is non-finite for {key} at frame {row}")
                pixels = np.rint(image.permute(1, 2, 0).detach().cpu().numpy() * 255).astype("uint8")
                image_samples[key] = hashlib.sha256(pixels.tobytes()).hexdigest()
            samples.append({
                "episode_index": int(episode["episode_index"]), "frame_index": row - start,
                "dataset_index": row, "task": item.get("task"), "video_sha256": image_samples,
            })

    size = max(1, min(int(batch_size), len(loaded)))
    batch = next(iter(DataLoader(loaded, batch_size=size, num_workers=0, shuffle=False)))
    batch_shapes = {name: list(value.shape) for name, value in batch.items() if isinstance(value, torch.Tensor)}
    return {
        "ok": True, "status": "passed", "format_version": TARGET_DATASET_VERSION,
        "official_lerobot_version": str(getattr(lerobot, "__version__", OFFICIAL_LEROBOT_VERSION)),
        "datasets_version": str(datasets.__version__), "torch_version": str(torch.__version__),
        "python": sys.version, "episode_count": len(episode_rows), "frame_count": len(loaded),
        "video_keys": video_keys, "sample_count": len(samples), "samples": samples,
        "batch_size": size, "batch_shapes": batch_shapes, "offline": True, "video_backend": "pyav",
        "dataset_fingerprint": dataset_fingerprint(dataset), "elapsed_seconds": round(time.perf_counter() - started, 3),
    }


def convert(source: Path, output: Path, report: Path, batch_size: int = 2) -> dict:
    source, output, report = Path(source).resolve(), Path(output).resolve(), Path(report).resolve()
    if output.exists():
        raise FileExistsError(f"Official conversion output already exists: {output}")
    if report.exists():
        raise FileExistsError(f"Official verification report already exists: {report}")
    with tempfile.TemporaryDirectory(prefix="official-lerobot-", dir=source.parent) as folder:
        workspace = Path(folder)
        staged = workspace / "dataset"
        shutil.copytree(source, staged)
        source_info = ensure_v21_metadata(staged)
        from lerobot.datasets.v30.convert_dataset_v21_to_v30 import convert_dataset
        convert_dataset(repo_id="dataset", root=workspace, push_to_hub=False, force_conversion=True)
        legacy = workspace / "dataset_old"
        if legacy.is_dir():
            for item in legacy.iterdir():
                if item.is_file() and item.name not in {"annotations.jsonl"}:
                    shutil.copy2(item, staged / item.name)
                elif item.name == "annotations.jsonl":
                    shutil.copy2(item, staged / item.name)
        verification = verify_v30(staged, batch_size=batch_size)
        shutil.copytree(staged, output)
    verification.update({
        "source_format_version": source_info.get("codebase_version"),
        "target_format_version": TARGET_DATASET_VERSION,
        "output": str(output), "converted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(json_safe(verification), ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return verification


def main() -> int:
    if not sys.flags.utf8_mode:
        environment = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
                       "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
        return subprocess.run([sys.executable, "-X", "utf8", str(Path(__file__).resolve()), *sys.argv[1:]], env=environment).returncode
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["convert", "verify"])
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=2)
    args = parser.parse_args()
    try:
        if args.action == "convert":
            if not args.output:
                raise ValueError("--output is required for convert")
            result = convert(args.dataset, args.output, args.report, args.batch_size)
        else:
            result = verify_v30(args.dataset, args.batch_size)
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(json_safe(result), ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps(json_safe(result), ensure_ascii=True))
        return 0
    except Exception as error:
        result = {"ok": False, "status": "failed", "error": str(error), "type": type(error).__name__}
        try:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception:
            pass
        print(json.dumps(result, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
