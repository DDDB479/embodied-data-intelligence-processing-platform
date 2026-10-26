const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const execFileAsync = promisify(execFile);

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const workDir = process.env.DATA_WORK_DIR ? path.resolve(process.env.DATA_WORK_DIR) : path.join(root, "work");
const uploadDir = path.join(workDir, "uploads");
const backupDir = path.join(workDir, "backups");
const exportDir = path.join(workDir, "exports");
const stateFile = path.join(workDir, "server-state.json");
const authFile = path.join(workDir, "auth.json");
const MAX_UPLOAD = 20 * 1024 * 1024 * 1024;
const SAMPLE_LIMIT = 5 * 1024 * 1024;
const DATA_TYPES = ["UMI", "EGO", "遥操"];
const DEEP_FORMATS = ["HDF5", "H5", "MCAP", "PARQUET", "ZIP", "LEROBOT"];
const VIDEO_FORMATS = ["MP4", "MOV", "WEBM", "AVI"];
const loginFailures = new Map();
const LEROBOT_SCHEMA_SCRIPT = path.join(root, "tools", "lerobot_schema_check.py");
const EMBODIED_SOURCE_CANDIDATES = [
  process.env.EMBODIED_SOURCE_DIR,
  path.resolve(root, "..", "具身平台插件开发", "src"),
  path.resolve(root, "..", "embodied-data-platform", "src"),
].filter(Boolean);
const ROLE_POLICIES = {
  "数据治理负责人": ["资产管理", "规则管理", "问题处置", "数据集发布", "训练调度", "成员管理", "节点管理", "平台设置"],
  "质量工程师": ["资产查看", "运行质检", "问题处置", "标注查看"],
  "标注审核员": ["资产查看", "标注审核", "问题查看"],
  "算法工程师": ["数据集查看", "训练调度", "失败样本回流", "模型关联"],
  "采集运维": ["采集任务", "节点管理", "资产上传", "问题查看"],
};

