(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlatformImportDetection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STRUCTURED_EXTENSIONS = new Set(['json', 'jsonl', 'csv', 'yaml', 'yml', 'toml']);
  const MEDIA_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'jpg', 'jpeg', 'png']);
  const TRAJECTORY_EXTENSIONS = new Set(['parquet', 'h5', 'hdf5', 'mcap', 'bag', 'npz', 'csv', 'json', 'jsonl']);

  function pathOf(file) {
    return String(file?.webkitRelativePath || file?.path || file?.name || '').replace(/\\/g, '/');
  }

  function extensionOf(file) {
    const name = pathOf(file).split('/').pop() || '';
    const match = /\.([^.]+)$/.exec(name);
    return match ? match[1].toLowerCase() : '';
  }

  function detectPreset(input = {}) {
    const files = Array.isArray(input.files) ? input.files : [];
    const roles = Array.isArray(input.roles) ? input.roles : [];
    const paths = files.map(pathOf);
    const extensions = files.map(extensionOf);
    const roleCounts = { meta: 0, trajectory: 0, media: 0 };
    roles.forEach(role => { if (Object.prototype.hasOwnProperty.call(roleCounts, role)) roleCounts[role] += 1; });
    const count = values => extensions.filter(ext => values.includes(ext)).length;
    const hdf5Count = count(['h5', 'hdf5']);
    const mcapCount = count(['mcap', 'bag']);
    const parquetCount = count(['parquet']);
    const structuredCount = count([...STRUCTURED_EXTENSIONS]);
    const mediaCount = count([...MEDIA_EXTENSIONS]);
    const trajectoryCount = files.filter((file, index) => roles[index] === 'trajectory' || TRAJECTORY_EXTENSIONS.has(extensions[index])).length;
    const hasInfo = paths.some(value => /(^|\/)meta\/info\.json$/i.test(value)) || files.some(file => /^info\.json$/i.test(file?.name || ''));
    const hasEpisodeMetadata = paths.some(value => /(^|\/)meta\/(episodes|tasks)\.jsonl$/i.test(value));
    const hasAnnotation = paths.some(value => /(^|\/)(?:meta\/)?annotations?\.jsonl$/i.test(value));
    const completeGroups = roleCounts.meta > 0 && roleCounts.trajectory > 0 && roleCounts.media > 0;
    const lerobotShape = (hasInfo || hasEpisodeMetadata || hasAnnotation) && parquetCount > 0 && mediaCount > 0;

    if (hdf5Count) return result('hdf5', 'HDF5', hdf5Count >= Math.max(1, trajectoryCount) ? 'high' : 'medium', `检测到 ${hdf5Count} 个 HDF5 文件，按轨迹与传感器数据包导入。`);
    if (lerobotShape) return result('lerobot-v21', 'LeRobot', 'high', '检测到 LeRobot 元数据、Parquet 轨迹和视频，自动匹配 LeRobot v2.1 三组数据包。');
    if (mcapCount) return result('mcap', 'MCAP', mcapCount >= Math.max(1, trajectoryCount) ? 'high' : 'medium', `检测到 ${mcapCount} 个 MCAP / ROS Bag 文件，按轨迹包导入。`);
    if (completeGroups) return result('standard-3', `${parquetCount ? 'Parquet' : '多格式'}三组`, 'high', '检测到 meta、轨迹/状态和视频三组文件，自动匹配标准三组数据包。');
    if (parquetCount) return result('parquet', 'Parquet', parquetCount === files.length ? 'high' : 'medium', `检测到 ${parquetCount} 个 Parquet 数据文件，按表格轨迹包导入。`);
    if (structuredCount) return result('structured', 'JSON / CSV', structuredCount === files.length ? 'high' : 'medium', `检测到 ${structuredCount} 个 JSON、JSONL、CSV 或配置数据文件。`);
    if (mediaCount) return result('media', '视频 / 图像', mediaCount === files.length ? 'high' : 'medium', `检测到 ${mediaCount} 个视频或图像文件，按媒体数据包导入。`);
    return result('single', '通用', 'low', '文件组合没有命中专用目录或格式规则，使用兼容导入模式。');
  }

  function resolvePreset(input = {}) {
    const detection = detectPreset(input);
    const available = new Set(Array.isArray(input.availablePresetIds) ? input.availablePresetIds : []);
    const manual = input.mode === 'manual' && available.has(input.manualPreset);
    const automatic = available.has(detection.preset) ? detection.preset : available.has('single') ? 'single' : detection.preset;
    return Object.freeze({
      ...detection,
      preset: manual ? input.manualPreset : automatic,
      mode: manual ? 'manual' : 'auto',
      automaticPreset: detection.preset,
      automaticLabel: detection.format,
      reason: manual ? `已手动选择预设；自动识别结果为 ${detection.reason}` : detection.reason,
    });
  }

  function result(preset, format, confidence, reason) {
    return Object.freeze({ preset, format, confidence, reason });
  }

  return Object.freeze({ detectPreset, resolvePreset });
});
