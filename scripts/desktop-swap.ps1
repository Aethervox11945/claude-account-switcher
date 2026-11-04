# Swaps the Claude desktop app's sign-in while the app is closed.
#
# The app keeps its sign-in in two places: three keys of config.json (the
# encrypted OAuth token caches and the account id) and the Chromium cookie
# store Network\Cookies, which the app holds locked while it runs. So this
# script closes the app, saves the current sign-in under its account id,
# puts the target's in place (or none, for "new"), and starts the app again.
#
# The account switcher mod launches it outside the app's process tree, so it
# outlives the app it closes. Everything it changes is backed up first and put
# back if any step fails.

param(
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [Parameter(Mandatory = $true)] [string] $StoreDir,
  [Parameter(Mandatory = $true)] [ValidateSet('switch', 'new')] [string] $Mode,
  [string] $To = '',
  [int] $DelayMs = 1500,
  [switch] $NoRelaunch,
  # Which running executables count as the app (a test points it elsewhere).
  [string[]] $AppPathLike = @('*\WindowsApps\Claude_*\app\Claude.exe', '*\AnthropicClaude\app-*\claude.exe')
)

$ErrorActionPreference = 'Stop'

$AuthKeys = @('oauth:tokenCache', 'oauth:tokenCacheV2', 'lastKnownAccountUuid')
$CookieNames = @('Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm')
$ConfigPath = Join-Path $DataDir 'config.json'
$NetworkDir = Join-Path $DataDir 'Network'
$Utf8 = New-Object System.Text.UTF8Encoding $false

New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
$LogPath = Join-Path $StoreDir 'swap.log'

function Write-Log([string] $Message) {
  $line = '{0} {1}' -f (Get-Date -Format o), $Message
  [IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $Utf8)
}

function Get-Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Write-JsonFile([string] $Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 100), $Utf8)
}

function Read-JsonFile([string] $Path) {
  [IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json
}

function Test-AccountId([string] $Id) {
  $Id -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

function Get-AppProcesses {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $path = $_.Path
      $path -and @($AppPathLike | Where-Object { $path -like $_ }).Count -gt 0
    })
}

function Wait-AppGone([int] $Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-AppProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  (Get-AppProcesses).Count -eq 0
}

# Closes the app, by its windows first, and answers the executable it ran
# from, or $null where it was not running.
function Stop-App {
  $running = Get-AppProcesses
  if ($running.Count -eq 0) { return $null }
  $exe = $running[0].Path
  foreach ($process in $running) {
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { [void] $process.CloseMainWindow() }
  }
  if (-not (Wait-AppGone 5)) {
    Write-Log 'the app kept running after its window closed; stopping it'
    Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not (Wait-AppGone 15)) { throw 'Claude did not exit' }
  }
  $exe
}

function Start-App([string] $Exe) {
  if ($Exe -like '*\WindowsApps\*') {
    $package = Get-AppxPackage -Name 'Claude' |
      Where-Object { $Exe.StartsWith($_.InstallLocation, [StringComparison]::OrdinalIgnoreCase) } |
      Select-Object -First 1
    $app = (Get-AppxPackageManifest $package).Package.Applications.Application |
      Where-Object { $_.Executable -like '*Claude.exe' } |
      Select-Object -First 1
    Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$($package.PackageFamilyName)!$($app.Id)"
    return
  }
  # A per-user install starts through its stub, which picks the newest app-*.
  $stub = Join-Path (Split-Path (Split-Path $Exe)) 'claude.exe'
  if (Test-Path -LiteralPath $stub) { Start-Process -FilePath $stub } else { Start-Process -FilePath $Exe }
}

function Wait-Unlocked([string] $Path, [int] $Seconds) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ($true) {
    try {
      $stream = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
      $stream.Close()
      return
    } catch {
      if ((Get-Date) -gt $deadline) { throw "still locked: $Path" }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Copy-Cookies([string] $From, [string] $Into) {
  New-Item -ItemType Directory -Force -Path $Into | Out-Null
  foreach ($name in $CookieNames) {
    Remove-Item -LiteralPath (Join-Path $Into $name) -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $CookieNames) {
    $source = Join-Path $From $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $Into $name) -Force }
  }
}

