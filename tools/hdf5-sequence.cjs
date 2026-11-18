const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HDF5_EXTENSIONS = new Set(['.h5', '.hdf5']);

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function metadataFingerprint(files) {
  return sha256(JSON.stringify(files.map(file => [file.relativePath, file.size, file.mtimeMs])));
}

function sequenceFingerprint(files) {
  if (files.every(file => /^[a-f0-9]{64}$/.test(String(file.sha256 || '')))) {
    return sha256(JSON.stringify(files.map(file => [file.relativePath, file.size, file.sha256])));
  }
  return metadataFingerprint(files);
}

function scanHdf5SequenceRoot(input, options = {}) {
  const normalized = String(input || '').trim().replace(/^["']|["']$/g, '').trim();
  const rootPath = path.resolve(normalized);
  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) throw new Error('服务端数据路径必须是目录');
  const maxFiles = Math.max(1, Math.min(Number(options.maxFiles || 250000), 250000));
  const files = [];

  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => naturalCompare(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !HDF5_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const info = fs.statSync(absolutePath);
      if (!info.isFile() || info.size <= 0) continue;
      files.push({ absolutePath, relativePath: path.relative(rootPath, absolutePath).replaceAll('\\', '/'), size: info.size, mtimeMs: Math.trunc(info.mtimeMs), sha256: sha256File(absolutePath) });
      if (files.length > maxFiles) throw new Error(`目录内 HDF5 文件超过 ${maxFiles} 个，请缩小导入目录`);
    }
  }

  walk(rootPath);
  if (!files.length) throw new Error('目录内没有可导入的 HDF5 文件');
  const grouped = new Map();
  for (const file of files) {
    const parent = path.posix.dirname(file.relativePath);
    const relativePath = parent === '.' ? path.basename(rootPath) : parent;
    if (!grouped.has(relativePath)) grouped.set(relativePath, []);
    grouped.get(relativePath).push(file);
  }
  const episodes = [...grouped.entries()].map(([relativePath, members], index) => {
    members.sort((left, right) => naturalCompare(path.posix.basename(left.relativePath), path.posix.basename(right.relativePath)));
    const prefixed = members.map(member => ({ relativePath: path.posix.relative(relativePath, member.relativePath), size: member.size, mtimeMs: member.mtimeMs, sha256: member.sha256 }));
    return {
      episodeIndex: index,
      relativePath,
      name: path.posix.basename(relativePath),
      directory: path.resolve(rootPath, ...relativePath.split('/')),
      fileCount: members.length,
      totalBytes: members.reduce((sum, member) => sum + member.size, 0),
      firstFile: members[0].relativePath,
      lastFile: members[members.length - 1].relativePath,
      fingerprints: sequenceFingerprint(prefixed),
      metadataFingerprint: metadataFingerprint(prefixed),
      files: members,
    };
  }).sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
  episodes.forEach((episode, index) => { episode.episodeIndex = index; });
  return {
    schemaVersion: 1,
    profile: 'hdf5-frame-sequence-v1',
    rootPath,
    rootName: path.basename(rootPath),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    episodeCount: episodes.length,
    episodes,
  };
}

function buildSequenceManifest(scan, episode, metadata = {}) {
  if (!scan || !episode) throw new Error('缺少 HDF5 序列扫描结果');
  return {
    schemaVersion: 1,
    profile: scan.profile,
    sourceRoot: scan.rootPath,
    relativePath: episode.relativePath,
    directory: episode.directory,
    assetId: metadata.assetId || null,
    bundleId: metadata.bundleId || null,
    episodeIndex: Number(episode.episodeIndex),
    fileCount: Number(episode.fileCount),
    totalBytes: Number(episode.totalBytes),
    fingerprint: episode.fingerprints,
    metadataFingerprint: episode.metadataFingerprint,
    files: episode.files.map(file => ({
      relativePath: path.posix.relative(episode.relativePath, file.relativePath),
      sourceRelativePath: file.relativePath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256 || null,
    })),
  };
}

function readSequenceManifest(manifestPath) {
  const file = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.profile !== 'hdf5-frame-sequence-v1' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('HDF5 序列清单无效');
  const sourceRoot = path.resolve(manifest.sourceRoot);
  const members = manifest.files.map(item => {
    const relativePath = String(item.relativePath || '').replaceAll('\\', '/');
    const sourceRelativePath = String(item.sourceRelativePath || '').replaceAll('\\', '/');
    if (!relativePath || !sourceRelativePath || sourceRelativePath.startsWith('/') || sourceRelativePath.split('/').includes('..')) throw new Error('HDF5 序列清单包含非法路径');
    const absolutePath = path.resolve(sourceRoot, ...sourceRelativePath.split('/'));
    if (!absolutePath.startsWith(sourceRoot + path.sep)) throw new Error('HDF5 序列文件越过源目录');
    if (!fs.existsSync(absolutePath)) throw new Error(`HDF5 序列文件不存在：${sourceRelativePath}`);
    return { ...item, relativePath, sourceRelativePath, absolutePath };
  });
  const episodeDirectory = path.resolve(manifest.directory || members[0].absolutePath);
  if (episodeDirectory !== sourceRoot && !episodeDirectory.startsWith(sourceRoot + path.sep)) throw new Error('HDF5 Episode 目录越过源根目录');
  const expectedNames = new Set(members.map(member => member.relativePath));
  const actual = fs.readdirSync(episodeDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && HDF5_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => {
      const absolutePath = path.join(episodeDirectory, entry.name);
      const stat = fs.statSync(absolutePath);
      return { relativePath: entry.name, absolutePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
    }).filter(file => file.size > 0);
  const actualNames = new Set(actual.map(file => file.relativePath));
  const missingFiles = [...expectedNames].filter(name => !actualNames.has(name));
  const extraFiles = [...actualNames].filter(name => !expectedNames.has(name));
  const actualMetadataFingerprint = metadataFingerprint(actual);
  const expectedMetadataFingerprint = manifest.metadataFingerprint || manifest.fingerprint;
  const changed = missingFiles.length > 0 || extraFiles.length > 0 || actualMetadataFingerprint !== expectedMetadataFingerprint;
  return { ...manifest, sourceRoot, directory: episodeDirectory, file, members, currentFingerprint: changed ? actualMetadataFingerprint : manifest.fingerprint, actualMetadataFingerprint, missingFiles, extraFiles, changed };
}

module.exports = { HDF5_EXTENSIONS, naturalCompare, sha256File, metadataFingerprint, sequenceFingerprint, scanHdf5SequenceRoot, buildSequenceManifest, readSequenceManifest };
