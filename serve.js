const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');
const { execFile, spawn, spawnSync } = require("child_process");
const { promisify } = require("util");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const hdf5Sequence = require(path.join(__dirname, "tools", "hdf5-sequence.cjs"));
const umiData = require(path.join(__dirname, 'tools', 'umi-data.cjs'));

const fsp = require('node:fs/promises');
const execFileAsync = promisify(execFile);

function runCommandWithProgress(command, args, options = {}) {
  const maxBuffer = Number(options.maxBuffer || 32 * 1024 * 1024), timeout = Number(options.timeout || 0);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd || root, env: options.env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', size = 0, settled = false;
    const timer = timeout > 0 ? setTimeout(() => { child.kill(); finish(new Error(`命令执行超过 ${Math.round(timeout / 1000)} 秒`)); }, timeout) : null;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const consumeStderr = text => {
      stderr += text; size += Buffer.byteLength(text);
      if (size > maxBuffer) { child.kill(); finish(new Error('检查进程输出超过缓冲区限制')); return; }
      pending += text;
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('PROGRESS ')) continue;
        try { options.onProgress?.(JSON.parse(line.slice(9))); } catch {}
      }
    };
    child.stdout.on('data', chunk => { stdout += String(chunk); size += chunk.length; if (size > maxBuffer) { child.kill(); finish(new Error('检查进程输出超过缓冲区限制')); } });
    child.stderr.on('data', chunk => consumeStderr(String(chunk)));
    child.on('error', finish);
    child.on('close', code => {
      if (pending.startsWith('PROGRESS ')) { try { options.onProgress?.(JSON.parse(pending.slice(9))); } catch {} }
      if (code === 0) finish(); else finish(Object.assign(new Error(stderr.replace(/^PROGRESS .*$/gm, '').trim() || `检查进程退出码 ${code}`), { code, stdout, stderr }));
    });
  });
}

const root = __dirname;
let activeDirectoryScans = 0;
function scanServerDirectory(kind, rootPath) {
  if (activeDirectoryScans > 0) {
    const error = new Error('已有服务端目录扫描正在执行，请等待完成后再试');
    error.status = 409;
    return Promise.reject(error);
  }
  activeDirectoryScans++;
  const workerFile = path.join(root, 'tools', 'server-directory-scan-worker.cjs');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { kind, rootPath } });
    let settled = false;
    const finish = (error, scan) => {
      if (settled) return;
      settled = true;
      activeDirectoryScans = Math.max(0, activeDirectoryScans - 1);
      clearTimeout(timer);
      if (error) reject(error); else resolve(scan);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('服务端目录扫描超过 30 分钟，已终止扫描'));
    }, 30 * 60 * 1000);
    worker.once('message', message => {
      if (message?.ok) finish(null, message.scan);
      else {
        const error = new Error(message?.error?.message || '服务端目录扫描失败');
        error.name = message?.error?.name || 'Error';
        finish(error);
      }
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled) finish(new Error(`服务端目录扫描线程异常退出：${code}`));
    });
  });
}
function prepareInspectionManifest(assets, uploadDir, manifestFile, settings, progress = () => {}) {
  const workerFile = path.join(root, 'tools', 'inspection-manifest-worker.cjs');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { assets, uploadDir, manifestFile, settings } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('质检清单准备超过 30 分钟，已终止扫描'));
    }, 30 * 60 * 1000);
    worker.on('message', message => {
      if (message?.type === 'progress') {
        progress({ completedAssets: Number(message.completed || 0), totalAssets: Number(message.total || 0), assetName: message.assetName || '' });
      } else if (message?.type === 'result') {
        finish(null, message.result);
      } else if (message?.type === 'error') {
        const error = new Error(message.error?.message || '质检清单准备失败');
        error.name = message.error?.name || 'Error';
        finish(error);
      }
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled) finish(new Error(`质检清单准备线程异常退出：${code}`));
    });
  });
}
const { PlatformStore } = require(path.join(root, 'tools', 'platform-store.cjs'));
const { TaskQueue } = require(path.join(root, 'tools', 'task-queue.cjs'));
const backupTools = require(path.join(root, 'tools', 'storage-backup.cjs'));
const { ResumableUploads } = require(path.join(root, 'tools', 'resumable-upload.cjs'));
let platformStore, taskQueue, resumableUploads, workLockOwned = false;
function getStore() {
  if (!platformStore) platformStore = new PlatformStore(workDir, { state: defaultState, auth: () => ({ sessionSecret: crypto.randomBytes(32).toString('base64url'), users: [], nodeCredentials: [] }) });
  return platformStore;
}
const port = Number(process.env.PORT || 4173);
// Listen on IPv6 any-address with dual-stack enabled by default. Windows
// commonly resolves `localhost` to ::1 first; an IPv4-only listener makes the
// static page load inconsistently while /api/auth/status fails.
const host = process.env.HOST || "::";
const workDir = process.env.DATA_WORK_DIR ? path.resolve(process.env.DATA_WORK_DIR) : path.join(root, "work");
const uploadDir = path.join(workDir, "uploads");
const backupDir = path.join(workDir, "backups");
const exportDir = path.join(workDir, "exports");
const deliveryDir = path.join(workDir, "deliveries");
const previewDir = path.join(workDir, "previews");
const stateFile = path.join(workDir, "server-state.json");
const authFile = path.join(workDir, "auth.json");
const MAX_UPLOAD = 20 * 1024 * 1024 * 1024;
const SAMPLE_LIMIT = 5 * 1024 * 1024;
const DATA_TYPES = ["UMI", "EGO", "遥操"];
const WORKFLOW_STAGES = [
  { id: "import", name: "上传 / 导入", description: "登记数据包、识别 meta / trajectory / media 并写入服务端" },
  { id: "clean", name: "数据清洗", description: "执行只读结构、文件签名和存储一致性检查" },
  { id: "select", name: "数据筛选", description: "按数据类型、场景和质量门禁筛选可用 Episode" },
  { id: "annotate", name: "数据标注", description: "维护 Episode 标注并保留版本与审核状态" },
  { id: "review", name: "标注审核", description: "复核标注完整性和关键字段，形成审核证据" },
  { id: "quality", name: "数据质检", description: "运行规则、LeRobot schema 和媒体一致性检查" },
  { id: "convert", name: "格式转换", description: "在记录转换结果和输入指纹后生成交付格式" },
  { id: "deliver", name: "打包交付", description: "仅对通过验收门禁的数据生成 Manifest 和清单" },
];
const V6_WORKFLOW_VERSION = "V6";
const V6_WORKFLOW_GROUPS = [
  { id: "capture", name: "采集与接入", nodes: [
    { id: "start", name: "开始", mode: "system", available: true, action: "overview" },
    { id: "pico_capture", name: "PICO 采集", mode: "human", available: false, action: "tasks" },
    { id: "pico_upload", name: "PICO 上传", mode: "human", available: true, action: "intake", note: "当前平台以总文件夹导入承接上传" },
    { id: "capture_complete", name: "采集完成", mode: "system", available: true, action: "assets" },
  ] },
  { id: "normalize", name: "融合与预处理", nodes: [
    { id: "data_merging", name: "数据融合与同步", mode: "algorithm", available: false, action: "workflow" },
    { id: "desensing", name: "视频脱敏", mode: "algorithm", available: false, action: "workflow" },
    { id: "video_preprocess", name: "去畸变算法", mode: "algorithm", available: false, action: "workflow" },
    { id: "pose_point_cloud", name: "位姿对齐与点云", mode: "algorithm", available: false, action: "workflow" },
  ] },
  { id: "quality", name: "自动与人工质检", nodes: [
    { id: "algo_auto_checker", name: "自动质检算法", mode: "algorithm", available: true, action: "qc" },
    { id: "agent_check", name: "Agent 质检", mode: "algorithm", available: false, action: "qc" },
    { id: "create_inspect_nodes", name: "创建抽检节点", mode: "system", available: true, action: "issues" },
    { id: "human_case_inspect", name: "人工质检", mode: "human", available: true, action: "issues" },
    { id: "human_case_sample", name: "人工抽检", mode: "human", available: false, action: "issues" },
  ] },
  { id: "pose", name: "位姿准备与标注", nodes: [
    { id: "hand_pose_prelabel", name: "手势位姿预标", mode: "algorithm", available: false, action: "workflow" },
    { id: "good_frame_detect", name: "好帧检测", mode: "algorithm", available: false, action: "workflow" },
    { id: "body_pose", name: "Body Pose 算法", mode: "algorithm", available: false, action: "workflow" },
    { id: "pose_mcap", name: "位姿写入 MCAP", mode: "algorithm", available: false, action: "workflow" },
    { id: "start_pose_label", name: "启动位姿标注", mode: "system", available: false, action: "annotation" },
    { id: "pose_labeling", name: "位姿标注", mode: "human", available: false, action: "annotation" },
  ] },
  { id: "semantic", name: "裁剪、语义与翻译", nodes: [
    { id: "data_cut", name: "视频与数据裁剪", mode: "algorithm", available: false, action: "workflow" },
    { id: "semantics_prelabel", name: "语义预标", mode: "algorithm", available: false, action: "annotation" },
    { id: "start_semantic_label", name: "启动语义标注", mode: "system", available: false, action: "annotation" },
    { id: "semantic_labeling", name: "语义标注", mode: "human", available: false, action: "annotation" },
    { id: "labeling_complete", name: "标注完成", mode: "system", available: false, action: "annotation" },
    { id: "translate", name: "标注翻译", mode: "algorithm", available: false, action: "annotation" },
  ] },
  { id: "skip_semantic", name: "跳过语义分支", conditional: true, nodes: [
    { id: "data_cut_skip_sem", name: "视频与数据裁剪（跳过语义）", mode: "algorithm", available: false, action: "workflow" },
    { id: "delivery_packaging_skip_sem", name: "交付脚本处理（跳过语义）", mode: "server", available: true, action: "exports" },
    { id: "mcap_conversion_skip_sem", name: "MCAP 转换（跳过语义）", mode: "server", available: true, action: "exports", note: "LeRobot v2.x 转 MCAP JSON 轨迹，原视频随包保留" },
  ] },
  { id: "delivery", name: "交付与格式输出", nodes: [
    { id: "delivery_packaging", name: "交付脚本处理", mode: "server", available: true, action: "exports" },
    { id: "lerobot_v6", name: "LeRobot", mode: "server", available: true, action: "exports", note: "V6 流水线的训练交付节点，输出 LeRobot v3.0 并执行官方加载验证" },
    { id: "mcap_conversion", name: "MCAP 转换", mode: "server", available: true, action: "exports", note: "LeRobot v2.x 转 MCAP JSON，非 ROS 消息格式" },
    { id: "zarr_conversion", name: "Zarr 转换", mode: "server", available: true, action: "exports", note: "LeRobot v2.x 转 Zarr v2 列数组，保留原视频" },
    { id: "delivery_checker", name: "交付检测", mode: "server", available: true, action: "exports" },
    { id: "mcap_delivery_visualization", name: "MCAP 可视化交付", mode: "algorithm", available: false, action: "exports" },
    { id: "complete_job", name: "完成", mode: "system", available: true, action: "exports" },
  ] },
];
const ENGINE_OPERATORS = [
  { id: "sync", name: "数据同步", stage: "上传 / 导入", mode: "server", description: "按总文件夹结构登记 meta、trajectory、media，并将原始文件写入服务端存储。", capabilities: ["folder-import", "stream-upload", "sha256"] },
  { id: "clean", name: "基础清洗", stage: "导入后核验", mode: "server", description: "只读检查文件签名、结构和可读取性，不静默修改原始数据。", capabilities: ["signature", "schema", "storage-reconcile"] },
  { id: "compliance", name: "质量合规", stage: "数据质检", mode: "server", description: "执行服务端规则、LeRobot schema 检查和问题证据归档。", capabilities: ["rules", "lerobot-schema", "issue-evidence"] },
  { id: "perception", name: "感知检查", stage: "视频 / 图像", mode: "optional-plugin", description: "通过 Embodied Data 插件执行 detect、info、validate、quality。", capabilities: ["embodied-detect", "embodied-info", "embodied-validate", "embodied-quality"] },
  { id: "label", name: "标注审核", stage: "标注 / 复核", mode: "server", description: "维护 Episode 标注、审核状态和交付门禁。", capabilities: ["episode-annotation", "review-gate"] },
  { id: "export", name: "交付清单", stage: "验收 / 交付", mode: "server", description: "按质量门禁生成原始文件清单、Manifest 和 annotations JSONL。", capabilities: ["manifest", "sha256", "delivery-gate"] },
];
const DEEP_FORMATS = ["HDF5", "H5", "HDF5_SEQUENCE", "MCAP", "PARQUET", "ZIP", "LEROBOT"];
const VIDEO_FORMATS = ["MP4", "MOV", "WEBM", "AVI"];
const SERVICE_VERSION = "3.6.3";
const OFFICIAL_LEROBOT_VERSION = "0.4.4";
const TRAINING_DELIVERY_FORMAT = "LeRobot v3.0";
const loginFailures = new Map();
const activeDeliveryConversions = new Set();
const LEROBOT_SCHEMA_SCRIPT = path.join(root, "tools", "lerobot_schema_check.py");
const OFFICIAL_LEROBOT_SCRIPT = path.join(root, "tools", "official_lerobot.py");
const EMBODIED_SOURCE_CANDIDATES = [
  process.env.EMBODIED_SOURCE_DIR,
  path.resolve(root, "..", "具身平台插件开发", "src"),
  path.resolve(root, "..", "embodied-data-platform", "src"),
].filter(Boolean);
const ALL_PERMISSIONS = [
  "资产查看", "资产上传", "资产管理", "删除数据", "运行质检", "规则管理",
  "问题查看", "问题处置", "标注查看", "标注编辑", "标注审核",
  "数据集查看", "数据集发布", "训练调度", "失败样本回流", "模型关联",
  "采集任务", "节点管理", "成员管理", "平台设置",
];
const ROLE_POLICIES = {
  "数据治理负责人": ALL_PERMISSIONS,
  "质量工程师": ["资产查看", "运行质检", "问题处置", "标注查看", "标注编辑"],
  "标注审核员": ["资产查看", "标注查看", "标注审核", "问题查看"],
  "算法工程师": ["数据集查看", "训练调度", "失败样本回流", "模型关联"],
  "采集运维": ["采集任务", "节点管理", "资产上传", "问题查看"],
};

let lerobotPythonCache;
let officialLerobotRuntimeCache;

function inspectOfficialLerobotRuntime() {
  if (officialLerobotRuntimeCache !== undefined) return officialLerobotRuntimeCache;
  const candidates = [
    process.env.LEROBOT_OFFICIAL_PYTHON,
    path.join(root, "runtime", "lerobot", "Scripts", "python.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.existsSync(OFFICIAL_LEROBOT_SCRIPT)) continue;
    try {
      const result = spawnSync(candidate, ["-c", "import lerobot; print(lerobot.__version__)"], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true });
      const version = String(result.stdout || "").trim().split(/\s+/).pop();
      if (result.status === 0 && version) {
        officialLerobotRuntimeCache = { status: version === OFFICIAL_LEROBOT_VERSION ? "available" : "version-mismatch", version, python: candidate, expectedVersion: OFFICIAL_LEROBOT_VERSION };
        return officialLerobotRuntimeCache;
      }
    } catch {}
  }
  officialLerobotRuntimeCache = { status: "missing", version: null, python: null, expectedVersion: OFFICIAL_LEROBOT_VERSION };
  return officialLerobotRuntimeCache;
}

function findLerobotPython() {
  if (lerobotPythonCache !== undefined) return lerobotPythonCache;
  const candidates = [];
  if (process.env.LEROBOT_PYTHON) candidates.push(process.env.LEROBOT_PYTHON);
  candidates.push(
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, "runtime", "python", "Scripts", "python.exe"),
    path.join(__dirname, "runtime", "python", "Scripts", "python.exe")
  );
  if (path.extname(process.execPath).toLowerCase() === ".exe") {
    candidates.push(path.join(path.dirname(process.execPath), "python", "Scripts", "python.exe"));
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "uv", "python", "cpython-3.12-windows-x86_64-none", "python.exe"));
  candidates.push("python.exe", "python");
  for (const candidate of candidates) {
    if (candidate !== "python" && candidate !== "python.exe" && !fs.existsSync(candidate)) continue;
    try {
      const result = spawnSync(candidate, ["-c", "import pyarrow"], { cwd: root, timeout: 5000, windowsHide: true });
      if (result.status === 0) { lerobotPythonCache = candidate; return candidate; }
    } catch {}
  }
  lerobotPythonCache = null;
  return null;
}

async function runLerobotSchemaCheck(filePaths) {
  if (!fs.existsSync(LEROBOT_SCHEMA_SCRIPT)) {
    const error = new Error("LeRobot 校验脚本不存在");
    error.code = "LEROBOT_SCRIPT_MISSING";
    throw error;
  }
  const python = findLerobotPython();
  if (!python) {
    const error = new Error("未找到可用 Python 运行环境，请设置 LEROBOT_PYTHON 或安装含 pyarrow 的 Python");
    error.code = "LEROBOT_PYTHON_MISSING";
    throw error;
  }
  const { stdout } = await execFileAsync(python, [LEROBOT_SCHEMA_SCRIPT, ...filePaths], {
    cwd: root,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  let report;
  try { report = JSON.parse(String(stdout || "").trim()); }
  catch { throw new Error("LeRobot 校验脚本返回了无效结果"); }
  if (!report || report.ok !== true || !Array.isArray(report.files)) throw new Error(report?.error || "LeRobot 校验未完成");
  return report;
}

function findEmbodiedInvocation() {
  const python = process.env.EMBODIED_PYTHON || findLerobotPython();
  const configuredCli = process.env.EMBODIED_CLI;
  const cliCandidates = [
    configuredCli,
    path.join(root, "runtime", "python", "Scripts", "embodied.exe"),
    path.join(root, "runtime", "python", "Scripts", "embodied"),
  ].filter(Boolean);
  for (const command of cliCandidates) {
    if (command !== configuredCli && !fs.existsSync(command)) continue;
    return { command, prefix: [], env: process.env };
  }
  if (!python) return null;
  for (const sourceDir of EMBODIED_SOURCE_CANDIDATES) {
    if (!sourceDir || !fs.existsSync(path.join(sourceDir, "embodied_core"))) continue;
    const env = { ...process.env, PYTHONPATH: [sourceDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
    return { command: python, prefix: ["-m", "embodied_core.cli"], env };
  }
  return null;
}

function engineOperatorCatalog(plugin = findEmbodiedInvocation()) {
  return ENGINE_OPERATORS.map(operator => ({
    ...operator,
    status: operator.mode === "optional-plugin" ? (plugin ? "available" : "optional") : "available",
    availability: operator.mode === "optional-plugin" ? (plugin ? "服务端已连接 Embodied Data 插件" : "未配置外部插件，执行时会明确返回不可用") : "服务端已启用",
  }));
}

async function runEmbodiedCommand(args, timeout = 180000) {
  const invocation = findEmbodiedInvocation();
  if (!invocation) {
    const error = new Error("未找到 Embodied Data 插件，请设置 EMBODIED_CLI 或 EMBODIED_SOURCE_DIR");
    error.code = "EMBODIED_PLUGIN_MISSING";
    throw error;
  }
  const { stdout } = await execFileAsync(invocation.command, [...invocation.prefix, ...args], {
    cwd: root,
    env: invocation.env,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  try { return JSON.parse(String(stdout || "").trim()); }
  catch { throw new Error("Embodied Data 插件返回了无效 JSON"); }
}

function safeBundlePath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || path.posix.isAbsolute(raw)) throw new Error("数据包相对路径无效");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..")) throw new Error("数据包路径不能越过工作目录");
  return parts;
}

function materializeEmbodiedBundle(bundleId, assets) {
  const runRoot = path.join(workDir, "embodied-analysis", `${safeName(bundleId)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(runRoot, { recursive: true });
  try {
    assets.forEach(asset => {
      const stored = asset.serverFile?.storedName;
      if (!stored) return;
      const source = path.resolve(uploadDir, stored), uploadRoot = path.resolve(uploadDir);
      if (!source.startsWith(uploadRoot + path.sep) || !fs.existsSync(source)) throw new Error(`资产文件不存在：${asset.name}`);
      const parts = safeBundlePath(asset.relativePath || asset.name), target = path.resolve(runRoot, ...parts);
      if (!target.startsWith(path.resolve(runRoot) + path.sep)) throw new Error("数据包路径越过分析目录");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.linkSync(source, target); } catch { fs.copyFileSync(source, target); }
    });
    const paths = assets.map(asset => safeBundlePath(asset.relativePath || asset.name));
    const first = paths[0]?.[0], nestedRoot = first && paths.every(parts => parts[0] === first) && fs.existsSync(path.join(runRoot, first, "meta")) ? path.join(runRoot, first) : runRoot;
    return { runRoot, datasetRoot: nestedRoot };
  } catch (error) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

function datasetRootPrefixParts(assetList) {
  const paths = assetList.map(asset => safeBundlePath(asset.relativePath || asset.name));
  const first = paths[0]?.[0];
  return first && paths.every(parts => parts[0] === first) && paths.some(parts => parts[1] === "meta") ? 1 : 0;
}

function bundleInfoAsset(assetList) {
  return assetList.find(asset => asset.bundleRole === "meta" && /meta[\\/]info\.json$/i.test(asset.relativePath || asset.name) && asset.serverFile?.storedName);
}

function readBundleLeRobotInfo(assetList) {
  const meta = bundleInfoAsset(assetList);
  if (!meta) return null;
  try { return JSON.parse(fs.readFileSync(path.join(uploadDir, meta.serverFile.storedName), "utf8")); }
  catch { return null; }
}

async function createHdf5SequenceDelivery(state, jobId, bundleId, assetList, progress = () => {}) {
  if (!assetList.length || !assetList.every(isHdf5SequenceAsset)) throw new Error('HDF5 序列交付不能与其他源格式混在同一批次');
  const official = inspectOfficialLerobotRuntime();
  if (official.status !== 'available') throw new Error(`官方 LeRobot ${OFFICIAL_LEROBOT_VERSION} 运行时不可用：${official.status}`);
  const python = findLerobotPython();
  if (!python) throw new Error('独立交付验包需要配置含 pyarrow 的 Python 环境');
  const deliveryRoot = path.join(deliveryDir, safeName(jobId)), output = path.join(deliveryRoot, 'lerobot'), archive = path.join(deliveryRoot, 'lerobot.zip'), reportPath = path.join(deliveryRoot, 'hdf5-conversion-report.json'), requestPath = path.join(deliveryRoot, 'hdf5-delivery-request.json');
  fs.rmSync(deliveryRoot, { recursive: true, force: true });
  fs.mkdirSync(deliveryRoot, { recursive: true });
  const episodes = assetList.map(asset => {
    const sequence = hdf5Sequence.readSequenceManifest(path.join(uploadDir, asset.serverFile.storedName));
    if (sequence.changed) throw new Error(`Episode ${episodeIndexForAsset(asset)} 的源文件集合或元数据已变化，请重新质检并建立新的交付版本`);
    if (sequence.members.some(member => !/^[a-f0-9]{64}$/.test(String(member.sha256 || '')))) throw new Error(`Episode ${episodeIndexForAsset(asset)} 的旧清单缺少逐文件 SHA-256，请重新导入该批次`);
    const instruction = annotationInstructionForAsset(state, asset);
    if (!instruction) throw new Error(`Episode ${episodeIndexForAsset(asset)} 缺少已审核任务指令`);
    return { episodeIndex: episodeIndexForAsset(asset), relativePath: asset.relativePath, instruction, files: sequence.members.map(member => ({ path: member.absolutePath, relativePath: member.relativePath, sha256: member.sha256 })) };
  }).sort((left, right) => left.episodeIndex - right.episodeIndex);
  fs.writeFileSync(requestPath, JSON.stringify({ repoId: `local/${String(bundleId).toLowerCase()}`, sourceProfile: 'hdf5-frame-sequence', episodes }, null, 2), 'utf8');
  try {
    const { stdout } = await runCommandWithProgress(official.python, ['-X', 'utf8', path.join(root, 'tools', 'hdf5_sequence_convert.py'), '--manifest', requestPath, '--output', output, '--archive', archive, '--report', reportPath], {
      timeout: 21600000, maxBuffer: 32 * 1024 * 1024,
      onProgress: item => progress({ completed: Number(item.completed || 0), total: Number(item.total || 0), message: item.stage === 'verify' ? '正在执行官方 LeRobot 加载与 DataLoader 验证' : item.stage === 'package' ? '正在生成清单与交付 ZIP' : `正在编码 HDF5 帧 ${item.completed || 0}/${item.total || 0}` }),
    });
    const report = JSON.parse(String(stdout || '').trim());
    if (report.ok !== true || report.sourceNumericConsistency?.checked !== true || report.officialVerification?.status !== 'passed' || report.officialVerification?.officialLerobotVersion !== OFFICIAL_LEROBOT_VERSION) throw new Error(report.error || 'HDF5 转 LeRobot v3.0 失败或源数值回读一致性未通过');
    const { stdout: checked } = await execFileAsync(python, [path.join(root, 'tools', 'verify_delivery.py'), '--archive', archive, '--target', 'lerobot'], { timeout: 21600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const verification = JSON.parse(String(checked || '').trim());
    if (verification.ok !== true || verification.officialVerification !== 'passed' || verification.archiveSha256 !== report.archiveSha256) throw new Error(verification.error || '独立验包失败');
    report.independentVerification = { ...verification, checkedAt: new Date().toISOString() };
    return {
      directory: output, relativeDirectory: path.relative(workDir, output), archive, sourceFormat: 'HDF5 frame sequence', baseFormat: 'HDF5 frame sequence', version: 'v3.0', sourceVersion: 'HDF5_SEQUENCE', targetVersion: 'v3.0', trainingReady: true,
      structure: { ok: true, engine: 'hdf5-frame-sequence', episodes: report.episodes, frames: report.frames, cameras: report.cameras }, validation: { ok: true, score: null, errors: 0, warnings: 0, issues: [], engine: 'official-lerobot-v3' }, checkedAt: new Date().toISOString(), prebuiltConversion: report,
    };
  } catch (error) {
    throw new Error(`HDF5 序列交付未完成：${error.message}`);
  }
}

async function createUmiSessionDelivery(state, jobId, bundleId, assetList, progress = () => {}) {
  if (!assetList.length || !assetList.every(isUmiSessionAsset)) throw new Error('UMI delivery cannot be mixed with other source formats');
  const official = inspectOfficialLerobotRuntime();
  if (official.status !== 'available') throw new Error(`Official LeRobot ${OFFICIAL_LEROBOT_VERSION} runtime is unavailable: ${official.status}`);
  const python = findLerobotPython();
  if (!python) throw new Error('Independent delivery verification requires the configured Python runtime');
  const deliveryRoot = path.join(deliveryDir, safeName(jobId)), output = path.join(deliveryRoot, 'lerobot'), archive = path.join(deliveryRoot, 'lerobot.zip'), reportPath = path.join(deliveryRoot, 'umi-conversion-report.json'), requestPath = path.join(deliveryRoot, 'umi-delivery-request.json');
  fs.rmSync(deliveryRoot, { recursive: true, force: true });
  fs.mkdirSync(deliveryRoot, { recursive: true });
  const episodes = assetList.map(asset => {
    const session = umiData.readUmiManifest(path.join(uploadDir, asset.serverFile.storedName)), instruction = annotationInstructionForAsset(state, asset);
    if (!instruction) throw new Error(`Episode ${episodeIndexForAsset(asset)} is missing an approved instruction`);
    return {
      episodeIndex: episodeIndexForAsset(asset), sessionId: session.sessionId, instruction,
      required: session.required,
      files: session.members.map(member => ({ path: member.absolutePath, relativePath: member.sourceRelativePath, role: member.role, size: member.size })),
    };
  }).sort((left, right) => left.episodeIndex - right.episodeIndex);
  fs.writeFileSync(requestPath, JSON.stringify({ repoId: `local/${String(bundleId).toLowerCase()}`, sourceProfile: 'umi-session-v1', episodes }, null, 2), 'utf8');
  try {
    const { stdout } = await runCommandWithProgress(official.python, ['-X', 'utf8', path.join(root, 'tools', 'umi_convert.py'), '--manifest', requestPath, '--output', output, '--archive', archive, '--report', reportPath], {
      timeout: 21600000, maxBuffer: 32 * 1024 * 1024,
      onProgress: item => progress({ completed: Number(item.completed || 0), total: Number(item.total || 0), message: item.stage === 'verify' ? 'Running official LeRobot load and DataLoader verification' : item.stage === 'package' ? 'Packaging delivery inventory and ZIP' : `Encoding UMI frames ${item.completed || 0}/${item.total || 0}` }),
    });
    const report = JSON.parse(String(stdout || '').trim());
    if (report.ok !== true || report.officialVerification?.status !== 'passed' || report.officialVerification?.officialLerobotVersion !== OFFICIAL_LEROBOT_VERSION) throw new Error(report.error || 'UMI to LeRobot v3.0 conversion failed');
    const { stdout: checked } = await execFileAsync(python, [path.join(root, 'tools', 'verify_delivery.py'), '--archive', archive, '--target', 'lerobot'], { timeout: 21600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const verification = JSON.parse(String(checked || '').trim());
    if (verification.ok !== true || verification.officialVerification !== 'passed' || verification.archiveSha256 !== report.archiveSha256) throw new Error(verification.error || 'Independent delivery verification failed');
    report.independentVerification = { ...verification, checkedAt: new Date().toISOString() };
    return {
      directory: output, relativeDirectory: path.relative(workDir, output), archive, sourceFormat: 'TeleUMI session', baseFormat: 'TeleUMI session', version: 'v3.0', sourceVersion: 'UMI_SESSION', targetVersion: 'v3.0', trainingReady: true,
      structure: { ok: true, engine: 'umi-session-v1', episodes: report.episodes, frames: report.frames, cameras: report.cameras }, validation: { ok: true, score: null, errors: 0, warnings: 0, issues: [], engine: 'official-lerobot-v3' }, checkedAt: new Date().toISOString(), prebuiltConversion: report,
    };
  } catch (error) {
    throw new Error(`UMI delivery failed: ${error.message}`);
  }
}

function deliverySourceFingerprint(state, job) {
  const ids = new Set(job.assetIds || []);
  const assets = state.assets.filter(asset => ids.has(asset.id)).sort((left, right) => left.id.localeCompare(right.id));
  const annotations = state.annotations.filter(item => ids.has(item.assetId)).map(item => [item.assetId, item.instruction, item.status, item.autoImported === true, item.importEvidence?.files || []]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return crypto.createHash("sha256").update(JSON.stringify({ assets: assets.map(asset => [asset.id, asset.serverFile?.sha256, annotationInstructionForAsset(state, asset), annotationStandardFor(state, annotationGroupKeyForAsset(asset))]), annotations })).digest("hex");
}

function materializeLeRobotAssets(assetList, destination) {
  const prefixParts = datasetRootPrefixParts(assetList);
  assetList.forEach(asset => {
    const stored = asset.serverFile?.storedName;
    if (!stored) throw new Error(`资产缺少原始文件：${asset.name}`);
    const source = path.resolve(uploadDir, stored), uploadRoot = path.resolve(uploadDir);
    if (!source.startsWith(uploadRoot + path.sep) || !fs.existsSync(source)) throw new Error(`资产文件不存在：${asset.name}`);
    const parts = safeBundlePath(asset.relativePath || asset.name).slice(prefixParts), target = path.resolve(destination, ...parts), targetRoot = path.resolve(destination);
    if (!target.startsWith(targetRoot + path.sep)) throw new Error("LeRobot 交付路径越界");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.linkSync(source, target); } catch { fs.copyFileSync(source, target); }
  });
}

function structuralLeRobotCheck(directory, assetList) {
  const infoPath = path.join(directory, "meta", "info.json"), dataFiles = fs.existsSync(path.join(directory, "data")) ? fs.readdirSync(path.join(directory, "data"), { recursive: true }).filter(name => String(name).toLowerCase().endsWith(".parquet")) : [];
  if (!fs.existsSync(infoPath)) throw new Error("LeRobot 交付目录缺少 meta/info.json");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8")), version = String(info.codebase_version || info.version || "");
  if (!/^v?[23](?:\.|$)/i.test(version)) throw new Error(`交付目录不是 LeRobot v2/v3 格式：${version || "未知版本"}`);
  if (!dataFiles.length) throw new Error("LeRobot 交付目录缺少 data/**/*.parquet");
  const videos = assetList.filter(asset => asset.bundleRole === "media").length;
  return { ok: true, version, parquetFiles: dataFiles.length, videoFiles: videos, features: Object.keys(info.features || {}).length };
}

async function materializeLeRobotDelivery(state, jobId, bundleId, assetList, progress = () => {}) {
  if (assetList.some(isUmiSessionAsset)) return createUmiSessionDelivery(state, jobId, bundleId, assetList, progress);
  if (assetList.some(isHdf5SequenceAsset)) return createHdf5SequenceDelivery(state, jobId, bundleId, assetList, progress);
  const info = readBundleLeRobotInfo(assetList);
  const hasMedia = assetList.some(asset => asset.bundleRole === "media");
  const version = String(info?.codebase_version || info?.version || "");
  if (info && !/^v?2(?:\.|$)/i.test(version)) throw new Error(`当前交付转换只接受 LeRobot v2.x 源数据，识别到：${version || "未知版本"}`);
  if (!info && hasMedia) throw new Error("源格式转换会丢失视频流，不能生成完整 LeRobot 交付包；请先补齐 LeRobot 元数据或改用保留视频的转换器");
  const root = path.join(deliveryDir, safeName(jobId)), destination = path.join(root, "lerobot"), staging = `${destination}.staging-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    if (info) {
      fs.mkdirSync(staging, { recursive: true });
      materializeLeRobotAssets(assetList, staging);
    } else {
      const materialized = materializeEmbodiedBundle(bundleId, assetList);
      try { await runEmbodiedCommand(["convert", materialized.datasetRoot, staging, "--target", "lerobot", "--json"], 600000); }
      finally { fs.rmSync(materialized.runRoot, { recursive: true, force: true }); }
    }
    const tasksPath = path.join(staging, "meta", "tasks.jsonl");
    if (!fs.existsSync(tasksPath)) {
      const instructions = [...new Set(annotationGroupList(state).filter(item => item.key === bundleId || item.scopeId === bundleId).map(item => item.instruction).filter(Boolean))];
      if (!instructions.length) throw new Error("LeRobot 交付包缺少 meta/tasks.jsonl，且没有可写入的任务指令");
      fs.writeFileSync(tasksPath, `${instructions.map((task, index) => JSON.stringify({ task_index: index, task })).join("\n")}\n`, "utf8");
    }
    const structure = structuralLeRobotCheck(staging, assetList);
    let validation;
    const trajectories = assetList.filter(asset => asset.bundleRole === "trajectory"), sourceSchemasVerified = Boolean(info) && trajectories.length > 0 && trajectories.every(asset => asset.inspection?.lerobotSchema?.status === "verified" && !(asset.inspection.lerobotSchema.issues || []).length);
    if (sourceSchemasVerified) validation = { ok: true, score: null, errors: 0, warnings: 0, issues: [], engine: "source-schema+structure" };
    else try {
      const report = await runEmbodiedCommand(["validate", staging, "--json"], 300000);
      validation = { ok: report?.ok === true, score: report?.score ?? null, errors: report?.errors ?? null, warnings: report?.warnings ?? null, issues: report?.issues || [], engine: "embodied-core" };
    } catch (error) {
      const schemaFiles = trajectories.map(asset => path.join(staging, ...safeBundlePath(asset.relativePath || asset.name).slice(datasetRootPrefixParts(assetList))));
      const schema = await runLerobotSchemaCheck(schemaFiles);
      validation = { ok: schema.files.every(item => item.status === "verified"), score: null, issues: schema.files.flatMap(item => item.issues || []), engine: "pyarrow-schema" };
    }
    if (!validation.ok) throw new Error(`LeRobot 交付包校验失败：${validation.issues.map(item => item.message || item.code || item).join("；") || "结构不完整"}`);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    return { directory: destination, relativeDirectory: path.relative(workDir, destination), version, sourceVersion: version, targetVersion: "v3.0", baseFormat: `LeRobot ${version}`, trainingReady: false, structure, validation, checkedAt: new Date().toISOString() };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function reconcileLeRobotDeliveries() {
  const state = readState(), pending = state.exports.filter(job => !job.lerobotDirectory);
  let changed = 0;
  for (const job of pending) {
    const ids = new Set(job.assetIds || []), assets = state.assets.filter(asset => ids.has(asset.id)), bundleIds = [...new Set(assets.map(asset => asset.bundleId).filter(Boolean))];
    if (bundleIds.length !== 1) continue;
    try {
      const delivery = await materializeLeRobotDelivery(state, job.id, bundleIds[0], assets);
      Object.assign(job, { format: TRAINING_DELIVERY_FORMAT, baseFormat: `LeRobot ${delivery.sourceVersion || delivery.version}`, trainingReady: false, batchId: bundleIds[0], batchIds: [bundleIds[0]], batchName: assets[0]?.bundleName || bundleIds[0], lerobotDirectory: delivery.directory, lerobotRelativeDirectory: delivery.relativeDirectory, lerobotValidation: delivery.validation, lerobotVersion: delivery.sourceVersion || delivery.version });
      const built = buildBundleManifest(state, { id: job.id, name: job.name, format: job.format, contents: job.contents, assetIds: job.assetIds, createdAt: job.createdAt, lerobot: delivery });
      if (job.fileName) fs.writeFileSync(path.join(exportDir, job.fileName), JSON.stringify(built.manifest, null, 2), "utf8");
      audit(state, "重建 LeRobot 交付目录", job.id, `${built.manifest.episodeCount} 条数据 · ${built.manifest.fileCount} 个文件 · ${delivery.validation.engine}`, "系统迁移");
      changed++;
    } catch (error) { console.warn(`LeRobot 交付目录重建失败 ${job.id}: ${error.message}`); }
  }
  if (changed) writeState(state);
  return changed;
}

function compactEmbodiedInfo(info) {
  const value = info || {};
  return {
    format: value.format || null,
    version: value.version || null,
    episodes: value.episodes ?? null,
    totalFrames: value.total_frames ?? null,
    totalDurationS: value.total_duration_s ?? null,
    fps: value.fps ?? null,
    robotType: value.robot_type || null,
    tasks: Array.isArray(value.tasks) ? value.tasks.slice(0, 20) : [],
    features: Array.isArray(value.features) ? value.features.map(item => ({ key: item.key, dtype: item.dtype, shape: item.shape, kind: item.kind })).slice(0, 100) : [],
    meta: value.meta || null,
    notes: Array.isArray(value.notes) ? value.notes.slice(0, 50) : [],
  };
}

function compactEmbodiedQuality(quality) {
  if (!quality || typeof quality !== "object") return null;
  return { stats: quality.stats || {}, anomalies: quality.anomalies || [], segments: quality.segments || undefined };
}

async function runEmbodiedBundleCheck(bundleId, assets) {
  const materialized = materializeEmbodiedBundle(bundleId, assets);
  try {
    const [detection, info, validation, quality] = await Promise.all([
      runEmbodiedCommand(["detect", materialized.datasetRoot, "--json"]),
      runEmbodiedCommand(["info", materialized.datasetRoot, "--json"]),
      runEmbodiedCommand(["validate", materialized.datasetRoot, "--json"]),
      runEmbodiedCommand(["quality", materialized.datasetRoot, "--json", "--no-anomalies"]),
    ]);
    return {
      bundleId,
      parser: "embodied-core",
      checkedAt: new Date().toISOString(),
      detection,
      info: compactEmbodiedInfo(info),
      validation: { ok: validation?.ok === true, score: validation?.score ?? null, errors: validation?.errors || 0, warnings: validation?.warnings || 0, infos: validation?.infos || 0, issues: validation?.issues || [] },
      quality: compactEmbodiedQuality(quality),
    };
  } finally {
    fs.rmSync(materialized.runRoot, { recursive: true, force: true });
  }
}
const LEGACY_DEMO_ASSETS = new Map([
  ["AST-0001", "厨房抓取-UMI-042"], ["AST-0002", "家庭整理-EGO-207"],
  ["AST-0003", "双臂装配-OP-118"], ["AST-0004", "零售分拣-UMI-019"],
]);
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".avi": "video/x-msvideo",
};

function defaultRules() {
  return [
    { id: "RULE-DATA-TYPE", code: "data_type", name: "数据类型合法性", scope: "全部", category: "规范性", threshold: "UMI / EGO / 遥操", severity: "高", enabled: true, locked: true, system: true },
    { id: "RULE-ORIGINAL", code: "original_file", name: "原始文件可用性", scope: "全部", category: "完整性", threshold: "服务端必须存在原始文件", severity: "高", enabled: true, locked: true, system: true },
    { id: "RULE-SIGNATURE", code: "file_signature", name: "文件格式签名校验", scope: "全部", category: "完整性", threshold: "扩展名与文件头一致", severity: "高", enabled: true, system: true },
    { id: "RULE-STRUCTURED", code: "structured_schema", name: "结构化字段完整性", scope: "全部", category: "完整性", threshold: "时间戳、动作/轨迹、观测字段齐全", severity: "高", enabled: true, system: true },
    { id: "RULE-DEEP", code: "deep_parse", name: "容器格式深度解析", scope: "全部", category: "可用性", threshold: "专用解析器验证内部时序", severity: "中", enabled: true, system: true },
    { id: "RULE-VIDEO-META", code: "video_metadata", name: "视频元数据可解码", scope: "全部", category: "可用性", threshold: "时长必须大于 0", severity: "中", enabled: true, system: true },
    { id: "RULE-VIDEO-RES", code: "video_resolution", name: "视频最低分辨率", scope: "全部", category: "清晰度", threshold: "640 x 480", severity: "中", enabled: true, system: true },
    { id: "RULE-TELE-CONTROL", code: "teleop_control", name: "遥操控制流关联", scope: "遥操", category: "同步性", threshold: "视频关联关节状态/控制指令流", severity: "中", enabled: true, system: true },
    { id: "RULE-UMI-TRAJECTORY", code: "umi_trajectory", name: "UMI 轨迹关联", scope: "UMI", category: "同步性", threshold: "视频关联 SLAM/末端轨迹", severity: "中", enabled: true, system: true },
    { id: "RULE-SEGMENT", code: "segment_completeness", name: "Episode 片段完整性", scope: "全部", category: "完整性", threshold: "轨迹与视频按 Episode / 相机逐项对应", severity: "高", enabled: true, locked: true, system: true },
    { id: "RULE-PRODUCTION", code: "production_evidence", name: "服务端生产检查", scope: "全部", category: "可用性", threshold: "完整结构解析、轨迹数值和视频实际解码；检查证据绑定文件哈希", severity: "高", enabled: true, locked: true, system: true },
  ];
}
function defaultSettings() {
  return { thresholds: { "快速质检": 85, "标准质检": 90, "全量质检": 93, "仅同步检测": 90 }, video: { minWidth: 640, minHeight: 480, blackMeanMax: 8, blackRatioMax: 0.95, freezeDifferenceMax: 0.15, freezeRatioMax: 0.98, durationToleranceSeconds: 0.1 }, hdf5: { gapAbsoluteMs: 100, gapFactor: 2.5, cadenceToleranceMs: 10, maxImagesPerDataset: 200, depthZeroRatioMax: 0.8 }, umi: { minCameraFps: 35, maxCameraFps: 45, minViveHz: 80, maxViveHz: 150, maxViveGapMs: 70, minClampHz: 50, maxClampHz: 70, maxClampGapMs: 50, maxStartOffsetMs: 100, maxEndOffsetMs: 100, minQuaternionNorm: 0.98, maxQuaternionNorm: 1.02, minClampValue: 0, maxClampValue: 100 }, issueWeights: { high: 35, medium: 8 } };
}
function defaultState() { return { assets: [], tasks: [], qcBatches: [], runs: [], audit: [], episodeTags: {}, issues: [], issueHistorySummary: { archivedCount: 0, lastCompactedAt: null }, annotations: [], annotationStandards: {}, annotationImports: [], exceptionReviews: [], exports: [], datasets: [], trainingJobs: [], feedbackSamples: [], nodes: [], members: [], bundles: [], notificationsReadAt: null, rules: defaultRules(), settings: defaultSettings() }; }
function compactStateCollections(state) {
  let changed = false;
  const issues = Array.isArray(state.issues) ? state.issues : [], closed = issues.filter(item => item.status === "已关闭"), open = issues.filter(item => item.status !== "已关闭"), keepClosed = 1000;
  if (closed.length > keepClosed) {
    closed.sort((left, right) => String(right.closedAt || right.updatedAt || right.createdAt || "").localeCompare(String(left.closedAt || left.updatedAt || left.createdAt || "")));
    const removed = closed.length - keepClosed;
    state.issues = [...open, ...closed.slice(0, keepClosed)];
    const summary = state.issueHistorySummary || { archivedCount: 0, lastCompactedAt: null };
    state.issueHistorySummary = { archivedCount: Number(summary.archivedCount || 0) + removed, lastCompactedAt: new Date().toISOString() };
    changed = true;
  }
  if (Array.isArray(state.qcBatches)) {
    state.qcBatches = state.qcBatches.map((batch, index) => {
      const results = Array.isArray(batch.results) ? batch.results : [], keep = index === 0 ? 300 : 50;
      if (results.length <= keep && !batch.resultsCompacted) return batch;
      changed = true;
      return { ...batch, resultCount: Number(batch.total || results.length), results: results.slice(0, keep), resultsCompacted: results.length > keep, resultSampleCount: Math.min(results.length, keep) };
    });
  }
  if (Array.isArray(state.runs) && state.runs.length > 100) { state.runs = state.runs.slice(0, 100); changed = true; }
  return changed;
}
function ensureStorage() {
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });
  fs.mkdirSync(deliveryDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });
  const store = getStore();
  if (!workLockOwned) {
    store.db.exec('CREATE TABLE IF NOT EXISTS service_owner (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL); BEGIN IMMEDIATE');
    try {
      const owner = store.db.prepare('SELECT pid FROM service_owner WHERE id=1').get();
      let alive = false;
      if (owner && owner.pid !== process.pid) { try { process.kill(owner.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; } }
      if (alive) throw new Error(`该工作目录已由服务进程 ${owner.pid} 使用；禁止同时启动第二个任务执行器。`);
      store.db.prepare('INSERT OR REPLACE INTO service_owner(id,pid) VALUES(1,?)').run(process.pid);
      store.db.exec('COMMIT'); workLockOwned = true;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  }
}
function readState() {
    const raw = getStore().read('state');
    const state = { ...defaultState(), ...raw };
    state.assets = (state.assets || []).map(item => {
      const schema = item.inspection?.lerobotSchema;
      if (schema?.path) {
        const { path: _legacyPath, ...cleanSchema } = schema;
        return { ...item, inspection: { ...item.inspection, lerobotSchema: cleanSchema }, isDemo: item.isDemo === true || LEGACY_DEMO_ASSETS.get(item.id) === item.name, serverManaged: Boolean(item.serverFile) };
      }
      return { ...item, isDemo: item.isDemo === true || LEGACY_DEMO_ASSETS.get(item.id) === item.name, serverManaged: Boolean(item.serverFile) };
    });
    state.tasks = (state.tasks || []).map(item => { const parsedTarget = Number(String(item.target || "").match(/\d+/)?.[0] || 0); return { ...item, scene: item.scene || "未填写场景", nodeIds: Array.isArray(item.nodeIds) ? item.nodeIds : item.node ? [item.node] : [], targetCount: Math.max(0, Number(item.targetCount || parsedTarget || 0)), acceptanceScore: Math.min(100, Math.max(0, Number(item.acceptanceScore || 90))), owner: item.owner || "未分配", status: item.status || "待启动" }; });
    state.annotations = Array.isArray(state.annotations) ? state.annotations : [];
    state.annotationImports = Array.isArray(state.annotationImports) ? state.annotationImports : [];
    state.runs = Array.isArray(state.runs) ? state.runs : [];
    state.exports = normalizeExportHistory({ assets: state.assets, exports: Array.isArray(state.exports) ? state.exports : [] });
    state.datasets = Array.isArray(state.datasets) ? state.datasets : [];
    state.trainingJobs = Array.isArray(state.trainingJobs) ? state.trainingJobs : [];
    state.feedbackSamples = Array.isArray(state.feedbackSamples) ? state.feedbackSamples : [];
    state.nodes = (Array.isArray(state.nodes) ? state.nodes : []).map(deriveNodeStatus);
    state.members = Array.isArray(state.members) ? state.members : [];
    state.issues = Array.isArray(state.issues) ? state.issues : [];
    state.exceptionReviews = Array.isArray(state.exceptionReviews) ? state.exceptionReviews : [];
    const legacyAnnotations = state.annotations.filter(item => !isCurrentAnnotation(state, item));
    state.legacyAnnotations = [...(Array.isArray(state.legacyAnnotations) ? state.legacyAnnotations : []), ...legacyAnnotations];
    state.annotations = state.annotations.filter(item => isCurrentAnnotation(state, item)).map(item => ({ ...item, groupKey: annotationGroupKeyForAnnotation(state, item) }));
    const rules = defaultRules();
    if (!Array.isArray(state.rules) || !state.rules.length) state.rules = rules;
    else {
      const knownCodes = new Set(state.rules.map(rule => rule.code));
      state.rules = [...state.rules, ...rules.filter(rule => rule.locked && !knownCodes.has(rule.code))];
    }
    state.settings = { ...defaultSettings(), ...(state.settings || {}), thresholds: { ...defaultSettings().thresholds, ...(state.settings?.thresholds || {}) }, video: { ...defaultSettings().video, ...(state.settings?.video || {}) }, hdf5: { ...defaultSettings().hdf5, ...(state.settings?.hdf5 || {}) }, umi: { ...defaultSettings().umi, ...(state.settings?.umi || {}) }, issueWeights: { ...defaultSettings().issueWeights, ...(state.settings?.issueWeights || {}) } };
    return getStore().track(state, 'state', raw);
}
let healthStateSummary = null;
function summarizeStateForHealth(state) {
  const assets = (state.assets || []).filter(item => !item.isDemo), productionIds = new Set(assets.map(item => item.id)), openIssues = (state.issues || []).filter(item => item.status !== "已关闭"), bundles = new Set(assets.map(item => item.bundleId).filter(Boolean)), accepted = new Set((state.bundles || []).filter(item => item.status === "已验收").map(item => item.id));
  return {
    assets: assets.length, demoAssets: (state.assets || []).length - assets.length,
    tasks: (state.tasks || []).length, tasksPendingAcceptance: (state.tasks || []).filter(item => item.status === "待验收").length,
    bundles: bundles.size, bundlesPendingAcceptance: 0, bundlesAccepted: [...bundles].filter(id => accepted.has(id)).length,
    annotations: (state.annotations || []).filter(item => !item.assetId || productionIds.has(item.assetId)).length,
    exports: (state.exports || []).length, datasets: (state.datasets || []).length, trainingJobs: (state.trainingJobs || []).length,
    feedbackSamples: (state.feedbackSamples || []).reduce((sum, item) => sum + Number(item.count || 0), 0),
    nodes: (state.nodes || []).length, nodesOnline: (state.nodes || []).filter(item => item.status === "在线").length,
    members: (state.members || []).length,
    exportEligible: assets.filter(item => item.status === "已通过" && item.bundleId && accepted.has(item.bundleId) && !openIssues.some(issue => issue.assetId === item.id)).length,
    issuesOpen: openIssues.filter(item => !item.assetId || productionIds.has(item.assetId)).length,
    rulesEnabled: (state.rules || []).filter(item => item.enabled !== false).length,
  };
}
function writeState(next) {
    compactStateCollections(next);
  getStore().write('state', next);
    healthStateSummary = summarizeStateForHealth(next);
}
function readAuth() {
    const value = getStore().read('auth');
    const users = Array.isArray(value.users) ? value.users : [], ownerId = String(value.ownerId || users[0]?.id || "");
    if (!value.sessionSecret || !Array.isArray(value.users)) throw new Error('认证记录结构损坏，请恢复备份。');
    return getStore().track({ ...value, ownerId, users: users.map(user => ({ ...user, isPlatformOwner: user.id === ownerId, canDeleteData: user.id === ownerId ? true : user.canDeleteData === true })), nodeCredentials: Array.isArray(value.nodeCredentials) ? value.nodeCredentials : [] }, 'auth', value);
}
function writeAuth(next) {
  getStore().write('auth', next);
}
function writeAccounts(auth, state) { compactStateCollections(state); getStore().writeMany([['auth', auth], ['state', state]]); healthStateSummary = summarizeStateForHealth(state); }

const JOB_ROUTES = { quality: '/api/qc/run', deep: '/api/assets/lerobot-deep-check', preview: '/api/episodes/preview', recheck: '/api/issues/recheck', convert: '/api/exports/convert', delivery: '/api/exports', backup: '/api/backup', verify: '/api/exports/verify' };
function publicJob(job) {
  const { key, sessionVersion, ...visible } = job;
  return visible;
}
function publicUploadTask(session) {
  const status = session.status === 'uploading' ? 'running' : session.status === 'paused' ? 'paused' : 'succeeded';
  return {
    id: `UP-${session.id}`,
    uploadSessionId: session.id,
    kind: 'upload',
    payload: { assetId: session.assetId, name: session.name, size: session.size },
    userId: session.userId,
    userName: session.userName || '上传用户',
    status,
    completed: Number(session.offset || 0),
    total: Number(session.size || 0),
    progress: session.size ? Number((Number(session.offset || 0) / Number(session.size) * 100).toFixed(1)) : 0,
    message: status === 'running' ? '正在上传' : status === 'paused' ? '上传已暂停' : '上传完成',
    createdAt: session.createdAt,
    startedAt: session.createdAt,
    finishedAt: session.completedAt || null,
  };
}
async function executeQueuedJob(job, progress) {
  const auth = readAuth(), user = auth.users.find(item => item.id === job.userId && item.status === '正常');
  if (!user || user.sessionVersion !== job.sessionVersion) throw new Error('任务提交账号或会话权限已变化，请重新提交。');
  const route = JOB_ROUTES[job.kind];
  if (!route) throw new Error('任务类型无效');
  // Execute the same authenticated API path as an interactive request, rechecking
  // role, domain and acceptance gates at execution time. No stored login cookies.
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify(job.payload))]);
  Object.assign(req, { method: 'POST', url: route, headers: { host: 'localhost', cookie: createSessionCookie(auth, user).split(';')[0], 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, progress });
  let status, result;
  const res = { writeHead(code) { status = code; }, end(bytes) { result = JSON.parse(bytes); } };
  await handleApi(req, res, route, new URL(route, 'http://localhost'));
  if (status >= 400 || !result?.ok) throw new Error(result?.error || '后台任务执行失败');
  return { batchId: result.batch?.id, exportId: result.job?.id, preview: result.preview, previewAssetId: result.previewAssetId, passRate: result.batch?.passRate, issueCount: result.batch?.issueCount, closed: result.closed, remaining: result.remaining, ...result.backupResult, verification: result.verification, report: result.report, embodied: result.embodied, checked: result.checked, manual: result.manual, deep: result.deep };
}

function productionInspectionContext(state, selected) {
  if (selected.every(asset => isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset))) return selected;
  const bundleIds = new Set(selected.map(asset => asset.bundleId));
  return state.assets.filter(asset => asset.serverFile && bundleIds.has(asset.bundleId));
}

async function inspectProductionAssets(state, ids, progress = () => {}) {
  const selected = state.assets.filter(asset => ids.includes(asset.id) && asset.serverFile);
  if (!selected.length) return;
  const context = productionInspectionContext(state, selected);
  const manifest = path.join(workDir, `.inspection-${crypto.randomUUID()}.json`);
  const python = findLerobotPython();
  if (!python) throw new Error('未配置含 pyarrow 的 Python，无法执行生产质检；原问题保留。');
  try {
    const inspectionContext = context.map(asset => ({ id: asset.id, name: asset.name, format: asset.format, bundleRole: asset.bundleRole, bundleId: asset.bundleId, relativePath: asset.relativePath, frameCount: asset.frameCount, serverFile: { storedName: asset.serverFile?.storedName, mode: asset.serverFile?.mode, fileCount: asset.serverFile?.fileCount, sha256: asset.serverFile?.sha256 } }));
    const estimatedFrames = selected.reduce((sum, asset) => sum + (isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset) ? Number(asset.frameCount || asset.serverFile?.fileCount || 0) : 1), 0);
    progress({ completed: 0, total: estimatedFrames, message: `正在读取 ${context.length} 个 Episode 的源文件清单` });
    const prepared = await prepareInspectionManifest(inspectionContext, uploadDir, manifest, { ...state.settings.video, hdf5: state.settings.hdf5 || {} }, item => {
      progress({ completed: 0, total: estimatedFrames, message: `正在读取源文件清单 ${Number(item.completedAssets || 0)}/${Number(item.totalAssets || 0)} 个 Episode${item.assetName ? ` · ${item.assetName}` : ''}` });
    });
    const frameById = new Map(prepared.frames.map(item => [item.id, Number(item.count || 1)])), selectedFrames = selected.reduce((sum, asset) => sum + Number(frameById.get(asset.id) || 1), 0);
    const frameTotals = new Map(prepared.frames.map(item => [item.id, Number(item.count || 1)])), priorFrames = new Map();
    let cumulativeFrames = 0;
    for (const frame of prepared.frames) { priorFrames.set(frame.id, cumulativeFrames); cumulativeFrames += Number(frame.count || 1); }
    progress({ completed: 0, total: selectedFrames, message: `源文件清单已完成，开始逐帧解码和解析 ${selected.length} 个 Episode / ${selectedFrames} 帧` });
    const { stdout } = await runCommandWithProgress(python, [path.join(root, 'tools', 'production_check.py'), '--manifest', manifest], {
      timeout: 1800000, maxBuffer: 32 * 1024 * 1024,
      onProgress: item => {
        if (!item?.assetId || !frameTotals.has(item.assetId)) return;
        const completed = Math.min(selectedFrames, (priorFrames.get(item.assetId) || 0) + Number(item.completed || 0));
        progress({ completed, total: selectedFrames, message: `正在逐帧解码和解析 ${completed}/${selectedFrames} 帧` });
      },
    });
    const report = JSON.parse(stdout);
    if (!report.ok) throw new Error(report.error || '生产检查未完成');
    for (const result of report.files) {
      const asset = selected.find(item => item.id === result.id);
      if (!asset) continue;
      const checkedAt = new Date().toISOString();
      const mediaReview = asset.inspection?.production?.mediaReview;
      const preparedFingerprint = prepared.fingerprints[asset.id];
      const actualHash = preparedFingerprint || await backupTools.digest(path.join(uploadDir, asset.serverFile.storedName));
      asset.inspection = { ...(asset.inspection || {}), production: { ...result, ...(actualHash !== asset.serverFile.sha256 ? {error:'源文件指纹已变化，请恢复原文件或重新导入该 Episode'} : {}), checkedAt, sha256: asset.serverFile.sha256, sourceFingerprint: actualHash, ...(mediaReview?.sha256 === actualHash ? { mediaReview } : {}) } };
      if (result.schema) asset.inspection.lerobotSchema = { ...result.schema, checkedAt, parser: 'pyarrow' };
      if (result.schema) asset.serverFile.deepCheck = { status: 'verified', detail: '已由 PyArrow 读取 Parquet 容器与内部列', checkedAt };
      if (result.hdf5) asset.serverFile.deepCheck = { status: result.hdf5.status === 'invalid' ? 'invalid' : result.hdf5.status === 'not_supported' ? 'not_supported' : 'verified', detail: result.hdf5.status === 'verified' ? `已解析 ${result.hdf5.metrics?.sampleCount || 0} 个 HDF5 采样` : (result.hdf5.issues?.[0]?.message || 'HDF5 结构解析未通过'), checkedAt };
      if (result.umi) asset.serverFile.deepCheck = { status: result.umi.status === 'invalid' ? 'invalid' : result.umi.status === 'warning' ? 'warning' : 'verified', detail: `UMI ${result.umi.metrics?.cameraFrames || 0} 个 RGB 帧 · ${result.umi.metrics?.viveSamples || 0} 个 VIVE 样本 · ${result.umi.metrics?.clampSamples || 0} 个夹爪样本`, checkedAt };
      if (result.structure?.status === 'verified') asset.serverFile.contentCheck = { ...(asset.serverFile.contentCheck || {}), fields: result.structure.fields, recordCount: result.structure.recordCount };
      if (result.media) asset.mediaMetadata = { width: result.media.width, height: result.media.height, duration: result.media.duration, fps: result.media.fps, verifiedBy: 'pyav' };
    }
    progress({ completed: selectedFrames, total: selectedFrames, message: '文件检查完成，正在归档问题证据' });
  } catch (error) { throw new Error(`生产检查未完成，未关闭原问题：${error.message}`); }
  finally { fs.rmSync(manifest, { force: true }); }
}
function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, role: user.role, domain: user.domain, status: user.status, permissions: ROLE_POLICIES[user.role] || [], canDeleteData: user.canDeleteData === true, isPlatformOwner: user.isPlatformOwner === true } : null;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("base64url") };
}
function verifyPassword(password, user) {
  try {
    const actual = crypto.scryptSync(String(password), user.passwordSalt, 64), expected = Buffer.from(user.passwordHash, "base64url");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
function createNodeCredential(auth, nodeId) {
  const token = `nd_${String(nodeId).toLowerCase()}_${crypto.randomBytes(32).toString("base64url")}`, now = new Date().toISOString();
  const credential = { nodeId, tokenHash: hashToken(token), status: "正常", createdAt: now, rotatedAt: now, lastUsedAt: null };
  const index = auth.nodeCredentials.findIndex(item => item.nodeId === nodeId);
  if (index >= 0) auth.nodeCredentials[index] = credential; else auth.nodeCredentials.push(credential);
  return { token, credential };
}
function authenticateNode(req, auth, state) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (!match) return null;
  const tokenHash = hashToken(match[1]), credential = auth.nodeCredentials.find(item => item.status === "正常" && item.tokenHash === tokenHash);
  if (!credential) return null;
  const node = state.nodes.find(item => item.id === credential.nodeId);
  return node ? { credential, user: { id: `node:${node.id}`, name: "节点代理", role: "节点代理", domain: node.type, status: "正常", permissions: ["节点管理"], nodeId: node.id, isNodeCredential: true } } : null;
}
function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 10 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) throw new Error("密码至少 10 位，并同时包含字母和数字");
  return value;
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }));
}
function createSessionCookie(auth, user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + 8 * 60 * 60 * 1000, version: user.sessionVersion || 1 })).toString("base64url");
  const signature = crypto.createHmac("sha256", auth.sessionSecret).update(payload).digest("base64url");
  return `embodied_session=${encodeURIComponent(payload + "." + signature)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
}
function sessionUser(req, auth) {
  try {
    const token = parseCookies(req).embodied_session || "", [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", auth.sessionSecret).update(payload).digest(), actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.sub || Number(claims.exp) <= Date.now()) return null;
    const user = auth.users.find(item => item.id === claims.sub);
    return user && user.status === "正常" && Number(user.sessionVersion || 1) === Number(claims.version || 1) ? user : null;
  } catch { return null; }
}
function permissionFor(req, pathname) {
  if (req.method === "GET") return null;
  if (req.method === "PUT" && /^\/api\/assets\/[^/]+\/content$/.test(pathname)) return ["资产上传", "资产管理"];
  const rules = [
    [/^\/api\/assets\/batch$/, ['资产上传', '资产管理']],
    [/^\/api\/bundles(?:\/status)?$/, ["资产管理"]],
    [/^\/api\/episodes\/preview$/, ['资产查看', '运行质检', '资产管理']],
    [/^\/api\/episodes\/[^/]+\/preview$/, ['资产管理']],
    [/^\/api\/imports\/(?:rollback|analyze|server-directory)$/, ["资产上传", "资产管理"]],
    [/^\/api\/assets\/lerobot-deep-check$/, ["运行质检", "资产管理"]], [/^\/api\/assets\/bulk-delete$/, ["删除数据"]], [/^\/api\/assets\/[^/]+$/, ["删除数据"]], [/^\/api\/assets$/, ["资产上传", "资产管理"]], [/^\/api\/tasks(?:\/status|\/[^/]+)?$/, ["采集任务"]],
    [/^\/api\/annotations\//, ["标注编辑", "标注审核", "资产管理"]], [/^\/api\/exports(?:\/(?:convert|verify))?$/, ["数据集发布"]],
    [/^\/api\/datasets(?:\/status)?$/, ["数据集发布"]], [/^\/api\/training\/feedback$/, ["失败样本回流", "训练调度"]],
    [/^\/api\/training(?:\/status)?$/, ["训练调度"]], [/^\/api\/nodes/, ["节点管理"]],
    [/^\/api\/members/, ["成员管理"]], [/^\/api\/qc/, ["运行质检", "资产管理"]], [/^\/api\/issues\/recheck$/, ["运行质检", "问题处置"]],
    [/^\/api\/episode-tags$/, ["标注审核", "资产管理"]], [/^\/api\/issues\/(update|review-media)$/, ["问题处置"]], [/^\/api\/exceptions\/review$/, ["标注审核", "问题处置", "资产管理"]],
    [/^\/api\/rules\//, ["规则管理"]], [/^\/api\/(settings|backup|storage\/reconcile)$/, ["平台设置"]],
  ];
  return rules.find(([pattern]) => pattern.test(pathname))?.[1] || null;
}
function isAdministrator(user) { return user?.role === "数据治理负责人"; }
function hasPermission(user, required = [], auth = null) {
  if (required.includes("删除数据")) return user?.canDeleteData === true || Boolean(auth && user?.id === auth.ownerId);
  if (isAdministrator(user)) return true;
  const permissions = user?.permissions || ROLE_POLICIES[user?.role] || [];
  return required.some(permission => permissions.includes(permission));
}
function readPermissionFor(pathname) {
  const rules = [
    [/^\/api\/engine\/capabilities$/, ["资产查看", "运行质检"]],
    [/^\/api\/bundles(?:\/|$)/, ["资产查看", "资产管理"]],
    [/^\/api\/assets(?:\/|$)/, ["资产查看", "资产上传", "资产管理"]], [/^\/api\/tasks(?:\/|$)/, ["采集任务"]],
    [/^\/api\/issues$/, ["问题查看", "问题处置"]], [/^\/api\/annotations$/, ["标注查看", "标注编辑", "标注审核"]],
    [/^\/api\/exports(?:\/|$)/, ["数据集发布"]], [/^\/api\/datasets$/, ["数据集查看", "数据集发布", "训练调度"]],
    [/^\/api\/training$/, ["训练调度", "数据集查看", "失败样本回流"]], [/^\/api\/nodes$/, ["节点管理"]],
    [/^\/api\/members$/, ["成员管理"]], [/^\/api\/rules$/, ["规则管理", "运行质检", "资产查看"]],
    [/^\/api\/ops$/, ["平台设置"]],
  ];
  return rules.find(([pattern]) => pattern.test(pathname))?.[1] || null;
}
function typeAllowed(user, type) { return !user || isAdministrator(user) || user?.domain === "全部数据域" || !DATA_TYPES.includes(type) || user?.domain === type; }
function assertTypeAllowed(user, type) { if (!typeAllowed(user, type)) { const error = new Error(`当前账号仅允许访问 ${user.domain} 数据域`); error.status = 403; throw error; } }
function taskMetrics(state, task) {
  const assets = state.assets.filter(asset => !asset.isDemo && asset.taskId === task.id);
  const openIssueIds = new Set(state.issues.filter(issue => issue.status !== "已关闭").map(issue => issue.assetId));
  const targetCount = Math.max(0, Number(task.targetCount || 0));
  const acceptanceScore = Math.min(100, Math.max(0, Number(task.acceptanceScore || 90)));
  const uploaded = assets.filter(asset => asset.serverFile).length;
  const accepted = assets.filter(asset => asset.serverFile && asset.status === "已通过" && Number(asset.score || 0) >= acceptanceScore && !openIssueIds.has(asset.id)).length;
  const openIssues = assets.reduce((sum, asset) => sum + state.issues.filter(issue => issue.assetId === asset.id && issue.status !== "已关闭").length, 0);
  const progress = targetCount ? Math.min(100, Number((assets.length / targetCount * 100).toFixed(1))) : 0;
  return { assetCount: assets.length, uploaded, accepted, openIssues, targetCount, acceptanceScore, progress, acceptanceReady: targetCount > 0 && accepted >= targetCount && openIssues === 0 };
}
function enrichTask(state, task) { return { ...task, metrics: taskMetrics(state, task) }; }
function isProductionLinkedRecord(state, record) {
  if (!record?.assetId) return true;
  return state.assets.find(item => item.id === record.assetId)?.isDemo !== true;
}
function isCurrentAnnotation(state, item) {
  if (!item?.bundleId || !Number.isInteger(item.episodeIndex)) return false;
  const asset = state.assets.find(asset => asset.id === item.assetId);
  return Boolean(asset && !asset.isDemo && asset.bundleId === item.bundleId && isLogicalEpisodeAsset(asset));
}
function annotationGroupKeyForAsset(asset) {
  const taskId = String(asset?.taskId || "").trim();
  return taskId ? `TASK:${taskId}` : String(asset?.bundleId || "").trim();
}
function annotationGroupKeyForAnnotation(state, item) {
  const asset = state.assets.find(candidate => candidate.id === item?.assetId);
  return String((asset ? annotationGroupKeyForAsset(asset) : "") || item?.groupKey || item?.bundleId || "").trim();
}

const ANNOTATION_SOURCE_LIMIT = 32 * 1024 * 1024;
function annotationSourceKind(value) {
  const relative = String(value?.relativePath || value?.name || value || "").replace(/\\/g, "/");
  if (!/\.jsonl$/i.test(relative)) return "";
  const name = path.posix.basename(relative).toLowerCase();
  if (name === "tasks.jsonl") return "tasks";
  if (name === "episodes.jsonl") return "episodes";
  if (/(^|[._-])annotations?([._-]|$)/i.test(name) || /annotation/i.test(relative)) return "annotations";
  return "";
}

function annotationEpisodeIndex(value) {
  if (Number.isInteger(Number(value)) && Number(value) >= 0) return Number(value);
  const match = /episode[_-]?0*(\d+)/i.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

function parseAnnotationJsonl(text, label) {
  const rows = [];
  String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); }
    catch (error) { throw new Error(`${label} 第 ${index + 1} 行不是有效 JSON：${error.message}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 第 ${index + 1} 行必须是 JSON 对象`);
    rows.push({ ...value, __line: index + 1 });
  });
  if (!rows.length) throw new Error(`${label} 没有有效记录`);
  return rows;
}

function importedInstruction(row, taskMap) {
  const candidates = [
    row?.instruction, row?.task_instruction, row?.language_instruction, row?.prompt,
    row?.annotation?.instruction, row?.annotations?.instruction, row?.label?.instruction,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return value.slice(0, 4000);
  }
  const taskIndex = Number(row?.task_index ?? row?.taskIndex);
  if (Number.isInteger(taskIndex) && taskIndex >= 0 && taskMap.has(taskIndex)) return taskMap.get(taskIndex);
  if (typeof row?.task === "string" && row.task.trim()) return row.task.trim().slice(0, 4000);
  const tasks = Array.isArray(row?.tasks) ? row.tasks : Array.isArray(row?.task) ? row.task : [];
  const values = tasks.flatMap(item => {
    if (typeof item === "string") return [item.trim()];
    if (Number.isInteger(Number(item?.task_index ?? item?.taskIndex)) && taskMap.has(Number(item.task_index ?? item.taskIndex))) return [taskMap.get(Number(item.task_index ?? item.taskIndex))];
    return [String(item?.task || item?.instruction || "").trim()];
  }).filter(Boolean);
  return [...new Set(values)].join("\n").slice(0, 4000);
}

function importedSegments(row) {
  const values = Array.isArray(row?.segments) ? row.segments : Array.isArray(row?.action_segments) ? row.action_segments : [];
  if (!values.length) return [];
  try {
    return normalizeAnnotationSegments(values.map(item => ({
      startFrame: item?.startFrame ?? item?.start_frame,
      endFrame: item?.endFrame ?? item?.end_frame,
      skill: item?.skill,
      object: item?.object,
    })));
  } catch { return []; }
}

function parseAnnotationImportSources(input = {}) {
  const sources = (Array.isArray(input.sources) ? input.sources : []).filter(source => source && annotationSourceKind(source.relativePath || source));
  const allowedEpisodes = new Set((input.episodeIndices || []).map(Number).filter(Number.isInteger));
  const taskIndicesByEpisode = input.taskIndicesByEpisode || {}, taskMap = new Map(), parsed = [], errors = [], warnings = [];
  sources.forEach(source => {
    const kind = source.kind || annotationSourceKind(source.relativePath || source);
    try { parsed.push({ ...source, kind, rows: parseAnnotationJsonl(source.text, source.relativePath || source.assetId || kind) }); }
    catch (error) { errors.push({ assetId: source.assetId || "", relativePath: source.relativePath || "", kind, error: error.message }); }
  });
  parsed.filter(source => source.kind === "tasks").forEach(source => source.rows.forEach(row => {
    const index = Number(row.task_index ?? row.taskIndex), task = String(row.task || row.instruction || "").trim();
    if (Number.isInteger(index) && index >= 0 && task) taskMap.set(index, task.slice(0, 4000));
  }));
  const layers = { annotations: new Map(), episodes: new Map(), tasks: new Map() };
  const add = (layer, episodeIndex, entry) => {
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) return;
    if (allowedEpisodes.size && !allowedEpisodes.has(episodeIndex)) return;
    const current = layers[layer].get(episodeIndex);
    if (current && current.instruction !== entry.instruction) {
      const detail = `Episode ${episodeIndex} 在同一来源层存在冲突指令，已保留首个有效值`;
      warnings.push(detail);
      errors.push({ assetId: entry.source?.assetId || "", relativePath: entry.source?.relativePath || "", kind: layer, error: detail });
      return;
    }
    if (!current) layers[layer].set(episodeIndex, entry);
  };
  parsed.filter(source => ["episodes", "annotations"].includes(source.kind)).forEach(source => source.rows.forEach(row => {
    const episodeIndex = annotationEpisodeIndex(row.episode_index ?? row.episodeIndex ?? row.episode ?? row.episode_id ?? row.episodeId);
    const instruction = importedInstruction(row, taskMap);
    if (episodeIndex == null || !instruction) return;
    const review = row.review && typeof row.review === "object" ? row.review : {};
    add(source.kind, episodeIndex, {
      episodeIndex, instruction,
      outcome: ["success", "failure"].includes(String(row.outcome || row.result || "").toLowerCase()) ? String(row.outcome || row.result).toLowerCase() : "",
      failureReason: String(row.failure_reason ?? row.failureReason ?? "").trim(),
      tags: [...new Set((Array.isArray(row.tags) ? row.tags : []).map(String).map(value => value.trim()).filter(Boolean))].slice(0, 30),
      segments: importedSegments(row),
      source: { assetId: source.assetId || "", relativePath: source.relativePath || "", kind: source.kind, line: row.__line, sha256: source.sha256 || "", reviewStatus: String(review.status || "").trim() },
    });
  }));
  Object.entries(taskIndicesByEpisode).forEach(([episode, indices]) => {
    const episodeIndex = Number(episode), instructions = [...new Set((Array.isArray(indices) ? indices : [indices]).map(Number).filter(Number.isInteger).map(index => taskMap.get(index)).filter(Boolean))];
    if (!instructions.length) return;
    const source = parsed.find(item => item.kind === "tasks");
    add("tasks", episodeIndex, {
      episodeIndex, instruction: instructions.join("\n").slice(0, 4000), outcome: "", failureReason: "", tags: [], segments: [],
      source: { assetId: source?.assetId || "", relativePath: source?.relativePath || "", kind: "tasks", line: null, sha256: source?.sha256 || "", derivedFrom: "parquet.task_index" },
    });
  });
  const entries = [...layers.annotations.values(), ...[...layers.episodes.entries()].filter(([episode]) => !layers.annotations.has(episode)).map(([, entry]) => entry),
    ...[...layers.tasks.entries()].filter(([episode]) => !layers.annotations.has(episode) && !layers.episodes.has(episode)).map(([, entry]) => entry)]
    .sort((left, right) => left.episodeIndex - right.episodeIndex);
  return { entries, errors, warnings, taskCount: taskMap.size, sourceCount: sources.length, validSourceCount: parsed.length };
}

function scopedState(state, user) {
  const assets = hasPermission(user, ["资产查看", "资产上传", "资产管理", "运行质检", "标注查看", "标注审核", "问题查看", "问题处置"]) ? state.assets.filter(item => !item.isDemo && typeAllowed(user, item.type)) : [];
  const assetIds = new Set(assets.map(item => item.id));
  const tasks = hasPermission(user, ["采集任务"]) ? state.tasks.filter(item => typeAllowed(user, item.type)).map(item => enrichTask(state, item)) : [];
  const issues = hasPermission(user, ["问题查看", "问题处置"]) ? state.issues.filter(item => typeAllowed(user, item.type) && (!item.assetId || assetIds.has(item.assetId))) : [];
  const annotations = hasPermission(user, ["标注查看", "标注审核"]) ? state.annotations.filter(item => isCurrentAnnotation(state, item) && typeAllowed(user, item.type) && assetIds.has(item.assetId)) : [];
  const nodes = hasPermission(user, ["节点管理"]) ? state.nodes.filter(item => typeAllowed(user, item.type)) : [];
  const qcBatches = hasPermission(user, ["运行质检", "资产查看", "资产管理"]) ? state.qcBatches.map(batch => { const results = (batch.results || []).filter(item => typeAllowed(user, item.type)); return { ...batch, results, targetIds: results.map(item => item.assetId), total: results.length, passed: results.filter(item => item.status === "已通过").length, issueCount: results.reduce((sum, item) => sum + (item.issues || []).length, 0) }; }).filter(batch => batch.total) : [];
  const runs = hasPermission(user, ["运行质检", "资产查看", "资产管理"]) ? state.runs.filter(run => !run.targetIds?.length || run.targetIds.some(id => assetIds.has(id))) : [];
  const datasets = hasPermission(user, ["数据集查看", "数据集发布", "训练调度"]) ? state.datasets.map(dataset => { const visibleAssets = (dataset.assets || []).filter(item => typeAllowed(user, item.type)); if (!visibleAssets.length) return null; const composition = DATA_TYPES.reduce((result, type) => typeAllowed(user, type) ? { ...result, [type]: visibleAssets.filter(item => item.type === type).length } : result, {}); return { ...dataset, assets: visibleAssets, assetCount: visibleAssets.length, totalBytes: visibleAssets.reduce((sum, item) => sum + Number(item.size || 0), 0), composition, checksum: isAdministrator(user) ? dataset.checksum : undefined, scoped: !isAdministrator(user) && user.domain !== "全部数据域" }; }).filter(Boolean) : [];
  const datasetIds = new Set(datasets.map(item => item.id));
  const trainingJobs = hasPermission(user, ["训练调度", "数据集查看"]) ? state.trainingJobs.filter(item => datasetIds.has(item.datasetId)) : [];
  const feedbackSamples = hasPermission(user, ["失败样本回流", "训练调度"]) ? state.feedbackSamples.filter(item => typeAllowed(user, item.type) && (!item.datasetId || datasetIds.has(item.datasetId))) : [];
  const rules = state.rules.filter(rule => rule.scope === "全部" || typeAllowed(user, rule.scope));
  const episodeIds = new Set(assets.map(item => `EP-${item.id}`)), episodeTags = Object.fromEntries(Object.entries(state.episodeTags || {}).filter(([id]) => episodeIds.has(id)));
  const bundleIds = new Set(assets.map(item => item.bundleId).filter(Boolean)), bundles = (state.bundles || []).filter(item => bundleIds.has(item.id));
  const v6Workflows = Object.fromEntries(bundleList(state, user).map(bundle => [bundle.id, deriveV6Workflow(state, bundle.id, user)]).filter(([, workflow]) => workflow));
  const annotationGroups = hasPermission(user, ["标注查看", "标注编辑", "标注审核"]) ? annotationGroupList(state, user) : [], annotationGroupKeys = new Set(annotationGroups.map(item => item.key));
  const annotationStandards = Object.fromEntries(Object.entries(state.annotationStandards || {}).filter(([key]) => annotationGroupKeys.has(key)));
  const exports = hasPermission(user, ["数据集发布"]) ? state.exports.filter(job => (job.assetIds || []).every(id => assetIds.has(id))).map(job => {
    const gate = bundleGate(state, job.batchId, user), fingerprint = deliverySourceFingerprint(state, job);
    return { ...job, conversions: Object.fromEntries(Object.entries(job.conversions || {}).map(([format, output]) => [format, { ...output, current: output.ok === true && output.independentVerification?.ok === true && gate?.ready === true && gate.status === "已验收" && output.sourceFingerprint === fingerprint }])) };
  }) : [];
  const exceptionReviews = state.exceptionReviews.filter(review => assetIds.has(review.assetId) && typeAllowed(user, review.type));
  return { ...state, assets, tasks, issues, annotations, annotationStandards, annotationGroups, exceptionReviews, v6Workflows, nodes, qcBatches, runs, datasets, trainingJobs, feedbackSamples, rules, episodeTags, bundles, exports, members: hasPermission(user, ["成员管理"]) ? state.members : [], audit: hasPermission(user, ["成员管理", "平台设置"]) ? state.audit : [] };
}
function loginAttemptKey(req, email) { return `${req.socket.remoteAddress || "unknown"}:${email}`; }
function checkLoginLimit(key) {
  const record = loginFailures.get(key); if (!record) return;
  if (Date.now() - record.firstAt > 15 * 60 * 1000) { loginFailures.delete(key); return; }
  if (record.count >= 5) { const error = new Error("登录失败次数过多，请 15 分钟后重试"); error.status = 429; throw error; }
}
function recordLoginFailure(key) {
  const current = loginFailures.get(key), now = Date.now();
  loginFailures.set(key, !current || now - current.firstAt > 15 * 60 * 1000 ? { count: 1, firstAt: now } : { ...current, count: current.count + 1 });
}
function sendJson(res, status, value, headers = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length >= 32 * 1024 && /gzip/i.test(String(res.req?.headers?.['accept-encoding'] || ''))) {
    const compressed = zlib.gzipSync(payload, { level: 6 });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': compressed.length, ...headers });
    res.end(compressed);
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': payload.length, ...headers });
  res.end(payload);
}
function sendError(res, status, message, extra = {}) { sendJson(res, status, { ok: false, error: message, ...extra }); }
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function safeName(name) { return String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180); }
function mergeRecord(list, record) { const index = list.findIndex(item => item.id === record.id); if (index >= 0) list[index] = { ...list[index], ...record }; else list.unshift(record); }
function audit(state, action, target, detail, user = "系统") {
  state.audit.unshift({ time: new Date().toLocaleString("zh-CN", { hour12: false }), user, action, target, detail });
  state.audit = state.audit.slice(0, 1000);
}

function deriveNodeStatus(node) {
  const heartbeat = Date.parse(node.lastHeartbeat || ""), ageSeconds = Number.isFinite(heartbeat) ? Math.max(0, Math.floor((Date.now() - heartbeat) / 1000)) : null;
  return { ...node, heartbeatAgeSeconds: ageSeconds, status: ageSeconds != null && ageSeconds <= 300 ? "在线" : "离线" };
}

function buildNotifications(state) {
  const items = [], open = state.issues.filter(item => item.status !== "已关闭"), high = open.filter(item => item.level === "高"), pendingAnnotations = state.annotations.filter(item => isCurrentAnnotation(state, item) && ["待审核", "待标注", "标注中"].includes(item.status)), runningTasks = state.tasks.filter(item => item.status === "进行中"), pendingAcceptance = state.tasks.filter(item => item.status === "待验收"), overdueTasks = state.tasks.filter(item => ["待启动", "进行中", "已暂停"].includes(item.status) && item.deadline && Date.parse(item.deadline + "T23:59:59") < Date.now()), runningTraining = state.trainingJobs.filter(item => item.status === "运行中"), offlineNodes = state.nodes.map(deriveNodeStatus).filter(item => item.status === "离线"), pendingBundles = bundleList(state).filter(item => ["可提交验收", "待验收"].includes(item.status));
  if (high.length) items.push({ id: "NOTICE-HIGH-ISSUES", title: `${high.length} 个高等级质量问题待处理`, detail: `共 ${open.length} 个未关闭问题，阻止数据验收与交付`, page: "issues", severity: "high", time: high[0].updatedAt || high[0].createdAt || new Date().toISOString() });
  if (pendingAcceptance.length) items.push({ id: "NOTICE-TASK-ACCEPTANCE", title: `${pendingAcceptance.length} 个采集任务等待验收签署`, detail: "请核对目标产出、质量门槛和阻断问题后完成签署", page: "tasks", severity: "medium", time: pendingAcceptance[0].submittedAt || pendingAcceptance[0].updatedAt });
  if (pendingBundles.length) items.push({ id: "NOTICE-BUNDLE-ACCEPTANCE", title: `${pendingBundles.length} 个数据包等待验收`, detail: pendingBundles.slice(0, 3).map(item => `${item.name} · ${item.status}`).join("；"), page: "overview", severity: "medium", time: pendingBundles[0].submittedAt || new Date().toISOString() });
  if (overdueTasks.length) items.push({ id: "NOTICE-TASK-OVERDUE", title: `${overdueTasks.length} 个采集任务已经逾期`, detail: overdueTasks.slice(0, 3).map(item => item.name).join("、"), page: "tasks", severity: "high", time: new Date().toISOString() });
  if (pendingAnnotations.length) items.push({ id: "NOTICE-ANNOTATIONS", title: `${pendingAnnotations.length} 个标注任务等待处理`, detail: "审核结果将参与数据集和交付门禁", page: "annotation", severity: "medium", time: pendingAnnotations[0].updatedAt || pendingAnnotations[0].createdAt || new Date().toISOString() });
  if (offlineNodes.length) items.push({ id: "NOTICE-NODES", title: `${offlineNodes.length} 个采集节点离线`, detail: "节点超过 5 分钟没有上报心跳", page: "nodes", severity: "high", time: offlineNodes[0].lastHeartbeat || new Date().toISOString() });
  if (runningTasks.length) items.push({ id: "NOTICE-TASKS", title: `${runningTasks.length} 个采集任务正在运行`, detail: "请关注节点心跳和数据上传状态", page: "tasks", severity: "info", time: runningTasks[0].updatedAt || runningTasks[0].createdAt || new Date().toISOString() });
  if (runningTraining.length) items.push({ id: "NOTICE-TRAINING", title: `${runningTraining.length} 个训练任务等待外部回报`, detail: "平台仅记录调度状态，不模拟训练进度", page: "training", severity: "info", time: runningTraining[0].updatedAt || runningTraining[0].createdAt || new Date().toISOString() });
  const readAt = Date.parse(state.notificationsReadAt || "") || 0;
  return { items, readAt: state.notificationsReadAt, unread: items.filter(item => (Date.parse(item.time) || Date.now()) > readAt).length };
}

function detectSignature(buffer, name, totalSize = buffer.length) {
  const ext = path.extname(name).toLowerCase(), head = buffer.subarray(0, 16), hex = head.toString("hex"), ascii = head.toString("ascii");
  let signature = "unknown", valid = true, recordCount = null, fields = [];
  if ([".h5", ".hdf5"].includes(ext)) { signature = "hdf5"; valid = findHdf5Signature(buffer) >= 0; }
  else if ([".mp4", ".mov", ".m4v"].includes(ext)) { signature = "iso-bmff"; valid = buffer.subarray(4, 8).toString("ascii") === "ftyp"; }
  else if (ext === ".webm") { signature = "webm"; valid = hex.startsWith("1a45dfa3"); }
  else if (ext === ".mcap") { signature = "mcap"; valid = ascii.includes("MCAP"); }
  else if (ext === ".parquet") { signature = "parquet"; valid = ascii.startsWith("PAR1"); }
  else if (ext === ".zip") { signature = "zip"; valid = hex.startsWith("504b0304"); }
  else if ([".json", ".jsonl", ".csv"].includes(ext)) {
    signature = "structured";
    if (totalSize <= SAMPLE_LIMIT) {
      try {
        const source = buffer.toString("utf8");
        if (ext === ".json") { const parsed = JSON.parse(source); recordCount = Array.isArray(parsed) ? parsed.length : 1; fields = Object.keys(Array.isArray(parsed) ? (parsed[0] || {}) : (parsed || {})); }
        if (ext === ".jsonl") { const lines = source.split(/\r?\n/).filter(line => line.trim()); recordCount = lines.length; fields = Object.keys(JSON.parse(lines[0] || "{}")); }
        if (ext === ".csv") { const lines = source.split(/\r?\n/).filter(line => line.trim()); recordCount = Math.max(lines.length - 1, 0); fields = (lines[0] || "").split(",").map(value => value.trim()).filter(Boolean); }
      } catch { valid = false; }
    }
  }
  return { signature, valid, extension: ext.slice(1).toUpperCase() || "RAW", inspectedBytes: Math.min(buffer.length, SAMPLE_LIMIT), recordCount, fields };
}

function findHdf5Signature(buffer) {
  const magic = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let offset = 0; offset + magic.length <= buffer.length; offset = offset === 0 ? 512 : offset * 2) {
    if (buffer.subarray(offset, offset + magic.length).equals(magic)) return offset;
  }
  return -1;
}

function inspectContainerFile(filePath, originalName, contentCheck) {
  const ext = path.extname(originalName).toLowerCase(), stat = fs.statSync(filePath), size = stat.size;
  const result = { status: "not_applicable", validator: "none", detail: "该格式不需要容器首尾校验" };
  if (![".h5", ".hdf5", ".mcap", ".parquet", ".zip"].includes(ext)) return result;
  const headSize = Math.min(size, SAMPLE_LIMIT), head = Buffer.alloc(headSize), descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, head, 0, headSize, 0);
    const tailSize = Math.min(size, 128 * 1024), tail = Buffer.alloc(tailSize);
    fs.readSync(descriptor, tail, 0, tailSize, Math.max(0, size - tailSize));
    if ([".h5", ".hdf5"].includes(ext)) {
      const offset = findHdf5Signature(head), version = offset >= 0 && offset + 8 < head.length ? head[offset + 8] : null, valid = offset >= 0 && [0, 1, 2, 3].includes(version);
      return { status: valid ? "verified" : "invalid", validator: "hdf5-superblock", detail: valid ? `HDF5 超级块 v${version}，签名偏移 ${offset}` : "未发现有效 HDF5 超级块", signatureOffset: offset, superblockVersion: version };
    }
    if (ext === ".mcap") {
      const magic = Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]), valid = head.subarray(0, 8).equals(magic) && tail.subarray(-8).equals(magic);
      return { status: valid ? "verified" : "invalid", validator: "mcap-boundary", detail: valid ? "MCAP 首尾魔数完整" : "MCAP 首尾魔数缺失或损坏" };
    }
    if (ext === ".parquet") {
      const starts = head.subarray(0, 4).toString("ascii") === "PAR1", ends = tail.subarray(-4).toString("ascii") === "PAR1", metadataLength = tail.length >= 8 ? tail.readUInt32LE(tail.length - 8) : 0, valid = starts && ends && metadataLength > 0 && metadataLength <= size - 12;
      return { status: valid ? "verified" : "invalid", validator: "parquet-footer", detail: valid ? `Parquet 页脚完整，元数据 ${metadataLength} bytes` : "Parquet 页头、页脚或元数据长度无效", metadataLength };
    }
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), entryCount = eocd >= 0 && eocd + 12 <= tail.length ? tail.readUInt16LE(eocd + 10) : 0, valid = contentCheck.valid !== false && eocd >= 0;
    return { status: valid ? "verified" : "invalid", validator: "zip-central-directory", detail: valid ? `ZIP 中央目录完整，共 ${entryCount} 个条目` : "ZIP 中央目录结束记录缺失", entryCount };
  } finally { fs.closeSync(descriptor); }
}

async function readFileSample(filePath) {
  const size = fs.statSync(filePath).size, length = Math.min(size, SAMPLE_LIMIT), sample = Buffer.alloc(length);
  if (!length) return sample;
  const handle = await fsp.open(filePath, 'r');
  try {
    let read = 0;
    while (read < length) {
      const result = await handle.read(sample, read, length - read, read);
      if (!result.bytesRead) throw new Error('文件采样读取不完整');
      read += result.bytesRead;
    }
  } finally { await handle.close(); }
  return sample;
}

async function adoptStagedAssetIntoState(state, filePath, assetId, originalName, sha256, size, uploadMode = 'resumable') {
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(String(sha256 || ''))) throw new Error('上传文件的摘要或大小无效');
  const asset = state.assets.find(item => item.id === assetId);
  if (!asset) { const error = new Error('资产不存在，请先创建资产元数据'); error.status = 404; throw error; }
  const acceptedBundle = state.bundles.find(bundle => bundle.id === asset.bundleId && ['已验收', '已归档'].includes(bundle.status));
  if (acceptedBundle) { const error = new Error('已验收批次禁止替换原文件，请建立修订批次'); error.status = 409; throw error; }
  const contentCheck = detectSignature(await readFileSample(filePath), originalName, size);
  const deepCheck = inspectContainerFile(filePath, originalName, contentCheck);
  const storedName = `${assetId}-${Date.now()}-${safeName(originalName)}`, finalPath = path.join(uploadDir, storedName);
  const handle = await fsp.open(filePath, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(filePath, finalPath);
  const serverFile = { storedName, originalName, sha256, size, contentCheck, deepCheck, storedAt: new Date().toISOString(), uploadMode };
  Object.assign(asset, { size, format: contentCheck.extension || asset.format, serverFile, serverManaged: true, status: '待质检', score: 0, updatedAt: new Date().toISOString() });
  audit(state, '接收原始文件', asset.id, `${originalName} · ${size} bytes · SHA-256 ${sha256.slice(0, 16)} · ${deepCheck.detail}`);
  return asset;
}

async function syncImportedAnnotationSources(assets) {
  const bundleIds = [...new Set(assets.filter(annotationSourceKind).map(asset => asset.bundleId).filter(Boolean))];
  for (const bundleId of bundleIds) {
    try { await autoImportBundleAnnotations(bundleId); }
    catch (error) { console.warn(`自动解析标注源失败 ${bundleId}: ${error.message}`); }
  }
}

async function adoptStagedAsset(filePath, assetId, originalName, sha256, size, uploadMode = 'resumable') {
  const state = readState(), asset = await adoptStagedAssetIntoState(state, filePath, assetId, originalName, sha256, size, uploadMode);
  writeState(state);
  await syncImportedAnnotationSources([asset]);
  return readState().assets.find(item => item.id === asset.id) || asset;
}

async function adoptStagedAssets(uploads) {
  if (!Array.isArray(uploads) || !uploads.length) return [];
  const state = readState(), assets = [];
  for (const upload of uploads) assets.push(await adoptStagedAssetIntoState(state, upload.file, upload.session.assetId, upload.session.name, upload.evidence.sha256, upload.evidence.size, 'resumable'));
  writeState(state);
  await syncImportedAnnotationSources(assets);
  return assets;
}

async function streamAssetContent(req, assetId, originalName) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (declared > MAX_UPLOAD) { const error = new Error("文件超过 20GB 上限"); error.status = 413; throw error; }
  const state = readState(), asset = state.assets.find(item => item.id === assetId);
  if (!asset) { const error = new Error("资产不存在，请先创建资产元数据"); error.status = 404; throw error; }
  const acceptedBundle = state.bundles.find(bundle => bundle.id === asset.bundleId && ['已验收', '已归档'].includes(bundle.status));
  if (acceptedBundle) { const error = new Error('已验收批次禁止替换原文件，请建立修订批次'); error.status = 409; throw error; }
  const tempName = `.upload-${assetId}-${crypto.randomBytes(6).toString("hex")}.tmp`, tempPath = path.join(uploadDir, tempName);
  const hash = crypto.createHash('sha256'); let size = 0;
  const inspect = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > MAX_UPLOAD) return callback(new Error("文件超过 20GB 上限"));
    hash.update(chunk);
    callback(null, chunk);
  }});
  try { await pipeline(req, inspect, fs.createWriteStream(tempPath, { flags: "wx" })); }
  catch (error) { try { fs.unlinkSync(tempPath); } catch {} throw error; }
  if (!size) { try { fs.unlinkSync(tempPath); } catch {} const error = new Error("上传文件为空"); error.status = 400; throw error; }
  const sha256 = hash.digest('hex');
  try { return await adoptStagedAsset(tempPath, assetId, originalName, sha256, size, 'stream'); }
  catch (error) { try { fs.unlinkSync(tempPath); } catch {} throw error; }
}

function hasAny(fields, candidates) { const lower = fields.map(value => String(value).toLowerCase()); return candidates.some(candidate => lower.some(field => field === candidate || field.includes(candidate))); }
function applicableRule(state, code, type) { return state.rules.find(rule => rule.code === code && (rule.scope === "全部" || rule.scope === type)); }
function classifyAssetType(asset) {
  const source = [asset?.bundleName, asset?.sourceRoot, asset?.relativePath, asset?.name].filter(Boolean).join(" ").toLowerCase();
  if (/(?:^|[^a-z])umi(?:[^a-z]|$)|universal[-_ ]?manipulation[-_ ]?interface/.test(source)) return { type: "UMI", reason: "路径或文件标识包含 UMI" };
  if (/(?:^|[^a-z])(?:ego|egocentric)(?:[^a-z]|$)|第一人称/.test(source)) return { type: "EGO", reason: "路径或文件标识包含 EGO / 第一人称" };
  if (/teleop|teleoperat|遥操|lerobot|master|slave|action\.parquet|observation\.state|joint/.test(source)) return { type: "遥操", reason: "路径或文件标识包含遥操控制流或 LeRobot 结构" };
  return { type: "", reason: "未找到可确认类型的目录或文件标识" };
}
function verifyStructuredEvidence(asset) {
  const stored = asset?.serverFile?.storedName, check = asset?.serverFile?.contentCheck || {};
  if (!stored || !["JSON", "JSONL", "CSV"].includes(String(asset.format || "").toUpperCase())) return { verified: false, reason: "非结构化文件，无法执行字段级复检" };
  const file = path.join(uploadDir, stored);
  if (!file.startsWith(uploadDir + path.sep) || !fs.existsSync(file)) return { verified: false, reason: "服务端原始文件不存在" };
  if (fs.statSync(file).size > SAMPLE_LIMIT && Number(check.recordCount || 0) > 0) {
    const fields = check.fields || [], groups = { UMI: [["timestamp", "time"], ["pose", "trajectory", "slam"], ["image", "video", "camera"]], EGO: [["timestamp", "time"], ["image", "video", "camera"], ["hand", "pose", "action"]], "遥操": [["timestamp", "time"], ["joint", "action", "command"], ["image", "video", "observation", "state"]] }[asset.type] || [];
    const missing = groups.filter(group => !hasAny(fields, group));
    return { verified: !missing.length, reason: missing.length ? "大文件仅能复核首页字段，仍有必需字段分组未识别" : "大文件首页字段已通过结构检查" };
  }
  try {
    const source = fs.readFileSync(file, "utf8"), values = [];
    if (asset.format === "CSV") {
      const lines = source.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return { verified: false, reason: "CSV 没有数据行" };
      const columns = lines[0].split(",").map(value => value.trim().replace(/^"|"$/g, ""));
      values.push(Object.fromEntries(columns.map((name, index) => [name, lines[1].split(",")[index]?.trim().replace(/^"|"$/g, "") || ""])));
    } else if (asset.format === "JSONL") {
      source.split(/\r?\n/).filter(value => value.trim()).slice(0, 100).forEach(line => values.push(JSON.parse(line)));
    } else {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) values.push(...parsed.slice(0, 100));
      else if (Array.isArray(parsed?.episodes)) values.push(...parsed.episodes.slice(0, 100));
      else if (Array.isArray(parsed?.data)) values.push(...parsed.data.slice(0, 100));
      else values.push(parsed);
    }
    if (!values.length) return { verified: false, reason: "结构化文件没有有效记录" };
    const fields = Object.keys(values[0] || {});
    if (asset.bundleRole === "meta") return { verified: fields.length > 0, reason: fields.length ? `元数据已解析 ${values.length} 条记录，字段 ${fields.slice(0, 8).join("、")}` : "元数据没有字段" };
    const groups = { UMI: [["timestamp", "time"], ["pose", "trajectory", "slam"], ["image", "video", "camera"]], EGO: [["timestamp", "time"], ["image", "video", "camera"], ["hand", "pose", "action"]], "遥操": [["timestamp", "time"], ["joint", "action", "command"], ["image", "video", "observation", "state"]] }[asset.type] || [];
    const missing = groups.filter(group => !hasAny(fields, group));
    return { verified: !missing.length, reason: missing.length ? `仍缺少 ${missing.map(group => group.join("/")).join("、")}` : `已解析 ${values.length} 条记录，字段结构完整` };
  } catch (error) {
    return { verified: false, reason: `结构化解析失败：${error.message}` };
  }
}
function findIssueEvidence(issue, asset, state) {
  const key = String(issue?.metric || "");
  if (!asset?.serverFile) return { verified: false, reason: "服务端没有原始文件，无法执行证据复核" };
  if (key.includes("原始文件")) return { verified: true, reason: "服务端已有原始文件及 SHA-256 摘要" };
  if (key.includes("数据类型")) {
    const result = classifyAssetType(asset);
    return { verified: result.type === asset.type, reason: result.reason, detectedType: result.type };
  }
  if (key === "片段完整性") {
    const issues = segmentIssuesFor(asset, state);
    return { verified: !issues.length, reason: issues.length ? issues.join("；") : "轨迹与视频片段已逐项对应" };
  }
  if (["文件内容", "文件格式签名", "容器结构"].includes(key)) {
    const deep = asset.serverFile.deepCheck;
    const verified = asset.serverFile.size > 0 && asset.serverFile.contentCheck?.valid !== false && (!deep || deep.status !== "invalid");
    return { verified, reason: verified ? "文件签名与容器首尾结构有效" : (deep?.detail || "文件签名或容器结构无效") };
  }
  if (key === "语义深度解析") {
    const schema = asset.inspection?.lerobotSchema;
    return schema?.status === "verified" ? { verified: true, reason: `LeRobot 内部字段校验通过：${(schema.issues || []).length ? schema.issues.join("；") : "列、行、时序与向量均已检查"}` } : { verified: false, reason: schema?.status === "invalid" ? (schema.issues || []).join("；") : "尚未执行 LeRobot 内部字段解析" };
  }
  if (/字段|元数据结构|记录数/.test(key)) {
    return verifyStructuredEvidence(asset);
  }
  if (/视频|时长|分辨率/.test(key)) {
    const media = asset.mediaMetadata || {}, duration = Number(media.duration || 0), width = Number(media.width || 0), height = Number(media.height || 0);
    return { verified: duration > 0 && (!width || !height || (width >= Number(state.settings.video.minWidth || 640) && height >= Number(state.settings.video.minHeight || 480))), reason: duration <= 0 ? "视频时长仍不可验证" : `视频元数据 ${width || "?"}x${height || "?"} · ${duration.toFixed(2)} 秒` };
  }
  if (/控制流关联|轨迹关联/.test(key)) {
    const sameBundle = state.assets.some(item => item.bundleId === asset.bundleId && item.serverFile && item.bundleRole === "trajectory");
    return { verified: sameBundle, reason: sameBundle ? "已找到同批次轨迹或控制流文件" : "同批次仍没有轨迹或控制流" };
  }
  if (key.startsWith('HDF5')) {
    const hdf5 = asset.inspection?.production?.hdf5;
    if (!hdf5) return { verified: false, reason: '尚未生成 HDF5 语义质检证据' };
    const sequenceCodes = new Set((hdf5.sequence?.issues || []).map(item => item.code));
    const issues = key.includes('时序') ? (hdf5.sequence?.issues || []) : key.includes('图像') ? (hdf5.issues || []).filter(item => ['image_decode', 'image_resolution', 'black_image', 'depth_invalid_ratio'].includes(item.code)) : key.includes('通道') ? (hdf5.issues || []).filter(item => item.code === 'constant_dataset') : (hdf5.issues || []).filter(item => !['image_decode', 'image_resolution', 'black_image', 'depth_invalid_ratio', 'constant_dataset'].includes(item.code));
    return { verified: !issues.length && !(key.includes('时序') && sequenceCodes.size), reason: issues.length ? issues.map(item => item.message).join('；') : 'HDF5 对应质量项复检通过' };
  }
  return { verified: false, reason: "该问题未绑定脚本化复核规则，需要人工检查原始数据" };
}
function episodeKey(asset) {
  const match = String(asset?.name || asset?.relativePath || "").match(/episode[_-](\d+)/i);
  return match ? `episode_${String(match[1]).padStart(6, "0")}` : "";
}
function mediaChannel(asset) {
  const parts = String(asset?.relativePath || asset?.name || "").split(/[\\/]+/);
  const videoIndex = parts.findIndex(part => part.toLowerCase() === "videos");
  return videoIndex >= 0 ? (parts[videoIndex + 2] || parts[videoIndex + 1] || "") : "";
}
function segmentIssuesFor(asset, state) {
  if (!asset?.bundleId || !["trajectory", "media"].includes(asset.bundleRole)) return [];
  const files = state.assets.filter(item => item.bundleId === asset.bundleId && !item.isDemo);
  const trajectories = files.filter(item => item.bundleRole === "trajectory" && item.serverFile);
  const media = files.filter(item => item.bundleRole === "media" && item.serverFile);
  const channels = [...new Set(media.map(mediaChannel).filter(Boolean))];
  if (!trajectories.length || !media.length || !channels.length) return [];
  const trajectoryEpisodes = new Set(trajectories.map(episodeKey).filter(Boolean));
  if (asset.bundleRole === "trajectory") {
    const key = episodeKey(asset);
    const missing = channels.filter(channel => !media.some(item => episodeKey(item) === key && mediaChannel(item) === channel));
    return missing.length ? [`${key || asset.name} 缺少视频片段：${missing.join("、")}`] : [];
  }
  const key = episodeKey(asset);
  return key && !trajectoryEpisodes.has(key) ? [`${key} 没有对应的轨迹 / 状态文件`] : [];
}
function evaluateAsset(asset, template, state) {
  const threshold = Number(state.settings.thresholds[template] ?? state.settings.thresholds["标准质检"] ?? 90);
  const issues = [], evidence = [], limitations = []; let capabilityBlocked = false;
  const add = (code, metric, level, detail, extra = {}) => { const rule = applicableRule(state, code, asset.type); if (rule && rule.enabled !== false) { const { levelOverride, ...metadata } = extra; issues.push({ ruleId: rule.id, metric, level: levelOverride || rule.severity || level, detail, ...metadata }); } };
  const bundleAssets = asset.bundleId ? state.assets.filter(item => item.bundleId === asset.bundleId && item.serverFile) : [], bundleRoles = new Set(bundleAssets.map(item => item.bundleRole).filter(Boolean));
  const bundleHas = role => bundleRoles.has(role);
  if (asset.bundleId && bundleAssets.length) evidence.push(`数据包 ${asset.bundleName || asset.bundleId} · ${bundleAssets.length} 个已接入文件 · ${[...bundleRoles].join("/") || "未标记分组"}`);
  const segmentRule = applicableRule(state, "segment_completeness", asset.type), segmentIssues = segmentRule?.enabled !== false ? segmentIssuesFor(asset, state) : [];
  segmentIssues.forEach(detail => issues.push({ ruleId: segmentRule.id, metric: "片段完整性", level: segmentRule.severity || "高", detail }));
  if (segmentIssues.length) evidence.push(`片段校验失败 ${segmentIssues.length} 项`);
  if (!DATA_TYPES.includes(asset.type)) add("data_type", "数据类型", "高", "数据类型未确认");
  if (!asset.serverFile) {
    add("original_file", "原始文件", "高", "服务端没有原始文件，无法执行可信质检");
    return { score: null, threshold, status: "待补传", detail: { sync: null, complete: null, action: null, sensor: null }, issues, evidence: ["仅有历史元数据"] };
  }
  const check = asset.serverFile.contentCheck || {};
  const production = asset.inspection?.production;
  if (!production || production.sha256 !== asset.serverFile.sha256) add('production_evidence', '服务端检查证据', '高', '尚无绑定当前文件哈希的生产检查证据，请执行完整质检');
  else {
    if (production.error) add('production_evidence', '文件解析失败', '高', production.error);
    if (production.structure?.status === 'not_supported' && !production.hdf5 && !production.umi) {
      capabilityBlocked = true;
      limitations.push(...(production.structure.issues || ['该格式没有配置完整解析器']));
    }
    const hdf5 = production.hdf5;
    if (hdf5) {
      if (hdf5.status === 'not_supported') {
        capabilityBlocked = true;
      } else {
        const seen = new Set();
        for (const finding of hdf5.issues || []) {
          const metric = ['image_decode', 'image_resolution', 'black_image', 'depth_invalid_ratio'].includes(finding.code) ? 'HDF5 图像质量' : finding.code === 'constant_dataset' ? 'HDF5 通道有效性' : 'HDF5 结构与数值';
          const key = `${metric}:${finding.code}:${finding.field || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          add('production_evidence', metric, finding.severity || '中', finding.message, { levelOverride: finding.severity || '中', aggregateKey: `hdf5:${asset.bundleId || asset.id}:${finding.code}:${finding.field || ''}` });
        }
        for (const finding of hdf5.sequence?.issues || []) {
          add('production_evidence', 'HDF5 时序连续性', finding.severity || '中', finding.message, { levelOverride: finding.severity || '中', aggregateKey: `hdf5:${hdf5.sequence.key}:${finding.code}` });
        }
        const rgb = hdf5.metrics || {}, sequence = hdf5.sequence || {};
        evidence.push(`HDF5 ${hdf5.profile || 'profile'} · ${rgb.sampleCount || 0} 个采样 · ${rgb.rgbDecodedImages || 0} 路 RGB / ${rgb.depthDecodedImages || 0} 路深度解码成功`);
        if (sequence.fileCount) evidence.push(`HDF5 序列 ${sequence.fileCount} 文件 · 推断 ${sequence.observedFps ?? '?'} FPS · 时间缺口 ${sequence.gapCount || 0} 个 · 最大间隔 ${sequence.maxGapMs || 0} ms`);
      }
      limitations.push(...(hdf5.limitations || []));
    }
    const umi = production.umi;
    if (umi) {
      if (umi.status === 'not_supported') capabilityBlocked = true;
      else {
        for (const finding of umi.issues || []) add('production_evidence', 'UMI 时序与数值', finding.severity || '中', finding.message, { levelOverride: finding.severity || '中', aggregateKey: `umi:${asset.bundleId || asset.id}:${finding.code}:${finding.field || ''}` });
        const metrics = umi.metrics || {};
        evidence.push(`UMI ${umi.profile || 'session'} · ${metrics.cameraFrames || 0} RGB 帧 · ${metrics.viveSamples || 0} VIVE 样本 · ${metrics.clampSamples || 0} 夹爪样本 · ${metrics.cameraFps?.toFixed?.(3) || metrics.cameraFps || '?'} FPS`);
        if (umi.sync) evidence.push(`UMI 同步 · 起点偏差 ${Number(umi.sync.startOffsetMs || 0).toFixed(2)} ms · 终点偏差 ${Number(umi.sync.endOffsetMs || 0).toFixed(2)} ms`);
      }
      limitations.push(...(umi.limitations || []));
    }
    if (production.media?.status === 'invalid') {
      const reviewed = production.mediaReview?.sha256 === asset.serverFile.sha256 && production.mediaReview?.approved === true;
      const pending = (production.media.findings || []).filter(finding => !reviewed || !['black_frames', 'frozen_frames'].includes(finding.code));
      if (pending.length || !production.media.findings?.length) add('production_evidence', '视频解码与同步', '高', pending.length ? pending.map(item => item.message).join('；') : production.media.issues.join('；'));
      if (reviewed) evidence.push(`黑屏/静止候选人工复核：${production.mediaReview.reviewer} · ${production.mediaReview.note}`);
    }
    if (production.schema?.status === 'invalid') add('production_evidence', '轨迹字段与数值', '高', production.schema.issues.join('；'));
    evidence.push(`服务端检查 ${production.checkedAt} · 文件哈希 ${production.sha256}`);
  }
  evidence.push(`SHA-256 ${asset.serverFile.sha256}`, `文件签名 ${check.signature || "unknown"}`, `文件大小 ${asset.serverFile.size} bytes`);
  if (!asset.serverFile.size) add("file_signature", "文件内容", "高", "文件为空");
  if (check.valid === false) add("file_signature", "文件格式签名", "高", `扩展名与文件头不匹配（${check.signature || "unknown"}）`);
  if (check.recordCount === 0) add("structured_schema", "记录数", "高", "结构化文件没有有效记录");
  const format = String(asset.format || check.extension || "").toUpperCase(), fields = check.fields || [], deepCheck = asset.serverFile.deepCheck, lerobotSchema = asset.inspection?.lerobotSchema, embodied = asset.inspection?.embodied;
  let pendingDeep = DEEP_FORMATS.includes(format) && applicableRule(state, "deep_parse", asset.type)?.enabled !== false;
  if (pendingDeep && deepCheck?.status === "invalid") add("file_signature", "容器结构", "高", deepCheck.detail);
  if (pendingDeep && deepCheck?.status === "verified") {
    evidence.push(`容器结构 ${deepCheck.detail}`);
    const isLerobotTrajectory = format === "PARQUET" && asset.bundleRole === "trajectory";
    const isNativeHdf5 = format.startsWith("HDF5") && production?.hdf5;
    if (isLerobotTrajectory && lerobotSchema?.status === "verified") {
      pendingDeep = false;
      evidence.push(`LeRobot 字段 ${lerobotSchema.columns?.join(", ") || "已解析"} · ${lerobotSchema.rowCount ?? "?"} 行 · 向量 ${Object.entries(lerobotSchema.vectorLengths || {}).map(([name, lengths]) => `${name}=${lengths.join("/")}`).join("，") || "已校验"}`);
    } else if (isLerobotTrajectory && lerobotSchema?.status === "invalid") {
      add("deep_parse", "语义深度解析", "高", `LeRobot 专用校验失败：${(lerobotSchema.issues || []).join("；") || "内部结构无效"}`);
    } else if (isNativeHdf5) {
      pendingDeep = false;
      const hdf5Status = production.hdf5.status === "verified" ? "结构与图像解码通过" : production.hdf5.status === "not_supported" ? "质检能力未覆盖" : "已生成异常证据";
      evidence.push(`HDF5 语义解析 ${production.hdf5.profile || "profile"} · ${hdf5Status}`);
    } else {
      add("deep_parse", "语义深度解析", "中", `${format} 容器结构已验证，仍需解析内部时间戳、轨迹和观测字段`);
    }
  }
  if (format === "PARQUET" && asset.bundleRole === "trajectory" && embodied) {
    const validation = embodied.validation || {};
    if (validation.ok === true) {
      pendingDeep = false;
      const info = embodied.info || {};
      evidence.push(`Embodied Data · ${embodied.detection?.format || info.format || "dataset"} ${info.version || ""} · ${info.episodes ?? "?"} Episode · ${info.totalFrames ?? "?"} 帧 · ${info.fps ?? "?"} FPS`);
      if (validation.warnings) evidence.push(`插件提示 ${validation.warnings} 项警告`);
    } else {
      add("deep_parse", "语义深度解析", "高", `Embodied Data 结构校验失败：${(validation.issues || []).join("；") || "未通过插件校验"}`);
    }
  }
  if (pendingDeep && !deepCheck) add("deep_parse", "容器结构", "中", `${format} 为历史上传文件，需重新上传以执行首尾结构校验`);
  if (["JSON", "JSONL", "CSV"].includes(format) && asset.bundleRole === "meta") {
    evidence.push(`元数据文件 ${asset.name} · ${check.recordCount ?? "记录数未统计"} 条记录 · 字段 ${fields.join(", ") || "未识别"}`);
    if (check.recordCount === 0 || !fields.length) add("structured_schema", "元数据结构", "中", "元数据文件为空或未识别出字段");
    if (annotationSourceKind(asset)) {
      const imported = asset.inspection?.annotationImport;
      if (imported?.status === "invalid") add("structured_schema", "标注源解析", "高", `标注文件解析失败：${(imported.errors || []).join("；") || "内容无效"}`);
      else if (imported?.status === "unmatched") evidence.push("标注源已解析，但当前未直接贡献 Episode 指令；缺失标注会由批次标注门禁阻断");
      else if (imported?.status === "verified") evidence.push(`自动标注解析 ${imported.importedEpisodes} 个 Episode · 任务 ${imported.taskCount || 0} 条 · 源哈希 ${imported.sourceSha256 || "--"}`);
    }
  } else if (["JSON", "JSONL", "CSV"].includes(format)) {
    const requirements = {
      UMI: [["timestamp", "time"], ["pose", "trajectory", "slam"], ["image", "video", "camera"]],
      EGO: [["timestamp", "time"], ["image", "video", "camera"], ["hand", "pose", "action"]],
      遥操: [["timestamp", "time"], ["joint", "action", "command"], ["image", "video", "observation", "state"]],
    }[asset.type] || [];
    requirements.forEach((group, index) => { if (!hasAny(fields, group)) add("structured_schema", ["时间戳字段", "动作/轨迹字段", "观测字段"][index], "高", `字段列表缺少 ${group.join("/")}`); });
    evidence.push(`记录数 ${check.recordCount ?? "大文件未全量统计"}`, `字段 ${fields.join(", ") || "未识别"}`);
  }
  if (VIDEO_FORMATS.includes(format)) {
    const media = asset.mediaMetadata || {};
    const duration = Number(media.duration || 0);
    evidence.push(`视频 ${media.width || "?"}x${media.height || "?"} · ${duration ? duration.toFixed(2) + "s" : "时长未知"}`);
    if (!duration || duration <= 0) add("video_metadata", "视频元数据", "中", "缺少可验证的视频时长，需要重新补传或人工复核");
    const minWidth = Number(state.settings.video.minWidth || 640), minHeight = Number(state.settings.video.minHeight || 480);
    if (media.width && media.height && (media.width < minWidth || media.height < minHeight)) add("video_resolution", "视频分辨率", "中", `分辨率 ${media.width}x${media.height} 低于 ${minWidth}x${minHeight} 基线`);
    if (asset.type === "遥操" && !bundleHas("trajectory") && applicableRule(state, "teleop_control", asset.type)?.enabled !== false) { add("teleop_control", "控制流关联", "中", "当前资产仅含视频，尚未关联关节状态/控制指令流"); pendingDeep = true; }
    if (asset.type === "UMI" && !bundleHas("trajectory") && applicableRule(state, "umi_trajectory", asset.type)?.enabled !== false) { add("umi_trajectory", "轨迹关联", "中", "当前资产仅含视频，尚未关联 SLAM/末端轨迹"); pendingDeep = true; }
  }
  state.rules.filter(rule => !rule.system && rule.enabled !== false && (rule.scope === "全部" || rule.scope === asset.type)).forEach(rule => {
    const value = String(rule.value ?? "").trim(), size = Number(asset.serverFile?.size || 0);
    if (rule.code === "filename_contains" && value && !String(asset.name || "").toLowerCase().includes(value.toLowerCase())) issues.push({ ruleId: rule.id, metric: rule.name, level: rule.severity || "中", detail: `文件名不包含要求的关键字：${value}` });
    if (rule.code === "max_file_size_mb" && Number(value) > 0 && size > Number(value) * 1024 * 1024) issues.push({ ruleId: rule.id, metric: rule.name, level: rule.severity || "中", detail: `文件大小超过 ${value} MB` });
    if (rule.code === "min_file_size_kb" && Number(value) > 0 && size < Number(value) * 1024) issues.push({ ruleId: rule.id, metric: rule.name, level: rule.severity || "中", detail: `文件大小低于 ${value} KB` });
    if (rule.code === "metadata_required" && value && (!asset[value] || ["未关联", "待确认"].includes(String(asset[value])))) issues.push({ ruleId: rule.id, metric: rule.name, level: rule.severity || "中", detail: `必填元数据 ${value} 缺失或未确认` });
  });
  if (limitations.length) evidence.push(`质检限制：${[...new Set(limitations)].join('；')}`);
  const high = issues.filter(item => item.level === "高").length, medium = issues.filter(item => item.level === "中").length;
  const rawScore = Math.max(0, Math.min(100, 100 - high * Number(state.settings.issueWeights.high || 35) - medium * Number(state.settings.issueWeights.medium || 8)));
  const score = capabilityBlocked ? null : rawScore;
  const status = high ? "问题" : capabilityBlocked ? "待质检" : pendingDeep || medium || rawScore < threshold ? "待深检" : "已通过";
  const verified = !capabilityBlocked && rawScore >= threshold && status === "已通过";
  const hdf5 = production?.hdf5, sequence = hdf5?.sequence, metrics = hdf5?.metrics || {}, umi = production?.umi, umiMetrics = umi?.metrics || {};
  const dimensions = hdf5 ? {
    complete: capabilityBlocked ? null : hdf5.status === 'invalid' ? 0 : 100,
    sync: capabilityBlocked ? null : sequence ? Math.max(0, 100 - Number(sequence.gapRatio || 0) * 100) : null,
    action: capabilityBlocked ? null : Math.max(0, 100 - Number(metrics.nonFiniteValues || 0) * 10),
    sensor: capabilityBlocked ? null : Math.max(0, Math.round(100 * ((metrics.rgbDecodedImages || 0) + (metrics.depthDecodedImages || 0)) / Math.max(1, (metrics.rgbDecodedImages || 0) + (metrics.depthDecodedImages || 0) + (metrics.rgbDecodeFailures || 0) + (metrics.depthDecodeFailures || 0)))),
  } : umi ? {
    complete: capabilityBlocked ? null : umi.status === 'invalid' ? 0 : 100,
    sync: capabilityBlocked ? null : Math.max(0, 100 - Number(umi.issues?.length || 0) * 5),
    action: capabilityBlocked ? null : umi.status === 'invalid' ? 0 : 100,
    sensor: capabilityBlocked ? null : umiMetrics.video?.status === 'invalid' ? 0 : 100,
  } : { sync: null, complete: check.valid === false ? 0 : 100, action: null, sensor: null };
  return { score, threshold, status, capabilityBlocked, limitations, detail: dimensions, issues, evidence };
}
function migrateLegacyHdf5CapabilityIssues(state) {
  const hdf5Ids = new Set(state.assets.filter(asset => !asset.isDemo && ['HDF5', 'H5'].includes(String(asset.format || '').toUpperCase())).map(asset => asset.id));
  const checkedAt = new Date().toISOString(); let closed = 0;
  for (const issue of state.issues) {
    const acceptedOptional6f = issue.metric === 'HDF5 通道有效性' && String(issue.detail || '').includes('puppet/6f');
    const legacyCapability = ['解析器未接入', '语义深度解析'].includes(issue.metric);
    if (issue.status === '已关闭' || !hdf5Ids.has(issue.assetId) || (!legacyCapability && !acceptedOptional6f)) continue;
    issue.status = '已关闭';
    const reason = acceptedOptional6f ? '设备数据配置确认 puppet/6f 未启用，已作为可选通道豁免' : '质检策略升级：旧版把 HDF5 解析能力缺失误报为数据缺陷；已由语义解析器替代';
    issue.verification = { verified: true, reason, checkedAt, batchId: null, actor: '系统质检迁移' };
    issue.resolution = acceptedOptional6f ? 'puppet/6f 已配置为不适用，不再作为数据缺陷' : '旧版能力缺失条目已关闭，HDF5 将按当前语义质检规则重新检查';
    issue.updatedAt = checkedAt; issue.closedAt = checkedAt; issue.closedBy = '系统质检迁移'; closed++;
  }
  let reset = 0;
  for (const asset of state.assets) {
    if (!hdf5Ids.has(asset.id) || asset.status !== '问题') continue;
    if (state.issues.some(issue => issue.assetId === asset.id && issue.status !== '已关闭')) continue;
    Object.assign(asset, { status: '待质检', score: null, capabilityBlocked: false, updatedAt: checkedAt }); reset++;
  }
  return { closed, reset };
}
function selectQcTargets(state, scope, model, targetIds) {
  let list = state.assets.filter(asset => !asset.isDemo);
  if (Array.isArray(targetIds) && targetIds.length) list = list.filter(asset => targetIds.includes(asset.id));
  if (scope === "待质检数据") list = list.filter(asset => ["待质检", "待补传", "待深检"].includes(asset.status) || !asset.lastQcAt);
  if (["UMI 数据", "EGO 数据", "遥操 数据"].includes(scope)) list = list.filter(asset => asset.type === scope.split(" ")[0]);
  if (scope === "未关联模型的数据") list = list.filter(asset => !asset.model || asset.model === "未关联");
  if (model && model !== "全部模型") list = list.filter(asset => asset.model === model);
  return list;
}
function reopenAcceptance(state, bundleIds, reason) {
  let changed = 0;
  for (const bundle of state.bundles || []) {
    if (!bundleIds.has(bundle.id) || !['待验收', '已验收', '已归档'].includes(bundle.status)) continue;
    const snapshot = { id: crypto.randomUUID(), status: bundle.status, acceptedAt: bundle.acceptedAt, acceptedBy: bundle.acceptedBy, submittedAt: bundle.submittedAt, submittedBy: bundle.submittedBy, note: bundle.acceptanceNote, reopenedAt: new Date().toISOString(), reason };
    bundle.acceptanceHistory = [...(bundle.acceptanceHistory || []), snapshot];
    bundle.status = '待复检'; bundle.acceptanceNote = reason;
    for (const key of ['acceptedAt', 'acceptedBy', 'submittedAt', 'submittedBy']) delete bundle[key];
    audit(state, '重新打开批次验收', bundle.id, reason); changed++;
  }
  return changed;
}
function qcIssueGroups(results, state) {
  const groups = new Map();
  for (const result of results) {
    const asset = state.assets.find(item => item.id === result.assetId);
    const production = asset?.inspection?.production;
    for (const issue of result.issues || []) {
      const key = issue.aggregateKey ? `AGG:${issue.aggregateKey}` : `${result.assetId}:${issue.metric}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          assetId: result.assetId,
          assetName: result.name,
          type: result.type,
          metric: issue.metric,
          level: issue.level,
          detail: issue.detail,
          ruleId: issue.ruleId,
          relativePath: asset?.relativePath || result.name,
          sourceSha256: asset?.serverFile?.sha256,
          aggregate: Boolean(issue.aggregateKey),
          affectedIds: new Set([result.assetId]),
        });
      } else groups.get(key).affectedIds.add(result.assetId);
    }
  }
  return [...groups.values()];
}

function runQc(state, request, user = null, started = Date.now()) {
  const runStartedAt = new Date(started).toISOString(), scope = request.scope || "待质检数据", template = request.template || "标准质检", model = request.model || "全部模型";
  const targets = selectQcTargets(state, scope, model, request.targetIds).filter(asset => typeAllowed(user, asset.type)), now = new Date().toLocaleString("zh-CN", { hour12: false });
  const targetBundleIds = new Set(targets.map(asset => asset.bundleId).filter(Boolean));
  const incompleteBundles = [...targetBundleIds].map(bundleId => {
    const bundleAssets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId);
    return { bundleId, pending: bundleAssets.filter(asset => !asset.serverFile).length, total: bundleAssets.length };
  }).filter(item => item.pending > 0);
  if (incompleteBundles.length) {
    const detail = incompleteBundles.map(item => `${item.bundleId} ${item.total - item.pending}/${item.total}`).join("、");
    const error = new Error(`原始文件尚未全部上传完成，不能进入质量检测：${detail}`);
    error.status = 409; error.extra = { incompleteBundles };
    throw error;
  }
  const results = targets.map(asset => ({ assetId: asset.id, name: asset.name, type: asset.type, model: asset.model || "未关联", ...evaluateAsset(asset, template, state) }));
  results.forEach(result => { const asset = state.assets.find(item => item.id === result.assetId); Object.assign(asset, { score: result.score ?? null, status: result.status, lastQcAt: now, qcTemplate: template, qcDetail: result.detail, qcLimitations: result.limitations || [], capabilityBlocked: result.capabilityBlocked === true }); });
  const issueGroups = qcIssueGroups(results, state);
  const activeKeys = new Set(issueGroups.map(group => group.key));
  for (const group of issueGroups) {
    const existing = state.issues.find(item => item.key === group.key);
    const affectedIds = [...group.affectedIds], asset = state.assets.find(item => item.id === group.assetId), production = asset?.inspection?.production;
    const detail = group.affectedIds.size > 1 ? `${group.detail}（影响 ${group.affectedIds.size} 个文件）` : group.detail;
    const record = { key: group.key, id: `ISS-${crypto.createHash("sha1").update(group.key).digest("hex").slice(0, 10).toUpperCase()}`, assetId: group.assetId, assetName: group.affectedIds.size > 1 ? `${group.affectedIds.size} 个文件` : group.assetName, type: group.type, metric: group.metric, level: group.level, detail, updatedAt: now, ruleId: group.ruleId, relativePath: group.relativePath, sourceSha256: group.sourceSha256, affectedAssetIds: affectedIds, affectedCount: affectedIds.length, locations: [...(production?.schema?.findings || []), ...(production?.media?.findings || []), ...(production?.hdf5?.issues || []), ...(production?.hdf5?.sequence?.gaps || [])].slice(0, 100), evidenceVersion: 'production-evidence-v1' };
    if (existing) {
      const wasClosed = existing.status === "已关闭";
      Object.assign(existing, record, { status: wasClosed ? "待处理" : existing.status, assignee: wasClosed ? "未分配" : (existing.assignee || "未分配"), resolution: wasClosed ? `问题再次检出；上次处置：${existing.resolution || "未填写"}` : (existing.resolution || ""), verification: wasClosed ? null : (existing.verification || null), closedAt: wasClosed ? null : (existing.closedAt || null), closedBy: wasClosed ? null : (existing.closedBy || null) });
    } else state.issues.unshift({ ...record, status: "待处理", assignee: "未分配", resolution: "", createdAt: now });
  }
  state.issues.forEach(issue => {
    if (results.some(result => result.assetId === issue.assetId) && !activeKeys.has(issue.key) && issue.status !== "已关闭") {
      const checkedAt = new Date().toISOString();
      Object.assign(issue, {
        status: "已关闭",
        verification: { verified: true, reason: "服务端重新质检未再检出该问题", checkedAt, batchId: null, actor: user?.name || "系统质检引擎" },
        resolution: issue.resolution || "服务端重新质检未再检出该问题，系统自动关闭",
        updatedAt: now,
        closedAt: checkedAt,
        closedBy: user?.name || "系统质检引擎",
      });
    }
  });
  const passed = results.filter(item => item.status === "已通过").length, issueCount = issueGroups.length;
  const batch = { id: "QC-" + Date.now().toString(36).toUpperCase(), scope, template, model, total: results.length, passed, passRate: results.length ? Number((passed / results.length * 100).toFixed(1)) : 0, issueCount, duration: Number(((Date.now() - started) / 1000).toFixed(2)), status: "已完成", createdAt: now, operator: "系统质检引擎", engine: "production-evidence-v1", results, targetIds: results.map(item => item.assetId), ruleSnapshot: state.rules.filter(rule => rule.enabled !== false).map(rule => rule.id), settingsSnapshot: state.settings };
  state.qcBatches.unshift(batch); state.qcBatches = state.qcBatches.slice(0, 100);
  const run = { id: "RUN-" + Date.now().toString(36).toUpperCase(), kind: "质检", batchId: batch.id, scope, status: "已完成", startedAt: runStartedAt, finishedAt: new Date().toISOString(), duration: batch.duration, operator: "系统质检引擎", targetIds: batch.targetIds, summary: { total: batch.total, passed: batch.passed, passRate: batch.passRate, issueCount: batch.issueCount }, nodes: [{ id: "input", label: "读取批次", status: "已完成", detail: `${targets.length} 个资产` }, { id: "validate", label: "结构与媒体校验", status: "已完成", detail: `${results.length} 个对象` }, { id: "rules", label: "规则执行", status: "已完成", detail: `${batch.ruleSnapshot.length} 条启用规则` }, { id: "evidence", label: "问题与证据归档", status: "已完成", detail: `${issueCount} 个问题` }], evidence: results.slice(0, 200).map(item => ({ assetId: item.assetId, name: item.name, status: item.status, score: item.score, issues: (item.issues || []).map(issue => issue.metric), evidence: item.evidence || [] })) };
  state.runs.unshift(run); state.runs = state.runs.slice(0, 100);
  batch.runId = run.id;
  state.issues.forEach(issue => {
    if (issue.verification?.verified === true && issue.verification.batchId == null && batch.targetIds.includes(issue.assetId) && issue.closedAt) issue.verification.batchId = batch.id;
  });
  reopenAcceptance(state, new Set(targets.filter(asset => asset.status !== '已通过').map(asset => asset.bundleId)), '本次真实检查发现异常，原验收已存入历史，请修复后重新提交');
  audit(state, "执行证据型质检", batch.id, `${template} · ${scope} · ${results.length} 个资产 · ${passed} 个通过 · ${issueCount} 个问题`);
  return batch;
}

function streamFileResponse(req, res, file, headers = {}) {
  const stat = fs.statSync(file), range = req.headers.range;
  const responseHeaders = { 'Accept-Ranges': 'bytes', 'Last-Modified': stat.mtime.toUTCString(), 'Cache-Control': 'no-store', ...headers };
  if (!range) {
    res.writeHead(200, { ...responseHeaders, 'Content-Length': stat.size });
    const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
    return;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : 0;
  const start = suffixLength ? Math.max(0, stat.size - suffixLength) : (match[1] ? Number(match[1]) : 0);
  const end = suffixLength ? stat.size - 1 : (match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1);
  if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  res.writeHead(206, { ...responseHeaders, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
  const stream = fs.createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); stream.pipe(res);
}

function streamStoredFile(req, res, asset, disposition) {
  const stored = asset?.serverFile?.storedName;
  if (!stored) { sendError(res, 404, "资产尚未上传原始文件"); return; }
  const file = path.join(uploadDir, stored);
  if (!file.startsWith(uploadDir) || !fs.existsSync(file)) { sendError(res, 404, "资产文件不存在"); return; }
  const type = mime[path.extname(asset.serverFile.originalName || asset.name).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': disposition ? 'application/octet-stream' : type };
  if (disposition) headers['Content-Disposition'] = `attachment; filename="${safeName(asset.serverFile.originalName || asset.name)}"`;
  streamFileResponse(req, res, file, headers);
}

function previewPaths(asset) {
  const assetId = safeName(asset?.id || '');
  const fingerprint = String(asset?.serverFile?.sha256 || '');
  if (!assetId || !/^[a-f0-9]{64}$/i.test(fingerprint)) return null;
  const base = path.join(previewDir, assetId);
  return { base, directory: path.join(base, fingerprint), metadata: path.join(base, `${fingerprint}.json`) };
}

function readPreviewCache(asset) {
  const paths = previewPaths(asset);
  if (!paths || !fs.existsSync(paths.metadata)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(paths.metadata, 'utf8'));
    if (metadata.ok === false) return { ...metadata, status: 'failed', paths };
    if (metadata.fingerprint !== asset.serverFile?.sha256 || metadata.assetId !== asset.id) return null;
    if (!Array.isArray(metadata.cameras) || !metadata.cameras.length) return null;
    if (!metadata.cameras.every(camera => fs.existsSync(path.join(paths.directory, path.basename(camera.file))))) return null;
    return { ...metadata, status: 'ready', paths };
  } catch { return null; }
}

function publicPreviewMetadata(metadata) {
  if (!metadata) return null;
  const { paths, directory, ...visible } = metadata;
  return visible;
}

function umiSourceVideoForAsset(asset) {
  if (!isUmiSessionAsset(asset) || !asset.serverFile?.storedName) return null;
  const manifest = umiData.readUmiManifest(path.join(uploadDir, asset.serverFile.storedName)), video = path.resolve(manifest.required?.video || '');
  if (!video || !fs.existsSync(video) || !fs.statSync(video).isFile()) return null;
  return { file: video, relativePath: path.relative(manifest.sourceRoot, video).replaceAll('\\', '/'), fps: Number(asset.mediaMetadata?.fps || 0), frames: Number(asset.frameCount || 0) };
}

function previewStatusForAsset(asset) {
  if (!isHdf5SequenceAsset(asset) && !isUmiSessionAsset(asset)) return { assetId: asset?.id || null, status: 'unsupported', message: '当前预览生成只支持 HDF5 和 UMI Episode' };
  const cached = readPreviewCache(asset);
  if (cached?.status === 'ready') return { assetId: asset.id, status: 'ready', preview: publicPreviewMetadata(cached), message: '预览已就绪' };
  const jobs = taskQueue?.list?.().filter(job => job.kind === 'preview' && job.payload?.assetId === asset.id) || [];
  const active = jobs.find(job => ['queued', 'running'].includes(job.status));
  if (active) return { assetId: asset.id, status: active.status, jobId: active.id, completed: Number(active.completed || 0), total: Number(active.total || 0), message: active.message || '正在生成预览' };
  const latest = jobs.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
  if (latest?.status === 'failed' || cached?.status === 'failed') return { assetId: asset.id, status: 'failed', jobId: latest?.id || null, message: latest?.error || cached?.error || '预览生成失败' };
  return { assetId: asset.id, status: 'not_generated', message: '尚未生成预览' };
}

async function generateEpisodePreview(asset, progress = () => {}) {
  const cached = readPreviewCache(asset);
  if (cached?.status === 'ready') return cached;
  const official = inspectOfficialLerobotRuntime();
  if (official.status !== 'available') throw new Error(`预览编码运行时不可用：${official.status}`);
  const isUmi = isUmiSessionAsset(asset), source = isUmi ? umiData.readUmiManifest(path.join(uploadDir, asset.serverFile.storedName)) : hdf5Sequence.readSequenceManifest(path.join(uploadDir, asset.serverFile.storedName));
  if (source.changed) throw new Error(`${isUmi ? 'UMI' : 'HDF5'} 源文件已变化，请先重新导入该 Episode`);
  const paths = previewPaths(asset);
  fs.mkdirSync(paths.base, { recursive: true });
  const requestPath = path.join(workDir, `.preview-${asset.id}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(isUmi
    ? { assetId: asset.id, fingerprint: asset.serverFile.sha256, video: source.required.video, fps: Number(asset.mediaMetadata?.fps || asset.inspection?.production?.umi?.metrics?.video?.fps || 40), frameCount: Number(asset.frameCount || source.frameCount || 0) }
    : { assetId: asset.id, fingerprint: asset.serverFile.sha256, frames: source.members.map(member => ({ path: member.absolutePath, relativePath: member.relativePath })) }), 'utf8');
  try {
    const { stdout } = await runCommandWithProgress(official.python, ['-X', 'utf8', path.join(root, 'tools', isUmi ? 'umi_preview.py' : 'hdf5_preview.py'), '--manifest', requestPath, '--output', paths.directory, '--metadata', paths.metadata, '--max-width', '640', '--crf', '28'], {
      timeout: 3600000, maxBuffer: 16 * 1024 * 1024,
      onProgress: item => progress({ completed: Number(item.completed || 0), total: Number(item.total || 0), message: `正在生成${isUmi ? ' UMI H.264 ' : '四路'}预览 ${item.completed || 0}/${item.total || 0}` }),
    });
    const result = JSON.parse(String(stdout || '').trim());
    if (result.ok !== true) throw new Error(result.error || '预览生成失败');
    const keep = new Set([path.basename(paths.directory), path.basename(paths.metadata)]);
    for (const name of fs.readdirSync(paths.base)) if (!keep.has(name)) fs.rmSync(path.join(paths.base, name), { recursive: true, force: true });
    return result;
  } finally { fs.rmSync(requestPath, { force: true }); }
}

function annotationGroupMeta(state, key) {
  const groupKey = String(key || "").trim();
  if (!groupKey) return null;
  if (groupKey.startsWith("TASK:")) {
    const taskId = groupKey.slice(5), task = (state.tasks || []).find(item => item.id === taskId);
    return { key: groupKey, scopeType: "task", scopeId: taskId, name: task?.name || taskId };
  }
  const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === groupKey);
  if (!assets.length) return null;
  return { key: groupKey, scopeType: "bundle", scopeId: groupKey, name: assets[0].bundleName || groupKey };
}

function resolveAnnotationGroup(state, body = {}) {
  const explicit = String(body.groupKey || "").trim();
  if (explicit) return annotationGroupMeta(state, explicit);
  const taskId = String(body.taskId || "").trim();
  if (taskId) return annotationGroupMeta(state, `TASK:${taskId}`);
  const bundleId = String(body.bundleId || "").trim();
  if (bundleId) return annotationGroupMeta(state, bundleId);
  const annotation = state.annotations.find(item => item.id === body.id);
  return annotation ? annotationGroupMeta(state, annotationGroupKeyForAnnotation(state, annotation)) : null;
}

function annotationGroupAnnotations(state, key) {
  return state.annotations.filter(item => isCurrentAnnotation(state, item) && annotationGroupKeyForAnnotation(state, item) === key);
}

function annotationGroupEpisodeStats(state, key) {
  const groupAssets = state.assets.filter(asset => !asset.isDemo && annotationGroupKeyForAsset(asset) === key);
  const episodes = groupAssets.filter(isLogicalEpisodeAsset);
  const openIssueIds = new Set(state.issues.filter(issue => issue.status !== "已关闭").map(issue => issue.assetId));
  const openIssueCount = groupAssets.filter(item => openIssueIds.has(item.id)).length;
  let videoCovered = 0, missingVideoCount = 0, qcPendingCount = 0;
  episodes.forEach(asset => {
    const episodeIndex = episodeIndexForAsset(asset), hasVideo = isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset) || groupAssets.some(item => item.bundleId === asset.bundleId && item.bundleRole === "media" && episodeIndexForAsset(item) === episodeIndex);
    if (hasVideo) videoCovered++; else missingVideoCount++;
    if (!asset.lastQcAt || asset.status !== "已通过") qcPendingCount++;
  });
  return { episodeCount: episodes.length, videoCovered, missingVideoCount, qcPendingCount, openIssueCount, anomalyCount: missingVideoCount + qcPendingCount + openIssueCount };
}

function annotationGroupFlow(state, key) {
  const groupAssets = state.assets.filter(asset => !asset.isDemo && annotationGroupKeyForAsset(asset) === key);
  const trajectoryAssets = groupAssets.filter(asset => asset.bundleRole === "trajectory"), sourceAssets = trajectoryAssets.length ? trajectoryAssets : groupAssets.filter(asset => asset.bundleRole !== "media");
  const sourceFormats = [...new Set(sourceAssets.map(asset => {
    const format = String(asset.format || path.extname(asset.relativePath || asset.name || "").replace(/^\./, "") || "").trim();
    return format ? format.toUpperCase() : "";
  }).filter(Boolean))];
  const bundleIds = new Set(groupAssets.map(asset => asset.bundleId).filter(Boolean));
  const exportJobs = (state.exports || []).filter(job => bundleIds.has(job.batchId) || (job.batchIds || []).some(id => bundleIds.has(id)));
  const deliveryFormats = [...new Set(exportJobs.flatMap(job => {
    const converted = Object.entries(job.conversions || {}).filter(([, output]) => output?.ok).map(([format]) => format.toUpperCase());
    return converted.length ? converted : [String(job.format || "").replace(/^LeRobot$/i, "LEROBOT v2.1").toUpperCase()];
  }).filter(Boolean))];
  return { sourceFormats, source: sourceFormats.join(" + ") || "原始数据", deliveryFormats, delivery: deliveryFormats.join(" + ") || "未生成" };
}

function annotationGroupSignals(state, key, stats, standard) {
  const signals = [], status = standard?.status || deriveAnnotationGroupStatus(state, key), flow = annotationGroupFlow(state, key);
  if (standard?.autoImported) signals.push({ key: "auto-import", label: `源文件自动匹配 ${standard.importedEpisodes || 0}/${stats.episodeCount}`, severity: status === "已通过" ? "low" : "medium" });
  if (status === "已驳回") signals.push({ key: "rejected", label: "标准已驳回", severity: "high" });
  if (stats.missingVideoCount) signals.push({ key: "missing-video", label: `缺视频 ${stats.missingVideoCount}`, severity: "high" });
  if (stats.openIssueCount) signals.push({ key: "open-issues", label: `未关闭问题 ${stats.openIssueCount}`, severity: "high" });
  if (stats.qcPendingCount) signals.push({ key: "qc-pending", label: `待质检 ${stats.qcPendingCount}`, severity: "medium" });
  if (status === "待审核") signals.push({ key: "review", label: "标准待审核", severity: "medium" });
  if (["待标注", "标注中"].includes(status)) signals.push({ key: "standard", label: status === "标注中" ? "标准待提交" : "待配任务标准", severity: "medium" });
  if (!flow.deliveryFormats.length) signals.push({ key: "delivery", label: "交付格式未生成", severity: "low" });
  if (!signals.length) signals.push({ key: "ready", label: "队列健康", severity: "low" });
  return signals;
}

function deriveAnnotationGroupStatus(state, key) {
  const annotations = annotationGroupAnnotations(state, key);
  if (annotations.length && annotations.every(annotationApproved)) return "已通过";
  if (annotations.some(item => item.status === "待审核")) return "待审核";
  if (annotations.some(item => item.status === "已驳回")) return "已驳回";
  if (annotations.some(item => String(item.instruction || "").trim() || item.status === "标注中")) return "标注中";
  return "待标注";
}

function annotationStandardFor(state, key) {
  const groupKey = String(key || "").trim(), value = state.annotationStandards?.[groupKey], instruction = String(value?.instruction || "").trim();
  if (!instruction) return null;
  return { ...value, key: groupKey, instruction, status: value.status || deriveAnnotationGroupStatus(state, groupKey) };
}

function annotationStandardApproved(standard) {
  return standard?.status === "已通过" && Boolean(String(standard.instruction || "").trim());
}

function annotationGroupList(state, user = null) {
  const groups = new Map(), assets = state.assets.filter(asset => !asset.isDemo && isLogicalEpisodeAsset(asset) && typeAllowed(user, asset.type));
  assets.forEach(asset => {
    const key = annotationGroupKeyForAsset(asset), meta = annotationGroupMeta(state, key);
    if (!meta) return;
    if (!groups.has(key)) groups.set(key, { ...meta, episodeCount: 0, annotationCount: 0 });
    groups.get(key).episodeCount++;
  });
  groups.forEach((group, key) => {
    const annotations = annotationGroupAnnotations(state, key).filter(item => typeAllowed(user, item.type)), standard = annotationStandardFor(state, key);
    group.annotationCount = annotations.length;
    group.stats = annotationGroupEpisodeStats(state, key);
    group.flow = annotationGroupFlow(state, key);
    group.signals = annotationGroupSignals(state, key, group.stats, standard);
    group.primarySignal = group.signals[0];
    group.status = standard?.status || deriveAnnotationGroupStatus(state, key);
    group.instruction = standard?.instruction || "";
    group.instructions = standard?.instructions || [];
    group.instructionCount = Number(standard?.instructionCount || group.instructions.length || (standard?.instruction ? 1 : 0));
    group.autoImported = standard?.autoImported === true;
    group.importedEpisodes = Number(standard?.importedEpisodes || 0);
    group.sourceFiles = standard?.sourceFiles || [];
    group.updatedAt = standard?.updatedAt || "";
    group.updatedBy = standard?.updatedBy || "";
    group.submittedAt = standard?.submittedAt || "";
    group.submittedBy = standard?.submittedBy || "";
    group.reviewer = standard?.reviewer || "";
    group.reviewedAt = standard?.reviewedAt || "";
    group.note = standard?.note || "";
  });
  const priority = { "待审核": 0, "已驳回": 1, "标注中": 2, "待标注": 3, "已通过": 4 };
  return [...groups.values()].sort((left, right) => (priority[left.status] ?? 5) - (priority[right.status] ?? 5) || left.name.localeCompare(right.name, "zh-CN"));
}

const ANNOTATION_STANDARD_EDITABLE = ["待标注", "标注中", "已驳回"];
const ANNOTATION_STANDARD_REVIEWABLE = ["待审核"];

function applyAnnotationStandard(state, body = {}, user = "系统") {
  const scope = resolveAnnotationGroup(state, body);
  if (!scope) throw new Error("任务或数据集不存在，或没有可标注的 Episode");
  const action = String(body.action || "save").trim();
  if (!["save", "submit", "approve", "reject", "reopen"].includes(action)) throw new Error("任务标注操作无效");
  const instruction = String(body.instruction == null ? state.annotationStandards?.[scope.key]?.instruction || "" : body.instruction).trim();
  if (!instruction) throw new Error("任务指令不能为空");
  if (instruction.length > 4000) throw new Error("任务指令不能超过 4000 个字符");
  const existing = state.annotationStandards?.[scope.key] || {}, currentStatus = existing.status || deriveAnnotationGroupStatus(state, scope.key);
  if (["approve", "reject"].includes(action) && String(existing.instruction || "").trim() !== instruction) throw new Error("审核操作只接受审核意见，不能修改任务指令");
  if (["save", "submit"].includes(action) && !ANNOTATION_STANDARD_EDITABLE.includes(currentStatus)) throw new Error(`当前状态“${currentStatus}”不能修改任务指令`);
  if (action === "approve" && !ANNOTATION_STANDARD_REVIEWABLE.includes(currentStatus)) throw new Error("只有待审核的任务指令可以审核通过");
  if (action === "reject" && !ANNOTATION_STANDARD_REVIEWABLE.includes(currentStatus)) throw new Error("只有待审核的任务指令可以退回");
  if (action === "reopen" && !["已通过", "已驳回"].includes(currentStatus)) throw new Error("只有已通过或已驳回的任务指令可以重新打开");
  const note = String(body.note == null ? existing.note || "" : body.note || "").trim();
  if (action === "reject" && !note) throw new Error("退回任务指令时必须填写审核意见");
  const now = new Date().toISOString(), nextStatus = action === "submit" ? "待审核" : action === "approve" ? "已通过" : action === "reject" ? "已驳回" : "标注中";
  const standard = {
    ...existing, key: scope.key, scopeType: scope.scopeType, scopeId: scope.scopeId, scopeName: scope.name,
    instruction, status: nextStatus, autoImported: false, importedEpisodes: 0, sourceFiles: [], updatedAt: now, updatedBy: user, note: ["approve", "reject"].includes(action) ? note : action === "submit" ? "" : existing.note || "",
    ...(action === "submit" ? { submittedAt: now, submittedBy: user, reviewer: "", reviewedAt: "" } : {}),
    ...(action === "approve" ? { reviewer: user, reviewedAt: now } : {}),
    ...(["save", "reopen", "reject"].includes(action) ? { reviewer: action === "reject" ? user : "", reviewedAt: action === "reject" ? now : "", ...(action === "reject" ? {} : { submittedAt: "", submittedBy: "" }) } : {}),
  };
  state.annotationStandards = state.annotationStandards && typeof state.annotationStandards === "object" ? state.annotationStandards : {};
  state.annotationStandards[scope.key] = standard;
  let updated = 0;
  annotationGroupAnnotations(state, scope.key).forEach(annotation => {
    const from = annotation.status, history = (Array.isArray(annotation.history) ? annotation.history : []).slice(-49);
    history.push({ action: "standardize", from, to: nextStatus, at: now, by: user, note: `任务级指令${action === "save" ? "保存" : action === "submit" ? "提交审核" : action === "approve" ? "审核通过" : action === "reject" ? "审核退回" : "重新打开"}` });
    Object.assign(annotation, {
      groupKey: scope.key, taskId: scope.scopeType === "task" ? scope.scopeId : "", taskName: scope.scopeType === "task" ? scope.name : "",
      instruction, status: nextStatus, autoImported: false, progress: nextStatus === "已通过" ? 100 : nextStatus === "待审核" ? 90 : 40,
      note: action === "approve" ? note : annotation.note || "", updatedAt: now, updatedBy: user, history,
      ...(action === "approve" ? { reviewer: user, reviewedBy: user, reviewedAt: now, annotator: annotation.annotator || existing.submittedBy || user } : {}),
      ...(action === "submit" ? { submittedAt: now, submittedBy: user, reviewer: "", reviewedBy: "", reviewedAt: "" } : {}),
      ...(["save", "reopen", "reject"].includes(action) ? { submittedAt: action === "reject" ? annotation.submittedAt || "" : "", submittedBy: action === "reject" ? annotation.submittedBy || "" : "", reviewer: action === "reject" ? user : "", reviewedBy: action === "reject" ? user : "", reviewedAt: action === "reject" ? now : "" } : {}),
    });
    updated++;
  });
  return { standard, updated, scope, action, previousStatus: currentStatus, nextStatus };
}

function submitAnnotationStandards(state, body = {}, user = "系统") {
  const groupKeys = [...new Set((Array.isArray(body.groupKeys) ? body.groupKeys : []).map(key => String(key || "").trim()).filter(Boolean))];
  if (!groupKeys.length) throw new Error("请选择至少一个任务或数据集");
  if (groupKeys.length > 100) throw new Error("一次最多批量提交 100 个任务或数据集");
  const submitted = [], skipped = [];
  groupKeys.forEach(key => {
    const scope = annotationGroupMeta(state, key);
    if (!scope) { skipped.push({ key, reason: "任务或数据集不存在" }); return; }
    const currentStatus = state.annotationStandards?.[key]?.status || deriveAnnotationGroupStatus(state, key);
    if (!ANNOTATION_STANDARD_EDITABLE.includes(currentStatus)) { skipped.push({ key, name: scope.name, reason: `当前状态“${currentStatus}”不能提交` }); return; }
    const instruction = String(state.annotationStandards?.[key]?.instruction || "").trim();
    if (!instruction) { skipped.push({ key, name: scope.name, reason: "尚未填写任务指令" }); return; }
    const result = applyAnnotationStandard(state, { groupKey: key, action: "submit", instruction }, user);
    submitted.push({ key, name: scope.name, updated: result.updated, status: result.nextStatus });
  });
  return { submitted, skipped };
}

function generateAnnotationTasks(state, user = "系统", domainUser = null) {
  const bundles = new Map();
  state.assets.filter(asset => !asset.isDemo && asset.bundleId && asset.serverFile && typeAllowed(domainUser, asset.type)).forEach(asset => {
    if (!bundles.has(asset.bundleId)) bundles.set(asset.bundleId, []);
    bundles.get(asset.bundleId).push(asset);
  });
  const episodes = [];
  bundles.forEach((files, bundleId) => {
    const trajectories = files.filter(isLogicalEpisodeAsset);
    trajectories.forEach(trajectory => {
      const episodeIndex = episodeIndexForAsset(trajectory);
      if (!Number.isInteger(episodeIndex)) return;
      episodes.push({ bundleId, groupKey: annotationGroupKeyForAsset(trajectory), episodeIndex, trajectory, files });
    });
  });
  const existing = new Set(state.annotations.map(item => `${annotationGroupKeyForAnnotation(state, item)}:${item.bundleId || ""}:${item.episodeIndex}`));
  const created = episodes.filter(item => !existing.has(`${item.groupKey}:${item.bundleId}:${item.episodeIndex}`) && item.trajectory.lastQcAt).map(item => {
    const annotationId = `ANN-${crypto.createHash("sha1").update(`${item.groupKey}:${item.bundleId}:${item.episodeIndex}`).digest("hex").slice(0, 16).toUpperCase()}`;
    const standard = annotationStandardFor(state, item.groupKey), meta = annotationGroupMeta(state, item.groupKey);
    const approved = annotationStandardApproved(standard);
    return {
      id: annotationId, assetId: item.trajectory.id, bundleId: item.bundleId, groupKey: item.groupKey,
      taskId: item.trajectory.taskId || "", taskName: item.trajectory.taskName || (meta?.scopeType === "task" ? meta.name : ""),
      bundleName: item.trajectory.bundleName || item.bundleId, episodeIndex: item.episodeIndex,
      episode: `EP-${String(item.episodeIndex).padStart(6, "0")}`, type: item.trajectory.type,
      title: `${meta?.name || item.trajectory.bundleName || item.bundleId} · Episode ${item.episodeIndex}`,
      assignee: standard?.updatedBy || "未分配", progress: approved ? 100 : standard ? 40 : 0, status: approved ? "已通过" : standard ? "标注中" : "待标注",
      instruction: standard?.instruction || "", outcome: "", failureReason: "", segments: [], tags: [], note: "", history: [], schemaVersion: "annotation.v3",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...(approved ? { reviewer: standard.reviewer || standard.updatedBy || "系统", reviewedBy: standard.reviewer || standard.updatedBy || "系统", reviewedAt: standard.reviewedAt || standard.updatedAt } : {}),
    };
  });
  state.annotations.unshift(...created);
  audit(state, "生成 Episode 标注任务", "标注工作台", `${created.length} 个 Episode 进入标注队列`, user);
  return created;
}

function reconcileImportedAnnotationStandard(state, key, actor = "系统自动导入", importedAt = new Date().toISOString()) {
  const scope = annotationGroupMeta(state, key);
  if (!scope) return null;
  const existing = state.annotationStandards?.[key];
  if (existing?.status === "已通过" && existing.autoImported !== true) return existing;
  const episodes = state.assets.filter(asset => !asset.isDemo && isLogicalEpisodeAsset(asset) && annotationGroupKeyForAsset(asset) === key);
  const annotations = episodes.map(asset => state.annotations.find(item => item.assetId === asset.id && isCurrentAnnotation(state, item))).filter(Boolean);
  if (!annotations.length) return null;
  const instructions = [...new Set(annotations.map(item => String(item.instruction || "").trim()).filter(Boolean))];
  if (!instructions.length) return null;
  const complete = episodes.length > 0 && episodes.every(asset => {
    const annotation = state.annotations.find(item => item.assetId === asset.id && isCurrentAnnotation(state, item));
    return annotationApproved(annotation);
  });
  const autoAnnotations = annotations.filter(item => item.autoImported === true);
  const sourceFiles = [...new Map(autoAnnotations.flatMap(item => (item.importEvidence?.files || []).map(file => [file.relativePath, file])).filter(([relativePath]) => relativePath)).values()];
  const instruction = instructions.length === 1 ? instructions[0] : `已从源数据自动导入 ${annotations.length} 个 Episode，共 ${instructions.length} 条任务指令（按 Episode 保留）`;
  const next = {
    ...(existing || {}), key, scopeType: scope.scopeType, scopeId: scope.scopeId, scopeName: scope.name,
    instruction, instructions, instructionCount: instructions.length, status: complete ? "已通过" : "标注中",
    autoImported: autoAnnotations.length > 0, completeAutoImport: autoAnnotations.length === annotations.length, importedEpisodes: annotations.length, sourceFiles,
    updatedAt: importedAt, updatedBy: actor, submittedAt: importedAt, submittedBy: actor,
    ...(complete ? { reviewer: actor, reviewedAt: importedAt } : { reviewer: "", reviewedAt: "" }),
    note: complete ? `系统已解析 ${sourceFiles.map(file => file.relativePath).join("、") || "源数据标注"}，并与 ${episodes.length} 个 Episode 逐一匹配。` : "源数据仅覆盖部分 Episode，其余记录仍需要人工补充。",
  };
  state.annotationStandards = state.annotationStandards && typeof state.annotationStandards === "object" ? state.annotationStandards : {};
  state.annotationStandards[key] = next;
  return next;
}

function applyImportedAnnotationEntries(state, bundleId, entries, analysis = {}) {
  const importedAt = analysis.importedAt || new Date().toISOString(), affectedGroups = new Set(), changed = [];
  (entries || []).forEach(entry => {
    const trajectory = state.assets.find(asset => !asset.isDemo && asset.bundleId === bundleId && asset.bundleRole === "trajectory" && episodeIndexForAsset(asset) === entry.episodeIndex);
    if (!trajectory || !String(entry.instruction || "").trim()) return;
    const existing = state.annotations.find(item => item.assetId === trajectory.id);
    if (existing?.status === "已通过" && existing.autoImported !== true) return;
    const groupKey = annotationGroupKeyForAsset(trajectory), meta = annotationGroupMeta(state, groupKey);
    const annotationId = existing?.id || `ANN-${crypto.createHash("sha1").update(`${groupKey}:${bundleId}:${entry.episodeIndex}`).digest("hex").slice(0, 16).toUpperCase()}`;
    const history = (Array.isArray(existing?.history) ? existing.history : []).slice(-49);
    history.push({ action: "auto-import", from: existing?.status || "未生成", to: "已通过", at: importedAt, by: "系统自动导入", note: `解析 ${entry.source?.relativePath || "源数据"} 并匹配 Episode ${entry.episodeIndex}` });
    const sourceFiles = [...new Map([...(existing?.importEvidence?.files || []), entry.source].filter(Boolean).map(file => [file.relativePath, file])).values()];
    const record = {
      ...(existing || {}), id: annotationId, assetId: trajectory.id, bundleId, groupKey,
      taskId: trajectory.taskId || "", taskName: trajectory.taskName || (meta?.scopeType === "task" ? meta.name : ""),
      bundleName: trajectory.bundleName || bundleId, episodeIndex: entry.episodeIndex, episode: `EP-${String(entry.episodeIndex).padStart(6, "0")}`,
      type: trajectory.type, title: `${meta?.name || trajectory.bundleName || bundleId} · Episode ${entry.episodeIndex}`,
      instruction: String(entry.instruction).trim(), outcome: entry.outcome || "", failureReason: entry.failureReason || "", segments: entry.segments || [], tags: entry.tags || [],
      status: "已通过", progress: 100, note: "源文件中的标注已通过内容解析、Episode 匹配和来源哈希校验，无需再次人工填写。",
      autoImported: true, importedAt, importEvidence: { files: sourceFiles, taskCount: analysis.taskCount || 0, warnings: analysis.warnings || [] },
      annotator: "系统自动导入", reviewer: "系统自动导入", reviewedBy: "系统自动导入", reviewedAt: importedAt,
      submittedAt: importedAt, submittedBy: "系统自动导入", updatedAt: importedAt, updatedBy: "系统自动导入", history,
      schemaVersion: "annotation.v4", assignee: "系统自动导入",
    };
    if (existing) Object.assign(existing, record); else state.annotations.unshift(record);
    affectedGroups.add(groupKey); changed.push(record);
  });
  affectedGroups.forEach(key => reconcileImportedAnnotationStandard(state, key, "系统自动导入", importedAt));
  return changed;
}

async function autoImportBundleAnnotations(bundleId, actor = "系统自动导入") {
  if (!bundleId) return { ok: true, imported: 0, sources: 0 };
  const state = readState(), assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId && asset.serverFile?.storedName);
  const sourceAssets = assets.filter(asset => annotationSourceKind(asset));
  if (!sourceAssets.length) return { ok: true, imported: 0, sources: 0 };
  const trajectories = assets.filter(isLogicalEpisodeAsset);
  const sources = [];
  for (const asset of sourceAssets) {
    const file = path.join(uploadDir, asset.serverFile.storedName);
    try {
      const size = fs.statSync(file).size;
      if (size > ANNOTATION_SOURCE_LIMIT) throw new Error(`标注源文件超过 ${ANNOTATION_SOURCE_LIMIT / 1024 / 1024}MB，拒绝同步读取`);
      sources.push({ assetId: asset.id, relativePath: asset.relativePath || asset.name, kind: annotationSourceKind(asset), sha256: asset.serverFile.sha256, text: fs.readFileSync(file, "utf8") });
    } catch (error) { sources.push({ assetId: asset.id, relativePath: asset.relativePath || asset.name, kind: annotationSourceKind(asset), sha256: asset.serverFile.sha256, text: "", error: error.message }); }
  }
  const episodeIndices = trajectories.map(episodeIndexForAsset).filter(Number.isInteger), taskIndicesByEpisode = {};
  let analysis = parseAnnotationImportSources({ sources: sources.filter(source => !source.error), episodeIndices, taskIndicesByEpisode });
  sources.filter(source => source.error).forEach(source => analysis.errors.push({ assetId: source.assetId, relativePath: source.relativePath, kind: source.kind, error: source.error }));
  if (analysis.entries.length < episodeIndices.length && sources.some(source => source.kind === "tasks")) {
    try {
      const report = await runLerobotSchemaCheck(trajectories.map(asset => path.join(uploadDir, asset.serverFile.storedName))), byName = new Map(report.files.map(item => [String(item.name || ""), item]));
      trajectories.forEach(asset => {
        const result = byName.get(path.basename(asset.serverFile.storedName)), episode = episodeIndexForAsset(asset);
        if (episode != null && result?.taskIndices?.length) taskIndicesByEpisode[episode] = result.taskIndices;
      });
      analysis = parseAnnotationImportSources({ sources: sources.filter(source => !source.error), episodeIndices, taskIndicesByEpisode });
      sources.filter(source => source.error).forEach(source => analysis.errors.push({ assetId: source.assetId, relativePath: source.relativePath, kind: source.kind, error: source.error }));
    } catch (error) { analysis.warnings.push(`Parquet task_index 解析失败：${error.message}`); }
  }
  analysis.importedAt = new Date().toISOString();
  const changed = applyImportedAnnotationEntries(state, bundleId, analysis.entries, analysis);
  sourceAssets.forEach(asset => {
    const sourceErrors = analysis.errors.filter(item => item.assetId === asset.id), imported = analysis.entries.filter(item => item.source?.assetId === asset.id).length;
    asset.inspection = { ...(asset.inspection || {}), annotationImport: { status: sourceErrors.length ? "invalid" : imported ? "verified" : "unmatched", importedEpisodes: imported, taskCount: analysis.taskCount, checkedAt: analysis.importedAt, sourceSha256: asset.serverFile?.sha256, errors: sourceErrors.map(item => item.error) } };
  });
  state.annotationImports = Array.isArray(state.annotationImports) ? state.annotationImports.filter(item => item.bundleId !== bundleId) : [];
  state.annotationImports.unshift({ id: `ANI-${crypto.createHash("sha1").update(`${bundleId}:${analysis.importedAt}`).digest("hex").slice(0, 12).toUpperCase()}`, bundleId, analyzedAt: analysis.importedAt, importedEpisodes: changed.length, episodeCount: episodeIndices.length, sourceCount: sourceAssets.length, taskCount: analysis.taskCount, status: analysis.errors.length ? "invalid" : changed.length === episodeIndices.length ? "complete" : changed.length ? "partial" : "unmatched", sources: sourceAssets.map(asset => ({ assetId: asset.id, relativePath: asset.relativePath || asset.name, kind: annotationSourceKind(asset), sha256: asset.serverFile?.sha256 })), errors: analysis.errors, warnings: analysis.warnings });
  state.annotationImports = state.annotationImports.slice(0, 500);
  audit(state, "自动解析标注源", bundleId, `源文件 ${sourceAssets.length} 个 · 匹配 ${changed.length}/${episodeIndices.length} 个 Episode · 指令 ${new Set(changed.map(item => item.instruction)).size} 条${analysis.errors.length ? ` · 错误 ${analysis.errors.length}` : ""}`, actor);
  writeState(state);
  return { ok: !analysis.errors.length, imported: changed.length, episodes: episodeIndices.length, sources: sourceAssets.length, errors: analysis.errors, warnings: analysis.warnings, annotationImports: state.annotationImports.filter(item => item.bundleId === bundleId) };
}

async function autoImportExistingAnnotationSources() {
  const bundleIds = [...new Set(readState().assets.filter(asset => !asset.isDemo && asset.bundleId && annotationSourceKind(asset)).map(asset => asset.bundleId))];
  const results = [];
  for (const bundleId of bundleIds) {
    try { results.push(await autoImportBundleAnnotations(bundleId, "升级迁移自动导入")); }
    catch (error) { console.warn(`升级扫描标注源失败 ${bundleId}: ${error.message}`); results.push({ ok: false, bundleId, error: error.message }); }
  }
  return results;
}

const ANNOTATION_STATUSES = ["待标注", "标注中", "待审核", "已通过", "已驳回"];
const ANNOTATION_EDITABLE_STATUSES = ["待标注", "标注中", "已驳回"];

function annotationActionFromBody(body = {}) {
  if (body.action) return String(body.action);
  return ({ "待标注": "save", "标注中": "save", "待审核": "submit", "已通过": "approve", "已驳回": "reject" })[body.status] || "save";
}

function normalizeAnnotationSegments(value) {
  if (!Array.isArray(value)) throw new Error("动作分段必须是数组");
  const segments = value.map((segment, index) => {
    const startFrame = Number(segment?.startFrame), endFrame = Number(segment?.endFrame);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
      throw new Error(`第 ${index + 1} 个动作分段必须使用非负整数帧，且结束帧必须大于开始帧`);
    }
    const skill = String(segment?.skill || "").trim();
    if (!skill) throw new Error(`第 ${index + 1} 个动作分段缺少技能名称`);
    return { startFrame, endFrame, skill, object: String(segment?.object || "").trim() };
  }).sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  for (let index = 1; index < segments.length; index++) {
    if (segments[index].startFrame < segments[index - 1].endFrame) throw new Error(`第 ${index} 与第 ${index + 1} 个动作分段存在重叠`);
  }
  return segments;
}

function annotationSubmissionIssues(annotation) {
  const issues = [];
  if (!String(annotation?.instruction || "").trim()) issues.push("任务指令");
  if (!["success", "failure"].includes(annotation?.outcome)) issues.push("执行结果");
  if (annotation?.outcome === "failure" && !String(annotation?.failureReason || "").trim()) issues.push("失败原因");
  if (!Array.isArray(annotation?.segments) || annotation.segments.length === 0) issues.push("至少一个动作分段");
  return issues;
}

function annotationApproved(annotation) {
  if (annotation?.status !== "已通过") return false;
  if (annotation.autoImported === true) return Boolean(String(annotation.instruction || "").trim());
  return annotationSubmissionIssues(annotation).length === 0;
}

function annotationInstructionForAsset(state, asset) {
  const annotation = state.annotations.find(item => item.assetId === asset?.id && isCurrentAnnotation(state, item));
  if (annotationApproved(annotation)) return String(annotation.instruction || "").trim();
  const standard = annotationStandardFor(state, annotationGroupKeyForAsset(asset));
  return annotationStandardApproved(standard) ? String(standard.instruction || "").trim() : "";
}

function applyAnnotationUpdate(state, body = {}, user = "系统") {
  const annotation = state.annotations.find(item => item.id === body.id);
  if (!annotation || !isCurrentAnnotation(state, annotation)) throw new Error("Episode 标注任务不存在");
  const action = annotationActionFromBody(body), previousStatus = annotation.status, now = new Date().toISOString();
  if (!["save", "submit", "approve", "reject", "reopen"].includes(action)) throw new Error("标注操作无效");
  if (action === "save" && !ANNOTATION_EDITABLE_STATUSES.includes(previousStatus)) throw new Error(`当前状态“${previousStatus}”不能保存草稿`);
  if (action === "submit" && !ANNOTATION_EDITABLE_STATUSES.includes(previousStatus)) throw new Error(`当前状态“${previousStatus}”不能提交审核`);
  if (action === "approve" && previousStatus !== "待审核") throw new Error("只有待审核的标注可以审核通过");
  if (action === "reject" && previousStatus !== "待审核") throw new Error("只有待审核的标注可以退回");
  if (action === "reopen" && !["已通过", "已驳回"].includes(previousStatus)) throw new Error("只有已通过或已驳回的标注可以重新打开");
  const history = (Array.isArray(annotation.history) ? annotation.history : []).slice(-49);
  const appendHistory = (to, note = "") => history.push({ action, from: previousStatus, to, at: now, by: user, note: String(note || "").slice(0, 500) });

  if (["approve", "reject"].includes(action)) {
    const contentFields = ["instruction", "outcome", "failureReason", "segments", "tags", "assignee"];
    const attempted = contentFields.filter(key => Object.prototype.hasOwnProperty.call(body, key));
    if (attempted.length) throw new Error("审核操作只接受审核意见，不能修改标注内容");
  }

  if (action === "reject") {
    const note = body.note == null ? String(annotation.note || "") : String(body.note);
    if (!note.trim()) throw new Error("退回修改时必须填写审核意见");
    appendHistory("已驳回", note);
    Object.assign(annotation, {
      status: "已驳回", note, progress: Math.min(Number(annotation.progress || 0), 80),
      reviewer: user, reviewedBy: user, reviewedAt: now, updatedAt: now, updatedBy: user, history,
    });
    return { annotation, action, previousStatus, nextStatus: "已驳回" };
  }

  if (action === "approve") {
    const issues = annotationSubmissionIssues(annotation);
    if (issues.length) throw new Error(`标注证据不完整，不能审核通过：缺少${issues.join("、")}`);
    const note = body.note == null ? "" : String(body.note).trim();
    appendHistory("已通过", note);
    Object.assign(annotation, {
      status: "已通过", note, progress: 100,
      reviewer: user, reviewedBy: user, reviewedAt: now, updatedAt: now, updatedBy: user, history,
    });
    return { annotation, action, previousStatus, nextStatus: "已通过" };
  }

  const standard = annotationStandardFor(state, annotation.bundleId);
  const instruction = standard ? standard.instruction : body.instruction == null ? String(annotation.instruction || "").trim() : String(body.instruction).trim();
  const outcome = body.outcome == null ? String(annotation.outcome || "").trim() : String(body.outcome).trim();
  const failureReason = body.failureReason == null ? String(annotation.failureReason || "").trim() : String(body.failureReason).trim();
  if (!["", "success", "failure"].includes(outcome)) throw new Error("标注结果必须是 success、failure 或留空");
  const sourceSegments = body.segments == null ? (Array.isArray(annotation.segments) ? annotation.segments : []) : body.segments;
  const segments = normalizeAnnotationSegments(sourceSegments);
  const note = body.note == null ? String(annotation.note || "") : String(body.note);
  const candidate = { ...annotation, instruction, outcome, failureReason, segments };
  const issues = annotationSubmissionIssues(candidate);
  if (["submit", "approve"].includes(action) && issues.length) throw new Error(`标注尚未完成：请补充${issues.join("、")}`);
  const nextStatus = action === "save" || action === "reopen" ? "标注中" : action === "submit" ? "待审核" : "已通过";
  const progress = nextStatus === "已通过" ? 100 : nextStatus === "待审核" ? 90 : issues.length ? (instruction ? 40 : 0) : 80;
  appendHistory(nextStatus, note);
  Object.assign(annotation, {
    status: nextStatus, instruction, outcome, failureReason, segments, note, progress,
    tags: Array.isArray(body.tags) ? [...new Set(body.tags.map(String))] : annotation.tags,
    assignee: body.assignee || annotation.assignee || "未分配", updatedAt: now, updatedBy: user, history,
    annotator: annotation.annotator || user,
  });
  if (nextStatus === "待审核") Object.assign(annotation, { submittedAt: now, submittedBy: user, reviewer: "", reviewedBy: "", reviewedAt: "", note: "" });
  if (nextStatus === "已通过") Object.assign(annotation, { reviewer: user, reviewedBy: user, reviewedAt: now });
  if (nextStatus === "标注中") Object.assign(annotation, { submittedAt: "", submittedBy: "", reviewer: "", reviewedBy: "", reviewedAt: "" });
  return { annotation, action, previousStatus, nextStatus };
}

function episodeIndexForAsset(asset) {
  if (Number.isInteger(asset?.episodeIndex) && asset.episodeIndex >= 0) return Number(asset.episodeIndex);
  const match = /episode_(\d+)\.(?:parquet|mp4)$/i.exec(asset?.relativePath || asset?.name || "");
  return match ? Number(match[1]) : null;
}

function mediaViewForAsset(asset) {
  const relativePath = String(asset?.relativePath || asset?.name || "").replace(/\\/g, "/");
  const match = /\/videos\/chunk-[^/]+\/([^/]+)\/episode_\d+\.mp4$/i.exec(relativePath);
  return match ? match[1] : asset?.bundleRole === "media" ? path.basename(path.dirname(relativePath)) : "";
}

function expectedMediaViewsForBundle(state, bundleId) {
  const bundleAssets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId);
  const meta = bundleAssets.find(asset => asset.bundleRole === "meta" && /meta[\\/]info\.json$/i.test(asset.relativePath || asset.name) && asset.serverFile?.storedName);
  if (meta) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(uploadDir, meta.serverFile.storedName), "utf8"));
      const views = Object.entries(info.features || {}).filter(([, feature]) => feature?.dtype === "video").map(([key]) => key);
      if (views.length) return views;
    } catch {}
  }
  return [];
}

function mediaViewPolicyForBundle(state, bundleId) {
  const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId);
  const expectedViews = expectedMediaViewsForBundle(state, bundleId), observedViews = [...new Set(assets.filter(asset => asset.bundleRole === "media").map(mediaViewForAsset).filter(Boolean))];
  const effectiveViews = expectedViews.length ? expectedViews : observedViews;
  return { expectedViews: effectiveViews, declaredViews: expectedViews, expectedCount: effectiveViews.length, observedViews, source: expectedViews.length ? "metadata" : observedViews.length ? "observed-files" : "none", type: assets[0]?.type || null };
}

function mediaViewsForEpisode(assets, episodeIndex) {
  return assets.filter(asset => asset.bundleRole === "media" && episodeIndexForAsset(asset) === episodeIndex).map(asset => ({ view: mediaViewForAsset(asset), asset })).filter(item => item.view);
}

function exportBatchForAssets(state, assetIds = []) {
  const ids = new Set((assetIds || []).map(String)), assets = state.assets.filter(asset => ids.has(asset.id)), bundleIds = [...new Set(assets.map(asset => asset.bundleId).filter(Boolean))].sort();
  if (!bundleIds.length) return { batchId: "", batchIds: [], batchName: "", episodeCount: 0, fileCount: assets.length };
  const trajectories = assets.filter(asset => asset.bundleRole === "trajectory" && Number.isInteger(episodeIndexForAsset(asset)));
  return {
    batchId: bundleIds.join("+"),
    batchIds: bundleIds,
    batchName: bundleIds.length === 1 ? (assets.find(asset => asset.bundleId === bundleIds[0])?.bundleName || bundleIds[0]) : bundleIds.map(id => assets.find(asset => asset.bundleId === id)?.bundleName || id).join(" + "),
    episodeCount: trajectories.length,
    fileCount: assets.length,
  };
}

function normalizeExportHistory(state) {
  const byBatch = new Map(), unbatched = [];
  (state.exports || []).forEach(job => {
    const batch = exportBatchForAssets(state, job.assetIds || []), normalized = { ...job, format: TRAINING_DELIVERY_FORMAT, baseFormat: job.baseFormat || (job.lerobotVersion ? `LeRobot ${job.lerobotVersion}` : null), batchId: job.batchId || batch.batchId, batchIds: job.batchIds || batch.batchIds, batchName: job.batchName || batch.batchName, episodeCount: Number(job.episodeCount || batch.episodeCount || 0), fileCount: Number(job.fileCount || batch.fileCount || job.assetCount || 0) };
    if (!normalized.batchId) { unbatched.push(normalized); return; }
    const existing = byBatch.get(normalized.batchId);
    if (!existing || String(normalized.createdAt || "").localeCompare(String(existing.createdAt || "")) < 0) byBatch.set(normalized.batchId, normalized);
  });
  return [...byBatch.values(), ...unbatched].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function buildBundleManifest(state, options = {}) {
  const id = String(options.id || "").trim(), name = String(options.name || "").trim(), format = String(options.format || TRAINING_DELIVERY_FORMAT), createdAt = options.createdAt || new Date().toISOString(), contents = Array.isArray(options.contents) ? [...new Set(options.contents.map(String))] : ["原始文件", "质量报告", "标注清单"];
  const ids = new Set((options.assetIds || []).map(String)), assets = state.assets.filter(asset => ids.has(asset.id) && !asset.isDemo && asset.serverFile), bundleIds = [...new Set(assets.map(asset => asset.bundleId).filter(Boolean))];
  if (bundleIds.length !== 1) throw new Error("Manifest 必须且只能对应一个生产批次");
  const bundleId = bundleIds[0], batch = exportBatchForAssets(state, assets.map(asset => asset.id)), bundleAssets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId), mediaViewPolicy = mediaViewPolicyForBundle(state, bundleId), expectedMediaViews = mediaViewPolicy.expectedViews;
  const fileRef = asset => ({ id: asset.id, name: asset.name, role: asset.bundleRole || null, view: asset.bundleRole === "media" ? mediaViewForAsset(asset) : null, format: asset.format, relativePath: asset.relativePath || asset.name, size: asset.serverFile?.size || asset.size || 0, sha256: asset.serverFile?.sha256 || null, source: `/api/assets/${encodeURIComponent(asset.id)}/file` });
  const episodeRecords = assets.filter(isLogicalEpisodeAsset).map(asset => {
    const groupKey = annotationGroupKeyForAsset(asset), standard = annotationStandardFor(state, groupKey), annotation = state.annotations.find(item => item.assetId === asset.id && isCurrentAnnotation(state, item)), episodeIndex = episodeIndexForAsset(asset);
    const annotationId = annotation?.id || `ANN-${crypto.createHash("sha1").update(`${groupKey}:${asset.bundleId || ""}:${episodeIndex}`).digest("hex").slice(0, 16).toUpperCase()}`;
    const videos = mediaViewsForEpisode(bundleAssets, episodeIndex).map(item => ({ ...fileRef(item.asset), view: item.view })).sort((left, right) => String(left.view).localeCompare(String(right.view)));
    const instruction = annotationInstructionForAsset(state, asset), approved = Boolean(instruction);
    return { asset, groupKey, standard, annotation, episodeIndex, annotationId, instruction, approved, videos };
  });
  const recordByAssetId = new Map(episodeRecords.map(item => [item.asset.id, item]));
  const lerobot = options.lerobot ? { ...options.lerobot, directory: options.lerobot.relativeDirectory || options.lerobot.directory, sourceVersion: options.lerobot.sourceVersion || options.lerobot.version, targetVersion: options.lerobot.targetVersion || "v3.0", trainingReady: options.lerobot.trainingReady === true } : null;
  const manifest = { schemaVersion: "1.4", id, name, targetFormat: format, createdAt, batchId: bundleId, batchName: batch.batchName, scope: "当前生产批次门禁通过", contents, episodeCount: episodeRecords.length, fileCount: assets.length, assetCount: assets.length, expectedMediaViews, expectedMediaViewCount: mediaViewPolicy.expectedCount, mediaViewPolicySource: mediaViewPolicy.source, lerobot, sourceFormats: [...new Set(assets.map(asset => asset.format).filter(Boolean))], annotationCount: episodeRecords.filter(item => item.approved).length, annotationsFile: episodeRecords.some(item => item.approved) ? `${id}-annotations.jsonl` : null, episodes: episodeRecords.map(episode => ({ episodeId: `EP-${String(episode.episodeIndex).padStart(6, "0")}`, episodeIndex: episode.episodeIndex, taskId: episode.asset.taskId || null, instruction: episode.instruction, trajectory: fileRef(episode.asset), videos: episode.videos, review: { status: episode.approved ? "approved" : "missing", source: episode.annotation?.autoImported ? "source-jsonl-auto-import" : "manual", reviewer: episode.annotation?.autoImported ? "系统自动导入" : episode.standard?.reviewer || "", reviewedAt: episode.annotation?.autoImported ? episode.annotation.reviewedAt : episode.standard?.reviewedAt || episode.standard?.updatedAt || null } })), assets: assets.map(asset => {
    const episode = recordByAssetId.get(asset.id), episodeIndex = episodeIndexForAsset(asset);
    return { ...fileRef(asset), episodeIndex: episode?.episodeIndex ?? episodeIndex, episodeId: Number.isInteger(episodeIndex) ? `EP-${String(episodeIndex).padStart(6, "0")}` : null, type: asset.type, sourceRoot: asset.sourceRoot || asset.bundleName || null, bundleId: asset.bundleId || null, bundleRole: asset.bundleRole || null, taskId: asset.taskId || null, quality: { score: asset.score, status: asset.status, template: asset.qcTemplate, lastQcAt: asset.lastQcAt }, containerEvidence: asset.serverFile.deepCheck || asset.serverFile.contentCheck, annotationId: episode?.annotationId || null, annotationInstruction: episode?.instruction || null };
  }) };
  const annotationLines = episodeRecords.filter(item => item.approved).map(({ asset, standard, annotation, episodeIndex, annotationId, instruction }) => JSON.stringify({
    schema_version: "1.0.0", annotation_id: annotationId, dataset_id: asset.bundleId, task_id: asset.taskId || null, episode_index: episodeIndex,
    instruction, outcome: annotation?.autoImported ? annotation.outcome || null : null, failure_reason: annotation?.autoImported ? annotation.failureReason || "" : "", tags: annotation?.autoImported ? annotation.tags || [] : standard.tags || [], segments: annotation?.autoImported ? annotation.segments || [] : [],
    review: { annotator: annotation?.autoImported ? "系统自动导入" : standard?.updatedBy || annotation?.annotator || "", reviewer: annotation?.autoImported ? "系统自动导入" : standard?.reviewer || "", status: "approved", source: annotation?.autoImported ? "source-jsonl-auto-import" : "manual", submitted_at: annotation?.autoImported ? annotation.importedAt || null : standard?.submittedAt || null, reviewed_at: annotation?.autoImported ? annotation.reviewedAt || annotation.importedAt || null : standard?.reviewedAt || standard?.updatedAt || null },
  }));
  return { manifest, annotationLines, batch };
}

function rebuildLegacyExportManifests(state) {
  let rebuilt = 0;
  state.exports.forEach(job => {
    const target = job.fileName ? path.join(exportDir, job.fileName) : "";
    if (!target || !target.startsWith(exportDir) || !fs.existsSync(target)) return;
    try {
      const current = JSON.parse(fs.readFileSync(target, "utf8"));
      if (current.schemaVersion === "1.4" && current.targetFormat === TRAINING_DELIVERY_FORMAT) return;
      const built = buildBundleManifest(state, { id: job.id, name: job.name, format: TRAINING_DELIVERY_FORMAT, contents: job.contents, assetIds: job.assetIds, createdAt: job.createdAt, lerobot: job.lerobotDirectory ? { directory: job.lerobotRelativeDirectory || job.lerobotDirectory, sourceVersion: job.lerobotVersion, targetVersion: "v3.0", trainingReady: false, validation: job.lerobotValidation } : null });
      fs.writeFileSync(target, JSON.stringify(built.manifest, null, 2), "utf8");
      if (built.annotationLines.length) fs.writeFileSync(path.join(exportDir, `${job.id}-annotations.jsonl`), `${built.annotationLines.join("\n")}\n`, "utf8");
      Object.assign(job, { batchId: built.manifest.batchId, batchIds: [built.manifest.batchId], batchName: built.manifest.batchName, episodeCount: built.manifest.episodeCount, fileCount: built.manifest.fileCount, annotationCount: built.manifest.annotationCount });
      rebuilt++;
    } catch (error) { console.warn(`旧交付清单重建失败 ${job.id}: ${error.message}`); }
  });
  return rebuilt;
}

function hasProductionEvidence(asset) { return Boolean(asset.serverFile?.sha256 && asset.inspection?.production?.sha256 === asset.serverFile.sha256 && !asset.inspection.production.error); }
function bundleRequiredRoles(assets) {
  const roles = new Set((assets || []).map(asset => asset.bundleRole).filter(Boolean));
  const presets = new Set((assets || []).map(asset => String(asset.bundlePreset || "").trim()).filter(Boolean));
  if (["lerobot-v21", "standard-3"].some(preset => presets.has(preset))) return ["meta", "trajectory", "media"];
  if (presets.has("media")) return ["media"];
  if (["hdf5", "hdf5-sequence", "umi-session", "mcap", "parquet", "structured"].some(preset => presets.has(preset))) return ["trajectory"];
  if (presets.has("single")) return roles.has("trajectory") ? ["trajectory"] : roles.has("media") ? ["media"] : roles.has("meta") ? ["meta"] : [];
  if (roles.has("meta") || roles.has("media")) return [...roles];
  if (roles.has("trajectory")) return ["trajectory"];
  return roles.size ? [...roles] : [];
}

function isHdf5SequenceAsset(asset) {
  return asset?.bundleRole === 'trajectory' && (asset.format === 'HDF5_SEQUENCE' || asset.serverFile?.mode === 'external-hdf5-sequence');
}

function isUmiSessionAsset(asset) {
  return asset?.bundleRole === 'trajectory' && (asset.format === 'UMI_SESSION' || asset.serverFile?.mode === 'external-umi-session');
}

function isLogicalEpisodeAsset(asset) {
  return asset?.bundleRole === 'trajectory' && (/episode_\d+\.parquet$/i.test(asset.relativePath || asset.name || '') || isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset));
}

function registerHdf5SequenceDirectory(state, body, user, preparedScan = null) {
  const scan = preparedScan || hdf5Sequence.scanHdf5SequenceRoot(body.rootPath);
  if (scan.episodeCount > 10000) throw new Error(`目录内聚合出 ${scan.episodeCount} 个 Episode，超过单批 10000 个限制`);
  const existingByDirectory = new Map(state.assets.filter(asset => asset.serverFile?.mode === 'external-hdf5-sequence').map(asset => [path.resolve(asset.sourceDirectory || '').toLowerCase(), asset]));
  const existingEpisodes = scan.episodes.map(episode => ({ episode, asset: existingByDirectory.get(path.resolve(episode.directory).toLowerCase()) })).filter(item => item.asset);
  if (existingEpisodes.length === scan.episodes.length) {
    const changed = existingEpisodes.filter(item => item.asset.serverFile?.provenanceVersion !== 'content-sha256-v1' || item.asset.serverFile?.sha256 !== item.episode.fingerprints);
    if (changed.length) {
      const error = new Error(`目录已有 ${changed.length} 个 Episode 与当前内容哈希不一致或来自旧版元数据指纹。请删除未验收批次后重新导入；已验收批次应建立修订批次。`);
      error.status = 409;
      throw error;
    }
    const bundleIds = [...new Set(existingEpisodes.map(item => item.asset.bundleId).filter(Boolean))], bundleId = bundleIds.length === 1 ? bundleIds[0] : existingEpisodes[0].asset.bundleId;
    const bundle = state.bundles.find(item => item.id === bundleId);
    return { bundleId, bundleName: bundle?.name || existingEpisodes[0].asset.bundleName || scan.rootName, scan, assets: existingEpisodes.map(item => item.asset), createdCount: 0, existingCount: existingEpisodes.length };
  }
  if (existingEpisodes.length) {
    const existingNames = existingEpisodes.map(item => item.episode.name).join('、'), newNames = scan.episodes.filter(episode => !existingByDirectory.has(path.resolve(episode.directory).toLowerCase())).map(episode => episode.name).join('、');
    throw new Error(`目录共识别 ${scan.episodes.length} 个 Episode；已存在：${existingNames}；待新增：${newNames}。请先将新增目录放入独立根目录，避免重复登记`);
  }
  const type = String(body.type || '遥操').trim();
  if (!DATA_TYPES.includes(type)) throw new Error('数据类型必须是 UMI、EGO 或遥操');
  const bundleId = `BND-${Date.now().toString(36).toUpperCase()}`, now = new Date().toISOString();
  const bundleName = String(body.bundleName || scan.rootName).trim() || scan.rootName;
  const records = scan.episodes.map(episode => {
    const assetId = `AST-${crypto.createHash('sha1').update(`${bundleId}:${episode.relativePath}`).digest('hex').slice(0, 40)}`;
    const manifestName = `${assetId}-sequence.json`;
    const manifest = hdf5Sequence.buildSequenceManifest(scan, episode, { assetId, bundleId });
    fs.writeFileSync(path.join(uploadDir, manifestName), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
    return {
      id: assetId, name: episode.name, type, size: episode.totalBytes, format: 'HDF5_SEQUENCE', records: `${episode.fileCount} 帧`,
      inspection: {}, mediaMetadata: { embedded: true, cameras: ['camera_0', 'camera_1', 'camera_2', 'camera_3'] },
      scene: String(body.scene || scan.rootName), node: String(body.node || ''), taskId: String(body.taskId || ''), taskName: String(body.taskName || ''),
      model: String(body.model || '未关联'), qcTemplate: String(body.qcTemplate || '标准质检'), annotationStatus: String(body.annotationStatus || '未标注'),
      createdAt: now, updatedAt: now, createdById: user.id, score: 0, status: '待质检', lastQcAt: '', bundleId, bundleName,
      bundlePreset: 'hdf5-sequence', bundlePresetSource: 'server-directory', bundlePresetReason: '服务端目录扫描：每个包含 HDF5 帧的目录聚合为一个 Episode',
      bundleRole: 'trajectory', bundleRoleLabel: '轨迹序列', bundleFileIndex: episode.episodeIndex + 1, bundleFileCount: scan.episodeCount,
      relativePath: episode.relativePath, sourceRoot: scan.rootName, sourceFolder: episode.relativePath, sourceDirectory: episode.directory,
      episodeIndex: episode.episodeIndex, frameCount: episode.fileCount, firstSourceFile: episode.firstFile, lastSourceFile: episode.lastFile,
      serverFile: {
        mode: 'external-hdf5-sequence', storedName: manifestName, sourceRoot: scan.rootPath, sourceDirectory: episode.directory,
        originalName: episode.name, sha256: episode.fingerprints, provenanceVersion: 'content-sha256-v1', size: episode.totalBytes, fileCount: episode.fileCount,
        sequenceProfile: scan.profile, storedAt: now, uploadMode: 'server-directory-reference',
        contentCheck: { valid: true, extension: 'HDF5_SEQUENCE', detail: `已登记 ${episode.fileCount} 个 HDF5 帧文件`, recordCount: episode.fileCount },
      },
      serverManaged: true,
    };
  });
  try {
    state.assets.unshift(...records);
    mergeRecord(state.bundles, { id: bundleId, name: bundleName, type, preset: 'hdf5-sequence', presetSource: 'server-directory', sourceRoot: scan.rootPath, status: '待质检', assetCount: records.length, episodeCount: records.length, frameCount: scan.fileCount, totalBytes: scan.totalBytes, createdAt: now, createdBy: user.name, updatedAt: now });
    audit(state, '服务端目录导入 HDF5 序列', bundleId, `${bundleName} · ${records.length} Episode · ${scan.fileCount} 帧 · ${scan.totalBytes} bytes`, user.name);
    writeState(state);
    return { bundleId, bundleName, scan, assets: records, createdCount: records.length, existingCount: 0 };
  } catch (error) {
    for (const asset of records) fs.rmSync(path.join(uploadDir, asset.serverFile.storedName), { force: true });
    throw error;
  }
}

function registerUmiSessionDirectory(state, body, user, preparedScan = null) {
  const scan = preparedScan || umiData.scanUmiRoot(body.rootPath);
  if (scan.sessionCount > 10000) throw new Error(`UMI directory contains ${scan.sessionCount} sessions; the batch limit is 10000`);
  const existingByDirectory = new Map(state.assets.filter(asset => asset.serverFile?.mode === 'external-umi-session').map(asset => [path.resolve(asset.sourceDirectory || '').toLowerCase(), asset]));
  const existingSessions = scan.sessions.map(session => ({ session, asset: existingByDirectory.get(path.resolve(session.directory).toLowerCase()) })).filter(item => item.asset);
  if (existingSessions.length === scan.sessions.length) {
    const bundleIds = [...new Set(existingSessions.map(item => item.asset.bundleId).filter(Boolean))], bundleId = bundleIds.length === 1 ? bundleIds[0] : existingSessions[0].asset.bundleId;
    const bundle = state.bundles.find(item => item.id === bundleId);
    return { bundleId, bundleName: bundle?.name || existingSessions[0].asset.bundleName || scan.rootName, scan, assets: existingSessions.map(item => item.asset), createdCount: 0, existingCount: existingSessions.length };
  }
  if (existingSessions.length) {
    const existingNames = existingSessions.map(item => item.session.name).join(', ');
    throw new Error(`UMI directory contains ${scan.sessionCount} sessions; already registered: ${existingNames}. Import new sessions from a separate root`);
  }
  const type = String(body.type || 'UMI').trim();
  if (type !== 'UMI') throw new Error('UMI session directories must use data type UMI');
  const bundleId = `BND-${Date.now().toString(36).toUpperCase()}`, now = new Date().toISOString();
  const bundleName = String(body.bundleName || scan.rootName).trim() || scan.rootName;
  const records = scan.sessions.map((session, index) => {
    const episode = { ...session, episodeIndex: index }, assetId = `AST-${crypto.createHash('sha1').update(`${bundleId}:${session.directory}`).digest('hex').slice(0, 40)}`;
    const manifestName = `${assetId}-umi-session.json`, manifest = umiData.buildUmiManifest(scan, episode, { assetId, bundleId });
    fs.writeFileSync(path.join(uploadDir, manifestName), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
    return {
      id: assetId, name: session.name, type: 'UMI', size: session.totalBytes, format: 'UMI_SESSION', records: `${session.frameCount} 帧`,
      inspection: {}, mediaMetadata: { embedded: true, cameras: ['camera_0'], fps: 40 },
      scene: String(body.scene || scan.rootName), node: String(body.node || ''), taskId: String(body.taskId || ''), taskName: String(body.taskName || session.taskName || ''),
      model: String(body.model || '未关联'), qcTemplate: String(body.qcTemplate || '标准质检'), annotationStatus: String(body.annotationStatus || '未标注'),
      createdAt: now, updatedAt: now, createdById: user.id, score: 0, status: '待质检', lastQcAt: '', bundleId, bundleName,
      bundlePreset: 'umi-session', bundlePresetSource: 'server-directory', bundlePresetReason: 'UMI server scan: each session directory is one Episode',
      bundleRole: 'trajectory', bundleRoleLabel: 'UMI 会话序列', bundleFileIndex: index + 1, bundleFileCount: scan.sessionCount,
      relativePath: session.relativePath, sourceRoot: scan.rootName, sourceFolder: session.relativePath, sourceDirectory: session.directory,
      episodeIndex: index, frameCount: session.frameCount, taskNameHint: session.taskName,
      serverFile: {
        mode: 'external-umi-session', storedName: manifestName, sourceRoot: scan.rootPath, sourceDirectory: session.directory,
        originalName: session.name, sha256: session.fingerprint, size: session.totalBytes, fileCount: session.fileCount,
        sequenceProfile: scan.profile, storedAt: now, uploadMode: 'server-directory-reference',
        contentCheck: { valid: true, extension: 'UMI_SESSION', detail: `Registered UMI session with ${session.fileCount} source files`, recordCount: session.frameCount },
      },
      serverManaged: true,
    };
  });
  try {
    state.assets.unshift(...records);
    mergeRecord(state.bundles, { id: bundleId, name: bundleName, type: 'UMI', preset: 'umi-session', presetSource: 'server-directory', sourceRoot: scan.rootPath, status: '待质检', assetCount: records.length, episodeCount: records.length, frameCount: scan.frameCount, sourceFileCount: scan.fileCount, totalBytes: scan.totalBytes, createdAt: now, createdBy: user.name, updatedAt: now });
    audit(state, '服务端目录导入 UMI 会话', bundleId, `${bundleName} · ${records.length} sessions · ${scan.frameCount} camera frames · ${scan.totalBytes} bytes`, user.name);
    writeState(state);
    return { bundleId, bundleName, scan, assets: records, createdCount: records.length, existingCount: 0 };
  } catch (error) {
    for (const asset of records) fs.rmSync(path.join(uploadDir, asset.serverFile.storedName), { force: true });
    throw error;
  }
}

function bundleGate(state, bundleId, user = null) {
  const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId && typeAllowed(user, asset.type));
  if (!assets.length) return null;
  const stored = (state.bundles || []).find(item => item.id === bundleId) || {};
  const roles = [...new Set(assets.map(asset => asset.bundleRole).filter(Boolean))], roleSet = new Set(roles);
  const issues = state.issues.filter(issue => issue.status !== "已关闭" && assets.some(asset => asset.id === issue.assetId) && typeAllowed(user, issue.type));
  const episodeAssetIds = new Set(assets.filter(isLogicalEpisodeAsset).map(asset => asset.id));
  const episodeAssets = assets.filter(asset => episodeAssetIds.has(asset.id));
  const mediaViewPolicy = mediaViewPolicyForBundle(state, bundleId), expectedMediaViews = mediaViewPolicy.expectedViews, actualMediaViews = new Set(assets.filter(asset => asset.bundleRole === "media").map(mediaViewForAsset).filter(Boolean));
  let episodeMediaPending = 0, missingViewCount = 0;
  episodeAssets.forEach(asset => {
    if (isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset)) return;
    const episodeIndex = episodeIndexForAsset(asset), present = new Set(mediaViewsForEpisode(assets, episodeIndex).map(item => item.view));
    const missing = expectedMediaViews.length ? expectedMediaViews.filter(view => !present.has(view)) : Array.from({ length: Math.max(0, mediaViewPolicy.expectedCount - present.size) }, (_, index) => `media-${index + 1}`);
    if (missing.length) { episodeMediaPending++; missingViewCount += missing.length; }
  });
  const annotations = state.annotations.filter(item => episodeAssetIds.has(item.assetId));
  const annotationPending = episodeAssets.filter(asset => !annotationInstructionForAsset(state, asset));
  const originalCount = assets.filter(asset => asset.serverFile).length, qcCount = assets.filter(asset => asset.lastQcAt).length;
  const requiredRoles = bundleRequiredRoles(assets), missingRoles = requiredRoles.filter(role => !roleSet.has(role));
  const uploadComplete = originalCount === assets.length && assets.length > 0, complete = requiredRoles.length > 0 && missingRoles.length === 0;
  const qcReady = uploadComplete && complete;
  const productionEvidencePending = assets.filter(asset => !hasProductionEvidence(asset)).length;
  const ready = productionEvidencePending === 0 && qcReady && episodeMediaPending === 0 && qcCount === assets.length && assets.every(asset => asset.status === "已通过") && issues.length === 0 && annotationPending.length === 0;
  const derivedStatus = ready ? "可提交验收" : !uploadComplete ? "上传中" : issues.length ? "需处理" : episodeMediaPending || !complete ? "待补齐" : qcCount < assets.length || productionEvidencePending ? "待质检" : annotationPending.length ? "待标注" : "待转换";
  const status = ready && stored.gateVersion === "episode-v2" && ["待验收", "已验收", "已归档"].includes(stored.status) ? stored.status : derivedStatus;
  const dataRecordCount = episodeAssets.length ? episodeAssets.reduce((sum, asset) => sum + (isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset) ? Math.max(1, Number(asset.frameCount || asset.serverFile?.fileCount || 1)) : 1), 0) : assets.filter(asset => asset.bundleRole === 'trajectory').length;
  return { id: bundleId, name: stored.name || assets[0].bundleName || bundleId, type: assets[0].type, preset: stored.preset || assets[0].bundlePreset || "", gateVersion: stored.gateVersion || "", assetCount: assets.length, productionEvidencePending, episodeCount: episodeAssetIds.size, dataRecordCount, roles, requiredRoles, missingRoles, complete, uploadComplete, qcReady, episodeMediaPending, expectedMediaViews, expectedMediaViewCount: mediaViewPolicy.expectedCount, mediaViewPolicySource: mediaViewPolicy.source, mediaViewCount: actualMediaViews.size, missingViewCount, originalCount, qcCount, issueCount: issues.length, annotationCount: episodeAssetIds.size, annotationPending: annotationPending.length, ready, status, submittedAt: stored.submittedAt || null, submittedBy: stored.submittedBy || null, acceptedAt: stored.acceptedAt || null, acceptedBy: stored.acceptedBy || null, acceptanceNote: stored.acceptanceNote || "" };
}

function bundleList(state, user = null) {
  const ids = [...new Set(state.assets.filter(asset => !asset.isDemo && asset.bundleId && typeAllowed(user, asset.type)).map(asset => asset.bundleId))];
  return ids.map(id => bundleGate(state, id, user)).filter(Boolean);
}

function deriveV6Workflow(state, bundleId, user = null) {
  const gate = bundleGate(state, bundleId, user);
  if (!gate) return null;
  const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId && typeAllowed(user, asset.type));
  const exportJob = state.exports.find(job => job.batchId === bundleId || (job.batchIds || []).includes(bundleId));
  const openIssues = state.issues.filter(issue => issue.status !== "已关闭" && assets.some(asset => asset.id === issue.assetId)).length;
  const qcDone = assets.length > 0 && assets.every(asset => asset.lastQcAt && hasProductionEvidence(asset));
  const uploaded = assets.length > 0 && assets.every(asset => asset.serverFile);
  const deliveryDone = Boolean(exportJob?.lerobotDirectory), checked = exportJob?.lerobotValidation?.ok === true;
  const conversionDone = format => exportJob?.conversions?.[format]?.ok === true && exportJob?.conversions?.[format]?.independentVerification?.ok === true && gate.ready && gate.status === "已验收" && exportJob.conversions[format].sourceFingerprint === deliverySourceFingerprint(state, exportJob);
  const done = {
    start: true,
    pico_upload: uploaded,
    capture_complete: assets.length > 0,
    algo_auto_checker: qcDone,
    create_inspect_nodes: qcDone,
    human_case_inspect: qcDone && openIssues === 0,
    delivery_packaging: Boolean(exportJob),
    delivery_packaging_skip_sem: Boolean(exportJob),
    lerobot_v6: deliveryDone,
    mcap_conversion: conversionDone("mcap"),
    mcap_conversion_skip_sem: conversionDone("mcap"),
    zarr_conversion: conversionDone("zarr"),
    delivery_checker: checked,
    complete_job: checked && gate.status === "已验收",
  };
  const groups = V6_WORKFLOW_GROUPS.map(group => ({
    ...group,
    nodes: group.nodes.map(node => ({ ...node, status: !node.available ? "unavailable" : done[node.id] ? "done" : "pending" })),
  }));
  const nodes = groups.flatMap(group => group.nodes), available = nodes.filter(node => node.available), doneCount = available.filter(node => node.status === "done").length;
  const conditionalIds = new Set(groups.find(group => group.id === "skip_semantic")?.nodes.map(node => node.id) || []), current = nodes.find(node => node.available && node.status === "pending" && !conditionalIds.has(node.id)) || null;
  return { version: V6_WORKFLOW_VERSION, bundleId, groups, totalNodes: nodes.length, availableNodes: available.length, unavailableNodes: nodes.length - available.length, doneNodes: doneCount, progress: nodes.length ? Math.round(doneCount / nodes.length * 100) : 0, availableProgress: available.length ? Math.round(doneCount / available.length * 100) : 0, current: current?.id || null, blockedByUnavailable: nodes.filter(node => !node.available).map(node => node.name) };
}

function exportGate(state, user = null) {
  const assets = state.assets.filter(asset => !asset.isDemo && typeAllowed(user, asset.type)), openIssueIds = new Set(state.issues.filter(issue => issue.status !== "已关闭" && typeAllowed(user, issue.type)).map(issue => issue.assetId));
  const approvedGroupKeys = new Set(annotationGroupList(state, user).filter(item => item.status === "已通过").map(item => item.key));
  const acceptedBundleIds = new Set(bundleList(state, user).filter(item => item.status === "已验收" && item.ready).map(item => item.id));
  const eligible = assets.filter(asset => asset.bundleId && acceptedBundleIds.has(asset.bundleId) && asset.serverFile && asset.status === "已通过" && !openIssueIds.has(asset.id));
  return { total: assets.length, withOriginal: assets.filter(asset => asset.serverFile).length, qualityPassed: assets.filter(asset => asset.status === "已通过" && !openIssueIds.has(asset.id)).length, annotationPassed: assets.filter(asset => approvedGroupKeys.has(annotationGroupKeyForAsset(asset))).length, eligible };
}

function streamExportManifest(res, state, id) {
  const job = state.exports.find(item => item.id === id), file = job?.fileName ? path.join(exportDir, job.fileName) : "";
  if (!job || !file || !file.startsWith(exportDir) || !fs.existsSync(file)) { sendError(res, 404, "交付清单不存在"); return; }
  const stat = fs.statSync(file); res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": stat.size, "Content-Disposition": `attachment; filename="${safeName(job.name)}-manifest.json"`, "Cache-Control": "no-store" }); fs.createReadStream(file).pipe(res);
}
function streamExportAnnotations(res, state, id) {
  const job = state.exports.find(item => item.id === id), file = job ? path.join(exportDir, `${job.id}-annotations.jsonl`) : "";
  if (!job || !Number(job.annotationCount) || !file.startsWith(exportDir) || !fs.existsSync(file)) { sendError(res, 404, "该交付记录没有可下载的 Episode 标注文件"); return; }
  const stat = fs.statSync(file); res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Length": stat.size, "Content-Disposition": `attachment; filename="${safeName(job.name)}-annotations.jsonl"`, "Cache-Control": "no-store" }); fs.createReadStream(file).pipe(res);
}
function assetFolderKey(asset) {
  const explicit = [asset?.sourceRoot, asset?.sourceFolder].map(value => String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  if (explicit) return explicit;
  const relative = String(asset?.relativePath || asset?.name || "").replace(/\\/g, "/"), directory = path.posix.dirname(relative);
  return directory === "." ? "" : directory;
}
function purgeAssets(state, assets, operator, action = "删除数据资产") {
  const referenced = assets.filter(asset => state.datasets.some(dataset => (dataset.assets || []).some(item => item.id === asset.id)) || state.exports.some(job => (job.assetIds || []).includes(asset.id)));
  if (referenced.length) { const error = new Error(`${referenced.length} 个资产已被数据集快照或交付清单引用，不能删除`); error.status = 409; throw error; }
  const ids = new Set(assets.map(item => item.id)), bundleIds = new Set(assets.map(item => item.bundleId).filter(Boolean)), root = path.resolve(uploadDir);
  assets.forEach(asset => {
    const stored = asset.serverFile?.storedName;
    if (stored) { const target = path.resolve(uploadDir, stored); if (target.startsWith(root + path.sep) && fs.existsSync(target)) fs.unlinkSync(target); }
    const preview = path.resolve(previewDir, safeName(asset.id));
    if (preview.startsWith(path.resolve(previewDir) + path.sep)) fs.rmSync(preview, { recursive: true, force: true });
  });
  state.assets = state.assets.filter(item => !ids.has(item.id));
  state.issues = state.issues.filter(item => !ids.has(item.assetId));
  state.annotations = state.annotations.filter(item => !ids.has(item.assetId));
  state.qcBatches = state.qcBatches.map(batch => { const results = (batch.results || []).filter(item => !ids.has(item.assetId)); return { ...batch, results, targetIds: results.map(item => item.assetId), total: results.length, passed: results.filter(item => item.status === "已通过").length, issueCount: results.reduce((sum, item) => sum + (item.issues || []).length, 0), passRate: results.length ? Number((results.filter(item => item.status === "已通过").length / results.length * 100).toFixed(1)) : 0 }; }).filter(batch => batch.total);
  assets.forEach(asset => { delete state.episodeTags[`EP-${asset.id}`]; audit(state, action, asset.id, `${asset.name} · ${asset.type} · ${asset.relativePath || "无原始路径"}`, operator); });
  state.bundles = (state.bundles || []).filter(item => !bundleIds.has(item.id) || state.assets.some(asset => asset.bundleId === item.id));
}
function reconcileStorage(state) {
  const referenced = new Set(), missing = [], sizeMismatch = [];
  state.assets.forEach(asset => {
    const stored = asset.serverFile?.storedName;
    if (!stored) return;
    referenced.add(stored);
    const target = path.resolve(uploadDir, stored);
    if (!target.startsWith(path.resolve(uploadDir) + path.sep) || !fs.existsSync(target)) { missing.push({ id: asset.id, name: asset.name, storedName: stored }); return; }
    const actualSize = fs.statSync(target).size, expectedSize = Number(asset.serverFile.size || 0);
    if (expectedSize && actualSize !== expectedSize) sizeMismatch.push({ id: asset.id, name: asset.name, storedName: stored, expectedSize, actualSize });
  });
  const orphan = fs.readdirSync(uploadDir, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.startsWith('.upload-') && !referenced.has(entry.name)).map(entry => ({ storedName: entry.name, size: fs.statSync(path.join(uploadDir, entry.name)).size }));
  return { checkedAt: new Date().toISOString(), referencedFiles: referenced.size, missing, sizeMismatch, orphan, healthy: !missing.length && !sizeMismatch.length && !orphan.length };
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-File-Name,Upload-Offset" }); res.end(); return true; }
  if (!pathname.startsWith("/api/")) return false;
  if (req.method === 'PATCH' && /^\/api\/uploads\/[a-f0-9-]+$/.test(pathname)) {
    try {
      const origin = String(req.headers.origin || ''), originHost = origin ? new URL(origin).host : '';
      if (originHost && originHost !== String(req.headers.host || '')) { sendError(res, 403, '请求来源校验失败'); return true; }
      const auth = readAuth(), currentUser = sessionUser(req, auth);
      if (!currentUser) { sendError(res, 401, '登录状态已失效，请重新登录'); return true; }
      if (!hasPermission(currentUser, ['资产上传', '资产管理'])) { sendError(res, 403, '无权上传文件'); return true; }
      resumableUploads ||= new ResumableUploads(getStore());
      const id = pathname.split('/').pop(), session = resumableUploads.get(id, currentUser);
      if (!session) { sendError(res, 404, '上传会话不存在'); return true; }
      const upload = await resumableUploads.append(session.id, Number(req.headers['upload-offset']), await readBody(req, session.chunkSize), currentUser);
      sendJson(res, 200, { ok: true, upload });
    } catch (error) { sendError(res, error.status || 400, error.message); }
    return true;
  }
  ensureStorage(); const state = readState(), auth = readAuth();
  state.members = state.members.map(member => { const account = auth.users.find(item => item.id === member.id); return { ...member, permissions: ROLE_POLICIES[member.role] || member.permissions || [], canDeleteData: account?.canDeleteData === true, isPlatformOwner: account?.id === auth.ownerId }; });
  let currentUser = sessionUser(req, auth), nodeCredential = null;
  if (!currentUser && req.method === "POST" && pathname === "/api/nodes/heartbeat") { nodeCredential = authenticateNode(req, auth, state); currentUser = nodeCredential?.user || null; }
  if (req.method === "GET" && pathname === "/api/auth/status") { sendJson(res, 200, { ok: true, authMode: "local", setupRequired: auth.users.length === 0, authenticated: Boolean(currentUser), user: publicUser(currentUser) }); return true; }
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const origin = String(req.headers.origin || "");
    let originHost = ""; try { originHost = origin ? new URL(origin).host : ""; } catch { sendError(res, 403, "请求来源校验失败"); return true; }
    if (originHost && originHost !== String(req.headers.host || "")) { sendError(res, 403, "请求来源校验失败"); return true; }
  }
  if (req.method === "POST" && ["/api/auth/setup", "/api/auth/login"].includes(pathname)) {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}"), email = String(body.email || "").trim().toLowerCase();
      if (pathname === "/api/auth/setup") {
        if (auth.users.length) { sendError(res, 409, "平台已经完成管理员初始化"); return true; }
        const name = String(body.name || "").trim(), password = validatePassword(body.password);
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("请填写姓名和有效工作邮箱");
        const id = `MEM-${Date.now().toString(36).toUpperCase()}`, passwordRecord = hashPassword(password), now = new Date().toISOString();
        const user = { id, name, email, role: "数据治理负责人", domain: "全部数据域", status: "正常", canDeleteData: true, isPlatformOwner: true, passwordSalt: passwordRecord.salt, passwordHash: passwordRecord.hash, sessionVersion: 1, createdAt: now, updatedAt: now };
        auth.ownerId = id; auth.users.push(user); state.members.push({ ...publicUser(user), createdAt: now, updatedAt: now }); audit(state, "初始化平台管理员", id, `${name} · ${email}`, name); writeAccounts(auth, state);
        sendJson(res, 201, { ok: true, authMode: "local", user: publicUser(user) }, { "Set-Cookie": createSessionCookie(auth, user) }); return true;
      }
      const attemptKey = loginAttemptKey(req, email); checkLoginLimit(attemptKey);
      const user = auth.users.find(item => item.email === email);
      if (!user || user.status !== "正常" || !verifyPassword(body.password, user)) { recordLoginFailure(attemptKey); sendError(res, 401, "邮箱、密码或账号状态无效"); return true; }
      loginFailures.delete(attemptKey);
      user.lastLoginAt = new Date().toISOString(); user.updatedAt = user.lastLoginAt;
      const member = state.members.find(item => item.id === user.id); if (member) { member.lastLoginAt = user.lastLoginAt; member.updatedAt = user.updatedAt; }
      audit(state, "账号登录", user.id, `${user.email} · ${req.socket.remoteAddress || "本机"}`, user.name); writeAccounts(auth, state);
      sendJson(res, 200, { ok: true, authMode: "local", user: publicUser(user) }, { "Set-Cookie": createSessionCookie(auth, user) }); return true;
    } catch (error) { sendError(res, error.status || 400, error.message || "认证请求失败"); return true; }
  }
  if (req.method === "POST" && pathname === "/api/auth/logout") { if (currentUser) { currentUser.sessionVersion = Number(currentUser.sessionVersion || 1) + 1; currentUser.updatedAt = new Date().toISOString(); audit(state, "账号退出", currentUser.id, "会话已吊销", currentUser.name); writeAccounts(auth, state); } sendJson(res, 200, { ok: true }, { "Set-Cookie": "embodied_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }); return true; }
  if (!currentUser) { sendError(res, 401, auth.users.length ? "登录会话无效或已过期" : "请先完成管理员初始化", { authMode: "local", setupRequired: auth.users.length === 0 }); return true; }
  if (req.method === "GET" && pathname === "/api/auth/me") { sendJson(res, 200, { ok: true, user: publicUser(currentUser), authMode: "local" }); return true; }
  if (req.method === "POST" && pathname === "/api/auth/password") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}"), nextPassword = validatePassword(body.newPassword);
      if (!verifyPassword(body.currentPassword, currentUser)) { sendError(res, 401, "当前密码不正确"); return true; }
      if (body.currentPassword === nextPassword) throw new Error("新密码不能与当前密码相同");
      const record = hashPassword(nextPassword); Object.assign(currentUser, { passwordSalt: record.salt, passwordHash: record.hash, sessionVersion: Number(currentUser.sessionVersion || 1) + 1, updatedAt: new Date().toISOString() });
      audit(state, "修改登录密码", currentUser.id, "密码已更新，其他会话全部失效", currentUser.name); writeAccounts(auth, state);
      sendJson(res, 200, { ok: true, user: publicUser(currentUser) }, { "Set-Cookie": createSessionCookie(auth, currentUser) }); return true;
    } catch (error) { sendError(res, error.status || 400, error.message || "密码修改失败"); return true; }
  }
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const required = permissionFor(req, pathname);
    if (required && !hasPermission(currentUser, required, auth)) { sendError(res, 403, `当前角色无权执行：${required.join(" 或 ")}`, { required }); return true; }
  }
  if (req.method === "GET") { const required = readPermissionFor(pathname); if (required && !hasPermission(currentUser, required)) { sendError(res, 403, `当前角色无权读取：${required.join(" 或 ")}`, { required }); return true; } }

  if (pathname === '/api/jobs' && req.method === 'GET') {
    const jobs = taskQueue.list().filter(job => job.userId === currentUser.id || hasPermission(currentUser, ['平台设置'])).map(publicJob);
    const uploads = resumableUploads.list(currentUser).map(publicUploadTask);
    const combined = [...jobs, ...uploads].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const active = combined.filter(job => ['queued', 'running', 'paused', 'failed', 'interrupted'].includes(job.status));
    const recent = combined.filter(job => ['succeeded', 'cancelled'].includes(job.status)).slice(0, 100);
    sendJson(res, 200, { ok: true, jobs: [...active, ...recent] });
    return true;
  }
  const jobActionRoute = /^\/api\/jobs\/([^/]+)(?:\/(pause|resume))?$/.exec(pathname);
  if (jobActionRoute && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      const taskId = decodeURIComponent(jobActionRoute[1]), action = jobActionRoute[2];
      if (taskId.startsWith('UP-')) {
        const sessionId = taskId.slice(3);
        if (req.method === 'DELETE') {
          const session = resumableUploads.remove(sessionId, currentUser);
          const asset = state.assets.find(item => item.id === session.assetId);
          if (asset && !asset.serverFile) {
            state.assets = state.assets.filter(item => item.id !== asset.id);
            audit(state, '取消上传任务', session.name, `释放未完成分片 ${session.offset}/${session.size} bytes`, currentUser.name);
            writeState(state);
          }
          sendJson(res, 200, { ok: true, removed: taskId }); return true;
        }
        if (action === 'pause') sendJson(res, 200, { ok: true, task: publicUploadTask(resumableUploads.pause(sessionId, currentUser)) });
        else if (action === 'resume') sendJson(res, 200, { ok: true, task: publicUploadTask(resumableUploads.resume(sessionId, currentUser)) });
        else throw new Error('不支持的上传任务操作');
        return true;
      }
      const job = taskQueue.list().find(item => item.id === taskId && (item.userId === currentUser.id || hasPermission(currentUser, ['平台设置'])));
      if (!job) throw new Error('后台任务不存在或无权操作');
      if (req.method === 'DELETE') { taskQueue.remove(taskId); sendJson(res, 200, { ok: true, removed: taskId }); return true; }
      const updated = action === 'pause' ? taskQueue.pause(taskId) : action === 'resume' ? taskQueue.resume(taskId) : null;
      if (!updated) throw new Error('不支持的后台任务操作');
      sendJson(res, 200, { ok: true, task: publicJob(updated) }); return true;
    } catch (error) { sendError(res, error.status || 400, error.message); return true; }
  }
  if (pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      let kind = body.kind, payload = body.payload || {}, retryOf = null;
      if (body.retryOf) {
        const prior = taskQueue.list().find(job => job.id === body.retryOf && job.userId === currentUser.id);
        if (!prior || !['failed', 'interrupted'].includes(prior.status)) throw new Error('只能重试自己失败或中断的任务');
        kind = prior.kind; payload = prior.payload; retryOf = prior.id;
      }
      if (!JOB_ROUTES[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('后台任务参数无效');
      const required = permissionFor({ method: 'POST' }, JOB_ROUTES[kind]);
      if (!required || !hasPermission(currentUser, required, auth)) { sendError(res, 403, '无权提交该后台任务'); return true; }
      const job = taskQueue.enqueue(kind, payload, currentUser, retryOf);
      sendJson(res, 202, { ok: true, job: publicJob(job) });
    } catch (error) { sendError(res, error.status || 400, error.message); }
    return true;
  }
  if (pathname === '/api/health/details' && req.method === 'GET') {
    if (!hasPermission(currentUser, ['平台设置'])) { sendError(res, 403, '无权读取运维状态'); return true; }
    const python = findLerobotPython();
    let media = false;
    if (python) media = spawnSync(python, ['-c', 'import av'], { timeout: 5000, windowsHide: true }).status === 0;
    sendJson(res, 200, { ok: true, database: 'sqlite-wal', authentication: 'ready', storage: fs.existsSync(uploadDir) ? 'ready' : 'error', python: python ? 'ready' : 'missing', mediaDecoder: media ? 'ready' : 'missing', optionalPlugin: findEmbodiedInvocation() ? 'configured' : 'not_configured', queue: taskQueue.list().reduce((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {}) }); return true;
  }


  if (pathname.startsWith('/api/uploads')) {
    try {
      if (!hasPermission(currentUser, ['资产上传', '资产管理'])) { sendError(res, 403, '无权上传文件'); return true; }
      resumableUploads ||= new ResumableUploads(getStore());
      if (pathname === '/api/uploads/batch-start' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}');
        if (!Array.isArray(body.files) || !body.files.length || body.files.length > 20000) { sendError(res, 400, '批量上传文件数量必须在 1 到 20000 之间'); return true; }
        const assets = new Map(state.assets.map(asset => [asset.id, asset])), frozen = new Set(state.bundles.filter(bundle => ['已验收', '已归档'].includes(bundle.status)).map(bundle => bundle.id));
        const files = body.files.map(item => {
          const asset = assets.get(String(item.assetId || ''));
          if (!asset) throw new Error(`上传资产不存在：${item.name || item.assetId || '未知文件'}`);
          assertTypeAllowed(currentUser, asset.type);
          if (asset.bundleId && frozen.has(asset.bundleId)) throw new Error(`已验收批次禁止替换文件：${asset.bundleName || asset.bundleId}`);
          return { assetId: asset.id, name: item.name || asset.name, size: item.size, key: item.key };
        });
        sendJson(res, 201, { ok: true, uploads: resumableUploads.startMany(files, currentUser) });
        return true;
      }
      if (pathname === '/api/uploads/complete-batch' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const sessions = await resumableUploads.completeMany(body.sessionIds, currentUser, adoptStagedAssets);
        const latest = readState(), assets = sessions.map(session => latest.assets.find(asset => asset.id === session.assetId)).filter(Boolean);
        sendJson(res, 200, { ok: true, assets, completed: sessions.map(session => ({ sessionId: session.id, assetId: session.assetId })) });
        return true;
      }
      const match = /^\/api\/uploads\/([a-f0-9-]+)(?:\/(complete))?$/.exec(pathname);
      if (pathname === '/api/uploads' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const asset = state.assets.find(item => item.id === body.assetId);
        if (!asset) throw new Error('请先创建资产');
        assertTypeAllowed(currentUser, asset.type);
        const bundle = state.bundles.find(item => item.id === asset.bundleId);
        if (bundle && ['已验收', '已归档'].includes(bundle.status)) throw new Error('已验收批次禁止替换文件；请创建修订批次。');
        sendJson(res, 201, { ok: true, upload: resumableUploads.start(asset, body, currentUser) }); return true;
      }
      const session = match && resumableUploads.get(match[1], currentUser);
      if (!session) { sendError(res, 404, '上传会话不存在'); return true; }
      const asset = state.assets.find(item => item.id === session.assetId);
      if (!asset) throw new Error('上传资产已删除');
      assertTypeAllowed(currentUser, asset.type);
      if (req.method === 'PATCH' && !match[2]) {
        const upload = await resumableUploads.append(session.id, Number(req.headers['upload-offset']), await readBody(req, session.chunkSize), currentUser);
        sendJson(res, 200, { ok: true, upload }); return true;
      }
      if (req.method === 'POST' && match[2]) {
        await resumableUploads.complete(session.id, currentUser, async (upload, file, evidence) => {
          await adoptStagedAsset(file, asset.id, upload.name, evidence.sha256, evidence.size);
        });
        sendJson(res, 201, { ok: true, asset: readState().assets.find(item => item.id === asset.id) }); return true;
      }
      if (req.method === 'GET') { sendJson(res, 200, { ok: true, upload: session }); return true; }
      sendError(res, 405, '不支持的上传方法');
    } catch (error) { sendError(res, error.status || 400, error.message); }
    return true;
  }

  const visible = scopedState(state, currentUser);
  const packageRoute = /^\/api\/exports\/([^/]+)\/package$/.exec(pathname);
  if (req.method === "GET" && packageRoute) {
    const job = state.exports.find(item => item.id === decodeURIComponent(packageRoute[1]));
    if (!job || (job.assetIds || []).some(id => !visible.assets.some(asset => asset.id === id))) { sendError(res, 404, "交付记录不存在或无权访问"); return true; }
    const output = job.conversions?.[url.searchParams.get("format") || "lerobot"];
    const gate = bundleGate(state, job.batchId, currentUser);
    if (!gate?.ready || gate.status !== "已验收" || output?.sourceFingerprint !== deliverySourceFingerprint(state, job)) { sendError(res, 409, "当前批次门禁或源数据版本已变化，请重新转换"); return true; }
    if (!output?.ok || !output.archive || !output.independentVerification?.ok) { sendError(res, 404, "该格式尚未完成转换"); return true; }
    const target = path.resolve(output.archive);
    if (!target.startsWith(path.resolve(deliveryDir) + path.sep) || !fs.existsSync(target)) { sendError(res, 404, "交付包文件不存在"); return true; }
    const stat = fs.statSync(target);
    if (output.archiveBytes != null && Number(output.archiveBytes) !== stat.size) { sendError(res, 409, '交付包大小与校验记录不一致，请重新转换'); return true; }
    streamFileResponse(req, res, target, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName(job.id)}-${safeName(output.format)}.zip"`,
      'ETag': `"${output.archiveSha256}"`,
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/engine/capabilities") {
    const plugin = findEmbodiedInvocation();
    sendJson(res, 200, {
      ok: true,
      engine: "evidence-v3-embodied",
      version: "1.0",
      operators: engineOperatorCatalog(plugin),
      workflowStages: WORKFLOW_STAGES,
      plugin: { configured: Boolean(plugin), source: plugin ? (plugin.prefix?.join(" ") || plugin.command) : null },
      evidencePolicy: "每次质检和交付都记录输入指纹、规则快照、问题证据和产物哈希；未满足门禁时不生成可交付结果。",
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/state") { sendJson(res, 200, { ok: true, ...visible, rolePolicies: ROLE_POLICIES, authMode: "local", currentUser: publicUser(currentUser), accessScope: { role: currentUser.role, domain: currentUser.domain } }); return true; }
  if (req.method === 'GET' && pathname === '/api/episodes/previews') {
    const requested = new Set(String(url.searchParams.get('assetIds') || '').split(',').map(value => value.trim()).filter(Boolean));
    const assets = visible.assets.filter(asset => (isHdf5SequenceAsset(asset) || isUmiSessionAsset(asset)) && typeAllowed(currentUser, asset.type) && (!requested.size || requested.has(asset.id)));
    sendJson(res, 200, { ok: true, previews: assets.map(previewStatusForAsset) }); return true;
  }
  const umiSourceVideoRoute = /^\/api\/episodes\/([^/]+)\/source-video$/.exec(pathname);
  if (req.method === 'GET' && umiSourceVideoRoute) {
    const asset = state.assets.find(item => item.id === decodeURIComponent(umiSourceVideoRoute[1]));
    if (!asset || !typeAllowed(currentUser, asset.type)) { sendError(res, 404, 'Episode 不存在或无权访问'); return true; }
    const source = umiSourceVideoForAsset(asset), cached = readPreviewCache(asset);
    if (!source) { sendError(res, 404, 'UMI 原始视频不存在'); return true; }
    const camera = cached?.status === 'ready' ? (cached.cameras || []).find(item => item.id === 'camera_0') : null;
    if (!camera) { sendError(res, 409, '浏览器兼容视频尚未生成，请先生成 UMI H.264 预览'); return true; }
    const file = path.resolve(cached.paths.directory, camera.file), rootPath = path.resolve(cached.paths.directory) + path.sep;
    if (!file.startsWith(rootPath) || !fs.existsSync(file)) { sendError(res, 404, 'UMI H.264 预览文件不存在'); return true; }
    streamFileResponse(req, res, file, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=3600' });
    return true;
  }
  const previewStatusRoute = /^\/api\/episodes\/([^/]+)\/preview\/status$/.exec(pathname);
  if (req.method === 'GET' && previewStatusRoute) {
    const asset = state.assets.find(item => item.id === decodeURIComponent(previewStatusRoute[1]));
    if (!asset || !typeAllowed(currentUser, asset.type)) { sendError(res, 404, 'Episode 不存在或无权访问'); return true; }
    sendJson(res, 200, { ok: true, ...previewStatusForAsset(asset) }); return true;
  }
  const previewFileRoute = /^\/api\/episodes\/([^/]+)\/preview\/(camera_[0-3]\.mp4|first\.jpg|middle\.jpg|last\.jpg)$/.exec(pathname);
  if (req.method === 'GET' && previewFileRoute) {
    const asset = state.assets.find(item => item.id === decodeURIComponent(previewFileRoute[1])), cached = readPreviewCache(asset);
    if (!asset || !typeAllowed(currentUser, asset.type)) { sendError(res, 404, 'Episode 不存在或无权访问'); return true; }
    if (cached?.status !== 'ready') { sendError(res, 404, '预览尚未生成'); return true; }
    const name = previewFileRoute[2], allowed = new Set([...(cached.cameras || []).map(camera => camera.file), ...(cached.thumbnails || [])]);
    if (!allowed.has(name)) { sendError(res, 404, '预览文件不存在'); return true; }
    const file = path.resolve(cached.paths.directory, name), rootPath = path.resolve(cached.paths.directory) + path.sep;
    if (!file.startsWith(rootPath) || !fs.existsSync(file)) { sendError(res, 404, '预览文件不存在'); return true; }
    const type = name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
    streamFileResponse(req, res, file, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' });
    return true;
  }
  const bundleReportRoute = /^\/api\/bundles\/([^/]+)\/report$/.exec(pathname);
  if (req.method === "GET" && bundleReportRoute) {
    const id = decodeURIComponent(bundleReportRoute[1]), gate = bundleGate(state, id, currentUser);
    if (!gate) { sendError(res, 404, "数据包不存在或当前账号无权访问"); return true; }
    const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === id && typeAllowed(currentUser, asset.type)), issues = state.issues.filter(issue => issue.status !== "已关闭" && assets.some(asset => asset.id === issue.assetId));
    const report = { schemaVersion: "1.0", reportType: "bundle-acceptance", generatedAt: new Date().toISOString(), gate, roles: { meta: assets.filter(asset => asset.bundleRole === "meta").length, trajectory: assets.filter(asset => asset.bundleRole === "trajectory").length, media: assets.filter(asset => asset.bundleRole === "media").length }, assets: assets.map(asset => ({ id: asset.id, name: asset.name, relativePath: asset.relativePath || asset.name, role: asset.bundleRole || null, format: asset.format, size: asset.serverFile?.size || asset.size || 0, sha256: asset.serverFile?.sha256 || null, stored: Boolean(asset.serverFile), qualityStatus: asset.status || "待质检", qualityScore: asset.score || 0, lastQcAt: asset.lastQcAt || null })), issues, acceptance: { ready: gate.ready, status: gate.status, original: `${gate.originalCount}/${gate.assetCount}`, qc: `${gate.qcCount}/${gate.assetCount}`, openIssues: gate.issueCount } };
    const payload = Buffer.from(JSON.stringify(report, null, 2)); res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, "Content-Disposition": `attachment; filename="${safeName(gate.name)}-acceptance-report.json"`, "Cache-Control": "no-store" }); res.end(payload); return true;
  }
  if (req.method === "GET" && pathname === "/api/bundles") { sendJson(res, 200, { ok: true, bundles: bundleList(state, currentUser), accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/assets") { sendJson(res, 200, { ok: true, assets: visible.assets, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/tasks") { sendJson(res, 200, { ok: true, tasks: visible.tasks, accessScope: currentUser.domain }); return true; }
  const taskReportRoute = /^\/api\/tasks\/([^/]+)\/report$/.exec(pathname);
  if (req.method === "GET" && taskReportRoute) {
    const task = state.tasks.find(item => item.id === decodeURIComponent(taskReportRoute[1]));
    if (!task || !typeAllowed(currentUser, task.type)) { sendError(res, 404, "采集任务不存在"); return true; }
    const metrics = taskMetrics(state, task), assets = state.assets.filter(asset => !asset.isDemo && asset.taskId === task.id && typeAllowed(currentUser, asset.type));
    const report = { schemaVersion: "1.0", generatedAt: new Date().toISOString(), task: enrichTask(state, task), assets: assets.map(asset => ({ id: asset.id, name: asset.name, type: asset.type, node: asset.node, format: asset.format, relativePath: asset.relativePath || asset.name, sourceRoot: asset.sourceRoot || asset.bundleName || null, bundleId: asset.bundleId || null, bundleRole: asset.bundleRole || null, size: asset.serverFile?.size || asset.size || 0, sha256: asset.serverFile?.sha256 || null, qualityScore: asset.score || 0, qualityStatus: asset.status || "待质检", lastQcAt: asset.lastQcAt || null, accepted: Boolean(asset.serverFile && asset.status === "已通过" && Number(asset.score || 0) >= metrics.acceptanceScore && !state.issues.some(issue => issue.assetId === asset.id && issue.status !== "已关闭")) })), issues: state.issues.filter(issue => assets.some(asset => asset.id === issue.assetId)) };
    const payload = Buffer.from(JSON.stringify(report, null, 2)); res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, "Content-Disposition": `attachment; filename="${safeName(task.id)}-acceptance-report.json"`, "Cache-Control": "no-store" }); res.end(payload); return true;
  }
  if (req.method === "GET" && pathname === "/api/issues") { sendJson(res, 200, { ok: true, issues: visible.issues, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/annotations") { sendJson(res, 200, { ok: true, annotations: visible.annotations, annotationStandards: visible.annotationStandards || {}, annotationGroups: visible.annotationGroups || [], accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/exports") { const gate = exportGate(visible); sendJson(res, 200, { ok: true, exports: visible.exports, gate: { ...gate, eligible: gate.eligible.length } }); return true; }
  if (req.method === "GET" && pathname === "/api/datasets") { sendJson(res, 200, { ok: true, datasets: visible.datasets, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/training") { sendJson(res, 200, { ok: true, trainingJobs: visible.trainingJobs, feedbackSamples: visible.feedbackSamples, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/nodes") { sendJson(res, 200, { ok: true, nodes: visible.nodes.map(deriveNodeStatus), offlineAfterSeconds: 300, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/members") { sendJson(res, 200, { ok: true, members: state.members, rolePolicies: ROLE_POLICIES, authMode: "local" }); return true; }
  if (req.method === "GET" && pathname === "/api/notifications") { sendJson(res, 200, { ok: true, ...buildNotifications(visible) }); return true; }
  if (req.method === "GET" && pathname === "/api/rules") { sendJson(res, 200, { ok: true, rules: visible.rules, settings: state.settings, accessScope: currentUser.domain }); return true; }
  if (req.method === "GET" && pathname === "/api/ops") { const disk = fs.statfsSync(workDir), gate = exportGate(state), nodes = state.nodes.map(deriveNodeStatus), productionIds = new Set(state.assets.filter(item => !item.isDemo).map(item => item.id)); sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage(), storage: { files: state.assets.filter(item => !item.isDemo && item.serverFile).length, bytes: state.assets.filter(item => !item.isDemo).reduce((sum, item) => sum + Number(item.serverFile?.size || 0), 0), freeBytes: disk.bavail * disk.bsize }, issuesOpen: state.issues.filter(item => item.status !== "已关闭" && (!item.assetId || productionIds.has(item.assetId))).length, rulesEnabled: state.rules.filter(item => item.enabled !== false).length, annotations: state.annotations.filter(item => !item.assetId || productionIds.has(item.assetId)).length, exports: state.exports.length, datasets: state.datasets.length, trainingJobs: state.trainingJobs.length, feedbackSamples: state.feedbackSamples.reduce((sum, item) => sum + Number(item.count || 0), 0), tasks: state.tasks.length, tasksRunning: state.tasks.filter(item => item.status === "进行中").length, tasksPendingAcceptance: state.tasks.filter(item => item.status === "待验收").length, tasksCompleted: state.tasks.filter(item => item.status === "已完成").length, nodes: nodes.length, nodesOnline: nodes.filter(item => item.status === "在线").length, members: state.members.length, authMode: "local", exportEligible: gate.eligible.length }); return true; }
  const assetRoute = /^\/api\/assets\/([^/]+)\/(media|file)$/.exec(pathname);
  if (req.method === "GET" && assetRoute) { const asset = visible.assets.find(item => item.id === decodeURIComponent(assetRoute[1])); streamStoredFile(req, res, asset, assetRoute[2] === "file"); return true; }
  const exportRoute = /^\/api\/exports\/([^/]+)\/download$/.exec(pathname);
  if (req.method === "GET" && exportRoute) { streamExportManifest(res, state, decodeURIComponent(exportRoute[1])); return true; }
  const annotationsExportRoute = /^\/api\/exports\/([^/]+)\/annotations$/.exec(pathname);
  if (req.method === "GET" && annotationsExportRoute) { streamExportAnnotations(res, state, decodeURIComponent(annotationsExportRoute[1])); return true; }
  const previewDeleteRoute = /^\/api\/episodes\/([^/]+)\/preview$/.exec(pathname);
  if (req.method === 'DELETE' && previewDeleteRoute) {
    const asset = state.assets.find(item => item.id === decodeURIComponent(previewDeleteRoute[1]));
    if (!asset || !isHdf5SequenceAsset(asset)) { sendError(res, 404, 'Episode 不存在或不是逐帧 HDF5 数据'); return true; }
    assertTypeAllowed(currentUser, asset.type);
    if ((taskQueue?.list?.() || []).some(job => job.kind === 'preview' && job.payload?.assetId === asset.id && ['queued', 'running'].includes(job.status))) { sendError(res, 409, '预览任务正在执行，不能清理'); return true; }
    const paths = previewPaths(asset);
    if (paths) fs.rmSync(paths.base, { recursive: true, force: true });
    sendJson(res, 200, { ok: true, preview: previewStatusForAsset(asset), removed: Boolean(paths) }); return true;
  }
  const deleteAssetRoute = /^\/api\/assets\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && deleteAssetRoute) {
    try {
      const id = decodeURIComponent(deleteAssetRoute[1]), asset = state.assets.find(item => item.id === id);
      if (!asset) { const error = new Error("资产不存在或已删除"); error.status = 404; throw error; }
      assertTypeAllowed(currentUser, asset.type);
      if (asset.isDemo) { const error = new Error("演示资产不能删除"); error.status = 409; throw error; }
      const bundle = asset.bundleId ? (state.bundles || []).find(item => item.id === asset.bundleId) : null;
      if (bundle && ["已验收", "已归档"].includes(bundle.status)) { const error = new Error(`资产属于${bundle.status}数据包，不能删除`); error.status = 409; throw error; }
      purgeAssets(state, [asset], currentUser.name);
      writeState(state); sendJson(res, 200, { ok: true, removed: id, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), bundles: bundleList(state, currentUser) });
    } catch (error) { sendError(res, error.status || 400, error.message || "资产删除失败", error.extra); }
    return true;
  }
  const deleteTaskRoute = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && deleteTaskRoute) {
    try {
      const id = decodeURIComponent(deleteTaskRoute[1]), task = state.tasks.find(item => item.id === id);
      if (!task) { const error = new Error("采集任务不存在或已删除"); error.status = 404; throw error; }
      assertTypeAllowed(currentUser, task.type);
      const linked = state.assets.filter(item => !item.isDemo && item.taskId === id);
      if (linked.length) { const error = new Error(`采集任务已关联 ${linked.length} 个资产，不能只删除任务记录；请先在数据资产中处理这些资产`); error.status = 409; throw error; }
      state.tasks = state.tasks.filter(item => item.id !== id);
      audit(state, "删除采集任务", id, `${task.name} · ${task.type}`, currentUser.name);
      writeState(state);
      sendJson(res, 200, { ok: true, removed: id, tasks: state.tasks.filter(item => typeAllowed(currentUser, item.type)).map(item => enrichTask(state, item)) });
    } catch (error) { sendError(res, error.status || 400, error.message || "采集任务删除失败", error.extra); }
    return true;
  }
  const contentRoute = /^\/api\/assets\/([^/]+)\/content$/.exec(pathname);
  if (req.method === "PUT" && contentRoute) {
    try { const id = decodeURIComponent(contentRoute[1]), existing = state.assets.find(item => item.id === id); if (!existing) { const error = new Error("资产不存在，请先创建资产元数据"); error.status = 404; throw error; } assertTypeAllowed(currentUser, existing.type); const originalName = decodeURIComponent(req.headers["x-file-name"] || url.searchParams.get("filename") || "upload.bin"); const asset = await streamAssetContent(req, id, originalName); sendJson(res, 201, { ok: true, asset }); }
    catch (error) { sendError(res, error.status || 400, error.message, error.extra); }
    return true;
  }
  if (req.method !== "POST") { sendError(res, 405, "请求方法不受支持"); return true; }
  if (["/api/training", "/api/training/status", "/api/training/feedback"].includes(pathname)) { sendError(res, 410, "训练执行与回流尚未接入外部系统，此入口已停用"); return true; }
  try {
    const contentType = String(req.headers["content-type"] || "");
    if (contentType.includes("multipart/form-data")) { sendError(res, 415, "旧版整包上传已停用，请刷新页面后使用流式上传"); return true; }
    const bodyLimit = pathname === '/api/assets/batch' ? 64 * 1024 * 1024 : undefined;
    const body = JSON.parse((await readBody(req, bodyLimit)).toString("utf8") || "{}");
    const operationStartedAt = Date.now();
    body.user = currentUser.name;
    if (pathname === '/api/episodes/preview') {
      const asset = state.assets.find(item => item.id === String(body.assetId || ''));
      if (!asset || (!isHdf5SequenceAsset(asset) && !isUmiSessionAsset(asset))) { const error = new Error('Episode 不存在或不是可预览的 HDF5 / UMI 数据'); error.status = 404; throw error; }
      assertTypeAllowed(currentUser, asset.type);
      const cached = readPreviewCache(asset);
      if (cached?.status === 'ready') { sendJson(res, 200, { ok: true, previewAssetId: asset.id, preview: publicPreviewMetadata(cached), duplicate: true }); return true; }
      const disk = fs.statfsSync(previewDir), freeBytes = Number(disk.bavail) * Number(disk.bsize);
      if (freeBytes < 512 * 1024 * 1024) throw new Error('磁盘可用空间低于 512 MB，已拒绝生成 Episode 预览');
      const preview = await generateEpisodePreview(asset, req.progress || (() => {}));
      const latest = readState(), current = latest.assets.find(item => item.id === asset.id);
      if (current) { audit(latest, '生成 Episode 预览', asset.id, `${asset.name} · ${preview.frameCount} 帧 · ${preview.cameras?.length || 0} 路相机`, currentUser.name); writeState(latest); }
      sendJson(res, 201, { ok: true, previewAssetId: asset.id, preview: publicPreviewMetadata({ ...preview, status: 'ready' }) });
      return true;
    }
    if (pathname === "/api/exports/convert") {
      const target = String(body.format || "").toLowerCase();
      if (!["lerobot", "mcap", "zarr"].includes(target)) { sendError(res, 400, "请选择 LeRobot、MCAP 或 Zarr"); return true; }
      const officialRuntime = inspectOfficialLerobotRuntime();
      if (target === "lerobot" && officialRuntime.status !== "available") { sendError(res, 409, `LeRobot v3.0 官方验证运行时不可用：${officialRuntime.status}，需要 LeRobot ${OFFICIAL_LEROBOT_VERSION}`); return true; }
      const job = state.exports.find(item => item.id === body.id);
      if (!job || !job.lerobotDirectory) { sendError(res, 409, "请先为当前批次生成 LeRobot 基础交付记录"); return true; }
      const assets = state.assets.filter(asset => job.assetIds.includes(asset.id));
      if (assets.some(asset => !typeAllowed(currentUser, asset.type))) { sendError(res, 403, "无权转换该数据域"); return true; }
      const gate = bundleGate(state, job.batchId, currentUser);
      if (!gate?.ready || gate.status !== "已验收") { sendError(res, 409, "当前批次未通过验收门禁"); return true; }
      const originalManifest = JSON.parse(fs.readFileSync(path.join(exportDir, job.fileName), "utf8"));
      if (assets.length !== job.assetIds.length || assets.some(asset => !originalManifest.assets.some(item => item.id === asset.id && item.sha256 === asset.serverFile?.sha256))) { sendError(res, 409, "源文件与基础交付快照不同，需要建立新的交付版本"); return true; }
      const fingerprint = deliverySourceFingerprint(state, job);
      if (job.conversions?.[target]?.sourceFingerprint === fingerprint && job.conversions[target].independentVerification?.ok && fs.existsSync(job.conversions[target].archive) && await backupTools.digest(job.conversions[target].archive) === job.conversions[target].archiveSha256) { sendJson(res, 200, { ok: true, duplicate: true, job, exports: visible.exports }); return true; }
      if (activeDeliveryConversions.has(job.id)) { sendError(res, 409, "该批次正在转换，请等待完成后再操作"); return true; }
      activeDeliveryConversions.add(job.id);
      try {
        const python = findLerobotPython();
        if (!python) throw new Error("转换需要配置含 pyarrow 的 Python 环境");
        const built = buildBundleManifest(state, { id: job.id, assetIds: job.assetIds });
        const conversionRoot = path.join(deliveryDir, safeName(job.id), "converted"); fs.mkdirSync(conversionRoot, { recursive: true });
        const runName = `${target}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, annotationPath = path.join(conversionRoot, `${runName}-annotations.jsonl`);
        fs.writeFileSync(annotationPath, built.annotationLines.join("\n") + "\n", "utf8");
        const evidencePath = path.join(conversionRoot, `${runName}-evidence.json`);
        fs.writeFileSync(evidencePath, JSON.stringify({ schemaVersion: '1.0', generatedAt: new Date().toISOString(), batch: { id: gate.id, status: gate.status, acceptedAt: gate.acceptedAt, acceptedBy: gate.acceptedBy }, sourceFingerprint: fingerprint, rules: state.rules, qualitySettings: state.settings, inspections: assets.map(asset => ({ id: asset.id, relativePath: asset.relativePath, sha256: asset.serverFile?.sha256, inspection: asset.inspection, qcBatchId: asset.qcBatchId })), annotations: built.annotationLines.map(line => JSON.parse(line)), runs: state.runs.filter(run => run.targetIds?.some(id => job.assetIds.includes(id))).slice(0, 20) }, null, 2));
        let report;
        try {
          const { stdout } = await execFileAsync(python, [path.join(root, "tools", "delivery_convert.py"), "--source", job.lerobotDirectory, "--output", path.join(conversionRoot, runName), "--target", target, "--annotations", annotationPath, "--evidence", evidencePath], { timeout: 1800000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
          report = JSON.parse(stdout.trim());
          if (report.ok !== true) throw new Error(report.error || "转换验证失败");
          req.progress?.({ completed: 0, total: report.episodes, message: '转换完成，正在独立解包、回读和逐帧解码视频' });
          const checked = await execFileAsync(python, [path.join(root, 'tools', 'verify_delivery.py'), '--archive', report.archive, '--target', target], { timeout: 1800000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
          const verification = JSON.parse(checked.stdout);
          if (!verification.ok || verification.archiveSha256 !== report.archiveSha256) throw new Error(verification.error || '独立交付验证失败');
          if (target === 'lerobot' && (verification.officialVerification !== 'passed' || verification.officialLerobotVersion !== OFFICIAL_LEROBOT_VERSION)) throw new Error(`LeRobot v3.0 官方加载证据无效，需要 LeRobot ${OFFICIAL_LEROBOT_VERSION}`);
          report.independentVerification = { ...verification, checkedAt: new Date().toISOString() };
          req.progress?.({ completed: report.episodes, total: report.episodes, message: '独立交付检查完成' });
        } catch (error) {
          let detail = error.message;
          try { detail = JSON.parse(String(error.stdout || "").trim()).error || detail; } catch {}
          throw new Error(`转换未完成：${detail}`);
        } finally { fs.rmSync(annotationPath, { force: true }); fs.rmSync(evidencePath, { force: true }); }
        // Re-read after the long conversion to retain concurrent business edits.
        const latest = readState(), current = latest.exports.find(item => item.id === job.id);
        const latestGate = bundleGate(latest, job.batchId, currentUser);
        if (!current || deliverySourceFingerprint(latest, current) !== fingerprint || !latestGate?.ready || latestGate.status !== "已验收") throw new Error("转换期间源数据、标注或验收状态已变化，请重新转换");
        current.conversions = { ...(current.conversions || {}), [target]: { ...report, sourceFingerprint: fingerprint, checkedAt: new Date().toISOString(), operator: currentUser.name } };
        audit(latest, "转换并验证交付格式", current.id, `${target} · ${report.episodes} Episode · ${report.frames} 帧 · ${report.archiveSha256}`, currentUser.name);
        writeState(latest); sendJson(res, 201, { ok: true, job: current, exports: scopedState(latest, currentUser).exports });
      } finally { activeDeliveryConversions.delete(job.id); }
      return true;
    }
    if (pathname === '/api/exports/verify') {
      const job = state.exports.find(item => item.id === body.id), target = String(body.format || 'lerobot').toLowerCase();
      const output = job?.conversions?.[target];
      if (!job || !output?.archive || job.assetIds.some(id => !visible.assets.some(asset => asset.id === id))) throw new Error('交付包不存在或无权校验');
      const gate = bundleGate(state, job.batchId, currentUser), fingerprint = deliverySourceFingerprint(state, job);
      if (!gate?.ready || gate.status !== '已验收' || output.sourceFingerprint !== fingerprint) throw new Error('交付包已失效，请重新转换');
      const python = findLerobotPython();
      if (!python) throw new Error('独立校验需要 Python 环境');
      const { stdout } = await execFileAsync(python, [path.join(root, 'tools', 'verify_delivery.py'), '--archive', output.archive, '--target', target], { timeout: 1800000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const verification = JSON.parse(stdout);
      if (!verification.ok || verification.archiveSha256 !== output.archiveSha256) throw new Error('交付包校验失败或整包哈希变化');
      const latest = readState(), current = latest.exports.find(item => item.id === job.id);
      if (!current || deliverySourceFingerprint(latest, current) !== fingerprint || current.conversions?.[target]?.archive !== output.archive) throw new Error('校验期间交付版本已变化');
      current.conversions[target].independentVerification = { ...verification, checkedAt: new Date().toISOString() };
      writeState(latest); sendJson(res, 200, { ok: true, verification }); return true;
    }
    if (pathname === "/api/bundles/status") {
      const id = String(body.id || "").trim(), nextStatus = String(body.status || "").trim(), allowed = ["待验收", "已验收", "已归档"];
      if (!id || !allowed.includes(nextStatus)) throw new Error("数据包验收参数无效");
      const gate = bundleGate(state, id, currentUser); if (!gate) { const error = new Error("数据包不存在或当前账号无权访问"); error.status = 404; throw error; }
      if (!gate.ready) { const error = new Error(`数据包尚未达到验收门禁：必需分组 ${gate.missingRoles?.length ? `缺少 ${gate.missingRoles.join("、")}` : "完整"}，上传 ${gate.originalCount}/${gate.assetCount}，视角不完整 Episode ${gate.episodeMediaPending}（缺 ${gate.missingViewCount || 0} 个视角），已质检 ${gate.qcCount}/${gate.assetCount}，缺少当前完整检查证据 ${gate.productionEvidencePending}，未关闭问题 ${gate.issueCount}，待审核标注 ${gate.annotationPending || 0}`); error.status = 409; error.extra = { bundle: gate }; throw error; }
      const transitions = { "可提交验收": ["待验收"], "待验收": ["已验收"], "已验收": ["已归档"], "已归档": [] };
      if (!(transitions[gate.status] || []).includes(nextStatus)) { const error = new Error(`批次不能从“${gate.status}”再次变更为“${nextStatus}”`); error.status = 409; error.extra = { currentStatus: gate.status, nextStatus }; throw error; }
      if (nextStatus === "已验收" && !isAdministrator(currentUser)) { const error = new Error("只有数据治理负责人可以签署批次验收"); error.status = 403; throw error; }
      if (nextStatus === "已归档" && !isAdministrator(currentUser)) { const error = new Error("只有数据治理负责人可以归档批次"); error.status = 403; throw error; }
      const now = new Date().toISOString(), record = { id, name: gate.name, type: gate.type, preset: gate.preset, status: nextStatus, gateVersion: "episode-v2", updatedAt: now, ...(nextStatus === "待验收" ? { submittedAt: now, submittedBy: currentUser.name, acceptanceNote: String(body.note || "已满足数据包验收门禁") } : {}), ...(nextStatus === "已验收" ? { acceptedAt: now, acceptedBy: currentUser.name, acceptanceNote: String(body.note || "数据包验收通过") } : {}) };
      mergeRecord(state.bundles, record); audit(state, nextStatus === "已验收" ? "签署数据包验收" : nextStatus === "已归档" ? "归档数据包" : "提交数据包验收", id, `${gate.name} · ${nextStatus} · ${body.note || ""}`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, bundle: bundleGate(state, id, currentUser), bundles: bundleList(state, currentUser) }); return true;
    }
    if (pathname === "/api/imports/rollback") {
      const bundleId = String(body.bundleId || "").trim(); if (!bundleId) throw new Error("导入批次编号不能为空");
      const bundle = (state.bundles || []).find(item => item.id === bundleId); if (bundle && ["已验收", "已归档"].includes(bundle.status)) { const error = new Error(`数据包已${bundle.status}，不能回滚`); error.status = 409; throw error; }
      const selected = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId);
      if (selected.some(asset => asset.createdById && asset.createdById !== currentUser.id) && !isAdministrator(currentUser)) { const error = new Error("只能回滚当前账号创建的导入批次"); error.status = 403; throw error; }
      if (selected.length) purgeAssets(state, selected, currentUser.name, "回滚失败导入");
      audit(state, "回滚失败导入", bundleId, `清理 ${selected.length} 个已创建资产`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, bundleId, removedCount: selected.length }); return true;
    }
    if (pathname === "/api/imports/analyze") {
      const bundleId = String(body.bundleId || "").trim();
      if (!bundleId) throw new Error("数据包编号不能为空");
      const bundleAssets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId);
      if (!bundleAssets.length) { const error = new Error("数据包不存在或没有资产"); error.status = 404; throw error; }
      if (bundleAssets.some(asset => !typeAllowed(currentUser, asset.type))) { const error = new Error("当前账号无权分析该数据包"); error.status = 403; throw error; }
      const analysis = await autoImportBundleAnnotations(bundleId, currentUser.name);
      sendJson(res, 200, { ok: true, ...analysis }); return true;
    }
    if (pathname === "/api/imports/server-directory") {
      const requested = String(body.preset || 'auto').trim();
      if (!['auto', 'umi-session', 'hdf5-sequence'].includes(requested)) throw new Error('服务端目录导入只支持自动识别、UMI Session 或 HDF5 帧序列');
      const rootPath = String(body.rootPath || '').trim();
      if (!rootPath) throw new Error('服务端目录路径不能为空');
      let mode = requested === 'hdf5-sequence' && String(body.type || '').trim() === 'UMI' ? 'umi-session' : requested;
      let preparedScan = null;
      if (mode === 'auto') {
        try { preparedScan = await scanServerDirectory('umi-session', rootPath); mode = 'umi-session'; }
        catch (error) {
          if (error.message === 'No UMI session directories found') mode = 'hdf5-sequence';
          else throw error;
        }
      }
      if (!preparedScan) preparedScan = await scanServerDirectory(mode, rootPath);
      const result = mode === 'umi-session'
        ? registerUmiSessionDirectory(state, { ...body, rootPath, type: 'UMI' }, currentUser, preparedScan)
        : registerHdf5SequenceDirectory(state, { ...body, rootPath }, currentUser, preparedScan);
      const scan = mode === 'umi-session'
        ? { mode, rootPath: result.scan.rootPath, rootName: result.scan.rootName, episodeCount: result.scan.episodeCount, sessionCount: result.scan.sessionCount, fileCount: result.scan.fileCount, totalBytes: result.scan.totalBytes, frameCount: result.scan.frameCount, sessions: result.scan.sessions.map(session => ({ name: session.name, frameCount: session.frameCount, taskName: session.taskName })) }
        : { mode, rootPath: result.scan.rootPath, rootName: result.scan.rootName, episodeCount: result.scan.episodeCount, fileCount: result.scan.fileCount, totalBytes: result.scan.totalBytes };
      sendJson(res, result.createdCount ? 201 : 200, { ok: true, bundle: bundleGate(state, result.bundleId, currentUser), assets: result.assets, bundleId: result.bundleId, createdCount: result.createdCount, existingCount: result.existingCount, scan });
      return true;
    }
    if (pathname === "/api/assets/bulk-delete") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(value => String(value).trim()).filter(Boolean))];
      const bundleId = String(body.bundleId || "").trim(), folder = String(body.folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!ids.length && !bundleId && !folder) throw new Error("请选择资产，或指定要删除的数据包 / 文件夹");
      if (ids.length > 500) throw new Error("按资产编号单次最多删除 500 个；整批删除请直接指定数据包");
      let selected = ids.length ? ids.map(id => state.assets.find(item => item.id === id)) : state.assets.filter(asset => !asset.isDemo && (!bundleId || asset.bundleId === bundleId) && (!folder || assetFolderKey(asset) === folder));
      if (!selected.length) { const error = new Error("指定范围内没有可删除资产"); error.status = 404; throw error; }
      if (selected.length > 20000) throw new Error("单次最多删除 20000 个资产，请分文件夹处理");
      if (selected.some(item => !item)) { const error = new Error("批量删除包含不存在的资产，已取消本次操作"); error.status = 404; throw error; }
      selected.forEach(asset => { assertTypeAllowed(currentUser, asset.type); if (asset.isDemo) { const error = new Error(`演示资产 ${asset.name} 不能删除`); error.status = 409; throw error; } const bundle = asset.bundleId ? (state.bundles || []).find(item => item.id === asset.bundleId) : null; if (bundle && ["已验收", "已归档"].includes(bundle.status)) { const error = new Error(`资产 ${asset.name} 属于${bundle.status}数据包，不能删除`); error.status = 409; throw error; } });
      purgeAssets(state, selected, currentUser.name, "批量删除数据资产"); audit(state, "批量删除数据资产", bundleId || folder || ids.join(","), `共删除 ${selected.length} 个资产`, currentUser.name);
      const removed = selected.map(item => item.id), scope = bundleId ? `${bundleId}${folder ? ` / ${folder}` : ""}` : folder ? `文件夹 ${folder}` : `${removed.length} 个勾选资产`;
      writeState(state); sendJson(res, 200, { ok: true, removed, removedCount: removed.length, scope, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), bundles: bundleList(state, currentUser) }); return true;
    }
    if (pathname === "/api/assets/batch") {
      if (!Array.isArray(body.assets) || !body.assets.length || body.assets.length > 20000) throw new Error('批量资产数量必须在 1 到 20000 之间');
      if (body.assets.length > 200 && body.assets.every(item => ['H5', 'HDF5'].includes(String(item.format || '').toUpperCase()))) throw new Error('HDF5 逐帧文件超过 200 个，请使用服务端目录导入并按 Episode 聚合，不能逐帧创建资产');
      const ids = new Set(), paths = new Set(), records = [];
      for (const raw of body.assets) {
        const item = { ...raw };
        if (!item.name || !item.id || !DATA_TYPES.includes(item.type)) throw new Error('资产编号、名称或数据类型无效');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || ids.has(item.id)) throw new Error(`资产编号重复或非法：${item.id}`);
        ids.add(item.id);
        if (item.relativePath) {
          const relative = String(item.relativePath).replaceAll('\\', '/');
          if (path.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.')) throw new Error(`文件相对路径无效：${relative}`);
          item.relativePath = relative;
          const pathKey = `${item.bundleId || ''}:${relative}`;
          if (paths.has(pathKey) || state.assets.some(asset => asset.id !== item.id && asset.bundleId === item.bundleId && asset.relativePath === relative)) throw new Error(`批次内存在重复路径：${relative}`);
          paths.add(pathKey);
        }
        if (annotationSourceKind(item)) item.bundleRole = 'meta';
        if (item.bundleRole && !['meta', 'trajectory', 'media'].includes(item.bundleRole)) throw new Error(`数据包文件分组无效：${item.name}`);
        assertTypeAllowed(currentUser, item.type);
        const existing = state.assets.find(asset => asset.id === item.id);
        if (existing) assertTypeAllowed(currentUser, existing.type);
        const frozen = state.bundles.find(bundle => [existing?.bundleId, item.bundleId].includes(bundle.id) && ['已验收', '已归档'].includes(bundle.status));
        if (frozen) { const error = new Error('已验收或归档批次禁止修改资产，请创建修订批次'); error.status = 409; throw error; }
        if (existing?.bundleId && item.bundleId !== existing.bundleId) throw new Error('已有资产不能移动到其他批次');
        if (item.bundleId && !item.bundleName && !existing?.bundleName) throw new Error('数据包资产必须带有数据包名称');
        delete item.isDemo;
        item.inspection = { ...(item.inspection || {}), production: existing?.inspection?.production, lerobotSchema: existing?.inspection?.lerobotSchema, embodied: existing?.inspection?.embodied };
        const serverFile = existing?.serverFile || null;
        const record = { ...item, score: existing?.score || 0, status: existing?.status || '待质检', lastQcAt: existing?.lastQcAt || '', qcBatchId: existing?.qcBatchId || '', createdById: existing?.createdById || currentUser.id, createdBy: existing?.createdBy || currentUser.name, serverFile, serverManaged: Boolean(serverFile), updatedAt: new Date().toISOString() };
        mergeRecord(state.assets, record); records.push(record);
      }
      audit(state, '批量登记数据资产', body.bundleId || '多个批次', `一次登记 ${records.length} 个资产`, currentUser.name);
      writeState(state);
      sendJson(res, 201, body.compact === true ? { ok: true, assetCount: records.length } : { ok: true, assets: records });
      return true;
    }
    if (pathname === "/api/assets") {
      if (!body.name || !body.id || !DATA_TYPES.includes(body.type)) throw new Error("资产编号、名称和数据类型不能为空");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw new Error('资产编号包含非法字符');
      if (body.relativePath) {
        const relative = String(body.relativePath).replaceAll('\\', '/');
        if (path.isAbsolute(relative) || relative.split('/').some(part => part === '..' || part === '.')) throw new Error('文件相对路径无效');
        body.relativePath = relative;
        if (state.assets.some(asset => asset.id !== body.id && asset.bundleId === body.bundleId && asset.relativePath === relative)) throw new Error('本批次已有同路径文件，请替换已有资产');
      }

      if (annotationSourceKind(body)) body.bundleRole = "meta";
      if (body.bundleRole && !["meta", "trajectory", "media"].includes(body.bundleRole)) throw new Error("数据包文件分组无效，必须是 meta、data 或 video");
      assertTypeAllowed(currentUser, body.type);
      const existing = state.assets.find(item => item.id === body.id); if (existing) assertTypeAllowed(currentUser, existing.type);
      const frozen = state.bundles.find(item => [existing?.bundleId, body.bundleId].includes(item.id) && ["已验收", "已归档"].includes(item.status));
      if (frozen) { const error = new Error('已验收或归档批次禁止修改资产，请创建修订批次'); error.status = 409; throw error; }
      if (existing?.bundleId && body.bundleId !== existing.bundleId) throw new Error('已有资产不能移动到其他批次');
      delete body.isDemo;
      body.inspection = { ...(body.inspection || {}), production: existing?.inspection?.production, lerobotSchema: existing?.inspection?.lerobotSchema, embodied: existing?.inspection?.embodied };

      if (body.bundleId && !body.bundleName && !existing?.bundleName) throw new Error("数据包资产必须带有数据包名称");
      if (body.taskId) { const task = state.tasks.find(item => item.id === body.taskId); if (!task) throw new Error("关联采集任务不存在"); if (task.type !== body.type) throw new Error(`采集任务仅接收 ${task.type} 数据`); if (["待验收", "已完成"].includes(task.status)) throw new Error("待验收或已完成任务不能继续接收资产"); body.taskName = task.name; }
      // Preserve legacy node metadata during file replacement; validate only an actual node change.
      if (body.node && body.node !== "未绑定" && (!existing || body.node !== existing.node)) { const node = state.nodes.find(item => item.id === body.node); if (!node) throw new Error("关联采集节点不存在"); if (node.type !== body.type) throw new Error(`采集节点仅接收 ${node.type} 数据`); }
      const serverFile = existing?.serverFile || null, record = { ...body, score: existing?.score || 0, status: existing?.status || "待质检", lastQcAt: existing?.lastQcAt || "", qcBatchId: existing?.qcBatchId || "", createdById: existing?.createdById || currentUser.id, createdBy: existing?.createdBy || currentUser.name, serverFile, serverManaged: Boolean(serverFile), updatedAt: new Date().toISOString() }; mergeRecord(state.assets, record); writeState(state); sendJson(res, 201, { ok: true, asset: record }); return true;
    }
    if (pathname === "/api/tasks") {
      const targetCount = Math.floor(Number(body.targetCount)), acceptanceScore = Number(body.acceptanceScore), nodeIds = [...new Set((Array.isArray(body.nodeIds) ? body.nodeIds : body.nodeId ? [body.nodeId] : []).map(String).filter(Boolean))];
      if (!body.name || !body.scene || !DATA_TYPES.includes(body.type) || !Number.isFinite(targetCount) || targetCount <= 0) throw new Error("任务名称、场景、数据类型和有效目标数量不能为空");
      if (!Number.isFinite(acceptanceScore) || acceptanceScore < 0 || acceptanceScore > 100) throw new Error("最低质量分必须在 0 到 100 之间");
      assertTypeAllowed(currentUser, body.type); const nodes = nodeIds.map(id => state.nodes.find(item => item.id === id)); if (nodes.some(node => !node)) throw new Error("关联采集节点不存在"); if (nodes.some(node => node.type !== body.type)) throw new Error("采集节点数据类型与任务不一致");
      const existing = state.tasks.find(item => item.id === body.id), now = new Date().toISOString(); if (existing && ["待验收", "已完成"].includes(existing.status)) throw new Error("已提交或已完成的采集任务不能直接修改"); ["submittedAt", "submittedBy", "acceptedAt", "acceptedBy", "acceptanceNote", "metrics"].forEach(key => delete body[key]); body.id = body.id || "TASK-" + Date.now(); Object.assign(body, { nodeIds, targetCount, acceptanceScore, target: `${targetCount} 个验收资产`, owner: String(body.owner || currentUser.name), status: existing?.status || "待启动", createdAt: existing?.createdAt || now, updatedAt: now }); mergeRecord(state.tasks, body); audit(state, existing ? "更新采集任务" : "创建采集任务", body.id, `${body.type} · ${body.name} · 目标 ${targetCount} · 门槛 ${acceptanceScore} 分`, currentUser.name); writeState(state); sendJson(res, 201, { ok: true, task: enrichTask(state, body) }); return true;
    }
    if (pathname === "/api/tasks/status") {
      const task = state.tasks.find(item => item.id === body.id), transitions = { "待启动": ["进行中"], "进行中": ["已暂停", "待验收"], "已暂停": ["进行中"], "待验收": ["进行中", "已完成"], "已完成": [] };
      if (!task) throw new Error("采集任务不存在"); assertTypeAllowed(currentUser, task.type); if (!(transitions[task.status] || []).includes(body.status)) throw new Error(`采集任务不能从“${task.status}”变更为“${body.status}”`);
      const metrics = taskMetrics(state, task); if (body.status === "待验收" && !metrics.acceptanceReady) { const error = new Error(`尚未达到验收门槛：通过 ${metrics.accepted}/${metrics.targetCount}，未关闭问题 ${metrics.openIssues}`); error.status = 409; error.extra = { metrics }; throw error; }
      if (body.status === "已完成" && !isAdministrator(currentUser)) { const error = new Error("仅数据治理负责人可以签署验收完成"); error.status = 403; throw error; }
      if (body.status === "已完成" && !metrics.acceptanceReady) { const error = new Error("验收条件已变化，请重新处理阻断项"); error.status = 409; error.extra = { metrics }; throw error; }
      task.status = body.status; task.updatedAt = new Date().toISOString(); if (body.status === "待验收") Object.assign(task, { submittedAt: task.updatedAt, submittedBy: currentUser.name }); if (body.status === "已完成") Object.assign(task, { acceptedAt: task.updatedAt, acceptedBy: currentUser.name, acceptanceNote: String(body.note || "验收门槛全部满足") }); audit(state, body.status === "已完成" ? "签署采集任务验收" : "更新采集任务状态", task.id, `${task.name} · ${task.status}`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, task: enrichTask(state, task), tasks: state.tasks.filter(item => typeAllowed(currentUser, item.type)).map(item => enrichTask(state, item)) }); return true;
    }
    if (pathname === "/api/annotations/generate") {
      if (!hasPermission(currentUser, ["标注编辑", "资产管理"])) { const error = new Error("当前账号只能查看标注，不能生成标注任务"); error.status = 403; throw error; }
      const created = generateAnnotationTasks(state, currentUser.name, currentUser), refreshed = scopedState(state, currentUser); writeState(state); sendJson(res, 201, { ok: true, created: created.length, annotations: refreshed.annotations, annotationStandards: refreshed.annotationStandards, annotationGroups: refreshed.annotationGroups }); return true;
    }
    if (pathname === "/api/annotations/batch") {
      if (!hasPermission(currentUser, ["标注编辑", "资产管理"])) { const error = new Error("当前账号没有批量提交任务指令的权限"); error.status = 403; throw error; }
      const groupKeys = [...new Set((Array.isArray(body.groupKeys) ? body.groupKeys : []).map(key => String(key || "").trim()).filter(Boolean))];
      for (const key of groupKeys) {
        const scope = annotationGroupMeta(state, key);
        if (!scope) { const error = new Error(`任务或数据集不存在：${key}`); error.status = 404; throw error; }
        const scopeAssets = state.assets.filter(item => !item.isDemo && annotationGroupKeyForAsset(item) === scope.key);
        if (scopeAssets.some(item => !typeAllowed(currentUser, item.type))) { const error = new Error("当前账号无权提交该任务或数据集"); error.status = 403; throw error; }
      }
      const result = submitAnnotationStandards(state, { groupKeys }, currentUser.name);
      if (result.submitted.length) {
        audit(state, "批量提交任务指令审核", "标注工作台", `提交 ${result.submitted.length} 个范围，跳过 ${result.skipped.length} 个`, currentUser.name);
        writeState(state);
      }
      const refreshed = scopedState(state, currentUser);
      sendJson(res, 200, { ok: true, ...result, annotations: refreshed.annotations, annotationStandards: refreshed.annotationStandards, annotationGroups: refreshed.annotationGroups }); return true;
    }
    if (pathname === "/api/annotations/standard") {
      const action = String(body.action || "save").trim(), needsEdit = ["save", "submit", "reopen"].includes(action), needsReview = ["approve", "reject"].includes(action);
      const scope = resolveAnnotationGroup(state, body);
      if (!scope) { const error = new Error("任务或数据集不存在，或没有可标注的 Episode"); error.status = 404; throw error; }
      const scopeAssets = state.assets.filter(item => !item.isDemo && annotationGroupKeyForAsset(item) === scope.key);
      if (scopeAssets.some(item => !typeAllowed(currentUser, item.type))) { const error = new Error("当前账号无权标注该任务或数据集"); error.status = 403; throw error; }
      if (needsEdit && !hasPermission(currentUser, ["标注编辑", "资产管理"])) { const error = new Error("当前账号没有标注编辑权限"); error.status = 403; throw error; }
      if (needsReview && !hasPermission(currentUser, ["标注审核", "资产管理"])) { const error = new Error("当前账号没有标注审核权限"); error.status = 403; throw error; }
      const result = applyAnnotationStandard(state, body, currentUser.name);
      const refreshed = scopedState(state, currentUser), actionLabel = { save: "保存任务指令", submit: "提交任务指令审核", approve: "审核通过任务指令", reject: "退回任务指令", reopen: "重新打开任务指令" }[action] || "更新任务指令";
      audit(state, actionLabel, scope.key, `${scope.name} · ${result.previousStatus} → ${result.nextStatus} · ${result.updated} 个 Episode 继承`, currentUser.name);
      writeState(state); sendJson(res, 200, { ok: true, ...result, annotations: refreshed.annotations, annotationStandards: refreshed.annotationStandards, annotationGroups: refreshed.annotationGroups }); return true;
    }
    if (pathname === "/api/annotations/update") {
      const annotation = state.annotations.find(item => item.id === body.id), action = annotationActionFromBody(body);
      if (!annotation || !isCurrentAnnotation(state, annotation)) throw new Error("Episode 标注任务不存在");
      assertTypeAllowed(currentUser, annotation.type);
      const allowed = ["save", "submit", "approve", "reject", "reopen"];
      if (!allowed.includes(action)) throw new Error("标注操作无效");
      const needsEdit = ["save", "submit", "reopen"].includes(action), needsReview = ["approve", "reject"].includes(action);
      if (needsEdit && !hasPermission(currentUser, ["标注编辑", "资产管理"])) { const error = new Error("当前账号没有标注编辑权限"); error.status = 403; throw error; }
      if (needsReview && !hasPermission(currentUser, ["标注审核", "资产管理"])) { const error = new Error("当前账号没有标注审核权限"); error.status = 403; throw error; }
      const result = applyAnnotationUpdate(state, body, currentUser.name);
      const actionLabel = { save: "保存标注草稿", submit: "提交标注审核", approve: "标注审核通过", reject: "退回标注修改", reopen: "重新打开标注" }[action];
      audit(state, actionLabel, annotation.id, `${annotation.episode} · ${result.previousStatus} → ${result.nextStatus} · ${annotation.note || "无审核意见"}`, currentUser.name);
      const refreshed = scopedState(state, currentUser); writeState(state); sendJson(res, 200, { ok: true, action, annotation: result.annotation, annotations: refreshed.annotations, annotationStandards: refreshed.annotationStandards, annotationGroups: refreshed.annotationGroups }); return true;
    }
    if (pathname === "/api/exceptions/review") {
      if (!hasPermission(currentUser, ["标注审核", "问题处置", "资产管理"])) { const error = new Error("当前账号没有异常复核权限"); error.status = 403; throw error; }
      const asset = state.assets.find(item => item.id === body.assetId);
      if (!asset || asset.isDemo || asset.bundleRole !== "trajectory" || !Number.isInteger(episodeIndexForAsset(asset))) { const error = new Error("Episode 记录不存在"); error.status = 404; throw error; }
      assertTypeAllowed(currentUser, asset.type);
      const decision = String(body.decision || "").trim();
      if (!["reviewed", "blocked"].includes(decision)) throw new Error("复核结论必须是“复核完成”或“确认异常”");
      const note = String(body.note || "").trim();
      if (decision === "blocked" && !note) throw new Error("确认异常时必须填写复核意见");
      if (note.length > 1000) throw new Error("复核意见不能超过 1000 个字符");
      const tags = [...new Set((Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(/[，,]/)).map(tag => String(tag || "").trim()).filter(Boolean))].slice(0, 20);
      const issueIds = new Set((Array.isArray(body.issueIds) ? body.issueIds : []).map(String));
      const issues = state.issues.filter(issue => issue.assetId === asset.id && issue.status !== "已关闭" && (!issueIds.size || issueIds.has(issue.id))).map(issue => issue.id);
      const now = new Date().toISOString(), review = {
        id: `EXR-${crypto.randomUUID()}`, assetId: asset.id, bundleId: asset.bundleId, bundleName: asset.bundleName || asset.bundleId,
        episodeIndex: episodeIndexForAsset(asset), type: asset.type, groupKey: annotationGroupKeyForAsset(asset), decision, note, tags, issueIds: issues,
        reviewStatus: decision === "reviewed" ? "复核完成" : "确认异常", reviewedAt: now, reviewedBy: currentUser.name,
      };
      state.exceptionReviews.unshift(review); state.exceptionReviews = state.exceptionReviews.slice(0, 5000);
      audit(state, "记录 Episode 异常复核", asset.id, `${review.episodeIndex} · ${review.reviewStatus}${note ? ` · ${note}` : ""}`, currentUser.name);
      const refreshed = scopedState(state, currentUser); writeState(state);
      sendJson(res, 200, { ok: true, review, exceptionReviews: refreshed.exceptionReviews }); return true;
    }
    if (pathname === "/api/exports") {
      if (body.format && !["LeRobot", "LeRobot v2.1", "LeRobot v3.0", "lerobot"].includes(body.format)) throw new Error("此接口建立 LeRobot 交付记录，其他格式请使用格式转换入口");
      const format = TRAINING_DELIVERY_FORMAT, name = String(body.name || "").trim(), gate = exportGate(state, currentUser), requestedAssetIds = Array.isArray(body.assetIds) ? new Set(body.assetIds.map(String)) : null, requestedBundleId = String(body.bundleId || "").trim();
      let eligible = requestedAssetIds ? gate.eligible.filter(asset => requestedAssetIds.has(asset.id)) : gate.eligible;
      if (requestedBundleId) eligible = eligible.filter(asset => asset.bundleId === requestedBundleId);
      if (!name) throw new Error("交付包名称不能为空");
      if (!eligible.length) { const error = new Error(requestedAssetIds ? "当前批次没有满足交付门禁的资产" : `质量门禁未通过：原始文件 ${gate.withOriginal}/${gate.total}，质检通过 ${gate.qualityPassed}/${gate.total}，标注通过 ${gate.annotationPassed}/${gate.total}`); error.status = 409; error.extra = { gate: { ...gate, eligible: 0 } }; throw error; }
      const bundleIds = [...new Set(eligible.map(asset => asset.bundleId).filter(Boolean))];
      if (bundleIds.length !== 1) { const error = new Error("一次只能为一个生产批次生成清单，请先选择具体批次"); error.status = 409; throw error; }
      const bundleId = bundleIds[0];
      if (eligible.length !== gate.eligible.filter(asset => asset.bundleId === bundleId).length) { const error = new Error("交付清单必须包含所选批次的全部文件，不能只选其中一部分"); error.status = 409; throw error; }
      const batch = exportBatchForAssets(state, eligible.map(asset => asset.id));
      const existing = state.exports.find(job => job.batchId === batch.batchId);
      if (existing) {
        Object.assign(existing, { format, baseFormat: existing.lerobotVersion ? `LeRobot ${existing.lerobotVersion}` : existing.baseFormat, trainingReady: Boolean(existing.conversions?.lerobot?.independentVerification?.officialVerification === "passed") });
        if (!existing.lerobotDirectory) {
          try {
            const delivery = await materializeLeRobotDelivery(state, existing.id, bundleId, eligible, req.progress || (() => {}));
            Object.assign(existing, { format, baseFormat: delivery.baseFormat || `LeRobot ${delivery.sourceVersion || delivery.version}`, trainingReady: delivery.trainingReady === true, formatVersion: 'v3.0', lerobotDirectory: delivery.directory, lerobotRelativeDirectory: delivery.relativeDirectory, lerobotValidation: delivery.validation, lerobotVersion: delivery.sourceVersion || delivery.version });
            if (delivery.prebuiltConversion) existing.conversions = { ...(existing.conversions || {}), lerobot: { ...delivery.prebuiltConversion, sourceFingerprint: deliverySourceFingerprint(state, existing), checkedAt: new Date().toISOString(), operator: currentUser.name } };
            const rebuilt = buildBundleManifest(state, { id: existing.id, name: existing.name, format, contents: existing.contents, assetIds: existing.assetIds, createdAt: existing.createdAt, lerobot: delivery });
            if (existing.fileName) fs.writeFileSync(path.join(exportDir, existing.fileName), JSON.stringify(rebuilt.manifest, null, 2), "utf8");
            if (rebuilt.annotationLines.length) fs.writeFileSync(path.join(exportDir, `${existing.id}-annotations.jsonl`), `${rebuilt.annotationLines.join("\n")}\n`, "utf8");
            writeState(state);
          } catch (error) { error.status = 422; throw error; }
        }
        sendJson(res, 200, { ok: true, duplicate: true, job: existing, exports: state.exports }); return true;
      }
      const id = `EXP-${Date.now().toString(36).toUpperCase()}`, createdAt = new Date().toISOString(), fileName = `${id}.json`, contents = Array.isArray(body.contents) ? [...new Set(body.contents.map(String))] : ["原始文件", "质量报告", "标注清单"];
      let delivery;
      try { delivery = await materializeLeRobotDelivery(state, id, bundleId, eligible, req.progress || (() => {})); }
      catch (error) { error.status = 422; throw error; }
      const built = buildBundleManifest(state, { id, name, format, contents, assetIds: eligible.map(asset => asset.id), createdAt, lerobot: delivery }), manifest = built.manifest;
      if (built.annotationLines.length) fs.writeFileSync(path.join(exportDir, `${id}-annotations.jsonl`), `${built.annotationLines.join("\n")}\n`, "utf8");
      fs.writeFileSync(path.join(exportDir, fileName), JSON.stringify(manifest, null, 2), "utf8");
      const job = { id, name, format, baseFormat: delivery.baseFormat || `LeRobot ${delivery.sourceVersion || delivery.version}`, formatVersion: 'v3.0', trainingReady: delivery.trainingReady === true, scope: manifest.scope, batchId: bundleId, batchIds: [bundleId], batchName: batch.batchName, episodeCount: manifest.episodeCount, fileCount: manifest.fileCount, assetCount: manifest.assetCount, assetIds: eligible.map(asset => asset.id), annotationCount: manifest.annotationCount, createdAt, status: delivery.prebuiltConversion ? '已验证' : '清单就绪', fileName, contents, lerobotDirectory: delivery.directory, lerobotRelativeDirectory: delivery.relativeDirectory, lerobotValidation: delivery.validation, lerobotVersion: delivery.sourceVersion || delivery.version };
      if (delivery.prebuiltConversion) job.conversions = { lerobot: { ...delivery.prebuiltConversion, sourceFingerprint: deliverySourceFingerprint(state, job), checkedAt: new Date().toISOString(), operator: currentUser.name } };
      state.exports.unshift(job); state.exports = normalizeExportHistory(state).slice(0, 200);
      audit(state, "生成 LeRobot 交付包", id, `${format} · ${name} · ${manifest.episodeCount} 条数据 · ${manifest.fileCount} 个文件 · ${delivery.validation.engine}`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, job, exports: state.exports }); return true;
    }
    if (pathname === "/api/datasets") {
      const name = String(body.name || "").trim(), version = String(body.version || "").trim(), gate = exportGate(state, currentUser);
      if (!name || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("数据集名称不能为空，版本号必须符合 v1.0.0 格式");
      if (state.datasets.some(item => item.name.toLowerCase() === name.toLowerCase() && item.version.toLowerCase() === version.toLowerCase())) { const error = new Error("相同名称和版本的数据集已经存在"); error.status = 409; throw error; }
      if (!gate.eligible.length) { const error = new Error(`数据集门禁未通过：当前可纳入资产 ${gate.eligible.length}/${gate.total}`); error.status = 409; error.extra = { gate: { ...gate, eligible: gate.eligible.length } }; throw error; }
      const assets = gate.eligible.map(asset => ({ id: asset.id, type: asset.type, sha256: asset.serverFile.sha256, size: asset.serverFile.size, score: asset.score, annotationId: state.annotations.find(item => item.assetId === asset.id)?.id })), composition = DATA_TYPES.reduce((result, type) => ({ ...result, [type]: assets.filter(asset => asset.type === type).length }), {}), checksum = crypto.createHash("sha256").update(assets.map(asset => `${asset.id}:${asset.sha256}`).sort().join("\n")).digest("hex"), now = new Date().toISOString(), id = `DS-${Date.now().toString(36).toUpperCase()}`;
      const dataset = { id, name, version: version.startsWith("v") ? version : `v${version}`, status: "已冻结", assetCount: assets.length, totalBytes: assets.reduce((sum, asset) => sum + Number(asset.size || 0), 0), composition, checksum, assets, createdAt: now, updatedAt: now, createdBy: body.user || "林晓雯" };
      state.datasets.unshift(dataset); audit(state, "冻结数据集版本", id, `${dataset.name} ${dataset.version} · ${dataset.assetCount} 个资产 · ${checksum.slice(0, 12)}`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, dataset, datasets: state.datasets }); return true;
    }
    if (pathname === "/api/datasets/status") {
      const dataset = state.datasets.find(item => item.id === body.id), transitions = { "已冻结": ["已发布", "已归档"], "已发布": ["已归档"], "已归档": [] };
      if (!dataset) throw new Error("数据集版本不存在");
      if ((dataset.assets || []).some(item => !typeAllowed(currentUser, item.type))) throw new Error("当前账号无权变更跨数据域数据集");
      if (!(transitions[dataset.status] || []).includes(body.status)) throw new Error(`数据集不能从“${dataset.status}”变更为“${body.status}”`);
      dataset.status = body.status; dataset.updatedAt = new Date().toISOString(); audit(state, "更新数据集状态", dataset.id, `${dataset.name} ${dataset.version} · ${dataset.status}`, body.user || "林晓雯"); writeState(state); sendJson(res, 200, { ok: true, dataset, datasets: state.datasets }); return true;
    }
    if (pathname === "/api/training") {
      const dataset = state.datasets.find(item => item.id === body.datasetId), algorithms = ["ACT", "Diffusion Policy", "SmolVLA", "GR00T N1"], name = String(body.name || "").trim();
      if (!name || !dataset) throw new Error("训练任务名称和数据集版本不能为空");
      if ((dataset.assets || []).some(item => !typeAllowed(currentUser, item.type))) throw new Error("当前账号无权使用跨数据域数据集");
      if (!["已冻结", "已发布"].includes(dataset.status)) throw new Error("只能使用已冻结或已发布的数据集训练");
      if (!algorithms.includes(body.algorithm)) throw new Error("训练算法不受支持");
      const now = new Date().toISOString(), job = { id: `TRAIN-${Date.now().toString(36).toUpperCase()}`, name, datasetId: dataset.id, dataset: `${dataset.name} ${dataset.version}`, algorithm: body.algorithm, modelId: String(body.modelId || "").trim() || "未关联", status: "排队中", progress: 0, successRate: null, failureSamples: 0, createdAt: now, updatedAt: now, owner: body.user || "林晓雯" };
      state.trainingJobs.unshift(job); audit(state, "创建训练任务", job.id, `${job.algorithm} · ${job.dataset}`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, job, trainingJobs: state.trainingJobs }); return true;
    }
    if (pathname === "/api/training/status") {
      const job = state.trainingJobs.find(item => item.id === body.id), transitions = { "排队中": ["运行中", "已失败"], "运行中": ["已暂停", "已完成", "已失败"], "已暂停": ["运行中", "已失败"], "已完成": [], "已失败": [] };
      if (!job) throw new Error("训练任务不存在");
      const jobDataset = state.datasets.find(item => item.id === job.datasetId); if (!jobDataset || (jobDataset.assets || []).some(item => !typeAllowed(currentUser, item.type))) throw new Error("当前账号无权操作该训练任务");
      if (!(transitions[job.status] || []).includes(body.status)) throw new Error(`训练任务不能从“${job.status}”变更为“${body.status}”`);
      const rate = Number(body.successRate), failures = Number(body.failureSamples); Object.assign(job, { status: body.status, progress: body.status === "已完成" ? 100 : body.status === "运行中" ? Math.max(1, Number(job.progress || 0)) : job.progress, successRate: Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : job.successRate, failureSamples: Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : job.failureSamples, failureReason: body.failureReason == null ? job.failureReason : String(body.failureReason), updatedAt: new Date().toISOString() });
      audit(state, "更新训练任务状态", job.id, `${job.name} · ${job.status}${job.successRate == null ? "" : ` · 成功率 ${job.successRate}%`}`, body.user || "林晓雯"); writeState(state); sendJson(res, 200, { ok: true, job, trainingJobs: state.trainingJobs }); return true;
    }
    if (pathname === "/api/training/feedback") {
      const job = state.trainingJobs.find(item => item.id === body.trainingId), count = Math.floor(Number(body.count));
      if (!job || !Number.isFinite(count) || count <= 0 || !String(body.reason || "").trim()) throw new Error("请选择训练任务，并填写有效样本数和失败原因");
      assertTypeAllowed(currentUser, body.type);
      const record = { id: `FB-${Date.now().toString(36).toUpperCase()}`, trainingId: job.id, training: job.name, datasetId: job.datasetId, count, reason: String(body.reason).trim(), type: DATA_TYPES.includes(body.type) ? body.type : "待确认", scene: String(body.scene || "未填写").trim(), status: "待归因", createdAt: new Date().toISOString(), createdBy: body.user || "林晓雯" };
      state.feedbackSamples.unshift(record); audit(state, "登记失败样本回流", record.id, `${job.name} · ${count} 条 · ${record.reason}`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, record, feedbackSamples: state.feedbackSamples }); return true;
    }
    if (pathname === "/api/nodes") {
      const id = String(body.id || "").trim().toUpperCase(), type = body.type, site = String(body.site || "").trim();
      if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(id) || !DATA_TYPES.includes(type) || !site) throw new Error("节点编号、数据类型和部署位置不能为空，节点编号仅允许字母、数字、点、下划线和短横线");
      assertTypeAllowed(currentUser, type);
      const existing = state.nodes.find(item => item.id === id), now = new Date().toISOString(), node = { ...existing, id, type, site, agentVersion: String(body.agentVersion || existing?.agentVersion || "未上报"), capacityGb: Math.max(0, Number(body.capacityGb || existing?.capacityGb || 0)), lastHeartbeat: existing?.lastHeartbeat || null, latency: existing?.latency ?? null, disk: existing?.disk ?? null, queue: existing?.queue ?? 0, createdAt: existing?.createdAt || now, updatedAt: now };
      mergeRecord(state.nodes, node); let agentToken = null; if (!existing && !auth.nodeCredentials.some(item => item.nodeId === id)) agentToken = createNodeCredential(auth, id).token;
      audit(state, existing ? "更新采集节点" : "登记采集节点", id, `${type} · ${site} · Agent ${node.agentVersion}`, body.user || "林晓雯"); writeAccounts(auth, state); sendJson(res, 201, { ok: true, node: deriveNodeStatus(node), nodes: state.nodes.filter(item => typeAllowed(currentUser, item.type)).map(deriveNodeStatus), agentToken }); return true;
    }
    if (pathname === "/api/nodes/token") {
      const node = state.nodes.find(item => item.id === String(body.id || "").trim().toUpperCase()); if (!node) throw new Error("采集节点不存在"); assertTypeAllowed(currentUser, node.type);
      const agentToken = createNodeCredential(auth, node.id).token; audit(state, "轮换节点凭证", node.id, "旧节点令牌已立即失效", currentUser.name); writeAccounts(auth, state); sendJson(res, 200, { ok: true, node: deriveNodeStatus(node), agentToken }); return true;
    }
    if (pathname === "/api/nodes/heartbeat") {
      const node = state.nodes.find(item => item.id === String(body.id || "").toUpperCase()); if (!node) throw new Error("采集节点不存在");
      if (currentUser.isNodeCredential && currentUser.nodeId !== node.id) { const error = new Error("节点凭证与上报节点不匹配"); error.status = 403; throw error; }
      assertTypeAllowed(currentUser, node.type);
      const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; };
      Object.assign(node, { lastHeartbeat: new Date().toISOString(), latency: clamp(body.latency, 0, 60000, node.latency), disk: clamp(body.disk, 0, 100, node.disk), queue: clamp(body.queue, 0, 1000000, node.queue || 0), agentVersion: String(body.agentVersion || node.agentVersion || "未上报"), updatedAt: new Date().toISOString() }); if (nodeCredential) { nodeCredential.credential.lastUsedAt = node.lastHeartbeat; } audit(state, "接收节点心跳", node.id, `延迟 ${node.latency ?? "--"} ms · 磁盘 ${node.disk ?? "--"}% · 队列 ${node.queue}`, body.user || "节点代理"); writeAccounts(auth, state); sendJson(res, 200, { ok: true, node: deriveNodeStatus(node), nodes: state.nodes.filter(item => typeAllowed(currentUser, item.type)).map(deriveNodeStatus) }); return true;
    }
    if (pathname === "/api/nodes/diagnose") {
      const nodes = state.nodes.filter(node => typeAllowed(currentUser, node.type)).map(deriveNodeStatus), warnings = nodes.flatMap(node => [node.status === "离线" ? `${node.id} 心跳超时` : null, Number(node.disk) >= 85 ? `${node.id} 磁盘使用率 ${node.disk}%` : null, Number(node.latency) >= 200 ? `${node.id} 上行延迟 ${node.latency} ms` : null].filter(Boolean)); audit(state, "运行节点诊断", `${currentUser.domain}采集节点`, warnings.length ? warnings.join("；") : `${nodes.length} 个节点未发现预警`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, nodes, warnings }); return true;
    }
    if (pathname === "/api/members") {
      const name = String(body.name || "").trim(), email = String(body.email || "").trim().toLowerCase(), role = body.role, domain = String(body.domain || "全部数据域").trim(), password = String(body.password || "");
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !ROLE_POLICIES[role] || !["全部数据域", ...DATA_TYPES].includes(domain)) throw new Error("成员姓名、有效邮箱、平台角色和数据域不能为空");
      const duplicate = state.members.find(item => item.email === email && item.id !== body.id); if (duplicate) { const error = new Error("该邮箱已经登记"); error.status = 409; throw error; }
      const existing = state.members.find(item => item.id === body.id), authUser = auth.users.find(item => item.id === body.id || item.email === email), now = new Date().toISOString();
      if (!authUser && !password) throw new Error("新成员必须设置至少 10 位且包含字母和数字的初始密码");
      const owner = currentUser.id === auth.ownerId, requestedDeletePermission = Object.prototype.hasOwnProperty.call(body, "canDeleteData") ? body.canDeleteData === true : Boolean(existing?.canDeleteData || authUser?.canDeleteData);
      if (requestedDeletePermission !== Boolean(existing?.canDeleteData || authUser?.canDeleteData) && !owner) { const error = new Error("只有平台所有者可以开通或收回删除数据权限"); error.status = 403; throw error; }
      const canDeleteData = owner ? requestedDeletePermission : Boolean(existing?.canDeleteData || authUser?.canDeleteData);
      const id = existing?.id || authUser?.id || `MEM-${Date.now().toString(36).toUpperCase()}`, member = { ...existing, id, name, email, role, domain, permissions: ROLE_POLICIES[role], canDeleteData, isPlatformOwner: id === auth.ownerId, status: existing?.status || authUser?.status || "正常", createdAt: existing?.createdAt || now, updatedAt: now };
      let credentials = authUser;
      if (!credentials) { const record = hashPassword(validatePassword(password)); credentials = { id, name, email, role, domain, status: member.status, canDeleteData, isPlatformOwner: id === auth.ownerId, passwordSalt: record.salt, passwordHash: record.hash, sessionVersion: 1, createdAt: now, updatedAt: now }; auth.users.push(credentials); }
      else { Object.assign(credentials, { name, email, role, domain, status: member.status, canDeleteData, isPlatformOwner: id === auth.ownerId, updatedAt: now }); if (password) { const record = hashPassword(validatePassword(password)); Object.assign(credentials, { passwordSalt: record.salt, passwordHash: record.hash, sessionVersion: Number(credentials.sessionVersion || 1) + 1 }); } }
      mergeRecord(state.members, member); audit(state, existing ? "更新成员账号" : "创建成员账号", member.id, `${member.name} · ${member.role} · ${member.domain}`, currentUser.name); writeAccounts(auth, state); sendJson(res, 201, { ok: true, member, members: state.members, rolePolicies: ROLE_POLICIES, authMode: "local" }); return true;
    }
    if (pathname === "/api/members/delete-permission") {
      if (currentUser.id !== auth.ownerId) { const error = new Error("只有平台所有者可以开通或收回删除数据权限"); error.status = 403; throw error; }
      const member = state.members.find(item => item.id === body.id), account = auth.users.find(item => item.id === body.id);
      if (!member || !account) throw new Error("成员账号不存在");
      if (account.id === auth.ownerId && body.canDeleteData !== true) throw new Error("平台所有者必须保留删除数据权限");
      const enabled = body.canDeleteData === true; account.canDeleteData = enabled; member.canDeleteData = enabled; member.updatedAt = new Date().toISOString(); account.updatedAt = member.updatedAt;
      audit(state, enabled ? "开通删除数据权限" : "收回删除数据权限", member.id, `${member.name} · ${member.email}`, currentUser.name); writeAccounts(auth, state); sendJson(res, 200, { ok: true, member, members: state.members }); return true;
    }
    if (pathname === "/api/members/status") {
      const member = state.members.find(item => item.id === body.id), allowed = ["待激活", "正常", "已停用"]; if (!member) throw new Error("成员记录不存在"); if (!allowed.includes(body.status)) throw new Error("成员状态无效"); if (member.id === currentUser.id && body.status !== "正常") throw new Error("不能停用当前登录账号");
      const account = auth.users.find(item => item.id === member.id); if (!account) throw new Error("成员尚未创建登录账号");
      member.status = body.status; member.updatedAt = new Date().toISOString(); account.status = body.status; account.updatedAt = member.updatedAt; if (body.status !== "正常") account.sessionVersion = Number(account.sessionVersion || 1) + 1;
      audit(state, "更新成员状态", member.id, `${member.name} · ${member.status}`, currentUser.name); writeAccounts(auth, state); sendJson(res, 200, { ok: true, member, members: state.members }); return true;
    }
    if (pathname === "/api/notifications/read") { state.notificationsReadAt = new Date().toISOString(); writeState(state); sendJson(res, 200, { ok: true, notificationsReadAt: state.notificationsReadAt }); return true; }
    if (pathname === "/api/qc/run") { const ids = selectQcTargets(state, body.scope, body.model, body.targetIds).filter(asset => typeAllowed(currentUser, asset.type)).map(asset => asset.id); await inspectProductionAssets(state, ids, req.progress); const batch = runQc(state, body, currentUser, operationStartedAt); writeState(state); sendJson(res, 201, { ok: true, batch, runs: state.runs, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)) }); return true; }
    if (pathname === "/api/qc") { sendError(res, 410, "请通过 /api/qc/run 执行服务端质检"); return true; }
    if (pathname === "/api/assets/lerobot-deep-check") {
      const requestedIds = Array.isArray(body.assetIds) ? [...new Set(body.assetIds.map(String))].slice(0, 200) : [];
      const targets = state.assets.filter(asset => !asset.isDemo && requestedIds.includes(asset.id) && typeAllowed(currentUser, asset.type) && asset.bundleRole === "trajectory" && String(asset.format || "").toUpperCase() === "PARQUET" && asset.serverFile?.storedName);
      if (!targets.length) throw new Error("没有可执行 LeRobot 深度校验的 Parquet 轨迹文件");
      const files = targets.map(asset => path.join(uploadDir, asset.serverFile.storedName));
      let report;
      try { report = await runLerobotSchemaCheck(files); }
      catch (error) { error.status = error.status || 503; throw error; }
      const byName = new Map(report.files.map(item => [String(item.name || path.basename(item.path)), item]));
      const bundleGroups = new Map([...new Set(targets.map(asset => asset.bundleId))].map(bundleId => [
        bundleId,
        state.assets.filter(item => !item.isDemo && item.bundleId === bundleId && item.serverFile),
      ]));
      const embodiedReports = [];
      for (const [bundleId, bundleAssets] of bundleGroups) {
        try { if (findEmbodiedInvocation()) embodiedReports.push(await runEmbodiedBundleCheck(bundleId, bundleAssets)); }
        catch (error) { error.status = error.status || 503; throw error; }
      }
      const embodiedByBundle = new Map(embodiedReports.map(item => [item.bundleId, item]));
      targets.forEach(asset => {
        const result = byName.get(path.basename(asset.serverFile.storedName));
        const embodied = embodiedByBundle.get(asset.bundleId);
        asset.inspection = { ...(asset.inspection || {}), ...(result ? { lerobotSchema: { ...result, checkedAt: new Date().toISOString(), parser: "pyarrow" } } : {}), ...(embodied ? { embodied } : {}) };
      });
      await inspectProductionAssets(state, targets.map(asset => asset.id), req.progress);
      const batch = runQc(state, { scope: "LeRobot 深度校验", template: body.template || "标准质检", model: "全部模型", targetIds: targets.map(asset => asset.id) }, currentUser, operationStartedAt);
      audit(state, "执行 LeRobot 深度校验", batch.id, `${targets.length} 个 Parquet · ${embodiedReports.length} 个数据包经 Embodied Data 插件复核 · ${report.files.filter(item => item.status === "verified").length} 个字段通过 · ${report.files.filter(item => item.status !== "verified").length} 个结构异常`, currentUser.name);
      writeState(state);
      sendJson(res, 200, { ok: true, report, embodied: embodiedReports, batch, runs: state.runs, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)) });
      return true;
    }
    if (pathname === "/api/audit") { audit(state, `客户端事件：${String(body.action || "操作").slice(0, 80)}`, String(body.target || "").slice(0, 160), String(body.detail || "").slice(0, 500), currentUser.name); writeState(state); sendJson(res, 201, { ok: true }); return true; }
    if (pathname === "/api/episode-tags") { if (!body.episodeId || !Array.isArray(body.tags)) throw new Error("Episode 标签参数无效"); const assetId = String(body.episodeId).replace(/^EP-/, ""), asset = state.assets.find(item => item.id === assetId); if (asset) assertTypeAllowed(currentUser, asset.type); state.episodeTags[body.episodeId] = [...new Set(body.tags.map(String))]; writeState(state); sendJson(res, 201, { ok: true, episodeId: body.episodeId, tags: state.episodeTags[body.episodeId] }); return true; }
    if (pathname === "/api/issues/review-media") {
      const issue = state.issues.find(item => item.id === body.id && item.status !== '已关闭');
      const asset = state.assets.find(item => item.id === issue?.assetId), production = asset?.inspection?.production;
      if (!asset || !hasProductionEvidence(asset)) throw new Error('请先完成当前文件的服务端检查');
      assertTypeAllowed(currentUser, asset.type);
      if (!hasPermission(currentUser, ['运行质检', '平台设置'])) { sendError(res, 403, '仅质量工程师或负责人可复核媒体候选'); return true; }
      const findings = production.media?.findings || [], note = String(body.note || '').trim();
      if (!findings.some(item => ['black_frames', 'frozen_frames'].includes(item.code))) throw new Error('该问题不是可人工复核的黑屏或静止候选');
      if (note.length < 10) throw new Error('请填写至少 10 字的查看范围与判定依据');
      if (await backupTools.digest(path.join(uploadDir, asset.serverFile.storedName)) !== production.sha256) throw new Error('源文件已变化，需重新检查');
      production.mediaReview = { approved: true, sha256: production.sha256, reviewer: currentUser.name, reviewerId: currentUser.id, note, reviewedAt: new Date().toISOString() };
      const batch = runQc(state, { scope: '媒体人工复核', targetIds: [asset.id] }, currentUser);
      audit(state, '人工复核媒体候选', asset.id, note, currentUser.name); writeState(state);
      sendJson(res, 200, { ok: true, batch }); return true;
    }
    if (pathname === "/api/issues/recheck") {
      const requested = Array.isArray(body.issueIds) && body.issueIds.length ? new Set(body.issueIds.map(String)) : null;
      const visibleOpen = state.issues.filter(issue => issue.status !== "已关闭" && isProductionLinkedRecord(state, issue) && (!requested || requested.has(issue.id)) && typeAllowed(currentUser, issue.type));
      if (!visibleOpen.length) { sendJson(res, 200, { ok: true, checked: 0, closed: 0, remaining: 0, manual: 0, issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)), message: "当前没有未关闭问题" }); return true; }
      const targetIds = [...new Set(visibleOpen.flatMap(issue => issue.affectedAssetIds?.length ? issue.affectedAssetIds : [issue.assetId]).filter(Boolean))];
      const deepIds = visibleOpen.filter(issue => issue.metric === "语义深度解析" && String(issue.detail || "").includes("仍需解析")).map(issue => issue.assetId);
      let deepBatch = null;
      if (!body.skipDeepCheck && deepIds.length) {
        const targets = state.assets.filter(asset => deepIds.includes(asset.id) && asset.serverFile?.storedName && String(asset.format || "").toUpperCase() === "PARQUET" && asset.bundleRole === "trajectory" && typeAllowed(currentUser, asset.type));
        if (targets.length) {
          try {
            const report = await runLerobotSchemaCheck(targets.map(asset => path.join(uploadDir, asset.serverFile.storedName))), byName = new Map(report.files.map(item => [String(item.name || ""), item]));
            targets.forEach(asset => {
              const result = byName.get(path.basename(asset.serverFile.storedName));
              if (result) asset.inspection = { ...(asset.inspection || {}), lerobotSchema: { ...result, checkedAt: new Date().toISOString(), parser: "pyarrow" } };
            });
            deepBatch = { status: "verified", checked: report.files.length, passed: report.files.filter(item => item.status === "verified").length };
          } catch (error) {
            deepBatch = { status: "skipped", reason: error.message };
          }
        }
      }
      await inspectProductionAssets(state, targetIds, req.progress);
      const batch = runQc(state, { scope: "问题自动复核", template: body.template || "标准质检", model: "全部模型", targetIds }, currentUser, operationStartedAt);
      const results = [];
      visibleOpen.forEach(issue => {
        const asset = state.assets.find(item => item.id === issue.assetId);
        if (!asset) return;
        if (issue.status === "已关闭" && issue.verification?.verified === true) {
          results.push({ issueId: issue.id, assetId: asset.id, metric: issue.metric, verified: true, reason: issue.verification.reason, detectedType: null, checkedAt: issue.verification.checkedAt });
          return;
        }
        const evidence = findIssueEvidence(issue, asset, state);
        results.push({ issueId: issue.id, assetId: asset.id, metric: issue.metric, verified: evidence.verified, reason: evidence.reason, detectedType: evidence.detectedType || null, checkedAt: new Date().toISOString() });
        if (evidence.verified) Object.assign(issue, { status: "已关闭", verification: { verified: true, reason: evidence.reason, checkedAt: new Date().toISOString(), batchId: batch?.id || null, actor: currentUser.name }, resolution: issue.resolution || `服务端复检：${evidence.reason}`, updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }), closedAt: new Date().toISOString(), closedBy: currentUser.name });
        else Object.assign(issue, { verification: { verified: false, reason: evidence.reason, checkedAt: new Date().toISOString(), batchId: batch?.id || null, actor: currentUser.name }, updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }) });
      });
      const closed = results.filter(item => item.verified).length, remaining = visibleOpen.filter(item => item.status !== "已关闭").length, manual = results.filter(item => /人工|尚未执行 LeRobot|需要运行/.test(item.reason)).length;
      audit(state, "自动复核质量问题", batch?.id || "问题复核", `复核 ${results.length} 条 · 自动关闭 ${closed} 条 · 保留 ${remaining} 条 · 人工复核 ${manual} 条`, currentUser.name);
      writeState(state); sendJson(res, 200, { ok: true, batch, deep: deepBatch, checked: results.length, closed, remaining, manual, results, issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)), runs: state.runs }); return true;
    }
    if (pathname === "/api/issues/update") {
      const issue = state.issues.find(item => item.id === body.id), allowedStatuses = ["待处理", "处理中", "待复核", "已关闭"], nextStatus = String(body.status || "").trim(), resolution = String(body.resolution ?? issue?.resolution ?? "").trim();
      if (!issue) throw new Error("问题单不存在"); assertTypeAllowed(currentUser, issue.type); if (!allowedStatuses.includes(nextStatus)) throw new Error("问题状态无效");
      if (nextStatus === "已关闭" && issue.status !== "已关闭") { const error = new Error("请执行服务端自动复核；证据通过后问题会自动关闭"); error.status = 409; throw error; }
      if (nextStatus === "已关闭" && resolution.length < 4) throw new Error("关闭问题前必须填写至少 4 个字的处置说明");
      if (issue.status === "已关闭" && nextStatus === "已关闭") throw new Error("问题已经关闭，如需继续处理请先重新打开");
      Object.assign(issue, { assignee: String(body.assignee ?? issue.assignee ?? "未分配").trim() || "未分配", status: nextStatus, resolution, updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }), closedAt: nextStatus === "已关闭" ? new Date().toISOString() : null, closedBy: nextStatus === "已关闭" ? currentUser.name : null });
      audit(state, nextStatus === "已关闭" ? "关闭质量问题" : "更新质量问题", issue.id, `${issue.status} · ${issue.assignee} · ${issue.resolution || "无处理说明"}`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, issue }); return true;
    }
    if (pathname === "/api/rules/toggle") { const rule = state.rules.find(item => item.id === body.id); if (!rule) throw new Error("质量规则不存在"); if (rule.scope !== "全部") assertTypeAllowed(currentUser, rule.scope); else if (!isAdministrator(currentUser) && currentUser.domain !== "全部数据域") throw new Error("单一数据域账号不能修改全部数据域规则"); if (rule.locked) throw new Error("系统必需规则不可停用"); rule.enabled = Boolean(body.enabled); rule.updatedAt = new Date().toISOString(); audit(state, rule.enabled ? "启用质量规则" : "停用质量规则", rule.id, rule.name, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, rule, rules: state.rules.filter(item => item.scope === "全部" || typeAllowed(currentUser, item.scope)) }); return true; }
    if (pathname === "/api/rules/upsert") {
      const allowedCodes = ["filename_contains", "max_file_size_mb", "min_file_size_kb", "metadata_required"];
      if (!body.name || !allowedCodes.includes(body.code)) throw new Error("自定义规则参数无效");
      if (!["全部", ...DATA_TYPES].includes(body.scope)) throw new Error("规则适用类型无效");
      if (body.scope !== "全部") assertTypeAllowed(currentUser, body.scope); else if (!isAdministrator(currentUser) && currentUser.domain !== "全部数据域") throw new Error("单一数据域账号不能创建全部数据域规则");
      if (body.value == null || String(body.value).trim() === "") throw new Error("规则阈值不能为空");
      const id = body.id || `RULE-CUSTOM-${Date.now().toString(36).toUpperCase()}`;
      const record = { id, code: body.code, name: String(body.name).trim(), scope: body.scope, category: body.category || "自定义", threshold: String(body.threshold || body.value), value: String(body.value).trim(), severity: body.severity === "高" ? "高" : "中", enabled: body.enabled !== false, system: false, locked: false, updatedAt: new Date().toISOString() };
      mergeRecord(state.rules, record); audit(state, "保存质量规则", id, `${record.name} · ${record.scope} · ${record.threshold}`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, rule: record, rules: state.rules }); return true;
    }
    if (pathname === "/api/settings") {
      const incoming = body.settings || body, thresholds = incoming.thresholds || {}, video = incoming.video || {}, weights = incoming.issueWeights || {};
      const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; };
      state.settings = { thresholds: { "快速质检": clamp(thresholds["快速质检"], 0, 100, state.settings.thresholds["快速质检"]), "标准质检": clamp(thresholds["标准质检"], 0, 100, state.settings.thresholds["标准质检"]), "全量质检": clamp(thresholds["全量质检"], 0, 100, state.settings.thresholds["全量质检"]), "仅同步检测": clamp(thresholds["仅同步检测"], 0, 100, state.settings.thresholds["仅同步检测"]) }, video: { minWidth: clamp(video.minWidth, 1, 16384, state.settings.video.minWidth), minHeight: clamp(video.minHeight, 1, 16384, state.settings.video.minHeight) }, issueWeights: { high: clamp(weights.high, 1, 100, state.settings.issueWeights.high), medium: clamp(weights.medium, 1, 100, state.settings.issueWeights.medium) } };
      audit(state, "更新质量门禁", "平台设置", `标准 ${state.settings.thresholds["标准质检"]} 分 · 视频 ${state.settings.video.minWidth}x${state.settings.video.minHeight}`, body.user || "林晓雯"); writeState(state); sendJson(res, 200, { ok: true, settings: state.settings }); return true;
    }
    if (pathname === "/api/storage/reconcile") {
      const report = reconcileStorage(state); audit(state, "运行存储一致性校验", "uploads", `引用 ${report.referencedFiles} · 缺失 ${report.missing.length} · 大小不一致 ${report.sizeMismatch.length} · 孤儿 ${report.orphan.length}`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, report }); return true;
    }
    if (pathname === "/api/backup") { const backupResult = await backupTools.backup(getStore(), req.progress); sendJson(res, 201, { ok: true, backup: backupResult.backup, backupResult }); return true; }
    sendError(res, 404, "接口不存在"); return true;
  } catch (error) { sendError(res, error.status || 400, error.message || "请求失败", error.extra || {}); return true; }
}

ensureStorage();
resumableUploads = new ResumableUploads(getStore());
const startupState = readState();
healthStateSummary = summarizeStateForHealth(startupState);
const legacyHdf5Migration = migrateLegacyHdf5CapabilityIssues(startupState);
const createdEpisodeTasks = generateAnnotationTasks(startupState, "系统迁移");
const reopenedLegacyBatches = reopenAcceptance(startupState, new Set(startupState.assets.filter(asset => !hasProductionEvidence(asset)).map(asset => asset.bundleId)), '升级后缺少绑定当前文件的完整检查证据，请执行完整质检并重新验收');
const rebuiltExportManifests = rebuildLegacyExportManifests(startupState);
const compactedState = compactStateCollections(startupState);
if (createdEpisodeTasks.length || rebuiltExportManifests || reopenedLegacyBatches || legacyHdf5Migration.closed || legacyHdf5Migration.reset || compactedState) {
  const backupName = `state-before-startup-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(backupDir, backupName), JSON.stringify(startupState, null, 2));
  writeState(startupState);
  console.log(`启动迁移完成：新增 ${createdEpisodeTasks.length} 个 Episode 标注任务，重建 ${rebuiltExportManifests} 份旧交付清单，关闭 ${legacyHdf5Migration.closed} 条旧版 HDF5 误报，重置 ${legacyHdf5Migration.reset} 个 HDF5 资产，压缩历史状态 ${compactedState ? "是" : "否"}，原状态备份：${backupName}`);
}
taskQueue = new TaskQueue(getStore(), executeQueuedJob);
taskQueue.schedule();
const server = http.createServer(async (req, res) => {
  try {
  let url; try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch { sendError(res, 400, "非法 URL"); return; }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/health") {
    ensureStorage();
    const summary = healthStateSummary || summarizeStateForHealth(readState()), auth = readAuth(), embodiedPlugin = findEmbodiedInvocation(), officialLerobot = inspectOfficialLerobotRuntime();
    sendJson(res, 200, { ok: true, service: "embodied-data-quality", version: SERVICE_VERSION, port, storage: "sqlite-wal", uploadMode: "resumable-chunks", importRollback: "resume-preserving-uploaded-files", serverDirectoryScan: "worker-thread", qualityManifestScan: "worker-thread", backgroundTasks: "durable-single-worker", storageReconcile: "enabled", qcEngine: "evidence-v3-embodied", embodiedPlugin: embodiedPlugin ? "available" : "missing", annotationUnit: "episode-auto-import-or-task-manual", annotationAutoImport: "annotations-jsonl-and-lerobot-metadata", importPresetDetection: "auto-with-manual-override", ingestionPolicy: "preset-specific-required-groups", hdf5ImportMode: "server-directory-episode-aggregation", hdf5SequencePreset: "matching-cable-frames-folder-as-episode", episodePreview: "on-demand-four-camera-h264-cache", previewConcurrency: 1, previewMaxWidth: 640, previewCache: "work/previews/asset/fingerprint", qcPolicy: "after-all-registered-originals-uploaded", assetDeleteScopes: "selection-bundle-folder", pipelineProgress: "upload-clean-qc-preview-annotation-conversion", stateCompaction: "closed-issues-and-qc-result-samples", uploadSessionRetention: 100, assetPageSize: 300, deliveryUnit: "episode-with-views", deliveryFormat: TRAINING_DELIVERY_FORMAT, deliveryFormats: [TRAINING_DELIVERY_FORMAT, "MCAP JSON + original videos", "Zarr v2"], deliveryConversion: "hdf5-sequence-native-or-official-lerobot-v3-loaded-and-dataloader-verified", officialLerobotRuntime: officialLerobot.status, officialLerobotVersion: officialLerobot.version, officialLerobotExpectedVersion: officialLerobot.expectedVersion, officialLerobotVerificationRequired: true, manifestPolicy: "one-per-batch", pipelineTemplate: "V6", pipelineV5Enabled: false, pipelineNodes: V6_WORKFLOW_GROUPS.reduce((sum, group) => sum + group.nodes.length, 0), engineOperators: engineOperatorCatalog(embodiedPlugin).map(item => ({ id: item.id, status: item.status })), workflowStages: WORKFLOW_STAGES.map(item => item.id), issueClosure: "server-evidence-required", productionWorkflow: "task-asset-acceptance", authMode: "local", accessControl: "role-domain-and-owner-grants", setupRequired: auth.users.length === 0, accounts: auth.users.length, ...summary });
    return;
  }
  if (await handleApi(req, res, pathname, url)) return;
  // Serve only public UI assets; production files require authenticated APIs.
  if (pathname !== "/" && pathname !== "/index.html" && !/^\/(?:assets|docs)\/[a-zA-Z0-9_.-]+\.(?:js|css|png|jpg|svg|ico)$/.test(pathname)) { res.writeHead(404); res.end("not found"); return; }
  const requestPath = pathname === "/" ? "/index.html" : pathname, file = path.resolve(root, "." + requestPath);
  if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('not found'); return; }
    const extension = path.extname(file).toLowerCase(), etag = `W/"${data.length}-${Math.floor(fs.statSync(file).mtimeMs)}"`;
    if (String(req.headers['if-none-match'] || '') === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    const compressible = ['.js', '.css', '.html', '.json'].includes(extension) && data.length >= 1024 && /gzip/i.test(String(req.headers['accept-encoding'] || ''));
    const body = compressible ? zlib.gzipSync(data, { level: 6 }) : data;
    const headers = { 'Content-Type': mime[extension] || 'application/octet-stream', 'Cache-Control': requestPath === '/index.html' ? 'no-cache' : 'public, max-age=300, must-revalidate', 'ETag': etag, 'Content-Length': body.length, 'Vary': 'Accept-Encoding' };
    if (compressible) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers); res.end(body);
  });
  } catch (error) { console.error(error.stack); if (!res.headersSent) sendError(res, error.status || 503, error.message || "平台存储或服务异常"); else res.destroy(); }
});
server.listen(port, host, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === "IPv4" && !item.internal).map(item => item.address);
  const officialLerobot = inspectOfficialLerobotRuntime();
  console.log("========================================"); console.log(`具身数据质量管控平台 v${SERVICE_VERSION} 已启动  ${new Date().toLocaleString("zh-CN")}`); console.log("  本机访问：http://localhost:" + port); lan.forEach(address => console.log("  局域网访问：http://" + address + ":" + port)); console.log("  生产闭环：上传 → 清洗质检 → 标注 → 转换 → 验收"); console.log("  流程模板：V6（V5 已停用）"); console.log("  入库规则：按数据包预设判断必需分组；原始文件上传完成后质检"); console.log("  数据导入：浏览器小包上传或服务端 HDF5 目录按 Episode 聚合"); console.log("  HDF5 序列：帧目录聚合、流式质检、原生转换官方 LeRobot v3.0"); console.log("  性能保护：HDF5 逐帧文件超过 200 个时阻止浏览器逐文件登记"); console.log("  资产删除：勾选、数据包、文件夹三种范围"); console.log("  任务进度：上传 / 清洗 / 质检 / 标注 / 转换统一展示"); console.log("  标注来源：源 JSONL / LeRobot 元数据自动解析，未覆盖部分人工补充"); console.log(`  交付格式：${TRAINING_DELIVERY_FORMAT}（官方加载 + DataLoader 验证）`); console.log(`  官方 LeRobot：${officialLerobot.status} · ${officialLerobot.version || "未检测到"} · 期望 ${OFFICIAL_LEROBOT_VERSION}`); console.log("  访问控制：角色权限 + 数据域隔离 + 所有者授权"); console.log("  流式上传目录：" + uploadDir); console.log("========================================");
  reconcileLeRobotDeliveries().then(changed => { if (changed) console.log(`已补齐 ${changed} 份 LeRobot 交付目录`); }).catch(error => console.warn(`LeRobot 交付目录对账失败：${error.message}`));
  autoImportExistingAnnotationSources().then(results => { const scanned = results.filter(item => item.sources).length, imported = results.reduce((sum, item) => sum + Number(item.imported || 0), 0); if (scanned) console.log(`启动标注源扫描：${scanned} 个批次 · 自动匹配 ${imported} 个 Episode`); }).catch(error => console.warn(`启动标注源扫描失败：${error.message}`));
});
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用。` : "服务监听异常：" + error.message); process.exitCode = 1; });
process.on("uncaughtException", error => { console.error("服务异常：" + error.stack); process.exit(1); });
