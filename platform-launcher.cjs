const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = __dirname;
const workDir = path.join(root, "work");
const serviceFile = path.join(root, "platform-service.cjs");
const launcherLog = path.join(workDir, "launcher.log");
const lockOwnerFile = path.join(workDir, "platform-service.lock", "owner.json");
const healthUrl = "http://localhost:4173/health";
const openBrowser = process.argv.includes("--open-browser");

fs.mkdirSync(workDir, { recursive: true });

function log(message) {
  try {
    fs.appendFileSync(launcherLog, `${new Date().toISOString()} ${message}\r\n`, "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function supervisorRunning() {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerFile, "utf8"));
    process.kill(Number(owner.pid), 0);
    return true;
  } catch {
    return false;
  }
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

function startSupervisor() {
  const child = spawn(process.execPath, [serviceFile], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  log(`Requested Node supervisor start with PID ${child.pid}.`);
}

function launchBrowser() {
  const child = spawn("explorer.exe", ["http://localhost:4173/"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function main() {
  if (!fs.existsSync(serviceFile)) throw new Error(`Missing supervisor: ${serviceFile}`);

  if (!supervisorRunning()) startSupervisor();

  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    healthy = await healthCheck();
    if (healthy) break;
    await sleep(500);
  }

  if (!healthy) {
    log("Platform did not become healthy within 30 seconds.");
    process.exitCode = 1;
    return;
  }

  log("Platform is healthy.");
  if (openBrowser) launchBrowser();
}

main().catch(error => {
  log(`Launcher failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
