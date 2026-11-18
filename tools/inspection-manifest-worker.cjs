const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const hdf5Sequence = require(path.join(__dirname, 'hdf5-sequence.cjs'));
const umiData = require(path.join(__dirname, 'umi-data.cjs'));

try {
  const assets = Array.isArray(workerData?.assets) ? workerData.assets : [];
  const uploadDir = String(workerData?.uploadDir || '');
  const manifestFile = String(workerData?.manifestFile || '');
  const settings = workerData?.settings || {};
  const inspectionAssets = [];
  const fingerprints = {};
  const frames = [];

  assets.forEach((asset, index) => {
    const storedName = String(asset.serverFile?.storedName || '');
    const sourcePath = storedName ? path.join(uploadDir, storedName) : '';
    if (asset.format === 'HDF5_SEQUENCE' || asset.serverFile?.mode === 'external-hdf5-sequence') {
      const sequence = hdf5Sequence.readSequenceManifest(sourcePath);
      if (sequence.changed) {
        const changes = [...sequence.missingFiles.map(name => `缺失 ${name}`), ...sequence.extraFiles.map(name => `新增 ${name}`)];
        throw new Error(`HDF5 Episode ${asset.relativePath || asset.name} 文件集合或元数据已变化${changes.length ? `：${changes.slice(0, 10).join('、')}` : ''}`);
      }
      if (sequence.members.some(member => !/^[a-f0-9]{64}$/.test(String(member.sha256 || '')))) throw new Error(`HDF5 Episode ${asset.relativePath || asset.name} 的旧清单缺少逐文件 SHA-256，请重新导入该批次`);
      fingerprints[asset.id] = sequence.currentFingerprint;
      frames.push({ id: asset.id, count: sequence.members.length });
      inspectionAssets.push({
        id: asset.id,
        role: asset.bundleRole,
        bundleId: asset.bundleId,
        relativePath: asset.relativePath || asset.name,
        path: sequence.directory,
        members: sequence.members.map(member => ({ path: member.absolutePath, relativePath: member.relativePath, sha256: member.sha256 || null })),
        sourceFingerprint: sequence.currentFingerprint,
        expectedFingerprint: asset.serverFile?.sha256,
        sequenceProfile: sequence.profile,
      });
    } else if (asset.format === 'UMI_SESSION' || asset.serverFile?.mode === 'external-umi-session') {
      const session = umiData.readUmiManifest(sourcePath);
      fingerprints[asset.id] = session.currentFingerprint;
      frames.push({ id: asset.id, count: Number(asset.frameCount || asset.serverFile?.fileCount || 1), umi: true });
      inspectionAssets.push({
        id: asset.id,
        role: asset.bundleRole,
        bundleId: asset.bundleId,
        relativePath: asset.relativePath || asset.name,
        path: session.directory,
        sourceFingerprint: session.currentFingerprint,
        expectedFingerprint: asset.serverFile?.sha256,
        umi: {
          profile: session.profile,
          sessionId: session.sessionId,
          taskName: session.taskName,
          qualityStatus: session.qualityStatus,
          canProcess: session.canProcess,
          captureStatus: session.captureStatus,
          required: session.required,
          files: session.members.map(member => ({ path: member.absolutePath, relativePath: member.sourceRelativePath, role: member.role, size: member.size })),
        },
      });
    } else {
      frames.push({ id: asset.id, count: 1 });
      inspectionAssets.push({
        id: asset.id,
        role: asset.bundleRole,
        bundleId: asset.bundleId,
        relativePath: asset.relativePath || asset.name,
        path: sourcePath,
      });
    }
    parentPort.postMessage({ type: 'progress', completed: index + 1, total: assets.length, assetId: asset.id, assetName: asset.name });
  });

  fs.writeFileSync(manifestFile, JSON.stringify({ assets: inspectionAssets, settings }));
  parentPort.postMessage({ type: 'result', result: { fingerprints, frames, assetCount: inspectionAssets.length } });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: { name: String(error?.name || 'Error'), message: String(error?.message || error) } });
}
