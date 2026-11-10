$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $root "work"
$bundledNode = Join-Path $root "runtime\node.exe"
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
$server = Join-Path $root "serve.js"
$stdout = Join-Path $work "service.log"
$stderr = Join-Path $work "service.err.log"
$supervisorLog = Join-Path $work "supervisor.log"
$healthUrl = "http://127.0.0.1:4173/health"

New-Item -ItemType Directory -Force -Path $work | Out-Null

function Write-SupervisorLog($message) {
  try { "$(Get-Date -Format s) $message" | Out-File $supervisorLog -Append -Encoding utf8 } catch {}
}

if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  Write-SupervisorLog "Node.js runtime is missing. Install Node.js 22.13+ or provide runtime\node.exe"
  exit 2
}

if (-not (Test-Path -LiteralPath $server)) {
  Write-SupervisorLog "Missing server: $server"
  exit 3
}

$runtimeVersion = & $node -p "Number(process.versions.node.split('.')[0]) >= 22 && !!require('node:sqlite').DatabaseSync" 2>$null
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne "true") {
  Write-SupervisorLog "SQLite requires Node.js 22.13+; use a supported runtime."
  exit 4
}

function Test-PlatformHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $healthUrl
    return $response.StatusCode -eq 200 -and $response.Content -match "embodied-data-quality"
  } catch {
    return $false
  }
}

# The logon/daily task may run while the platform is already healthy. Reusing
# that process avoids a false task failure caused by a second bind to port 4173.
# If the child exits later, keep the supervisor alive and restart it with a
# bounded backoff instead of waiting for the next logon or daily trigger.
$restartDelay = 2
$child = $null
$unhealthyTicks = 0
while ($true) {
  if (Test-PlatformHealth) {
    $restartDelay = 2
    $unhealthyTicks = 0
    Start-Sleep -Seconds 5
    continue
  }

  if ($child -and -not $child.HasExited) {
    $unhealthyTicks++
    if ($unhealthyTicks -lt 30) { Start-Sleep -Seconds 2; continue }
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog "Platform child stayed unhealthy; forcing restart."
    $unhealthyTicks = 0
  }

  try {
    $child = Start-Process -FilePath $node -ArgumentList $server -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Write-SupervisorLog "Platform child started with PID $($child.Id)."
    $unhealthyTicks = 0
    Start-Sleep -Seconds 2
  } catch {
    Write-SupervisorLog "Failed to start platform child: $($_.Exception.Message)"
    Start-Sleep -Seconds $restartDelay
    $restartDelay = [Math]::Min(30, $restartDelay + 2)
  }
}
