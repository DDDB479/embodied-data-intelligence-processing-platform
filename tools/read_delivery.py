"""Minimal consumer example. This is not an official LeRobot training loader."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
root = args.directory
files = sorted(root.glob('*.mcap'))
if files:
    from mcap.reader import make_reader
    with files[0].open('rb') as stream:
        _, channel, message = next(make_reader(stream).iter_messages())
        print(channel.topic, message.log_time, json.loads(message.data))
elif sorted(root.glob('*.zarr')):
    import zarr
    group = zarr.open_group(str(sorted(root.glob('*.zarr'))[0]), mode='r')
    print(dict(group.attrs), list(group.array_keys()))
else:
    import pyarrow.parquet as pq
    file = next((root / 'data').rglob('*.parquet'))
    print(pq.read_table(file).slice(0, 1).to_pylist())
