<#
Builds and (re)starts every worker on a Windows machine running Docker Desktop: worker-media
(FFmpeg renders) and worker-io (Drive imports, ZIP downloads, outbox). The Windows version of
deploy-worker-host.sh, with the same steps and checks: read its header for what a worker host
is, and why it must run the main host's commit.

First time on a new machine (Docker Desktop with the WSL 2 backend, Git for Windows):
  git clone <repo>; cd ag-go-api
  copy .env.example .env   # copy the main host's values (R2, Google, QUEUE_PREFIX...), but
                           # point DATABASE_URL and REDIS_URL at its private IP, not localhost
  Docker Desktop > Settings > General: tick "Start Docker Desktop when you sign in". The
  workers only come back after a reboot (Windows Update...) once Docker Desktop runs, which
  needs a signed-in user. Check System > Workers after a reboot.
  WORKER_MEDIA_MEMORY_LIMIT + WORKER_IO_MEMORY_LIMIT must fit in the memory Docker Desktop
  gets (by default half of the RAM; raise it with memory= in %UserProfile%\.wslconfig).

# Every deploy, in PowerShell (no admin needed), on the commit the main host runs:
#   git fetch origin; git checkout --detach <commit>; if ($?) { powershell -ExecutionPolicy Bypass -File .\deploy-worker-host.ps1 }
Keep the window open and the machine awake until it ends: the old workers finish their
running jobs first (up to WORKER_STOP_GRACE_PERIOD), and the machine has no workers if the
script is cut off meanwhile.

This file stays ASCII: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
#>
param(
  # Image tag; defaults to the checked-out commit, like the main host's deploy.
  [string]$Tag = '',
  [int]$StartupCheckSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$Workers = @('worker-media', 'worker-io')
$Image = 'ag-go-api'

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message"
}