function Set-AuthKeys($Config, $Auth) {
  foreach ($key in $AuthKeys) {
    $Config.PSObject.Properties.Remove($key)
    if ($null -ne $Auth -and $Auth.PSObject.Properties[$key]) {
      $Config | Add-Member -NotePropertyName $key -NotePropertyValue $Auth.PSObject.Properties[$key].Value
    }
  }
  Write-JsonFile $ConfigPath $Config
}

function Save-Backup {
  $root = Join-Path $StoreDir 'backups'
  $dir = Join-Path $root (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $dir 'config.json')
  Copy-Cookies $NetworkDir $dir
  Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending |
    Select-Object -Skip 5 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $dir
}

function Restore-Backup([string] $Dir) {
  Copy-Item -LiteralPath (Join-Path $Dir 'config.json') -Destination $ConfigPath -Force
  Copy-Cookies $Dir $NetworkDir
}

# Saves the signed-in account's keys and cookies under its id; answers the id,
# or $null where the app holds no sign-in.
function Save-Current($Config) {
  $id = [string] $Config.lastKnownAccountUuid
  $hasTokens = $Config.PSObject.Properties['oauth:tokenCache'] -or $Config.PSObject.Properties['oauth:tokenCacheV2']
  if (-not $hasTokens -or -not (Test-AccountId $id)) {
    Write-Log 'no desktop sign-in to save'
    return $null
  }
  $dir = Join-Path $StoreDir "desktop\$id"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $auth = [ordered]@{ savedAt = Get-Now }
  foreach ($key in $AuthKeys) {
    if ($Config.PSObject.Properties[$key]) { $auth[$key] = $Config.PSObject.Properties[$key].Value }
  }
  Write-JsonFile (Join-Path $dir 'auth.json') $auth
  Copy-Cookies $NetworkDir $dir
  Write-Log "saved the desktop sign-in of $id"
  $id
}

function Write-Result([bool] $Ok, $From, $Problem) {
  Write-JsonFile (Join-Path $StoreDir 'last-swap.json') ([ordered]@{
      ok    = $Ok
      mode  = $Mode
      from  = $From
      to    = $To
      at    = Get-Now
      error = $Problem
    })
}

$exe = $null
$from = $null
try {
  Write-Log "start: mode=$Mode to=$To"
  if ($Mode -eq 'switch') {
    if (-not (Test-AccountId $To)) { throw "not an account id: $To" }
    if (-not (Test-Path -LiteralPath (Join-Path $StoreDir "desktop\$To\auth.json"))) {
      throw 'no saved desktop sign-in for that account'
    }
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "no desktop config at $ConfigPath" }

  # Let the mod's message reach the screen before the app goes away.
  Start-Sleep -Milliseconds $DelayMs
  $exe = Stop-App
  Wait-Unlocked (Join-Path $NetworkDir 'Cookies') 15
  Wait-Unlocked $ConfigPath 15

  $backup = Save-Backup
  try {
    $config = Read-JsonFile $ConfigPath
    $from = Save-Current $config
    if ($Mode -eq 'switch') {
      $targetDir = Join-Path $StoreDir "desktop\$To"
      Set-AuthKeys $config (Read-JsonFile (Join-Path $targetDir 'auth.json'))
      Copy-Cookies $targetDir $NetworkDir
    } else {
      Set-AuthKeys $config $null
      foreach ($name in $CookieNames) {
        Remove-Item -LiteralPath (Join-Path $NetworkDir $name) -Force -ErrorAction SilentlyContinue
      }
    }
    # The app must still be able to read what was written.
    [void] (Read-JsonFile $ConfigPath)
  } catch {
    Write-Log "rolling back: $_"
    Restore-Backup $backup
    throw
  }
  Write-Log "done: from=$from to=$To"
  Write-Result $true $from $null
} catch {
  Write-Log "failed: $_"
  Write-Result $false $from "$_"
} finally {
  if ($exe -and -not $NoRelaunch) {
    try { Start-App $exe } catch { Write-Log "could not start the app again: $_" }
  }
}
