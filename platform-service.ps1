$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $root "work"
$node = Join-Path $root "runtime\node.exe"
$server = Join-Path $root "serve.js"
$stdout = Join-Path $work "service.log"
$stderr = Join-Path $work "service.err.log"
$healthUrl = "http://127.0.0.1:4173/health"

New-Item -ItemType Directory -Force -Path $work | Out-Null

if (-not (Test-Path -LiteralPath $node)) {
  "$(Get-Date -Format s) Missing runtime: $node" | Out-File $stderr -Append -Encoding utf8
  exit 2
}

if (-not (Test-Path -LiteralPath $server)) {
  "$(Get-Date -Format s) Missing server: $server" | Out-File $stderr -Append -Encoding utf8
  exit 3
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
if (Test-PlatformHealth) { exit 0 }
$listeners = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count) {
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -match "serve\.js") {
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-PlatformHealth) { exit 0 }
      }
    }
  }
  "$(Get-Date -Format s) Port 4173 is occupied and the owner is not healthy: $($listeners.OwningProcess -join ', ')" | Out-File $stderr -Append -Encoding utf8
  exit 11
}

& $node $server 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
