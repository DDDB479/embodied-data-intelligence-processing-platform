const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'serve.js'), 'utf8').replace(/\r\n/g, '\n');
const definitions = source.split('\nensureStorage();\nconst startupState =')[0];
const { annotationApproved, applyAnnotationUpdate, applyAnnotationStandard, submitAnnotationStandards, annotationGroupEpisodeStats, annotationGroupFlow, annotationGroupSignals, bundleGate, generateAnnotationTasks, ROLE_POLICIES, ALL_PERMISSIONS } = new Function(
  'require', '__dirname', 'process', 'Buffer',
  `${definitions}\nreturn { annotationApproved, applyAnnotationUpdate, applyAnnotationStandard, submitAnnotationStandards, annotationGroupEpisodeStats, annotationGroupFlow, annotationGroupSignals, bundleGate, generateAnnotationTasks, ROLE_POLICIES, ALL_PERMISSIONS };`,
)(require, root, process, Buffer);

function asset(id, role, relativePath) {
  return {
    id, bundleId: 'B-ANNOTATION', bundleName: 'matching_cable8_joint', bundleRole: role,
    relativePath, name: path.basename(relativePath), type: '遥操', status: '已通过',
    inspection: { production: { sha256: id } }, lastQcAt: '2026-10-23T00:00:00.000Z', serverFile: { size: 10, sha256: id },
  };
}

function fixture() {
  const state = {
    assets: [
      asset('meta', 'meta', 'meta/info.json'),
      asset('trajectory', 'trajectory', 'data/chunk-000/episode_000000.parquet'),
      ...['head', 'left', 'right', 'fourth'].map(view => asset(`video-${view}`, 'media', `videos/chunk-000/observation.images.${view}/episode_000000.mp4`)),
    ],
    annotations: [], issues: [], bundles: [], audit: [],
  };
  return { state, annotation: generateAnnotationTasks(state, '系统')[0] };
}

const completeFields = {
  instruction: '把线缆插入右侧卡扣并闭合',
  outcome: 'success',
  segments: [{ startFrame: 0, endFrame: 30, skill: '抓取', object: '线缆' }],
};

const datasetInstruction = 'Connect all matching cable connectors on the table in the order of green, red, and then gray. If a color is not present, skip it and proceed to the next available color. For each available color, mate the matching connectors securely and place the connected pair into the basket. Continue until all connectors on the table have been connected and placed in the basket.';

test('data governance lead explicitly owns every permission including annotation review', () => {
  assert.deepEqual(ROLE_POLICIES['数据治理负责人'], ALL_PERMISSIONS);
  assert.ok(ALL_PERMISSIONS.includes('标注审核'));
  assert.ok(ALL_PERMISSIONS.includes('标注编辑'));
  assert.ok(ALL_PERMISSIONS.includes('平台设置'));
});

test('one task instruction is reviewed once and inherited by its Episode', () => {
  const { state, annotation } = fixture();
  assert.equal(annotation.status, '待标注');
  assert.equal(annotation.progress, 0);

  applyAnnotationStandard(state, { bundleId: annotation.bundleId, action: 'save', instruction: datasetInstruction }, '标注员甲');
  assert.equal(annotation.status, '标注中');
  assert.equal(annotation.progress, 40);
  assert.equal(annotation.instruction, datasetInstruction);

  applyAnnotationStandard(state, { bundleId: annotation.bundleId, action: 'submit', instruction: datasetInstruction }, '标注员甲');
  assert.equal(annotation.status, '待审核');
  assert.equal(state.annotationStandards[annotation.bundleId].status, '待审核');
  assert.equal(bundleGate(state, 'B-ANNOTATION').ready, false);

  applyAnnotationStandard(state, { bundleId: annotation.bundleId, action: 'approve', note: '任务指令复核通过' }, '审核员乙');
  assert.equal(annotation.status, '已通过');
  assert.equal(annotation.progress, 100);
  assert.equal(annotation.reviewer, '审核员乙');
  assert.equal(state.annotationStandards[annotation.bundleId].status, '已通过');
  assert.equal(bundleGate(state, 'B-ANNOTATION').ready, true);
});

test('rejected annotations require a review reason and can be corrected and resubmitted', () => {
  const { state, annotation } = fixture();
  applyAnnotationUpdate(state, { id: annotation.id, action: 'submit', ...completeFields }, '标注员甲');
  assert.throws(() => applyAnnotationUpdate(state, { id: annotation.id, action: 'reject', note: '' }, '审核员乙'), /审核意见/);

  applyAnnotationUpdate(state, { id: annotation.id, action: 'reject', note: '动作分段边界不准确' }, '审核员乙');
  assert.equal(annotation.status, '已驳回');
  assert.equal(annotation.note, '动作分段边界不准确');
  assert.equal(annotation.reviewer, '审核员乙');

  applyAnnotationUpdate(state, { id: annotation.id, action: 'save', ...completeFields, segments: [{ startFrame: 0, endFrame: 45, skill: '抓取', object: '线缆' }] }, '标注员甲');
  assert.equal(annotation.status, '标注中');
  assert.equal(annotation.reviewer, '');
  assert.equal(annotation.segments[0].endFrame, 45);
});

