const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanHdf5SequenceRoot, buildSequenceManifest, readSequenceManifest } = require('../tools/hdf5-sequence.cjs');

test('HDF5 frame directories are aggregated into logical episodes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf5-sequence-'));
  try {
    const source = path.join(root, 'matching_cable');
    for (const [episode, count] of [['68', 3], ['69', 2]]) {
      fs.mkdirSync(path.join(source, episode), { recursive: true });
      for (let index = 0; index < count; index++) fs.writeFileSync(path.join(source, episode, `${index}.hdf5`), Buffer.from(`frame-${episode}-${index}`));
    }
    fs.writeFileSync(path.join(source, 'README.txt'), 'ignored');
    const scan = scanHdf5SequenceRoot(source);
    assert.equal(scan.episodeCount, 2);
    assert.equal(scan.fileCount, 5);
    assert.deepEqual(scan.episodes.map(item => item.name), ['68', '69']);
    assert.deepEqual(scan.episodes.map(item => item.fileCount), [3, 2]);
    const manifestPath = path.join(root, 'episode.json');
    const manifest = buildSequenceManifest(scan, scan.episodes[0], { assetId: 'AST-TEST', bundleId: 'BND-TEST' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const loaded = readSequenceManifest(manifestPath);
    assert.equal(loaded.members.length, 3);
    assert.equal(loaded.changed, false);
    assert.match(loaded.members[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(loaded.members[0].absolutePath, /68[\\/]0\.hdf5$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('content hashes change with same size and mtime, and added frames are detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf5-sequence-provenance-'));
  try {
    const episode = path.join(root, '68');
    fs.mkdirSync(episode);
    const frame = path.join(episode, '0.hdf5');
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    fs.writeFileSync(frame, Buffer.alloc(1024, 65));
    fs.utimesSync(frame, fixedTime, fixedTime);
    const before = scanHdf5SequenceRoot(root);
    const manifestPath = path.join(root, 'episode.json');
    fs.writeFileSync(manifestPath, JSON.stringify(buildSequenceManifest(before, before.episodes[0], { assetId: 'A', bundleId: 'B' })));

    fs.writeFileSync(frame, Buffer.alloc(1024, 66));
    fs.utimesSync(frame, fixedTime, fixedTime);
    const afterContentChange = scanHdf5SequenceRoot(root);
    assert.notEqual(afterContentChange.episodes[0].fingerprints, before.episodes[0].fingerprints);

    fs.writeFileSync(path.join(episode, '1.hdf5'), Buffer.alloc(512, 67));
    const loaded = readSequenceManifest(manifestPath);
    assert.equal(loaded.changed, true);
    assert.deepEqual(loaded.extraFiles, ['1.hdf5']);
    assert.equal(loaded.members.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
