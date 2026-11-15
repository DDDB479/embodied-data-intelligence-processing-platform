[CmdletBinding()]
param(
  [switch]$SkipDependencies,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $root "work"
$healthUrl = "http://127.0.0.1:4173/health"

function Write-Step([string]$message) {
  Write-Host "`n==> $message" -ForegroundColor Cyan
}

function Fail([string]$message) {
  Write-Host "`nUpdate stopped: $message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  Fail "Git is not installed or is not available in PATH."
}

Push-Location $root
try {
  $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    Fail "The repository must be on branch main. Current branch: $branch"
  }

  $dirty = @(& git status --porcelain)
  if ($LASTEXITCODE -ne 0) { Fail "Unable to read git status." }
  if ($dirty.Count -gt 0) {
    $dirty | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
    Fail "The working tree has local source changes. Commit or stash them before updating."
  }

  $before = (& git rev-parse --short HEAD).Trim()
  Write-Step "Updating from $before"

  $node = Join-Path $root "runtime\node.exe"
  if (-not (Test-Path -LiteralPath $node)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { Fail "Node.js 22.13+ is required." }
    $node = $nodeCommand.Source
  }

  $database = Join-Path $work "platform.sqlite"
  if (Test-Path -LiteralPath $database) {
    $backupDir = Join-Path $work "backups"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backup = Join-Path $backupDir ("before-update-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".sqlite")
    Write-Step "Creating a consistent database backup"
    & $node (Join-Path $root 'tools\create-db-backup.js') $database $backup
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backup)) { Fail "Database backup failed. No source files were changed." }
    Write-Host "Database backup: $backup"
  }

  Write-Step "Fetching origin/main"
  & git fetch origin main
  if ($LASTEXITCODE -ne 0) { Fail "git fetch failed. Check network and GitHub access." }

  Write-Step "Applying fast-forward update"
  & git merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { Fail "Fast-forward merge failed. No local commits were discarded." }

  $after = (& git rev-parse --short HEAD).Trim()
  Write-Host "Updated source: $before -> $after"

  if (-not $SkipDependencies) {
    $python = Join-Path $root "runtime\python\Scripts\python.exe"
    if (Test-Path -LiteralPath $python) {
      Write-Step "Updating Python delivery dependencies"
      & $python -m pip install -r (Join-Path $root "tools\requirements-delivery.txt")
      if ($LASTEXITCODE -ne 0) { Fail "Python dependency installation failed." }
    }

    $uv = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($uv) {
      Write-Step "Synchronizing the official LeRobot runtime"
      $previousEnvironment = $env:UV_PROJECT_ENVIRONMENT
      try {
        $env:UV_PROJECT_ENVIRONMENT = Join-Path $root "runtime\lerobot"
        Push-Location (Join-Path $root "tools\lerobot-runtime")
        try {
          & $uv.Source sync --locked
          if ($LASTEXITCODE -ne 0) { Fail "Official LeRobot dependency synchronization failed." }
        } finally { Pop-Location }
      } finally {
        $env:UV_PROJECT_ENVIRONMENT = $previousEnvironment
      }
    } else {
      Write-Warning "uv was not found. Existing LeRobot runtime was preserved; install uv to refresh it automatically."
    }
  }

  if (-not $NoRestart) {
    Write-Step "Restarting the platform"
    $listeners = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
      if ($process -and $process.CommandLine -like "*$root\serve.js*") {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }

    Start-Sleep -Seconds 3
    $healthy = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $healthUrl
        if ($response.StatusCode -eq 200 -and $response.Content -match "embodied-data-quality") { $healthy = $true; break }
      } catch {}
      if ($attempt -eq 8 -or $attempt -eq 20) {
        $launcher = Join-Path $root "platform-launcher.ps1"
        if (Test-Path -LiteralPath $launcher) {
          $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
          Start-Process $powershell -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher) -WorkingDirectory $root
        }
      }
      Start-Sleep -Seconds 1
    }
    if (-not $healthy) { Fail "Source update completed, but the platform did not become healthy. Check work\service.err.log." }
    $health = Invoke-RestMethod -TimeoutSec 5 $healthUrl
    Write-Host "Platform ready: version $($health.version) at http://localhost:4173/" -ForegroundColor Green
  }
} finally {
  Pop-Location
}
