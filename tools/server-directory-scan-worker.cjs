const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

try {
  const kind = String(workerData?.kind || '');
  const rootPath = String(workerData?.rootPath || '');
  let scan;
  if (kind === 'umi-session') {
    scan = require(path.join(__dirname, 'umi-data.cjs')).scanUmiRoot(rootPath);
  } else if (kind === 'hdf5-sequence') {
    scan = require(path.join(__dirname, 'hdf5-sequence.cjs')).scanHdf5SequenceRoot(rootPath);
  } else {
    throw new Error(`Unsupported directory scan type: ${kind}`);
  }
  parentPort.postMessage({ ok: true, scan });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: String(error?.name || 'Error'),
      message: String(error?.message || error),
    },
  });
}
