const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UMI_PROFILE = 'umi-session-v1';
const REQUIRED_FILES = {
  metadata: 'single_hand/Metadata/metadata.json',
  uiMetadata: 'Metadata/ui_backend_metadata.json',
  pcMetadata: 'single_hand/Metadata/pc_metadata.json',
  jointMetadata: 'single_hand/Metadata/pc_joint_metadata.json',
  video: 'single_hand/RGB_Images/video.mp4',
  rgbTimestamps: 'single_hand/RGB_Images/timestamps.csv',
  trajectory: 'single_hand/Merged_Trajectory/merged_trajectory.txt',
  vive: 'single_hand/Merged_Trajectory/vut_raw.csv',
  clamp: 'single_hand/Clamp_Data/clamp_timebase.csv',
  clampTum: 'single_hand/Clamp_Data/clamp_data_tum.txt',
};

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeRelative(value) {
  return String(value || '').replaceAll('\\', '/');
}

function fingerprint(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files.map(file => [file.relativePath, file.size, file.mtimeMs]))).digest('hex');
}

function fileRole(relativePath) {
  const value = relativePath.toLowerCase();
  if (value.endsWith('/metadata.json') || value.includes('/metadata/') || value.includes('/meta/')) return 'meta';
  if (value.endsWith('.mp4') || value.endsWith('.png') || value.includes('/rgb_images/')) return 'media';
  return 'trajectory';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function countCsvRows(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(line => line.trim());
  return Math.max(0, lines.length - 1);
}

function inspectSession(directory) {
  const sourceDirectory = path.resolve(directory), singleHand = path.join(sourceDirectory, 'single_hand');
  if (!fs.statSync(sourceDirectory, { throwIfNoEntry: false })?.isDirectory() || !fs.statSync(singleHand, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`UMI session is missing single_hand: ${sourceDirectory}`);
  }
  const required = {};
  for (const [role, relativePath] of Object.entries(REQUIRED_FILES)) {
    const absolutePath = path.join(sourceDirectory, ...relativePath.split('/'));
    if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`UMI session is missing ${relativePath}: ${sourceDirectory}`);
    required[role] = absolutePath;
  }
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => naturalCompare(left.name, right.name))) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(absolutePath), relativePath = normalizeRelative(path.relative(sourceDirectory, absolutePath));
      files.push({ relativePath, sourceRelativePath: relativePath, absolutePath, role: fileRole(relativePath), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
    }
  }
  walk(sourceDirectory);
  const metadata = readJson(required.metadata), ui = readJson(required.uiMetadata);
  const taskName = String(ui.task_name || metadata?.config?.project_config_snapshot?.capture?.task_name || '').trim();
  return {
    name: path.basename(sourceDirectory),
    sessionId: String(ui.session_id || metadata?.config?.session_id || path.basename(sourceDirectory)),
    directory: sourceDirectory,
    relativePath: path.basename(sourceDirectory),
    taskName,
    handMode: String(ui.hand_mode || 'single'),
    qualityStatus: String(ui.quality_status || ''),
    canProcess: ui.can_process === true,
    captureStatus: String(ui.capture_status || ''),
    frameCount: countCsvRows(required.rgbTimestamps),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    fingerprint: fingerprint(files),
    required,
    files,
  };
}

function scanUmiRoot(input) {
  const rootPath = path.resolve(String(input || '').trim()), rootStat = fs.statSync(rootPath, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) throw new Error('UMI server directory does not exist');
  const candidates = fs.statSync(path.join(rootPath, 'single_hand'), { throwIfNoEntry: false })?.isDirectory()
    ? [rootPath]
    : fs.readdirSync(rootPath, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(rootPath, entry.name)).filter(directory => fs.statSync(path.join(directory, 'single_hand'), { throwIfNoEntry: false })?.isDirectory());
  if (!candidates.length) throw new Error('No UMI session directories found');
  const sessions = candidates.sort(naturalCompare).map(inspectSession);
  return {
    schemaVersion: 1,
    profile: UMI_PROFILE,
    rootPath,
    rootName: path.basename(rootPath),
    sessionCount: sessions.length,
    episodeCount: sessions.length,
    fileCount: sessions.reduce((sum, session) => sum + session.fileCount, 0),
    totalBytes: sessions.reduce((sum, session) => sum + session.totalBytes, 0),
    frameCount: sessions.reduce((sum, session) => sum + session.frameCount, 0),
    sessions,
  };
}

function buildUmiManifest(scan, session, metadata = {}) {
  return {
    schemaVersion: 1,
    profile: scan.profile,
    sourceRoot: scan.rootPath,
    sessionId: session.sessionId,
    relativePath: session.relativePath,
    directory: session.directory,
    assetId: metadata.assetId || null,
    bundleId: metadata.bundleId || null,
    episodeIndex: Number(session.episodeIndex || 0),
    taskName: session.taskName,
    qualityStatus: session.qualityStatus,
    canProcess: session.canProcess,
    captureStatus: session.captureStatus,
    frameCount: session.frameCount,
    fileCount: session.fileCount,
    totalBytes: session.totalBytes,
    fingerprint: session.fingerprint,
    required: Object.fromEntries(Object.entries(session.required).map(([role, file]) => [role, normalizeRelative(path.relative(scan.rootPath, file))])),
    files: session.files.map(file => ({ relativePath: file.relativePath, sourceRelativePath: normalizeRelative(path.relative(scan.rootPath, file.absolutePath)), role: file.role, size: file.size, mtimeMs: file.mtimeMs })),
  };
}

function readUmiManifest(manifestPath) {
  const file = path.resolve(manifestPath), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.profile !== UMI_PROFILE || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('UMI session manifest is invalid');
  const sourceRoot = path.resolve(manifest.sourceRoot), members = manifest.files.map(item => {
    const sourceRelativePath = normalizeRelative(item.sourceRelativePath || item.relativePath);
    if (!sourceRelativePath || sourceRelativePath.startsWith('/') || sourceRelativePath.split('/').includes('..')) throw new Error('UMI manifest contains an invalid path');
    const absolutePath = path.resolve(sourceRoot, ...sourceRelativePath.split('/'));
    if (!absolutePath.startsWith(sourceRoot + path.sep) || !fs.existsSync(absolutePath)) throw new Error(`UMI source file is missing: ${sourceRelativePath}`);
    const stat = fs.statSync(absolutePath);
    return { ...item, absolutePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  });
  const currentFingerprint = fingerprint(members.map(item => ({ relativePath: item.relativePath, size: item.size, mtimeMs: item.mtimeMs })));
  const required = Object.fromEntries(Object.entries(manifest.required || {}).map(([role, relativePath]) => [role, path.resolve(sourceRoot, ...normalizeRelative(relativePath).split('/'))]));
  return { ...manifest, sourceRoot, file, members, required, currentFingerprint, changed: currentFingerprint !== manifest.fingerprint };
}

module.exports = { UMI_PROFILE, REQUIRED_FILES, naturalCompare, scanUmiRoot, buildUmiManifest, readUmiManifest };