function findLerobotPython() {
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
      if (result.status === 0) return candidate;
    } catch {}
  }
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
  ];
}
function defaultSettings() {
  return { thresholds: { "快速质检": 85, "标准质检": 90, "全量质检": 93, "仅同步检测": 90 }, video: { minWidth: 640, minHeight: 480 }, issueWeights: { high: 35, medium: 8 } };
}
function defaultState() { return { assets: [], tasks: [], qcBatches: [], runs: [], audit: [], episodeTags: {}, issues: [], annotations: [], exports: [], datasets: [], trainingJobs: [], feedbackSamples: [], nodes: [], members: [], bundles: [], notificationsReadAt: null, rules: defaultRules(), settings: defaultSettings() }; }
function ensureStorage() {
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });
  if (!fs.existsSync(stateFile)) writeState(defaultState());
  if (!fs.existsSync(authFile)) writeAuth({ sessionSecret: crypto.randomBytes(32).toString("base64url"), users: [], nodeCredentials: [] });
}
function readState() {
  try {
    const state = { ...defaultState(), ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
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
    state.runs = Array.isArray(state.runs) ? state.runs : [];
    state.exports = Array.isArray(state.exports) ? state.exports : [];
    state.datasets = Array.isArray(state.datasets) ? state.datasets : [];
    state.trainingJobs = Array.isArray(state.trainingJobs) ? state.trainingJobs : [];
    state.feedbackSamples = Array.isArray(state.feedbackSamples) ? state.feedbackSamples : [];
    state.nodes = (Array.isArray(state.nodes) ? state.nodes : []).map(deriveNodeStatus);
    state.members = Array.isArray(state.members) ? state.members : [];
    state.issues = Array.isArray(state.issues) ? state.issues : [];
    const legacyAnnotations = state.annotations.filter(item => !isCurrentAnnotation(state, item));
    state.legacyAnnotations = [...(Array.isArray(state.legacyAnnotations) ? state.legacyAnnotations : []), ...legacyAnnotations];
    state.annotations = state.annotations.filter(item => isCurrentAnnotation(state, item));
    const rules = defaultRules();
    if (!Array.isArray(state.rules) || !state.rules.length) state.rules = rules;
    else {
      const knownCodes = new Set(state.rules.map(rule => rule.code));
      state.rules = [...state.rules, ...rules.filter(rule => rule.locked && !knownCodes.has(rule.code))];
    }
    state.settings = { ...defaultSettings(), ...(state.settings || {}), thresholds: { ...defaultSettings().thresholds, ...(state.settings?.thresholds || {}) }, video: { ...defaultSettings().video, ...(state.settings?.video || {}) }, issueWeights: { ...defaultSettings().issueWeights, ...(state.settings?.issueWeights || {}) } };
    return state;
  } catch { return defaultState(); }
}
function writeState(next) {
  const temp = stateFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temp, stateFile);
}
function readAuth() {
  try {
    const value = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const users = Array.isArray(value.users) ? value.users : [], ownerId = String(value.ownerId || users[0]?.id || "");
    if (!value.ownerId && ownerId) { try { writeAuth({ ...value, ownerId }); } catch {} }
    return { sessionSecret: String(value.sessionSecret || crypto.randomBytes(32).toString("base64url")), ownerId, users: users.map(user => ({ ...user, isPlatformOwner: user.id === ownerId, canDeleteData: user.id === ownerId ? true : user.canDeleteData === true })), nodeCredentials: Array.isArray(value.nodeCredentials) ? value.nodeCredentials : [] };
  } catch { return { sessionSecret: crypto.randomBytes(32).toString("base64url"), users: [], nodeCredentials: [] }; }
}
function writeAuth(next) {
  const temp = authFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temp, authFile);
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
    [/^\/api\/bundles(?:\/status)?$/, ["资产管理"]],
    [/^\/api\/imports\/rollback$/, ["资产上传", "资产管理"]],
    [/^\/api\/assets\/lerobot-deep-check$/, ["运行质检", "资产管理"]], [/^\/api\/assets\/[^/]+$/, ["删除数据"]], [/^\/api\/assets$/, ["资产上传", "资产管理"]], [/^\/api\/tasks(?:\/status)?$/, ["采集任务"]],
    [/^\/api\/annotations\//, ["标注审核", "资产管理"]], [/^\/api\/exports$/, ["数据集发布"]],
    [/^\/api\/datasets(?:\/status)?$/, ["数据集发布"]], [/^\/api\/training\/feedback$/, ["失败样本回流", "训练调度"]],
    [/^\/api\/training(?:\/status)?$/, ["训练调度"]], [/^\/api\/nodes/, ["节点管理"]],
    [/^\/api\/members/, ["成员管理"]], [/^\/api\/qc/, ["运行质检", "资产管理"]], [/^\/api\/issues\/recheck$/, ["运行质检", "问题处置"]],
    [/^\/api\/episode-tags$/, ["标注审核", "资产管理"]], [/^\/api\/issues\/update$/, ["问题处置"]],
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
    [/^\/api\/bundles(?:\/|$)/, ["资产查看", "资产管理"]],
    [/^\/api\/assets(?:\/|$)/, ["资产查看", "资产上传", "资产管理"]], [/^\/api\/tasks(?:\/|$)/, ["采集任务"]],
    [/^\/api\/issues$/, ["问题查看", "问题处置"]], [/^\/api\/annotations$/, ["标注查看", "标注审核"]],
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
  return Boolean(asset && !asset.isDemo && asset.bundleId === item.bundleId && asset.bundleRole === "trajectory" && /episode_\d+\.parquet$/i.test(asset.relativePath || asset.name));
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
  return { ...state, assets, tasks, issues, annotations, nodes, qcBatches, runs, datasets, trainingJobs, feedbackSamples, rules, episodeTags, bundles, exports: hasPermission(user, ["数据集发布"]) ? state.exports : [], members: hasPermission(user, ["成员管理"]) ? state.members : [], audit: hasPermission(user, ["成员管理", "平台设置"]) ? state.audit : [] };
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
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

async function streamAssetContent(req, assetId, originalName) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD) { const error = new Error("文件超过 20GB 上限"); error.status = 413; throw error; }
  const state = readState(), asset = state.assets.find(item => item.id === assetId);
  if (!asset) { const error = new Error("资产不存在，请先创建资产元数据"); error.status = 404; throw error; }
  const tempName = `.upload-${assetId}-${crypto.randomBytes(6).toString("hex")}.tmp`, tempPath = path.join(uploadDir, tempName);
  const hash = crypto.createHash("sha256"), sample = []; let sampleSize = 0, size = 0;
  const inspect = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > MAX_UPLOAD) return callback(new Error("文件超过 20GB 上限"));
    hash.update(chunk);
    if (sampleSize < SAMPLE_LIMIT) { const part = chunk.subarray(0, Math.min(chunk.length, SAMPLE_LIMIT - sampleSize)); sample.push(part); sampleSize += part.length; }
    callback(null, chunk);
  }});
  try { await pipeline(req, inspect, fs.createWriteStream(tempPath, { flags: "wx" })); }
  catch (error) { try { fs.unlinkSync(tempPath); } catch {} throw error; }
  if (!size) { try { fs.unlinkSync(tempPath); } catch {} const error = new Error("上传文件为空"); error.status = 400; throw error; }
  const sha256 = hash.digest("hex"), duplicate = state.assets.find(item => item.id !== assetId && item.serverFile?.sha256 === sha256);
  if (duplicate) { fs.unlinkSync(tempPath); const error = new Error("文件已存在"); error.status = 409; error.extra = { duplicateId: duplicate.id, duplicateName: duplicate.name }; throw error; }
  const contentCheck = detectSignature(Buffer.concat(sample), originalName, size);
  const storedName = `${assetId}-${Date.now()}-${safeName(originalName)}`, finalPath = path.join(uploadDir, storedName);
  fs.renameSync(tempPath, finalPath);
  const deepCheck = inspectContainerFile(finalPath, originalName, contentCheck);
  const oldPath = asset.serverFile?.storedName ? path.join(uploadDir, asset.serverFile.storedName) : "";
  if (oldPath && oldPath !== finalPath && oldPath.startsWith(uploadDir)) { try { fs.unlinkSync(oldPath); } catch {} }
  const serverFile = { storedName, originalName, sha256, size, contentCheck, deepCheck, storedAt: new Date().toISOString(), uploadMode: "stream" };
  Object.assign(asset, { size, format: contentCheck.extension || asset.format, serverFile, serverManaged: true, status: "待质检", score: 0, updatedAt: new Date().toISOString() });
  audit(state, "接收原始文件", asset.id, `${originalName} · ${size} bytes · SHA-256 ${sha256.slice(0, 16)} · ${deepCheck.detail}`);
  writeState(state);
  return asset;
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
  const issues = [], evidence = [], add = (code, metric, level, detail) => { const rule = applicableRule(state, code, asset.type); if (rule && rule.enabled !== false) issues.push({ ruleId: rule.id, metric, level: rule.severity || level, detail }); };
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
    if (isLerobotTrajectory && lerobotSchema?.status === "verified") {
      pendingDeep = false;
      evidence.push(`LeRobot 字段 ${lerobotSchema.columns?.join(", ") || "已解析"} · ${lerobotSchema.rowCount ?? "?"} 行 · 向量 ${Object.entries(lerobotSchema.vectorLengths || {}).map(([name, lengths]) => `${name}=${lengths.join("/")}`).join("，") || "已校验"}`);
    } else if (isLerobotTrajectory && lerobotSchema?.status === "invalid") {
      add("deep_parse", "语义深度解析", "高", `LeRobot 专用校验失败：${(lerobotSchema.issues || []).join("；") || "内部结构无效"}`);
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
  const high = issues.filter(item => item.level === "高").length, medium = issues.filter(item => item.level === "中").length;
  const score = Math.max(0, Math.min(100, 100 - high * Number(state.settings.issueWeights.high || 35) - medium * Number(state.settings.issueWeights.medium || 8)));
  const status = high ? "问题" : pendingDeep || medium || score < threshold ? "待深检" : "已通过";
  const verified = score >= threshold && status === "已通过";
  return { score, threshold, status, detail: { sync: verified ? 100 : null, complete: check.valid === false ? 0 : 100, action: verified ? 100 : null, sensor: verified ? 100 : null }, issues, evidence };
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
function runQc(state, request, user = null) {
  const started = Date.now(), runStartedAt = new Date().toISOString(), scope = request.scope || "待质检数据", template = request.template || "标准质检", model = request.model || "全部模型";
  const targets = selectQcTargets(state, scope, model, request.targetIds).filter(asset => typeAllowed(user, asset.type)), now = new Date().toLocaleString("zh-CN", { hour12: false });
  const results = targets.map(asset => ({ assetId: asset.id, name: asset.name, type: asset.type, model: asset.model || "未关联", ...evaluateAsset(asset, template, state) }));
  results.forEach(result => { const asset = state.assets.find(item => item.id === result.assetId); Object.assign(asset, { score: result.score || 0, status: result.status, lastQcAt: now, qcTemplate: template }); });
  const activeKeys = new Set();
  results.forEach(result => result.issues.forEach(issue => {
    const key = `${result.assetId}:${issue.metric}`; activeKeys.add(key);
    const existing = state.issues.find(item => item.key === key);
    const record = { key, id: `ISS-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 10).toUpperCase()}`, assetId: result.assetId, assetName: result.name, type: result.type, metric: issue.metric, level: issue.level, detail: issue.detail, updatedAt: now };
    if (existing) {
      const wasClosed = existing.status === "已关闭";
      Object.assign(existing, record, { status: wasClosed ? "待处理" : existing.status, assignee: wasClosed ? "未分配" : (existing.assignee || "未分配"), resolution: wasClosed ? `问题再次检出；上次处置：${existing.resolution || "未填写"}` : (existing.resolution || ""), verification: wasClosed ? null : (existing.verification || null), closedAt: wasClosed ? null : (existing.closedAt || null), closedBy: wasClosed ? null : (existing.closedBy || null) });
    } else state.issues.unshift({ ...record, status: "待处理", assignee: "未分配", resolution: "", createdAt: now });
  }));
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
  const passed = results.filter(item => item.status === "已通过").length, issueCount = results.reduce((sum, item) => sum + item.issues.length, 0);
  const batch = { id: "QC-" + Date.now().toString(36).toUpperCase(), scope, template, model, total: results.length, passed, passRate: results.length ? Number((passed / results.length * 100).toFixed(1)) : 0, issueCount, duration: Number(((Date.now() - started) / 1000).toFixed(2)), status: "已完成", createdAt: now, operator: "系统质检引擎", engine: "evidence-v2", results, targetIds: results.map(item => item.assetId), ruleSnapshot: state.rules.filter(rule => rule.enabled !== false).map(rule => rule.id), settingsSnapshot: state.settings };
  state.qcBatches.unshift(batch); state.qcBatches = state.qcBatches.slice(0, 100);
  const run = { id: "RUN-" + Date.now().toString(36).toUpperCase(), kind: "质检", batchId: batch.id, scope, status: "已完成", startedAt: runStartedAt, finishedAt: new Date().toISOString(), duration: batch.duration, operator: "系统质检引擎", targetIds: batch.targetIds, summary: { total: batch.total, passed: batch.passed, passRate: batch.passRate, issueCount: batch.issueCount }, nodes: [{ id: "input", label: "读取批次", status: "已完成", detail: `${targets.length} 个资产` }, { id: "validate", label: "结构与媒体校验", status: "已完成", detail: `${results.length} 个对象` }, { id: "rules", label: "规则执行", status: "已完成", detail: `${batch.ruleSnapshot.length} 条启用规则` }, { id: "evidence", label: "问题与证据归档", status: "已完成", detail: `${issueCount} 个问题` }], evidence: results.slice(0, 200).map(item => ({ assetId: item.assetId, name: item.name, status: item.status, score: item.score, issues: (item.issues || []).map(issue => issue.metric), evidence: item.evidence || [] })) };
  state.runs.unshift(run); state.runs = state.runs.slice(0, 100);
  batch.runId = run.id;
  state.issues.forEach(issue => {
    if (issue.verification?.verified === true && issue.verification.batchId == null && batch.targetIds.includes(issue.assetId) && issue.closedAt) issue.verification.batchId = batch.id;
  });
  audit(state, "执行证据型质检", batch.id, `${template} · ${scope} · ${results.length} 个资产 · ${passed} 个通过 · ${issueCount} 个问题`);
  return batch;
}

function streamStoredFile(req, res, asset, disposition) {
  const stored = asset?.serverFile?.storedName;
  if (!stored) { sendError(res, 404, "资产尚未上传原始文件"); return; }
  const file = path.join(uploadDir, stored);
  if (!file.startsWith(uploadDir) || !fs.existsSync(file)) { sendError(res, 404, "资产文件不存在"); return; }
  const stat = fs.statSync(file), range = req.headers.range, type = mime[path.extname(asset.serverFile.originalName || asset.name).toLowerCase()] || "application/octet-stream";
  const headers = { "Content-Type": disposition ? "application/octet-stream" : type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (disposition) headers["Content-Disposition"] = `attachment; filename="${safeName(asset.serverFile.originalName || asset.name)}"`;
  if (!range) { res.writeHead(200, { ...headers, "Content-Length": stat.size }); fs.createReadStream(file).pipe(res); return; }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return; }
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : 0;
  const start = suffixLength ? Math.max(0, stat.size - suffixLength) : (match[1] ? Number(match[1]) : 0);
  const end = suffixLength ? stat.size - 1 : (match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1);
  if (start > end || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return; }
  res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function generateAnnotationTasks(state, user = "系统", domainUser = null) {
  const bundles = new Map();
  state.assets.filter(asset => !asset.isDemo && asset.bundleId && asset.serverFile && typeAllowed(domainUser, asset.type)).forEach(asset => {
    if (!bundles.has(asset.bundleId)) bundles.set(asset.bundleId, []);
    bundles.get(asset.bundleId).push(asset);
  });
  const episodes = [];
  bundles.forEach((files, bundleId) => {
    const trajectories = files.filter(asset => asset.bundleRole === "trajectory" && /\.parquet$/i.test(asset.relativePath || asset.name));
    trajectories.forEach(trajectory => {
      const match = /episode_(\d+)\.parquet$/i.exec(trajectory.relativePath || trajectory.name);
      if (!match) return;
      episodes.push({ bundleId, episodeIndex: Number(match[1]), trajectory, files });
    });
  });
  const existing = new Set(state.annotations.map(item => `${item.bundleId || ""}:${item.episodeIndex}`));
  const created = episodes.filter(item => !existing.has(`${item.bundleId}:${item.episodeIndex}`) && item.trajectory.lastQcAt).map(item => {
    const annotationId = `ANN-${crypto.createHash("sha1").update(`${item.bundleId}:${item.episodeIndex}`).digest("hex").slice(0, 16).toUpperCase()}`;
    return {
      id: annotationId, assetId: item.trajectory.id, bundleId: item.bundleId,
      bundleName: item.trajectory.bundleName || item.bundleId, episodeIndex: item.episodeIndex,
      episode: `EP-${String(item.episodeIndex).padStart(6, "0")}`, type: item.trajectory.type,
      title: `${item.trajectory.bundleName || item.bundleId} · Episode ${item.episodeIndex}`,
      assignee: "未分配", progress: 0, status: "待标注", instruction: "",
      outcome: "", segments: [], tags: [], note: "", schemaVersion: "annotation.v1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  });
  state.annotations.unshift(...created);
  audit(state, "生成 Episode 标注任务", "标注工作台", `${created.length} 个 Episode 进入标注队列`, user);
  return created;
}

function bundleGate(state, bundleId, user = null) {
  const assets = state.assets.filter(asset => !asset.isDemo && asset.bundleId === bundleId && typeAllowed(user, asset.type));
  if (!assets.length) return null;
  const stored = (state.bundles || []).find(item => item.id === bundleId) || {};
  const roles = [...new Set(assets.map(asset => asset.bundleRole).filter(Boolean))], roleSet = new Set(roles);
  const issues = state.issues.filter(issue => issue.status !== "已关闭" && assets.some(asset => asset.id === issue.assetId) && typeAllowed(user, issue.type));
  const episodeAssetIds = new Set(assets.filter(asset => asset.bundleRole === "trajectory" && /episode_\d+\.parquet$/i.test(asset.relativePath || asset.name)).map(asset => asset.id));
  const episodeMediaPending = assets.filter(asset => episodeAssetIds.has(asset.id) && !assets.some(media => media.bundleRole === "media" && new RegExp(`episode_0*${Number(/episode_(\d+)\.parquet$/i.exec(asset.relativePath || asset.name)[1])}(?:\\D|$)`, "i").test(media.relativePath || media.name))).length;
  const annotations = state.annotations.filter(item => episodeAssetIds.has(item.assetId));
  const annotationPending = episodeAssetIds.size ? [...episodeAssetIds].filter(assetId => !annotations.some(item => item.assetId === assetId && item.status === "已通过" && String(item.instruction || "").trim() && ["success", "failure"].includes(item.outcome))) : [];
  const originalCount = assets.filter(asset => asset.serverFile).length, qcCount = assets.filter(asset => asset.lastQcAt).length;
  const complete = episodeAssetIds.size > 0 && ["meta", "trajectory", "media"].every(role => roleSet.has(role));
  const ready = complete && episodeMediaPending === 0 && originalCount === assets.length && qcCount === assets.length && assets.every(asset => asset.status === "已通过") && issues.length === 0 && annotationPending.length === 0;
  const derivedStatus = ready ? "可提交验收" : issues.length ? "需处理" : episodeMediaPending || !complete ? "待补齐" : annotationPending.length ? "待审核" : "待质检";
  const status = ready && stored.gateVersion === "episode-v2" && ["待验收", "已验收", "已归档"].includes(stored.status) ? stored.status : derivedStatus;
  return { id: bundleId, name: stored.name || assets[0].bundleName || bundleId, type: assets[0].type, preset: stored.preset || assets[0].bundlePreset || "", gateVersion: stored.gateVersion || "", assetCount: assets.length, roles, complete, episodeMediaPending, originalCount, qcCount, issueCount: issues.length, annotationCount: annotations.length, annotationPending: annotationPending.length, ready, status, submittedAt: stored.submittedAt || null, submittedBy: stored.submittedBy || null, acceptedAt: stored.acceptedAt || null, acceptedBy: stored.acceptedBy || null, acceptanceNote: stored.acceptanceNote || "" };
}

function bundleList(state, user = null) {
  const ids = [...new Set(state.assets.filter(asset => !asset.isDemo && asset.bundleId && typeAllowed(user, asset.type)).map(asset => asset.bundleId))];
  return ids.map(id => bundleGate(state, id, user)).filter(Boolean);
}

function exportGate(state, user = null) {
  const assets = state.assets.filter(asset => !asset.isDemo && typeAllowed(user, asset.type)), openIssueIds = new Set(state.issues.filter(issue => issue.status !== "已关闭" && typeAllowed(user, issue.type)).map(issue => issue.assetId));
  const approvedAnnotationIds = new Set(state.annotations.filter(item => item.status === "已通过" && String(item.instruction || "").trim() && ["success", "failure"].includes(item.outcome)).map(item => item.assetId));
  const acceptedBundleIds = new Set(bundleList(state, user).filter(item => item.status === "已验收" && item.ready).map(item => item.id));
  const eligible = assets.filter(asset => asset.bundleId && acceptedBundleIds.has(asset.bundleId) && asset.serverFile && asset.status === "已通过" && !openIssueIds.has(asset.id));
  return { total: assets.length, withOriginal: assets.filter(asset => asset.serverFile).length, qualityPassed: assets.filter(asset => asset.status === "已通过" && !openIssueIds.has(asset.id)).length, annotationPassed: assets.filter(asset => approvedAnnotationIds.has(asset.id)).length, eligible };
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
function purgeAssets(state, assets, operator, action = "删除数据资产") {
  const referenced = assets.filter(asset => state.datasets.some(dataset => (dataset.assets || []).some(item => item.id === asset.id)) || state.exports.some(job => (job.assetIds || []).includes(asset.id)));
  if (referenced.length) { const error = new Error(`${referenced.length} 个资产已被数据集快照或交付清单引用，不能删除`); error.status = 409; throw error; }
  const ids = new Set(assets.map(item => item.id)), bundleIds = new Set(assets.map(item => item.bundleId).filter(Boolean)), root = path.resolve(uploadDir);
  assets.forEach(asset => { const stored = asset.serverFile?.storedName; if (stored) { const target = path.resolve(uploadDir, stored); if (target.startsWith(root + path.sep) && fs.existsSync(target)) fs.unlinkSync(target); } });
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
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-File-Name" }); res.end(); return true; }
  if (!pathname.startsWith("/api/")) return false;
  ensureStorage(); const state = readState(), auth = readAuth();
  state.members = state.members.map(member => { const account = auth.users.find(item => item.id === member.id); return { ...member, canDeleteData: account?.canDeleteData === true, isPlatformOwner: account?.id === auth.ownerId }; });
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
        auth.ownerId = id; auth.users.push(user); state.members.push({ ...publicUser(user), createdAt: now, updatedAt: now }); audit(state, "初始化平台管理员", id, `${name} · ${email}`, name); writeAuth(auth); writeState(state);
        sendJson(res, 201, { ok: true, authMode: "local", user: publicUser(user) }, { "Set-Cookie": createSessionCookie(auth, user) }); return true;
      }
      const attemptKey = loginAttemptKey(req, email); checkLoginLimit(attemptKey);
      const user = auth.users.find(item => item.email === email);
      if (!user || user.status !== "正常" || !verifyPassword(body.password, user)) { recordLoginFailure(attemptKey); sendError(res, 401, "邮箱、密码或账号状态无效"); return true; }
      loginFailures.delete(attemptKey);
      user.lastLoginAt = new Date().toISOString(); user.updatedAt = user.lastLoginAt;
      const member = state.members.find(item => item.id === user.id); if (member) { member.lastLoginAt = user.lastLoginAt; member.updatedAt = user.updatedAt; }
      writeAuth(auth); audit(state, "账号登录", user.id, `${user.email} · ${req.socket.remoteAddress || "本机"}`, user.name); writeState(state);
      sendJson(res, 200, { ok: true, authMode: "local", user: publicUser(user) }, { "Set-Cookie": createSessionCookie(auth, user) }); return true;
    } catch (error) { sendError(res, error.status || 400, error.message || "认证请求失败"); return true; }
  }
  if (req.method === "POST" && pathname === "/api/auth/logout") { if (currentUser) { currentUser.sessionVersion = Number(currentUser.sessionVersion || 1) + 1; currentUser.updatedAt = new Date().toISOString(); writeAuth(auth); audit(state, "账号退出", currentUser.id, "会话已吊销", currentUser.name); writeState(state); } sendJson(res, 200, { ok: true }, { "Set-Cookie": "embodied_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }); return true; }
  if (!currentUser) { sendError(res, 401, auth.users.length ? "登录会话无效或已过期" : "请先完成管理员初始化", { authMode: "local", setupRequired: auth.users.length === 0 }); return true; }
  if (req.method === "GET" && pathname === "/api/auth/me") { sendJson(res, 200, { ok: true, user: publicUser(currentUser), authMode: "local" }); return true; }
  if (req.method === "POST" && pathname === "/api/auth/password") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}"), nextPassword = validatePassword(body.newPassword);
      if (!verifyPassword(body.currentPassword, currentUser)) { sendError(res, 401, "当前密码不正确"); return true; }
      if (body.currentPassword === nextPassword) throw new Error("新密码不能与当前密码相同");
      const record = hashPassword(nextPassword); Object.assign(currentUser, { passwordSalt: record.salt, passwordHash: record.hash, sessionVersion: Number(currentUser.sessionVersion || 1) + 1, updatedAt: new Date().toISOString() });
      writeAuth(auth); audit(state, "修改登录密码", currentUser.id, "密码已更新，其他会话全部失效", currentUser.name); writeState(state);
      sendJson(res, 200, { ok: true, user: publicUser(currentUser) }, { "Set-Cookie": createSessionCookie(auth, currentUser) }); return true;
    } catch (error) { sendError(res, error.status || 400, error.message || "密码修改失败"); return true; }
  }
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const required = permissionFor(req, pathname);
    if (required && !hasPermission(currentUser, required, auth)) { sendError(res, 403, `当前角色无权执行：${required.join(" 或 ")}`, { required }); return true; }
  }
  if (req.method === "GET") { const required = readPermissionFor(pathname); if (required && !hasPermission(currentUser, required)) { sendError(res, 403, `当前角色无权读取：${required.join(" 或 ")}`, { required }); return true; } }
  const visible = scopedState(state, currentUser);
  if (req.method === "GET" && pathname === "/api/state") { sendJson(res, 200, { ok: true, ...visible, rolePolicies: ROLE_POLICIES, authMode: "local", currentUser: publicUser(currentUser), accessScope: { role: currentUser.role, domain: currentUser.domain } }); return true; }
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
  if (req.method === "GET" && pathname === "/api/annotations") { sendJson(res, 200, { ok: true, annotations: visible.annotations, accessScope: currentUser.domain }); return true; }
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
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    body.user = currentUser.name;
    if (pathname === "/api/bundles/status") {
      const id = String(body.id || "").trim(), nextStatus = String(body.status || "").trim(), allowed = ["待验收", "已验收", "已归档"];
      if (!id || !allowed.includes(nextStatus)) throw new Error("数据包验收参数无效");
      const gate = bundleGate(state, id, currentUser); if (!gate) { const error = new Error("数据包不存在或当前账号无权访问"); error.status = 404; throw error; }
      if (!gate.ready) { const error = new Error(`数据包尚未达到验收门禁：分组 ${gate.complete ? "完整" : "不完整"}，缺视频 Episode ${gate.episodeMediaPending}，原始文件 ${gate.originalCount}/${gate.assetCount}，已质检 ${gate.qcCount}/${gate.assetCount}，未关闭问题 ${gate.issueCount}，待审核标注 ${gate.annotationPending || 0}`); error.status = 409; error.extra = { bundle: gate }; throw error; }
      if (nextStatus === "已验收" && (!isAdministrator(currentUser) || gate.status !== "待验收")) throw new Error("只有数据治理负责人可以签署待验收数据包");
      if (nextStatus === "已归档" && (!isAdministrator(currentUser) || gate.status !== "已验收")) throw new Error("只有已验收数据包可以归档");
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
    if (pathname === "/api/assets/bulk-delete") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(value => String(value).trim()).filter(Boolean))];
      if (!ids.length) throw new Error("请选择至少一个资产");
      if (ids.length > 500) throw new Error("单次最多批量删除 500 个资产");
      const selected = ids.map(id => state.assets.find(item => item.id === id));
      if (selected.some(item => !item)) { const error = new Error("批量删除包含不存在的资产，已取消本次操作"); error.status = 404; throw error; }
      selected.forEach(asset => { assertTypeAllowed(currentUser, asset.type); if (asset.isDemo) { const error = new Error(`演示资产 ${asset.name} 不能删除`); error.status = 409; throw error; } const bundle = asset.bundleId ? (state.bundles || []).find(item => item.id === asset.bundleId) : null; if (bundle && ["已验收", "已归档"].includes(bundle.status)) { const error = new Error(`资产 ${asset.name} 属于${bundle.status}数据包，不能删除`); error.status = 409; throw error; } });
      purgeAssets(state, selected, currentUser.name, "批量删除数据资产"); audit(state, "批量删除数据资产", ids.join(","), `共删除 ${selected.length} 个资产`, currentUser.name);
      writeState(state); sendJson(res, 200, { ok: true, removed: ids, removedCount: selected.length, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), bundles: bundleList(state, currentUser) }); return true;
    }
    if (pathname === "/api/assets") {
      if (!body.name || !body.id || !DATA_TYPES.includes(body.type)) throw new Error("资产编号、名称和数据类型不能为空");
      if (body.bundleRole && !["meta", "trajectory", "media"].includes(body.bundleRole)) throw new Error("数据包文件分组无效，必须是 meta、data 或 video");
      assertTypeAllowed(currentUser, body.type);
      const existing = state.assets.find(item => item.id === body.id); if (existing) assertTypeAllowed(currentUser, existing.type);
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
    if (pathname === "/api/annotations/generate") { const created = generateAnnotationTasks(state, currentUser.name, currentUser); writeState(state); sendJson(res, 201, { ok: true, created: created.length, annotations: state.annotations.filter(item => isCurrentAnnotation(state, item) && typeAllowed(currentUser, item.type)) }); return true; }
    if (pathname === "/api/annotations/update") {
      const annotation = state.annotations.find(item => item.id === body.id), allowed = ["待标注", "标注中", "待审核", "已通过", "已驳回"];
      if (!annotation || !isCurrentAnnotation(state, annotation)) throw new Error("Episode 标注任务不存在");
      assertTypeAllowed(currentUser, annotation.type);
      if (body.status && !allowed.includes(body.status)) throw new Error("标注任务状态无效");
      const instruction = body.instruction == null ? String(annotation.instruction || "").trim() : String(body.instruction).trim();
      const outcome = body.outcome == null ? String(annotation.outcome || "").trim() : String(body.outcome).trim();
      const segments = body.segments == null ? annotation.segments : body.segments;
      if (!["", "success", "failure"].includes(outcome)) throw new Error("标注结果必须是 success、failure 或留空");
      if (!Array.isArray(segments) || segments.some(segment => !Number.isInteger(Number(segment.startFrame)) || !Number.isInteger(Number(segment.endFrame)) || Number(segment.startFrame) < 0 || Number(segment.endFrame) < Number(segment.startFrame) || !String(segment.skill || "").trim())) throw new Error("标注分段必须包含有效的开始帧、结束帧和技能名称");
      if (body.status === "已通过" && (!instruction || !outcome)) { const error = new Error("审核通过前必须填写任务指令和成功/失败结果"); error.status = 409; throw error; }
      const updatedAt = new Date().toISOString();
      Object.assign(annotation, { status: body.status || annotation.status, instruction, outcome, segments: segments.map(segment => ({ startFrame: Number(segment.startFrame), endFrame: Number(segment.endFrame), skill: String(segment.skill).trim(), object: String(segment.object || "").trim() })), note: body.note == null ? annotation.note : String(body.note), tags: Array.isArray(body.tags) ? [...new Set(body.tags.map(String))] : annotation.tags, assignee: body.assignee || annotation.assignee, progress: body.status === "已通过" ? 100 : (instruction && outcome ? 80 : instruction ? 40 : 0), annotator: annotation.annotator || currentUser.name, reviewer: body.status === "已通过" ? currentUser.name : annotation.reviewer || "", reviewedAt: body.status === "已通过" ? updatedAt : annotation.reviewedAt || "", updatedAt });
      audit(state, annotation.status === "已通过" ? "标注审核通过" : "更新标注任务", annotation.id, `${annotation.episode} · ${annotation.status} · ${annotation.note || "无审核意见"}`, currentUser.name); writeState(state); sendJson(res, 200, { ok: true, annotation, annotations: state.annotations.filter(item => isCurrentAnnotation(state, item) && typeAllowed(currentUser, item.type)) }); return true;
    }
    if (pathname === "/api/exports") {
      const format = "原始格式清单", name = String(body.name || "").trim(), gate = exportGate(state, currentUser), requestedAssetIds = Array.isArray(body.assetIds) ? new Set(body.assetIds.map(String)) : null, eligible = requestedAssetIds ? gate.eligible.filter(asset => requestedAssetIds.has(asset.id)) : gate.eligible;
      if (!name) throw new Error("交付包名称不能为空");
      if (requestedAssetIds) {
        const bundleIds = new Set(eligible.map(asset => asset.bundleId));
        for (const bundleId of bundleIds) {
          if (eligible.filter(asset => asset.bundleId === bundleId).length !== gate.eligible.filter(asset => asset.bundleId === bundleId).length) {
            const error = new Error("交付清单必须包含所选批次的全部文件，不能只选其中一部分"); error.status = 409; throw error;
          }
        }
      }
      if (!eligible.length) { const error = new Error(requestedAssetIds ? "当前批次没有满足交付门禁的资产" : `质量门禁未通过：原始文件 ${gate.withOriginal}/${gate.total}，质检通过 ${gate.qualityPassed}/${gate.total}，标注通过 ${gate.annotationPassed}/${gate.total}`); error.status = 409; error.extra = { gate: { ...gate, eligible: 0 } }; throw error; }
      const id = `EXP-${Date.now().toString(36).toUpperCase()}`, createdAt = new Date().toISOString(), fileName = `${id}.json`, contents = Array.isArray(body.contents) ? [...new Set(body.contents.map(String))] : ["原始文件", "质量报告", "标注清单"];
      const eligibleIds = new Set(eligible.map(asset => asset.id)), episodeAnnotations = state.annotations.filter(item => item.status === "已通过" && eligibleIds.has(item.assetId));
      const manifest = { schemaVersion: "1.0", id, name, targetFormat: format, createdAt, scope: requestedAssetIds ? "当前生产批次门禁通过" : "质量与标注门禁均通过", contents, assetCount: eligible.length, annotationCount: episodeAnnotations.length, annotationsFile: episodeAnnotations.length ? `${id}-annotations.jsonl` : null, assets: eligible.map(asset => {
        const annotation = state.annotations.find(item => item.assetId === asset.id);
        return { id: asset.id, episodeIndex: annotation?.episodeIndex ?? null, episodeId: annotation?.episode || null, name: asset.name, type: asset.type, format: asset.format, relativePath: asset.relativePath || asset.name, sourceRoot: asset.sourceRoot || asset.bundleName || null, bundleId: asset.bundleId || null, bundleRole: asset.bundleRole || null, size: asset.serverFile.size, sha256: asset.serverFile.sha256, source: `/api/assets/${encodeURIComponent(asset.id)}/file`, quality: { score: asset.score, status: asset.status, template: asset.qcTemplate, lastQcAt: asset.lastQcAt }, containerEvidence: asset.serverFile.deepCheck || asset.serverFile.contentCheck, annotationId: annotation?.id || null };
      }) };
      if (episodeAnnotations.length) {
        const lines = episodeAnnotations.map(item => JSON.stringify({
          schema_version: "1.0.0", annotation_id: item.id, dataset_id: item.bundleId, episode_index: item.episodeIndex,
          instruction: item.instruction, outcome: item.outcome, segments: item.segments || [],
          review: { annotator: item.annotator || "", reviewer: item.reviewer || "", status: "approved", reviewed_at: item.reviewedAt || item.updatedAt },
        }));
        fs.writeFileSync(path.join(exportDir, `${id}-annotations.jsonl`), `${lines.join("\n")}\n`, "utf8");
      }
      fs.writeFileSync(path.join(exportDir, fileName), JSON.stringify(manifest, null, 2), "utf8");
      const job = { id, name, format, scope: manifest.scope, assetCount: manifest.assetCount, assetIds: eligible.map(asset => asset.id), annotationCount: manifest.annotationCount, createdAt, status: "清单就绪", fileName, contents }; state.exports.unshift(job); state.exports = state.exports.slice(0, 200);
      audit(state, "创建交付清单", id, `${format} · ${name} · ${manifest.assetCount} 个资产`, body.user || "林晓雯"); writeState(state); sendJson(res, 201, { ok: true, job, exports: state.exports }); return true;
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
      audit(state, existing ? "更新采集节点" : "登记采集节点", id, `${type} · ${site} · Agent ${node.agentVersion}`, body.user || "林晓雯"); writeAuth(auth); writeState(state); sendJson(res, 201, { ok: true, node: deriveNodeStatus(node), nodes: state.nodes.filter(item => typeAllowed(currentUser, item.type)).map(deriveNodeStatus), agentToken }); return true;
    }
    if (pathname === "/api/nodes/token") {
      const node = state.nodes.find(item => item.id === String(body.id || "").trim().toUpperCase()); if (!node) throw new Error("采集节点不存在"); assertTypeAllowed(currentUser, node.type);
      const agentToken = createNodeCredential(auth, node.id).token; audit(state, "轮换节点凭证", node.id, "旧节点令牌已立即失效", currentUser.name); writeAuth(auth); writeState(state); sendJson(res, 200, { ok: true, node: deriveNodeStatus(node), agentToken }); return true;
    }
    if (pathname === "/api/nodes/heartbeat") {
      const node = state.nodes.find(item => item.id === String(body.id || "").toUpperCase()); if (!node) throw new Error("采集节点不存在");
      if (currentUser.isNodeCredential && currentUser.nodeId !== node.id) { const error = new Error("节点凭证与上报节点不匹配"); error.status = 403; throw error; }
      assertTypeAllowed(currentUser, node.type);
      const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; };
      Object.assign(node, { lastHeartbeat: new Date().toISOString(), latency: clamp(body.latency, 0, 60000, node.latency), disk: clamp(body.disk, 0, 100, node.disk), queue: clamp(body.queue, 0, 1000000, node.queue || 0), agentVersion: String(body.agentVersion || node.agentVersion || "未上报"), updatedAt: new Date().toISOString() }); if (nodeCredential) { nodeCredential.credential.lastUsedAt = node.lastHeartbeat; writeAuth(auth); } audit(state, "接收节点心跳", node.id, `延迟 ${node.latency ?? "--"} ms · 磁盘 ${node.disk ?? "--"}% · 队列 ${node.queue}`, body.user || "节点代理"); writeState(state); sendJson(res, 200, { ok: true, node: deriveNodeStatus(node), nodes: state.nodes.filter(item => typeAllowed(currentUser, item.type)).map(deriveNodeStatus) }); return true;
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
      mergeRecord(state.members, member); audit(state, existing ? "更新成员账号" : "创建成员账号", member.id, `${member.name} · ${member.role} · ${member.domain}`, currentUser.name); writeAuth(auth); writeState(state); sendJson(res, 201, { ok: true, member, members: state.members, rolePolicies: ROLE_POLICIES, authMode: "local" }); return true;
    }
    if (pathname === "/api/members/delete-permission") {
      if (currentUser.id !== auth.ownerId) { const error = new Error("只有平台所有者可以开通或收回删除数据权限"); error.status = 403; throw error; }
      const member = state.members.find(item => item.id === body.id), account = auth.users.find(item => item.id === body.id);
      if (!member || !account) throw new Error("成员账号不存在");
      if (account.id === auth.ownerId && body.canDeleteData !== true) throw new Error("平台所有者必须保留删除数据权限");
      const enabled = body.canDeleteData === true; account.canDeleteData = enabled; member.canDeleteData = enabled; member.updatedAt = new Date().toISOString(); account.updatedAt = member.updatedAt;
      audit(state, enabled ? "开通删除数据权限" : "收回删除数据权限", member.id, `${member.name} · ${member.email}`, currentUser.name); writeAuth(auth); writeState(state); sendJson(res, 200, { ok: true, member, members: state.members }); return true;
    }
    if (pathname === "/api/members/status") {
      const member = state.members.find(item => item.id === body.id), allowed = ["待激活", "正常", "已停用"]; if (!member) throw new Error("成员记录不存在"); if (!allowed.includes(body.status)) throw new Error("成员状态无效"); if (member.id === currentUser.id && body.status !== "正常") throw new Error("不能停用当前登录账号");
      const account = auth.users.find(item => item.id === member.id); if (!account) throw new Error("成员尚未创建登录账号");
      member.status = body.status; member.updatedAt = new Date().toISOString(); account.status = body.status; account.updatedAt = member.updatedAt; if (body.status !== "正常") account.sessionVersion = Number(account.sessionVersion || 1) + 1;
      audit(state, "更新成员状态", member.id, `${member.name} · ${member.status}`, currentUser.name); writeAuth(auth); writeState(state); sendJson(res, 200, { ok: true, member, members: state.members }); return true;
    }
    if (pathname === "/api/notifications/read") { state.notificationsReadAt = new Date().toISOString(); writeState(state); sendJson(res, 200, { ok: true, notificationsReadAt: state.notificationsReadAt }); return true; }
    if (pathname === "/api/qc/run") { const batch = runQc(state, body, currentUser); writeState(state); sendJson(res, 201, { ok: true, batch, runs: state.runs, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)) }); return true; }
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
        try { embodiedReports.push(await runEmbodiedBundleCheck(bundleId, bundleAssets)); }
        catch (error) { error.status = error.status || 503; throw error; }
      }
      const embodiedByBundle = new Map(embodiedReports.map(item => [item.bundleId, item]));
      targets.forEach(asset => {
        const result = byName.get(path.basename(asset.serverFile.storedName));
        const embodied = embodiedByBundle.get(asset.bundleId);
        asset.inspection = { ...(asset.inspection || {}), ...(result ? { lerobotSchema: { ...result, checkedAt: new Date().toISOString(), parser: "pyarrow" } } : {}), ...(embodied ? { embodied } : {}) };
      });
      const batch = runQc(state, { scope: "LeRobot 深度校验", template: body.template || "标准质检", model: "全部模型", targetIds: targets.map(asset => asset.id) }, currentUser);
      audit(state, "执行 LeRobot 深度校验", batch.id, `${targets.length} 个 Parquet · ${embodiedReports.length} 个数据包经 Embodied Data 插件复核 · ${report.files.filter(item => item.status === "verified").length} 个字段通过 · ${report.files.filter(item => item.status !== "verified").length} 个结构异常`, currentUser.name);
      writeState(state);
      sendJson(res, 200, { ok: true, report, embodied: embodiedReports, batch, runs: state.runs, assets: state.assets.filter(item => !item.isDemo && typeAllowed(currentUser, item.type)), issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)) });
      return true;
    }
    if (pathname === "/api/audit") { audit(state, `客户端事件：${String(body.action || "操作").slice(0, 80)}`, String(body.target || "").slice(0, 160), String(body.detail || "").slice(0, 500), currentUser.name); writeState(state); sendJson(res, 201, { ok: true }); return true; }
    if (pathname === "/api/episode-tags") { if (!body.episodeId || !Array.isArray(body.tags)) throw new Error("Episode 标签参数无效"); const assetId = String(body.episodeId).replace(/^EP-/, ""), asset = state.assets.find(item => item.id === assetId); if (asset) assertTypeAllowed(currentUser, asset.type); state.episodeTags[body.episodeId] = [...new Set(body.tags.map(String))]; writeState(state); sendJson(res, 201, { ok: true, episodeId: body.episodeId, tags: state.episodeTags[body.episodeId] }); return true; }
    if (pathname === "/api/issues/recheck") {
      const requested = Array.isArray(body.issueIds) && body.issueIds.length ? new Set(body.issueIds.map(String)) : null;
      const visibleOpen = state.issues.filter(issue => issue.status !== "已关闭" && isProductionLinkedRecord(state, issue) && (!requested || requested.has(issue.id)) && typeAllowed(currentUser, issue.type));
      if (!visibleOpen.length) { sendJson(res, 200, { ok: true, checked: 0, closed: 0, remaining: 0, manual: 0, issues: state.issues.filter(item => isProductionLinkedRecord(state, item) && typeAllowed(currentUser, item.type)), message: "当前没有未关闭问题" }); return true; }
      const targetIds = [...new Set(visibleOpen.map(issue => issue.assetId).filter(Boolean))];
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
      const batch = runQc(state, { scope: "问题自动复核", template: body.template || "标准质检", model: "全部模型", targetIds }, currentUser);
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
    if (pathname === "/api/backup") { const stamp = new Date().toISOString().replace(/[:.]/g, "-"), stateTarget = path.join(backupDir, `state-${stamp}.json`), authTarget = path.join(backupDir, `auth-${stamp}.json`); writeState(state); writeAuth(auth); fs.copyFileSync(stateFile, stateTarget); fs.copyFileSync(authFile, authTarget); sendJson(res, 201, { ok: true, backup: path.basename(stateTarget), authBackup: path.basename(authTarget), note: "状态与认证快照已创建；原始文件继续保存在 uploads 目录" }); return true; }
    sendError(res, 404, "接口不存在"); return true;
  } catch (error) { sendError(res, error.status || 400, error.message || "请求失败", error.extra || {}); return true; }
}

