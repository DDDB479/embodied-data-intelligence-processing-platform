const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets', 'extensions.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'extensions.css'), 'utf8');

test('Episode browser renders every external camera in one synchronized grid', () => {
  assert.match(source, /external-multiview-grid/);
  assert.match(source, /data-external-video=/);
  assert.match(source, /episodePreviewToggle/);
  assert.match(source, /episodePreviewSeek/);
  assert.match(source, /episodeVideoViewLabel/);
  assert.match(source, /viewRank=\{head:0,left:1,right:2,fourth:3\}/);
  assert.match(source, /externalVideoRetry/);
  assert.match(source, /episodeFullscreen/);
  assert.match(source, /requestFullscreen/);
  assert.doesNotMatch(source, /episodeVideoSelect/);
  assert.match(styles, /\.external-multiview-grid/);
  assert.match(styles, /\.external-video-card video/);
  assert.match(styles, /\.episode-preview-shell:fullscreen/);
});
