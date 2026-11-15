const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'serve.js'), 'utf8').replace(/\r\n/g, '\n');
const definitions = source.split('\nensureStorage();')[0];
const { bundleGate, bundleRequiredRoles, exportGate, runQc, generateAnnotationTasks, applyAnnotationStandard, annotationGroupList, normalizeExportHistory, buildBundleManifest, mediaViewPolicyForBundle, deriveV6Workflow, purgeAssets, assetFolderKey, parseAnnotationImportSources, applyImportedAnnotationEntries, compactStateCollections, productionInspectionContext } = new Function(
  'require', '__dirname', 'process', 'Buffer',
  `${definitions}\nreturn { bundleGate, bundleRequiredRoles, exportGate, runQc, generateAnnotationTasks, applyAnnotationStandard, annotationGroupList, normalizeExportHistory, buildBundleManifest, mediaViewPolicyForBundle, deriveV6Workflow, purgeAssets, assetFolderKey, parseAnnotationImportSources, applyImportedAnnotationEntries, compactStateCollections, productionInspectionContext };`,
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

test('HDF5 and single-format packages use preset-specific required groups', () => {
  const state = fixture();
  state.assets = [{ ...asset('hdf5-trajectory', 'trajectory', 'teleop/episode_000.hdf5'), bundleId: 'B-HDF5', bundleName: 'teleop-hdf5', bundlePreset: 'hdf5' }];
  state.bundles = [{ id: 'B-HDF5', status: '待验收', gateVersion: 'episode-v2' }];
  assert.deepEqual(bundleRequiredRoles(state.assets), ['trajectory']);
  const gate = bundleGate(state, 'B-HDF5');
  assert.equal(gate.complete, true);
  assert.equal(gate.uploadComplete, true);
  assert.equal(gate.ready, true);
  assert.equal(gate.episodeCount, 0);
  assert.equal(gate.dataRecordCount, 1);
});

test('HDF5 sequence QC keeps the selected episode scope', () => {
  const state = fixture();
  const first = { ...asset('sequence-68', 'trajectory', 'matching_cable/68'), bundleId: 'B-SEQUENCE', bundleName: 'matching-cable', bundlePreset: 'hdf5-sequence', format: 'HDF5_SEQUENCE', episodeIndex: 0, serverFile: { mode: 'external-hdf5-sequence', size: 100, sha256: 'seq-68' } };
  const second = { ...asset('sequence-69', 'trajectory', 'matching_cable/69'), bundleId: 'B-SEQUENCE', bundleName: 'matching-cable', bundlePreset: 'hdf5-sequence', format: 'HDF5_SEQUENCE', episodeIndex: 1, serverFile: { mode: 'external-hdf5-sequence', size: 100, sha256: 'seq-69' } };
  state.assets = [first, second];
  assert.deepEqual(productionInspectionContext(state, [first]).map(item => item.id), ['sequence-68']);
});

test('quality checks are blocked until every registered original file is uploaded', () => {
  const state = fixture();
  delete state.assets.find(item => item.id === 'video-left').serverFile;
  assert.throws(() => runQc(state, { scope: '全部数据', targetIds: state.assets.map(item => item.id) }), /尚未全部上传完成/);
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

test('existing annotations jsonl auto-approves each Episode and preserves different instructions', () => {
  const state = fixture();
  state.assets.push(
    asset('trajectory-2', 'trajectory', 'data/chunk-000/episode_000001.parquet'),
    asset('video-2', 'media', 'videos/chunk-000/observation.images.head/episode_000001.mp4'),
  );
  generateAnnotationTasks(state);
  const analysis = parseAnnotationImportSources({
    episodeIndices: [0, 1],
    sources: [{
      assetId: 'annotations', relativePath: 'annotations.jsonl', kind: 'annotations', sha256: 'annotation-source-hash',
      text: [
        JSON.stringify({ episode_index: 0, instruction: '插入红色连接器' }),
        JSON.stringify({ episode_index: 1, instruction: '把蓝色连接器放入料盒' }),
      ].join('\n'),
    }],
  });
  assert.equal(analysis.entries.length, 2);
  applyImportedAnnotationEntries(state, 'B-1', analysis.entries, { importedAt: '2026-11-13T00:00:00.000Z' });
  assert.ok(state.annotations.every(annotation => annotation.autoImported === true && annotation.status === '已通过'));
  const group = annotationGroupList(state).find(item => item.key === 'B-1');
  assert.equal(group.status, '已通过');
  assert.equal(group.autoImported, true);
  assert.equal(group.instructionCount, 2);
  assert.equal(bundleGate(state, 'B-1').annotationPending, 0);
  const built = buildBundleManifest(state, { id: 'EXP-AUTO', name: 'Auto', assetIds: state.assets.map(item => item.id) });
  assert.deepEqual(built.annotationLines.map(line => JSON.parse(line).instruction).sort(), ['插入红色连接器', '把蓝色连接器放入料盒'].sort());
});

test('partial annotation source leaves only uncovered Episodes in manual queue', () => {
  const state = fixture();
  state.assets.push(
    asset('trajectory-2', 'trajectory', 'data/chunk-000/episode_000001.parquet'),
    asset('video-2', 'media', 'videos/chunk-000/observation.images.head/episode_000001.mp4'),
  );
  generateAnnotationTasks(state);
  const analysis = parseAnnotationImportSources({
    episodeIndices: [0, 1],
    sources: [{ assetId: 'annotations', relativePath: 'meta/annotations.jsonl', kind: 'annotations', text: JSON.stringify({ episode_index: 0, instruction: '抓取零件' }) }],
  });
  applyImportedAnnotationEntries(state, 'B-1', analysis.entries, { importedAt: '2026-11-13T00:00:00.000Z' });
  const group = annotationGroupList(state).find(item => item.key === 'B-1');
  assert.equal(group.status, '标注中');
  assert.equal(group.autoImported, true);
  assert.equal(bundleGate(state, 'B-1').annotationPending, 1);
  assert.equal(state.annotations.filter(annotation => annotation.status === '待标注').length, 1);
});

test('malformed annotation jsonl is reported and never auto-approved', () => {
  const analysis = parseAnnotationImportSources({
    episodeIndices: [0],
    sources: [{ assetId: 'annotations', relativePath: 'annotations.jsonl', kind: 'annotations', text: '{"episode_index":0,"instruction":"valid"}\nnot-json' }],
  });
  assert.equal(analysis.entries.length, 0);
  assert.ok(analysis.errors.some(item => /第 2 行/.test(item.error)));
  const state = fixture();
  generateAnnotationTasks(state);
  applyImportedAnnotationEntries(state, 'B-1', analysis.entries, { importedAt: '2026-11-13T00:00:00.000Z' });
  assert.equal(state.annotations[0].status, '待标注');
  assert.equal(state.annotations[0].autoImported, undefined);
});

test('conflicting instructions for the same Episode are reported as source errors', () => {
  const analysis = parseAnnotationImportSources({
    episodeIndices: [0],
    sources: [{ assetId: 'annotations', relativePath: 'annotations.jsonl', kind: 'annotations', text: [
      JSON.stringify({ episode_index: 0, instruction: '抓取红色零件' }),
      JSON.stringify({ episode_index: 0, instruction: '抓取蓝色零件' }),
    ].join('\n') }],
  });
  assert.equal(analysis.entries.length, 1);
  assert.ok(analysis.errors.some(item => /冲突指令/.test(item.error)));
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

test('asset folder keys support deleting a selected source folder', () => {
  assert.equal(assetFolderKey({ sourceRoot: 'matching_cable', sourceFolder: 'left', relativePath: 'matching_cable/left/episode_000.h5' }), 'matching_cable/left');
  assert.equal(assetFolderKey({ relativePath: 'dataset/data/chunk-000/episode_000000.parquet' }), 'dataset/data/chunk-000');
});

test('closed issue history and oversized QC results are compacted', () => {
  const state = {
    issues: Array.from({ length: 1500 }, (_, index) => ({ id: `I-${index}`, status: '已关闭', closedAt: new Date(2026, 0, 1, 0, 0, index).toISOString() })),
    qcBatches: [{ id: 'latest', total: 400, results: Array.from({ length: 400 }, (_, index) => ({ assetId: `A-${index}` })) }, { id: 'old', total: 100, results: Array.from({ length: 100 }, (_, index) => ({ assetId: `B-${index}` })) }],
    issueHistorySummary: { archivedCount: 20 },
  };
  assert.equal(compactStateCollections(state), true);
  assert.equal(state.issues.length, 1000);
  assert.equal(state.issueHistorySummary.archivedCount, 520);
  assert.equal(state.qcBatches[0].results.length, 300);
  assert.equal(state.qcBatches[1].results.length, 50);
  assert.equal(state.qcBatches[0].resultsCompacted, true);
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