test('failure reasons, segment order and overlapping segments are validated', () => {
  const { state, annotation } = fixture();
  assert.throws(() => applyAnnotationUpdate(state, { id: annotation.id, action: 'submit', instruction: '插入线缆', outcome: 'failure', failureReason: '', segments: completeFields.segments }, '标注员甲'), /失败原因/);
  assert.throws(() => applyAnnotationUpdate(state, { id: annotation.id, action: 'save', instruction: '插入线缆', outcome: 'success', segments: [{ startFrame: 20, endFrame: 10, skill: '抓取' }] }, '标注员甲'), /结束帧必须大于开始帧/);
  assert.throws(() => applyAnnotationUpdate(state, { id: annotation.id, action: 'save', instruction: '插入线缆', outcome: 'success', segments: [{ startFrame: 0, endFrame: 30, skill: '抓取' }, { startFrame: 20, endFrame: 40, skill: '插入' }] }, '标注员甲'), /存在重叠/);
});

test('approval only records the review note and cannot rewrite submitted content', () => {
  const { state, annotation } = fixture();
  applyAnnotationUpdate(state, { id: annotation.id, action: 'submit', ...completeFields }, '标注员甲');
  const snapshot = JSON.stringify({ instruction: annotation.instruction, outcome: annotation.outcome, segments: annotation.segments });

  assert.throws(() => applyAnnotationUpdate(state, {
    id: annotation.id, action: 'approve', note: '复核通过', instruction: '审核人改写', segments: [],
  }, '审核员乙'), /只接受审核意见/);
  assert.equal(annotation.status, '待审核');
  assert.equal(JSON.stringify({ instruction: annotation.instruction, outcome: annotation.outcome, segments: annotation.segments }), snapshot);

  applyAnnotationUpdate(state, { id: annotation.id, action: 'approve', note: '证据与分段一致' }, '审核员乙');
  assert.equal(annotation.status, '已通过');
  assert.equal(annotation.note, '证据与分段一致');
  assert.equal(JSON.stringify({ instruction: annotation.instruction, outcome: annotation.outcome, segments: annotation.segments }), snapshot);
});

test('approval rejects incomplete evidence already stored in the task', () => {
  const { state, annotation } = fixture();
  applyAnnotationUpdate(state, { id: annotation.id, action: 'submit', ...completeFields }, '标注员甲');
  annotation.segments = [];

  assert.throws(() => applyAnnotationUpdate(state, { id: annotation.id, action: 'approve', note: '复核通过' }, '审核员乙'), /证据不完整.*动作分段/);
  assert.equal(annotation.status, '待审核');
  assert.equal(annotationApproved(annotation), false);
});

test('dataset standard instruction is inherited and cannot be overridden per episode', () => {
  const { state, annotation } = fixture();
  const applied = applyAnnotationStandard(state, { bundleId: 'B-ANNOTATION', instruction: datasetInstruction }, '管理员');
  assert.equal(applied.updated, 1);
  assert.equal(annotation.status, '标注中');
  assert.equal(annotation.progress, 40);
  assert.equal(annotation.instruction, datasetInstruction);
  assert.equal(annotation.history.at(-1).action, 'standardize');

  applyAnnotationUpdate(state, {
    id: annotation.id, action: 'save', instruction: '单集擅自改写', outcome: 'success', segments: completeFields.segments,
  }, '标注员甲');
  assert.equal(annotation.instruction, datasetInstruction);

  state.annotations = [];
  const created = generateAnnotationTasks(state, '系统');
  assert.equal(created.length, 1);
  assert.equal(created[0].status, '标注中');
  assert.equal(created[0].progress, 40);
  assert.equal(created[0].instruction, datasetInstruction);
});

test('batch submission skips incomplete or non-editable ranges and reports stats', () => {
  const { state, annotation } = fixture();
  const empty = submitAnnotationStandards(state, { groupKeys: ['B-ANNOTATION', 'B-MISSING'] }, '标注员甲');
  assert.equal(empty.submitted.length, 0);
  assert.equal(empty.skipped.length, 2);
  assert.match(empty.skipped.find(item => item.key === 'B-ANNOTATION').reason, /尚未填写/);

  applyAnnotationStandard(state, { bundleId: 'B-ANNOTATION', instruction: datasetInstruction }, '标注员甲');
  const submitted = submitAnnotationStandards(state, { groupKeys: ['B-ANNOTATION'] }, '标注员甲');
  assert.equal(submitted.submitted.length, 1);
  assert.equal(submitted.skipped.length, 0);
  assert.equal(annotation.status, '待审核');

  state.assets = state.assets.filter(item => item.bundleRole !== 'media');
  const stats = annotationGroupEpisodeStats(state, 'B-ANNOTATION');
  assert.equal(stats.episodeCount, 1);
  assert.equal(stats.videoCovered, 0);
  assert.equal(stats.missingVideoCount, 1);
});

test('dataset queue signals expose format flow and the first blocking reason', () => {
  const { state, annotation } = fixture();
  applyAnnotationStandard(state, { bundleId: 'B-ANNOTATION', instruction: datasetInstruction }, '标注员甲');
  state.assets.find(item => item.id === 'trajectory').format = 'HDF5';
  const flow = annotationGroupFlow(state, 'B-ANNOTATION');
  assert.deepEqual(flow.sourceFormats, ['HDF5']);
  assert.equal(flow.delivery, '未生成');
  const signals = annotationGroupSignals(state, 'B-ANNOTATION', annotationGroupEpisodeStats(state, 'B-ANNOTATION'), state.annotationStandards['B-ANNOTATION']);
  assert.equal(signals[0].key, 'standard');
  assert.ok(signals.some(item => item.key === 'delivery'));
});
