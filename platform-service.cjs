const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = __dirname;
const workDir = path.join(root, "work");
const serverFile = path.join(root, "serve.js");
const stdoutFile = path.join(workDir, "service.log");
const stderrFile = path.join(workDir, "service.err.log");
const supervisorFile = path.join(workDir, "supervisor.log");
const lockDir = path.join(workDir, "platform-service.lock");
const lockOwnerFile = path.join(lockDir, "owner.json");
const healthUrl = "http://127.0.0.1:4173/health";
const host = "127.0.0.1";
const port = 4173;

fs.mkdirSync(workDir, { recursive: true });

function log(message) {
  try {
    fs.appendFileSync(supervisorFile, `${new Date().toISOString()} ${message}\r\n`, "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(lockOwnerFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockOwnerFile, "utf8")); } catch {}
      if (owner?.pid && isProcessAlive(Number(owner.pid))) return false;
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
    }
  }
  return false;
}

function releaseLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerFile, "utf8"));
    if (Number(owner.pid) === process.pid) fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {}
}

function healthCheck(timeoutMs = 1800) {
  return new Promise(resolve => {
    const request = http.get(healthUrl, { timeout: timeoutMs }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(false);
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(payload.ok === true && payload.service === "embodied-data-quality");
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function isPortOccupied(timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function startServer() {
  const stdout = fs.openSync(stdoutFile, "a");
  const stderr = fs.openSync(stderrFile, "a");
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.once("exit", (code, signal) => {
    log(`Platform child exited: code=${code ?? "null"} signal=${signal ?? "none"}`);
  });
  child.once("error", error => log(`Platform child failed to start: ${error.message}`));
  log(`Platform child started with PID ${child.pid}.`);
  return child;
}

async function main() {
  if (!fs.existsSync(serverFile)) {
    log(`Missing server file: ${serverFile}`);
    process.exitCode = 3;
    return;
  }
  if (!acquireLock()) {
    log("Another Node supervisor is already running; exiting.");
    return;
  }

  let child = null;
  let childStartedAt = 0;
  let lastState = "";
  const setState = message => {
    if (message !== lastState) {
      log(message);
      lastState = message;
    }
  };

  const shutdown = () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    releaseLock();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", releaseLock);

  log(`Node supervisor started with PID ${process.pid}.`);
  while (true) {
    const healthy = await healthCheck();
    if (healthy) {
      if (child && child.exitCode !== null) child = null;
      setState("Platform is healthy.");
      await sleep(4000);
      continue;
    }

    if (child && child.exitCode === null) {
      const runtimeMs = Date.now() - childStartedAt;
      if (runtimeMs >= 60000) {
        log("Platform child stayed unhealthy for 60 seconds; forcing restart.");
        child.kill("SIGKILL");
        child = null;
      }
      await sleep(2000);
      continue;
    }

    if (child && child.exitCode !== null) child = null;
    if (await isPortOccupied()) {
      setState("Port 4173 is occupied but the health check failed; waiting before another start.");
      await sleep(5000);
      continue;
    }

    child = startServer();
    childStartedAt = Date.now();
    setState("Starting platform child.");
    await sleep(1500);
  }
}

main().catch(error => {
  log(`Supervisor fatal error: ${error.stack || error.message}`);
  releaseLock();
  process.exitCode = 1;
});
