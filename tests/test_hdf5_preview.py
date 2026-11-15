import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_production_check import encoded_image, write_hdf5_episode

try:
    import av  # noqa: F401
    import h5py  # noqa: F401
    from PIL import Image  # noqa: F401
    HAS_PREVIEW_RUNTIME = True
except Exception:
    HAS_PREVIEW_RUNTIME = False


spec = importlib.util.spec_from_file_location('hdf5_preview', Path(__file__).parents[1] / 'tools' / 'hdf5_preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class Hdf5PreviewTests(unittest.TestCase):
    @unittest.skipUnless(HAS_PREVIEW_RUNTIME, 'PyAV, h5py and Pillow are required')
    def test_frame_episode_generates_four_camera_preview_and_thumbnails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = encoded_image(root, 'frame.jpg', 'mjpeg', 'yuvj420p', 'rgb24')
            depth = encoded_image(root, 'depth.png', 'png', 'gray', 'gray')
            episode = root / '68'
            episode.mkdir()
            frames = [write_hdf5_episode(episode, f'{index}.hdf5', index * 50, rgb, depth) for index in range(3)]
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'assetId': 'AST-PREVIEW', 'fingerprint': 'abc123', 'frames': [{'path': str(path)} for path in frames]}), encoding='utf-8')
            output = root / 'preview'
            metadata_path = root / 'preview-metadata.json'
            result = preview.build_preview(manifest, output, metadata_path, 640, 28)
            self.assertEqual(result['frameCount'], 3)
            self.assertEqual(result['fps'], 20)
            self.assertEqual(len(result['cameras']), 4)
            self.assertTrue(all((output / camera['file']).is_file() for camera in result['cameras']))
            self.assertTrue(all((output / name).is_file() for name in result['thumbnails']))
            self.assertEqual(json.loads(metadata_path.read_text(encoding='utf-8'))['assetId'], 'AST-PREVIEW')
            import av
            counts = []
            for camera in result['cameras']:
                with av.open(str(output / camera['file'])) as container:
                    counts.append(sum(1 for _ in container.decode(video=0)))
            self.assertEqual(counts, [3, 3, 3, 3])


if __name__ == '__main__':
    unittest.main()
