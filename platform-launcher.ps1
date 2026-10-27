param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root "runtime\node.exe"
$healthUrl = "http://127.0.0.1:4173/health"
$taskName = "EmbodiedDataQualityPlatform"

function Clear-KnownPortConflict {
  $connections = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -match "outputs[\\/]video-viewer") {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
    }
  }
}

function Test-PlatformHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $healthUrl
    return $response.StatusCode -eq 200 -and $response.Content -match "embodied-data-quality"
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $runtime) -and -not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js 18+ is required. Install Node.js or provide runtime\node.exe"
}

Clear-KnownPortConflict

if (-not (Test-PlatformHealth)) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $service = Join-Path $root "platform-service.ps1"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if ($task) {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  } else {
    Start-Process $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$service) -WorkingDirectory $root
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-PlatformHealth) { break }
  }
  # A task can remain in Running state after its child process disappeared.
  # Start one foreground supervisor as a fallback; it exits immediately when
  # the task-managed service becomes healthy, so this does not create a second server.
  if (-not (Test-PlatformHealth)) {
    Start-Process $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$service) -WorkingDirectory $root
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      Start-Sleep -Seconds 1
      if (Test-PlatformHealth) { break }
    }
  }
}

if (-not (Test-PlatformHealth)) {
  $listeners = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
  if ($listeners.Count) {
    throw "Platform failed to become healthy: port 4173 is occupied by process $($listeners -join ', '). Check the process before stopping it."
  }
  throw "Platform failed to become healthy. Check the scheduled task history and work logs."
}

if ($OpenBrowser) {
  Start-Process "http://localhost:4173/"
}

Write-Output "Platform is ready at http://localhost:4173/"