ensureStorage();
const startupState = readState();
const createdEpisodeTasks = generateAnnotationTasks(startupState, "系统迁移");
if (createdEpisodeTasks.length) {
  const backupName = `state-before-episode-tasks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.copyFileSync(stateFile, path.join(backupDir, backupName));
  writeState(startupState);
  console.log(`已建立 ${createdEpisodeTasks.length} 个 Episode 标注任务，原状态备份：${backupName}`);
}
const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch { sendError(res, 400, "非法 URL"); return; }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/health") {
    ensureStorage();
    const state = readState(), auth = readAuth(), productionAssets = state.assets.filter(item => !item.isDemo), productionIds = new Set(productionAssets.map(item => item.id)), gate = exportGate(state), nodes = state.nodes.map(deriveNodeStatus), bundles = bundleList(state), bundlePending = bundles.filter(item => ["可提交验收", "待验收"].includes(item.status)).length, bundleAccepted = bundles.filter(item => item.status === "已验收").length;
    sendJson(res, 200, { ok: true, service: "embodied-data-quality", version: "2.10.0", port, storage: "server", uploadMode: "stream", importRollback: "enabled", storageReconcile: "enabled", qcEngine: "evidence-v3-embodied", embodiedPlugin: findEmbodiedInvocation() ? "available" : "missing", issueClosure: "server-evidence-required", productionWorkflow: "task-asset-acceptance", authMode: "local", accessControl: "role-domain-and-owner-grants", setupRequired: auth.users.length === 0, accounts: auth.users.length, assets: productionAssets.length, demoAssets: state.assets.length - productionAssets.length, tasks: state.tasks.length, tasksPendingAcceptance: state.tasks.filter(item => item.status === "待验收").length, bundles: bundles.length, bundlesPendingAcceptance: bundlePending, bundlesAccepted: bundleAccepted, annotations: state.annotations.filter(item => !item.assetId || productionIds.has(item.assetId)).length, exports: state.exports.length, datasets: state.datasets.length, trainingJobs: state.trainingJobs.length, feedbackSamples: state.feedbackSamples.reduce((sum, item) => sum + Number(item.count || 0), 0), nodes: nodes.length, nodesOnline: nodes.filter(item => item.status === "在线").length, members: state.members.length, exportEligible: gate.eligible.length, issuesOpen: state.issues.filter(item => item.status !== "已关闭" && (!item.assetId || productionIds.has(item.assetId))).length, rulesEnabled: state.rules.filter(item => item.enabled !== false).length });
    return;
  }
  if (await handleApi(req, res, pathname, url)) return;
  const requestPath = pathname === "/" ? "/index.html" : pathname, file = path.resolve(root, "." + requestPath);
  if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (error, data) => { if (error) { res.writeHead(404); res.end("not found"); return; } res.writeHead(200, { "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(data); });
});
server.listen(port, host, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === "IPv4" && !item.internal).map(item => item.address);
  console.log("========================================"); console.log("具身数据质量管控平台 v2.9 已启动  " + new Date().toLocaleString("zh-CN")); console.log("  本机访问：http://localhost:" + port); lan.forEach(address => console.log("  局域网访问：http://" + address + ":" + port)); console.log("  生产闭环：任务 → 资产 → 质检 → 验收"); console.log("  问题关闭：服务端证据复检"); console.log("  访问控制：角色权限 + 数据域隔离 + 所有者授权"); console.log("  流式上传目录：" + uploadDir); console.log("========================================");
});
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用。` : "服务监听异常：" + error.message); process.exitCode = 1; });
process.on("uncaughtException", error => console.error("服务异常：" + error.stack));
