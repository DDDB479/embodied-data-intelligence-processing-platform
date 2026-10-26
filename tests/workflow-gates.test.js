const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'serve.js'), 'utf8');
const definitions = source.split('\nensureStorage();\nconst startupState =')[0];
const { bundleGate, exportGate, generateAnnotationTasks, purgeAssets } = new Function(
  'require', '__dirname', 'process', 'Buffer',
  `${definitions}\nreturn { bundleGate, exportGate, generateAnnotationTasks, purgeAssets };`,
)(require, root, process, Buffer);

function asset(id, role, relativePath) {
  return {
    id, bundleId: 'B-1', bundleName: 'matching_cable8_joint', bundleRole: role,
    relativePath, name: path.basename(relativePath), type: '遥操', status: '已通过',
    lastQcAt: '2026-10-23T00:00:00.000Z', serverFile: { size: 10, sha256: id },
  };
}

function fixture() {
  return {
    assets: [
      asset('meta', 'meta', 'meta/info.json'),
      asset('trajectory', 'trajectory', 'data/chunk-000/episode_000000.parquet'),
      asset('video', 'media', 'videos/chunk-000/episode_000000.mp4'),
    ],
    annotations: [], issues: [], bundles: [{ id: 'B-1', status: '已验收', gateVersion: 'episode-v2' }], audit: [],
  };
}

test('one Episode creates one annotation, with no invented completion', () => {
  const state = fixture();
  const created = generateAnnotationTasks(state);
  assert.equal(created.length, 1);
  assert.equal(created[0].assetId, 'trajectory');
  assert.equal(created[0].progress, 0);
  assert.equal(created[0].status, '待标注');
  assert.equal(generateAnnotationTasks(state).length, 0);
});

test('acceptance requires matching video, approved annotation and every file to pass QC', () => {
  const state = fixture();
  const annotation = generateAnnotationTasks(state)[0];
  assert.equal(bundleGate(state, 'B-1').ready, false);
  annotation.status = '已通过';
  annotation.instruction = '插入线缆';
  annotation.outcome = 'success';
  assert.equal(bundleGate(state, 'B-1').ready, true);
  assert.deepEqual(exportGate(state).eligible.map(item => item.id).sort(), ['meta', 'trajectory', 'video']);
  state.assets[2].relativePath = 'videos/episode_000001.mp4';
  assert.equal(bundleGate(state, 'B-1').episodeMediaPending, 1);
  assert.equal(exportGate(state).eligible.length, 0);
  state.assets[2].relativePath = 'videos/episode_000000.mp4';
  state.assets[0].status = '待复核';
  assert.equal(bundleGate(state, 'B-1').ready, false);
  assert.equal(exportGate(state).eligible.length, 0);
});

test('legacy acceptance must be resubmitted under the current gate', () => {
  const state = fixture();
  const annotation = generateAnnotationTasks(state)[0];
  Object.assign(annotation, { status: '已通过', instruction: '插入线缆', outcome: 'success' });
  state.bundles[0].gateVersion = '';
  assert.equal(bundleGate(state, 'B-1').status, '可提交验收');
  assert.equal(exportGate(state).eligible.length, 0);
  Object.assign(state.bundles[0], { status: '待验收', gateVersion: 'episode-v2' });
  assert.equal(bundleGate(state, 'B-1').status, '待验收');
});

test('assets referenced by a dataset or delivery record cannot be purged', () => {
  const state = fixture();
  state.datasets = [{ id: 'DS-1', assets: [{ id: 'trajectory' }] }];
  state.exports = [];
  assert.throws(() => purgeAssets(state, [state.assets[1]], 'QA'), /不能删除/);
  state.datasets = [];
  state.exports = [{ id: 'EXP-1', assetIds: ['trajectory'] }];
  assert.throws(() => purgeAssets(state, [state.assets[1]], 'QA'), /不能删除/);
  assert.equal(state.assets.length, 3);
});
