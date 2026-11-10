const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const datasetInstruction = 'Connect all matching cable connectors on the table in the order of green, red, and then gray. If a color is not present, skip it and proceed to the next available color. For each available color, mate the matching connectors securely and place the connected pair into the basket. Continue until all connectors on the table have been connected and placed in the basket.';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, method, route, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function asset(id, role, relativePath) {
  return {
    id, bundleId: 'B-ANNOTATION-API', bundleName: 'matching_cable8_joint', bundleRole: role,
    relativePath, name: path.basename(relativePath), type: '遥操', status: '已通过',
    inspection: { production: { sha256: id } }, lastQcAt: '2026-10-23T00:00:00.000Z', serverFile: { storedName: `${id}.bin`, size: 10, sha256: id },
    ...(role === 'trajectory' ? { inspection: { production: { sha256: id }, lerobotSchema: { status: 'verified', issues: [] } } } : {}),
  };
}

test('annotation HTTP API enforces draft, submit and review transitions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-api-test-'));
  const assets = [
    asset('meta', 'meta', 'meta/info.json'),
    asset('trajectory', 'trajectory', 'data/chunk-000/episode_000000.parquet'),
    asset('video-head', 'media', 'videos/chunk-000/observation.images.head/episode_000000.mp4'),
    asset('video-left', 'media', 'videos/chunk-000/observation.images.left/episode_000000.mp4'),
    asset('video-right', 'media', 'videos/chunk-000/observation.images.right/episode_000000.mp4'),
    asset('video-fourth', 'media', 'videos/chunk-000/observation.images.fourth/episode_000000.mp4'),
  ];
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  assets.forEach(item => fs.writeFileSync(path.join(dir, 'uploads', item.serverFile.storedName), 'test file'));
  fs.writeFileSync(path.join(dir, 'uploads', 'meta.bin'), JSON.stringify({
    codebase_version: 'v2.1', fps: 20, robot_type: 'marvin',
    features: Object.fromEntries(['head', 'left', 'right', 'fourth'].map(view => [`observation.images.${view}`, { dtype: 'video', shape: [480, 640, 3] }])),
  }));
  fs.writeFileSync(path.join(dir, 'server-state.json'), JSON.stringify({
    assets,
    annotations: [], issues: [], bundles: [], tasks: [], audit: [],
  }, null, 2));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'serve.js')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_WORK_DIR: dir },
    stdio: 'ignore', windowsHide: true,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await request(port, 'GET', '/health')).status === 200; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated server did not start');
    const setup = await request(port, 'POST', '/api/auth/setup', { name: 'QA', email: 'annotation-qa@example.invalid', password: 'TestPass12345' });
    assert.equal(setup.status, 201);
    assert.ok(setup.body.user.permissions.includes('标注审核'));
    assert.ok(setup.body.user.permissions.includes('标注编辑'));
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const editorMember = await request(port, 'POST', '/api/members', { name: 'Editor', email: 'annotation-editor@example.invalid', role: '质量工程师', domain: '遥操', password: 'EditorPass12345' }, cookie);
    assert.equal(editorMember.status, 201);
    const reviewerMember = await request(port, 'POST', '/api/members', { name: 'Reviewer', email: 'annotation-reviewer@example.invalid', role: '标注审核员', domain: '遥操', password: 'ReviewerPass12345' }, cookie);
    assert.equal(reviewerMember.status, 201);
    const editorLogin = await request(port, 'POST', '/api/auth/login', { email: 'annotation-editor@example.invalid', password: 'EditorPass12345' });
    assert.equal(editorLogin.status, 200);
    const editorCookie = editorLogin.headers['set-cookie'][0].split(';')[0];
    const reviewerLogin = await request(port, 'POST', '/api/auth/login', { email: 'annotation-reviewer@example.invalid', password: 'ReviewerPass12345' });
    assert.equal(reviewerLogin.status, 200);
    const reviewerCookie = reviewerLogin.headers['set-cookie'][0].split(';')[0];
    const generated = await request(port, 'POST', '/api/annotations/generate', {}, cookie);
    assert.equal(generated.status, 201);
    assert.equal(generated.body.annotations.length, 1);
    const annotation = generated.body.annotations[0];
    assert.equal(annotation.status, '待标注');

    const exceptionReview = await request(port, 'POST', '/api/exceptions/review', { assetId: 'trajectory', decision: 'blocked', note: '确认缺帧，需要补采', tags: ['复采'] }, reviewerCookie);
    assert.equal(exceptionReview.status, 200);
    assert.equal(exceptionReview.body.review.assetId, 'trajectory');
    assert.equal(exceptionReview.body.review.reviewStatus, '确认异常');
    assert.deepEqual(exceptionReview.body.review.tags, ['复采']);
    const stateAfterReview = await request(port, 'GET', '/api/state', null, reviewerCookie);
    assert.equal(stateAfterReview.status, 200);
    assert.equal(stateAfterReview.body.exceptionReviews.length, 1);
    assert.equal(stateAfterReview.body.exceptionReviews[0].reviewedBy, 'Reviewer');

    const reviewerStandard = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'save', instruction: datasetInstruction }, reviewerCookie);
    assert.equal(reviewerStandard.status, 403);

    const standardized = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'save', instruction: datasetInstruction }, editorCookie);
    assert.equal(standardized.status, 200);
    assert.equal(standardized.body.updated, 1);
    assert.equal(standardized.body.annotationStandards[annotation.bundleId].instruction, datasetInstruction);
    assert.equal(standardized.body.annotationStandards[annotation.bundleId].status, '标注中');
    assert.equal(standardized.body.annotationGroups.length, 1);
    assert.equal(standardized.body.annotationGroups[0].episodeCount, 1);
    assert.equal(standardized.body.annotations[0].status, '标注中');
    assert.equal(standardized.body.annotations[0].instruction, datasetInstruction);

    const reviewerBatch = await request(port, 'POST', '/api/annotations/batch', { groupKeys: [annotation.bundleId] }, reviewerCookie);
    assert.equal(reviewerBatch.status, 403);
    const submitted = await request(port, 'POST', '/api/annotations/batch', { groupKeys: [annotation.bundleId] }, editorCookie);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.submitted.length, 1);
    assert.equal(submitted.body.skipped.length, 0);
    assert.equal(submitted.body.annotationStandards[annotation.bundleId].status, '待审核');
    assert.equal(submitted.body.annotations[0].status, '待审核');

    const editorApprove = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'approve', note: '自行通过', instruction: datasetInstruction }, editorCookie);
    assert.equal(editorApprove.status, 403);

    const reviewerEdit = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'save', instruction: '审核人改写' }, reviewerCookie);
    assert.equal(reviewerEdit.status, 403);

    const tampered = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'approve', note: '复核通过', instruction: '审核人改写' }, reviewerCookie);
    assert.equal(tampered.status, 400);
    assert.match(tampered.body.error, /不能修改任务指令/);

    const approved = await request(port, 'POST', '/api/annotations/standard', { bundleId: annotation.bundleId, action: 'approve', note: '复核通过', instruction: datasetInstruction }, reviewerCookie);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.standard.status, '已通过');
    assert.equal(approved.body.annotations[0].status, '已通过');
    assert.equal(approved.body.annotations[0].reviewer, 'Reviewer');
    assert.equal(approved.body.annotations[0].instruction, datasetInstruction);
    assert.deepEqual(approved.body.annotations[0].segments, []);

    const submittedBundle = await request(port, 'POST', '/api/bundles/status', { id: annotation.bundleId, status: '待验收', note: '任务指令已审核' }, cookie);
    assert.equal(submittedBundle.status, 200);
    const acceptedBundle = await request(port, 'POST', '/api/bundles/status', { id: annotation.bundleId, status: '已验收', note: '验收通过' }, cookie);
    assert.equal(acceptedBundle.status, 200);
    assert.equal(acceptedBundle.body.bundle.status, '已验收');
    const repeatedSubmit = await request(port, 'POST', '/api/bundles/status', { id: annotation.bundleId, status: '待验收', note: '重复提交' }, cookie);
    assert.equal(repeatedSubmit.status, 409);
    assert.match(repeatedSubmit.body.error, /不能从“已验收”/);
    const repeatedAccept = await request(port, 'POST', '/api/bundles/status', { id: annotation.bundleId, status: '已验收', note: '重复签署' }, cookie);
    assert.equal(repeatedAccept.status, 409);

    const exported = await request(port, 'POST', '/api/exports', { name: 'Task-Instruction-Release', format: 'LeRobot', contents: ['原始文件', '质量报告', '标注清单'] }, cookie);
    assert.equal(exported.status, 201);
    assert.equal(exported.body.job.annotationCount, 1);
    assert.equal(exported.body.job.episodeCount, 1);
    assert.equal(exported.body.job.fileCount, 6);
    assert.equal(fs.existsSync(exported.body.job.lerobotDirectory), true);
    assert.equal(fs.existsSync(path.join(exported.body.job.lerobotDirectory, 'meta', 'info.json')), true);
    assert.equal(fs.readdirSync(path.join(exported.body.job.lerobotDirectory, 'videos', 'chunk-000'), { recursive: true }).filter(name => String(name).endsWith('.mp4')).length, 4);
    const manifestFile = fs.readdirSync(path.join(dir, 'exports')).find(name => name.startsWith(exported.body.job.id) && name.endsWith('.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'exports', manifestFile), 'utf8'));
    assert.equal(manifest.schemaVersion, '1.3');
    assert.equal(manifest.targetFormat, 'LeRobot v2.1');
    assert.equal(manifest.lerobot.validation.ok, true);
    assert.equal(manifest.episodeCount, 1);
    assert.equal(manifest.fileCount, 6);
    assert.equal(manifest.episodes.length, 1);
    assert.equal(manifest.episodes[0].videos.length, 4);
    const duplicate = await request(port, 'POST', '/api/exports', { name: 'Duplicate', format: 'LeRobot', contents: ['原始文件', '质量报告', '标注清单'] }, cookie);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.job.id, exported.body.job.id);
    assert.equal(duplicate.body.exports.length, 1);
    const annotationFile = fs.readdirSync(path.join(dir, 'exports')).find(name => name.endsWith('-annotations.jsonl'));
    assert.ok(annotationFile, 'task-level annotation JSONL was not generated');
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'exports', annotationFile), 'utf8').trim());
    assert.equal(record.instruction, datasetInstruction);
    assert.equal(record.episode_index, 0);
    assert.equal(record.outcome, null);
    assert.deepEqual(record.segments, []);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
