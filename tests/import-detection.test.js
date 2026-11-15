const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPreset, resolvePreset } = require('../assets/import-detection.js');

function file(path, size = 1024) {
  return { name: path.split('/').pop(), webkitRelativePath: path, size };
}

test('HDF5 teleoperation data automatically selects the HDF5 preset', () => {
  const files = [
    file('teleop_demo/episode_000.hdf5'),
    file('teleop_demo/episode_001.h5'),
    file('teleop_demo/camera/front.mp4'),
  ];
  const detected = detectPreset({ type: '遥操', files, roles: ['trajectory', 'trajectory', 'media'] });
  assert.equal(detected.preset, 'hdf5');
  assert.equal(detected.format, 'HDF5');
  assert.equal(detected.confidence, 'high');
  assert.match(detected.reason, /HDF5/);
});

test('manual preset override survives automatic detection', () => {
  const files = [file('teleop_demo/episode_000.hdf5')];
  const resolved = resolvePreset({
    type: '遥操', files, roles: ['trajectory'], mode: 'manual', manualPreset: 'structured',
    availablePresetIds: ['hdf5', 'mcap', 'structured', 'single'],
  });
  assert.equal(resolved.mode, 'manual');
  assert.equal(resolved.preset, 'structured');
  assert.equal(resolved.automaticPreset, 'hdf5');
  assert.match(resolved.reason, /手动/);
});

test('switching back to automatic mode restores HDF5 detection', () => {
  const files = [file('teleop_demo/episode_000.h5')];
  const resolved = resolvePreset({
    type: '遥操', files, roles: ['trajectory'], mode: 'auto', manualPreset: 'structured',
    availablePresetIds: ['hdf5', 'structured', 'single'],
  });
  assert.equal(resolved.mode, 'auto');
  assert.equal(resolved.preset, 'hdf5');
});

test('LeRobot directory structure selects LeRobot v2.1', () => {
  const files = [
    file('dataset/meta/info.json'),
    file('dataset/data/chunk-000/episode_000000.parquet'),
    file('dataset/videos/chunk-000/observation.images.head/episode_000000.mp4'),
  ];
  const detected = detectPreset({ type: 'UMI', files, roles: ['meta', 'trajectory', 'media'] });
  assert.equal(detected.preset, 'lerobot-v21');
  assert.equal(detected.confidence, 'high');
});

test('MCAP and generic three-group packages select their matching presets', () => {
  assert.equal(detectPreset({ files: [file('bag/run.mcap')], roles: ['trajectory'] }).preset, 'mcap');
  assert.equal(detectPreset({
    files: [file('pkg/config.yaml'), file('pkg/state.csv'), file('pkg/front.mp4')],
    roles: ['meta', 'trajectory', 'media'],
  }).preset, 'standard-3');
});
