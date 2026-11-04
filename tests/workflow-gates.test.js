const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'serve.js'), 'utf8').replace(/\r\n/g, '\n');
const definitions = source.split('\nensureStorage();\nconst startupState =')[0];
const { bundleGate, exportGate, generateAnnotationTasks, applyAnnotationStandard, annotationGroupList, normalizeExportHistory, buildBundleManifest, mediaViewPolicyForBundle, deriveV6Workflow, purgeAssets } = new Function(
  'require', '__dirname', 'process', 'Buffer',
  `${definitions}\nreturn { bundleGate, exportGate, generateAnnotationTasks, applyAnnotationStandard, annotationGroupList, normalizeExportHistory, buildBundleManifest, mediaViewPolicyForBundle, deriveV6Workflow, purgeAssets };`,
)(require, root, process, Buffer);

function asset(id, role, relativePath) {
  return {
    id, bundleId: 'B-1', bundleName: 'matching_cable8_joint', bundleRole: role,
    relativePath, name: path.basename(relativePath), type: '遥操', status: '已通过',
    inspection: { production: { sha256: id } }, lastQcAt: '2026-10-23T00:00:00.000Z', serverFile: { size: 10, sha256: id },
  };
}

function fixture() {
  return {
    assets: [
      asset('meta', 'meta', 'meta/info.json'),
      asset('trajectory', 'trajectory', 'data/chunk-000/episode_000000.parquet'),
      ...['head', 'left', 'right', 'fourth'].map(view => asset(`video-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000000.mp4`)),
    ],
    annotations: [], annotationStandards: {}, issues: [], bundles: [{ id: 'B-1', status: '已验收', gateVersion: 'episode-v2' }], audit: [],
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

test('without metadata view count is inspected from files, not assumed by data type', () => {
  for (const [type, views] of [['UMI', ['left', 'right']], ['EGO', ['head', 'left', 'right']], ['遥操', ['head']]]) {
    const state = fixture();
    state.assets.forEach(item => { item.type = type; });
    state.assets = state.assets.filter(item => item.bundleRole !== 'media');
    state.assets.push(...views.map(view => asset(`video-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000000.mp4`)));
    const policy = mediaViewPolicyForBundle(state, 'B-1');
    assert.equal(policy.expectedCount, views.length);
    assert.deepEqual(policy.expectedViews, views.map(view => `observation.images.${view}`));
    assert.equal(policy.source, 'observed-files');
  }
});

test('acceptance requires matching video, one approved task instruction and every file to pass QC', () => {
  const state = fixture();
  generateAnnotationTasks(state);
  assert.equal(bundleGate(state, 'B-1').ready, false);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'save', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve', note: '任务指令通过' }, '审核员');
  assert.equal(bundleGate(state, 'B-1').ready, true);
  assert.equal(exportGate(state).annotationPassed, 6);
  assert.deepEqual(exportGate(state).eligible.map(item => item.id).sort(), ['meta', 'trajectory', 'video-fourth', 'video-head', 'video-left', 'video-right']);
  state.assets[2].relativePath = 'videos/episode_000001.mp4';
  assert.equal(bundleGate(state, 'B-1').episodeMediaPending, 1);
  assert.equal(exportGate(state).eligible.length, 0);
  state.assets[2].relativePath = 'videos/episode_000000.mp4';
  state.assets[0].status = '待复核';
  assert.equal(bundleGate(state, 'B-1').ready, false);
  assert.equal(exportGate(state).eligible.length, 0);
});

test('one approved task instruction covers every Episode in the same bundle', () => {
  const state = fixture();
  state.assets.push(
    asset('trajectory-2', 'trajectory', 'data/chunk-000/episode_000001.parquet'),
    ...['head', 'left', 'right', 'fourth'].map(view => asset(`video-2-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000001.mp4`)),
  );
  const created = generateAnnotationTasks(state);
  assert.equal(created.length, 2);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'save', instruction: '把线缆插入卡扣' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '把线缆插入卡扣' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve', note: '任务指令通过' }, '审核员');
  const gate = bundleGate(state, 'B-1');
  assert.equal(gate.annotationPending, 0);
  assert.equal(gate.ready, true);
  assert.ok(state.annotations.every(annotation => annotation.status === '已通过' && annotation.instruction === '把线缆插入卡扣'));
  assert.equal(exportGate(state).eligible.length, 11);
});

test('one acquisition task shares one instruction across multiple bundles', () => {
  const state = { assets: [], annotations: [], annotationStandards: {}, issues: [], bundles: [], tasks: [{ id: 'TASK-1', name: '对接线', type: '遥操', status: '进行中' }], audit: [] };
  for (const [bundleId, suffix] of [['B-1', 'a'], ['B-2', 'b']]) {
    state.assets.push(
      { ...asset(`${bundleId}-meta`, 'meta', 'meta/info.json'), bundleId, bundleName: bundleId, taskId: 'TASK-1' },
      { ...asset(`${bundleId}-trajectory`, 'trajectory', 'data/chunk-000/episode_000000.parquet'), bundleId, bundleName: bundleId, taskId: 'TASK-1' },
      ...['head', 'left', 'right', 'fourth'].map(view => ({ ...asset(`${bundleId}-video-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000000.mp4`), bundleId, bundleName: bundleId, taskId: 'TASK-1' })),
    );
  }
  const created = generateAnnotationTasks(state);
  assert.equal(created.length, 2);
  assert.ok(created.every(item => item.groupKey === 'TASK:TASK-1'));
  assert.equal(annotationGroupList(state)[0].episodeCount, 2);
  applyAnnotationStandard(state, { taskId: 'TASK-1', action: 'save', instruction: '连接对接线' }, '标注员');
  applyAnnotationStandard(state, { taskId: 'TASK-1', action: 'submit', instruction: '连接对接线' }, '标注员');
  applyAnnotationStandard(state, { taskId: 'TASK-1', action: 'approve', note: '任务指令通过' }, '审核员');
  assert.equal(bundleGate(state, 'B-1').ready, true);
  assert.equal(bundleGate(state, 'B-2').ready, true);
  assert.equal(annotationGroupList(state)[0].status, '已通过');
  assert.equal(exportGate(state).annotationPassed, 12);
});

test('legacy acceptance must be resubmitted under the current gate', () => {
  const state = fixture();
  generateAnnotationTasks(state);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'save', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve', note: '任务指令通过' }, '审核员');
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
  assert.equal(state.assets.length, 6);
});

test('export history keeps only one manifest per production batch', () => {
  const state = fixture();
  const assetIds = state.assets.map(item => item.id);
  const normalized = normalizeExportHistory({
    assets: state.assets,
    exports: [
      { id: 'EXP-LATE', assetIds, assetCount: 3, createdAt: '2026-10-30T10:03:35.000Z' },
      { id: 'EXP-FIRST', assetIds, assetCount: 3, createdAt: '2026-10-30T10:02:26.000Z' },
    ],
  });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'EXP-FIRST');
  assert.equal(normalized[0].batchId, 'B-1');
  assert.equal(normalized[0].episodeCount, 1);
  assert.equal(normalized[0].fileCount, 6);
});

test('manifest groups multi-view videos under one logical Episode', () => {
  const state = fixture();
  state.assets = [
    asset('meta', 'meta', 'meta/info.json'),
    asset('trajectory', 'trajectory', 'data/chunk-000/episode_000000.parquet'),
    ...['head', 'left', 'right', 'fourth'].map(view => asset(`video-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000000.mp4`)),
  ];
  generateAnnotationTasks(state);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'save', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve', note: '通过' }, '审核员');
  const built = buildBundleManifest(state, { id: 'EXP-1', name: 'Release', format: 'LeRobot', assetIds: state.assets.map(item => item.id), createdAt: '2026-10-30T00:00:00.000Z' });
  assert.equal(built.manifest.episodeCount, 1);
  assert.equal(built.manifest.fileCount, 6);
  assert.equal(built.manifest.episodes.length, 1);
  assert.equal(built.manifest.episodes[0].videos.length, 4);
  assert.equal(built.annotationLines.length, 1);
});

test('V6 workflow exposes the main pipeline and marks unconnected algorithms honestly', () => {
  const state = fixture();
  generateAnnotationTasks(state);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'save', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve', note: '通过' }, '审核员');
  state.exports = [{ id: 'EXP-1', batchId: 'B-1', assetIds: state.assets.map(item => item.id), lerobotDirectory: 'deliveries/EXP-1/lerobot', lerobotValidation: { ok: true }, createdAt: '2026-10-30T00:00:00.000Z' }];
  const workflow = deriveV6Workflow(state, 'B-1');
  const nodes = workflow.groups.flatMap(group => group.nodes);
  assert.equal(workflow.version, 'V6');
  assert.ok(nodes.some(node => node.id === 'lerobot_v6'));
  assert.ok(nodes.some(node => node.id === 'mcap_conversion'));
  assert.ok(nodes.every(node => node.id !== 'start_dub' && !/^v5/i.test(node.name)));
  assert.equal(nodes.find(node => node.id === 'data_merging').status, 'unavailable');
  assert.equal(nodes.find(node => node.id === 'lerobot_v6').status, 'done');
  assert.ok(workflow.unavailableNodes > 0);
});


test('legacy passed flags without current production evidence cannot pass acceptance', () => {
  const state = fixture();
  generateAnnotationTasks(state);
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'submit', instruction: '插入线缆' }, '标注员');
  applyAnnotationStandard(state, { bundleId: 'B-1', action: 'approve' }, '审核员');
  assert.equal(bundleGate(state, 'B-1').ready, true);
  delete state.assets[0].inspection.production;
  assert.equal(bundleGate(state, 'B-1').ready, false);
  assert.equal(bundleGate(state, 'B-1').productionEvidencePending, 1);
  assert.equal(exportGate(state).eligible.length, 0);
});
