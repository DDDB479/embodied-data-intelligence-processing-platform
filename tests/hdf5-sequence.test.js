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
    assert.match(loaded.members[0].absolutePath, /68[\\/]0\.hdf5$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