function Stop-Deploy([string]$Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

# Runs a native command with its output on the console; stops the deploy when it fails.
# Docker writes its progress to stderr, which must not count as a PowerShell error.
function Invoke-Checked([string]$What, [scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) {
    Stop-Deploy "$What failed (exit code $LASTEXITCODE)."
  }
}

# Non-empty stdout lines of a native command (stderr dropped), or nothing when it fails.
function Get-NativeOutput([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command 2>$null
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) {
    return
  }
  $output | ForEach-Object { "$_".Trim() } | Where-Object { $_ }
}

function Test-EnvSet([string]$Name) {
  [bool](Get-Content -LiteralPath .env | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=" })
}

# Value of $Name in .env (last assignment wins; quotes, inline comments and trailing blanks
# dropped), or $Default when unset.
function Get-EnvValue([string]$Name, [string]$Default = '') {
  $line = Get-Content -LiteralPath .env |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=" } |
    Select-Object -Last 1
  if (-not $line) {
    return $Default
  }
  $value = ($line -split '=', 2)[1]
  if ($value -notmatch '^\s*["'']') {
    $value = $value -replace '\s#.*$', ''
  }
  $value = $value.Trim().Trim('"').Trim("'")
  if ($value) { $value } else { $Default }
}

# Host part of a postgres:// or redis:// URL.
function Get-UrlHost([string]$Url) {
  $Url -replace '^[^:]+://', '' -replace '^[^/]*@', '' -replace '[:/?].*$', ''
}

# This machine's IP on the route to $Target (an IP or a name), else the IP of its adapter with
# the default gateway. A container only sees its Docker network address, so this is passed in.
function Get-HostIp([string]$Target) {
  $ip = $null
  try {
    $address = [System.Net.Dns]::GetHostAddresses($Target) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
      Select-Object -First 1
    if ($address -and -not [System.Net.IPAddress]::IsLoopback($address)) {
      $ip = Find-NetRoute -RemoteIPAddress $address.IPAddressToString |
        Where-Object { $_.IPAddress } |
        Select-Object -First 1 -ExpandProperty IPAddress
    }
  } catch {
    $ip = $null
  }
  if (-not $ip) {
    try {
      $ip = Get-NetIPConfiguration |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        ForEach-Object { $_.IPv4Address.IPAddress } |
        Select-Object -First 1
    } catch {
      $ip = $null
    }
  }
  "$ip"
}

# Sets a variable docker compose reads, or clears it so the value in .env applies: one left
# in this PowerShell session by an earlier run would win over .env.
function Set-ComposeVariable([string]$Name, [string]$Value) {
  if ($Value) {
    Set-Item -Path "Env:$Name" -Value $Value
  } else {
    Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
  }
}

function Get-ServiceContainer([string]$Service) {
  Get-NativeOutput { docker compose ps -a -q $Service } | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath .env)) {
  Stop-Deploy 'Missing .env (copy .env.example and fill it in first).'
}
if (-not (Get-NativeOutput { docker info --format '{{.ServerVersion}}' })) {
  Stop-Deploy 'The Docker daemon is not reachable: start Docker Desktop and wait until it is running.'
}

# One deploy at a time: a second run would remove the first one's new containers as leftovers.
$lock = New-Object System.Threading.Mutex($false, 'Global\ag-go-deploy-worker-host')
try {
  $locked = $lock.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # A deploy that died holding the lock: it is ours now.
  $locked = $true
}
if (-not $locked) {
  Stop-Deploy 'Another deploy-worker-host.ps1 is running on this machine.'
}

$replacing = $false
try {
  if (Get-ServiceContainer 'api') {
    Stop-Deploy 'An api container exists on this machine, so it looks like the main host: deploy that with ./deploy.sh (it also runs the migrations).'
  }

  # Same tag scheme as the main host's deploy: the commit being deployed.
  if (-not $Tag) {
    $Tag = Get-NativeOutput { git rev-parse --short HEAD } | Select-Object -First 1
    if (-not $Tag) {
      Stop-Deploy "Cannot read the checked-out commit for the image tag. Run: git config --global --add safe.directory '$($PWD.Path -replace '\\', '/')' (or pass -Tag <commit>)."
    }
  }
  Set-ComposeVariable 'TAG' $Tag

  # Shown on System > Workers: the commit the image is built from (workers on another commit
  # than the api are flagged there), this machine's name and IP (WORKER_HOSTNAME and
  # WORKER_HOST_IP in .env win).
  $gitCommit = Get-NativeOutput { git rev-parse HEAD } | Select-Object -First 1
  if (-not $gitCommit) {
    Write-Host 'Warning: cannot read the checked-out commit; System > Workers will show it as unknown.' -ForegroundColor Yellow
  }
  Set-ComposeVariable 'GIT_COMMIT' $gitCommit
  $hostName = if (Test-EnvSet 'WORKER_HOSTNAME') { '' } else { $env:COMPUTERNAME }
  Set-ComposeVariable 'WORKER_HOSTNAME' $hostName
  $hostIp = if (Test-EnvSet 'WORKER_HOST_IP') { '' } else { Get-HostIp (Get-UrlHost (Get-EnvValue 'REDIS_URL')) }
  Set-ComposeVariable 'WORKER_HOST_IP' $hostIp
  $shownCommit = if ($gitCommit) { $gitCommit.Substring(0, 7) } else { 'unknown' }
  $shownIp = Get-EnvValue 'WORKER_HOST_IP' $hostIp
  if (-not $shownIp) {
    $shownIp = 'IP unknown'
  }
  Write-Host "System > Workers will show: $(Get-EnvValue 'WORKER_HOSTNAME' $hostName) ($shownIp), commit $shownCommit"

  Write-Step 'Checking .env'
  # A .env copied from the main host as is points at its own localhost, which is nothing here
  # (and host.docker.internal is this Windows machine).
  foreach ($name in 'DATABASE_URL', 'REDIS_URL') {
    $url = Get-EnvValue $name
    if (-not $url) {
      Stop-Deploy "$name is not set in .env."
    }
    $urlHost = Get-UrlHost $url
    if (-not $urlHost -or $urlHost -eq 'localhost' -or $urlHost -like '127.*' -or $urlHost -eq '0.0.0.0' -or $urlHost -eq 'host.docker.internal') {
      Stop-Deploy "$name points at '$urlHost', which is not the main host from here. Use the main host's private IP (WireGuard, Tailscale or the provider's private network)."
    }
    Write-Host "$name -> $urlHost"
  }
  if ((Get-EnvValue 'MEDIA_WORKER_ENABLED') -ne 'true') {
    Stop-Deploy 'MEDIA_WORKER_ENABLED must be true in .env, or worker-media starts but never takes a render job.'
  }

  # The CPUs Docker Desktop gets, which is what the containers can use.
  $hostCpus = [double](Get-NativeOutput { docker info --format '{{.NCPU}}' } | Select-Object -First 1)
  $mediaCpus = [double](Get-EnvValue 'WORKER_MEDIA_CPUS' '2')
  $ioCpus = [double](Get-EnvValue 'WORKER_IO_CPUS' '1')
  Write-Host "Docker CPUs: $hostCpus | WORKER_MEDIA_CPUS=$mediaCpus + WORKER_IO_CPUS=$ioCpus | MEDIA_WORKER_CONCURRENCY=$(Get-EnvValue 'MEDIA_WORKER_CONCURRENCY' '?') x MEDIA_FFMPEG_THREADS=$(Get-EnvValue 'MEDIA_FFMPEG_THREADS' '2')"
  if ($mediaCpus -gt $hostCpus -or $ioCpus -gt $hostCpus) {
    Stop-Deploy "WORKER_MEDIA_CPUS=$mediaCpus / WORKER_IO_CPUS=$ioCpus cannot be more than the $hostCpus CPUs Docker Desktop has."
  }
  # worker-io is mostly network-bound; one CPU stays free for Windows and for image builds.
  $mediaRoom = [Math]::Max(1, $hostCpus - 1 - $ioCpus)
  if ($mediaCpus -lt $mediaRoom) {
    Write-Host "Note: WORKER_MEDIA_CPUS can go up to $mediaRoom if this machine only runs workers (keep MEDIA_WORKER_CONCURRENCY x MEDIA_FFMPEG_THREADS about equal to it)."
  }

  # An interrupted recreate leaves new containers named "<old id>_<name>" that were never
  # started. Compose would count them as extra replicas, so drop them before deploying.
  Write-Step 'Removing containers left over from an interrupted deploy'
  $leftovers = @(Get-NativeOutput { docker compose ps -a --format '{{.Name}}' } | Where-Object { $_ -match '^[0-9a-f]{12}_' })
  if ($leftovers.Count -gt 0) {
    $leftovers | ForEach-Object { Write-Host $_ }
    Invoke-Checked 'Removing leftover containers' { docker rm -f $leftovers }
  } else {
    Write-Host 'None'
  }

  # Built through the api service, the only one with a build section; api is not started here.
  Write-Step "Building image ${Image}:$Tag"
  Invoke-Checked 'The image build' { docker compose build api }

  # Read-only checks with the app code in the new image (src/workers/worker-host-preflight.ts):
  # Postgres, Redis, clock, migrations, and that QUEUE_PREFIX, R2 and the Google token key are
  # the main host's. A wrong value there would do damage, not just fail.
  Write-Step 'Checking the new image against the main host'
  Invoke-Checked 'The preflight check' { docker compose run --rm --no-deps -T $Workers[0] node dist/workers/worker-host-preflight.js }

  # The image the workers run now: kept for the rollback hint and by the image cleanup below.
  $previousImage = ''
  foreach ($service in $Workers) {
    $previousContainer = Get-ServiceContainer $service
    if ($previousContainer) {
      $previousImage = Get-NativeOutput { docker inspect -f '{{.Config.Image}}' $previousContainer } | Select-Object -First 1
      if ($previousImage) {
        break
      }
    }
  }

  # An `up` cut off midway (Ctrl-C, closed window) can leave the old workers stopped and the
  # new ones not started yet: the finally block below says so.
  Write-Step "Replacing $($Workers -join ' ') (old workers finish their running jobs first, this can take a while)"
  $replacing = $true
  Invoke-Checked 'Replacing the workers' { docker compose up -d --no-deps $Workers }
  $replacing = $false

  Write-Step "Checking the workers stay up (${StartupCheckSeconds}s)"
  Start-Sleep -Seconds $StartupCheckSeconds
  $unhealthy = $false
  foreach ($service in $Workers) {
    $container = Get-ServiceContainer $service
    $state = if ($container) { Get-NativeOutput { docker inspect -f '{{.State.Status}} {{.RestartCount}}' $container } | Select-Object -First 1 }
    if (-not $state) {
      $state = 'missing 0'
    }
    if ($state -ne 'running 0') {
      Write-Host "$service is not running cleanly (status, restarts: $state). Recent logs:" -ForegroundColor Red
      docker compose logs --tail 50 $service
      $unhealthy = $true
    }
  }
  if ($unhealthy) {
    # Stopping is always safe: the main host keeps processing. Rolling back is only safe to the
    # commit the main host runs; an older worker next to newer ones can process jobs twice.
    Write-Host "Stop the workers of this machine (the main host keeps working): docker compose stop $($Workers -join ' ')" -ForegroundColor Yellow
    if ($previousImage -and $previousImage -ne "${Image}:$Tag") {
      Write-Host "Or, only if the main host runs that commit, roll back: `$env:TAG='$($previousImage -replace "^${Image}:", '')'; docker compose up -d --no-deps $($Workers -join ' ')" -ForegroundColor Yellow
    }
    exit 1
  }

  # Every deploy leaves an image per commit; keep this one and the previous one (rollback).
  Write-Step 'Removing older worker images'
  foreach ($existing in @(Get-NativeOutput { docker image ls $Image --format '{{.Repository}}:{{.Tag}}' })) {
    if ($existing -ne "${Image}:$Tag" -and $existing -ne $previousImage) {
      Get-NativeOutput { docker image rm $existing } | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Removed $existing"
      }
    }
  }
  Get-NativeOutput { docker image prune -f } | Out-Null

  Write-Step 'Workers deployed'
  docker compose ps $Workers
  docker compose logs --tail 20 $Workers
} finally {
  if ($replacing) {
    Write-Host 'Workers may be stopped now: rerun this script to start them.' -ForegroundColor Red
  }
  if ($locked) {
    $lock.ReleaseMutex()
  }
}
