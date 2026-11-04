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
# back if any step fails. One switch runs at a time: a second one started while
# the first holds swap.lock does nothing and exits with code 3.

param(
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [Parameter(Mandatory = $true)] [string] $StoreDir,
  [Parameter(Mandatory = $true)] [ValidateSet('switch', 'new')] [string] $Mode,
  [string] $To = '',
  [int] $DelayMs = 1500,
  [switch] $NoRelaunch,
  # Also copies Code tab chats into the target account (see Sync-Chats).
  [switch] $SyncChats,
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

function Get-Stamp { Get-Date -Format 'yyyyMMdd-HHmmss-fff' }

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

# The executable the app runs from, or $null where it is not running.
function Get-AppExe {
  $running = Get-AppProcesses
  if ($running.Count -eq 0) { return $null }
  $running[0].Path
}

# Closes the app, by its windows first.
function Stop-App {
  $running = Get-AppProcesses
  if ($running.Count -eq 0) { return }
  foreach ($process in $running) {
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { [void] $process.CloseMainWindow() }
  }
  if (-not (Wait-AppGone 5)) {
    Write-Log 'the app kept running after its window closed; stopping it'
    Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not (Wait-AppGone 15)) { throw 'Claude did not exit' }
  }
}

function Start-App([string] $Exe) {
  if ($Exe -like '*\WindowsApps\*') {
    $packages = @(Get-AppxPackage -Name 'Claude')
    $package = $packages |
      Where-Object { $Exe.StartsWith($_.InstallLocation, [StringComparison]::OrdinalIgnoreCase) } |
      Select-Object -First 1
    # An update may have replaced the version it ran from while it was closed.
    if ($null -eq $package) { $package = $packages | Sort-Object { [version] $_.Version } -Descending | Select-Object -First 1 }
    if ($null -eq $package) { throw 'the Claude app package is no longer installed' }
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
  $dir = Join-Path $root (Get-Stamp)
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
# or $null where the app holds no sign-in. A sign-in whose account can't be told
# could not be saved, so the switch stops rather than drop it.
function Save-Current($Config) {
  $id = [string] $Config.lastKnownAccountUuid
  $hasTokens = $Config.PSObject.Properties['oauth:tokenCache'] -or $Config.PSObject.Properties['oauth:tokenCacheV2']
  if (-not $hasTokens) {
    Write-Log 'no desktop sign-in to save'
    return $null
  }
  if (-not (Test-AccountId $id)) {
    throw 'the app is signed in, but its config.json names no account for that sign-in, so it could not be saved and nothing was changed'
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

# The app lists Code tab chats per account, from one small record each under
# claude-code-sessions\<account>\<org>. A record points at its transcript in
# the CLI's projects folder, which no account owns, so copying the record is
# all it takes for a chat to show up under another account. Copies only: the
# newest copy of a record wins, and one it replaces is backed up first.
#
# A record carries what its chat saw in its organization (its MCP servers, its
# prompt), which is why this runs only when asked. chats-copied.json lists what
# was copied into each folder, so a chat deleted there is not copied back.
# Answers how many chats came across, each counted once.
function Sync-Chats([string] $Id) {
  $root = Join-Path $DataDir 'claude-code-sessions'
  $account = Join-Path $root $Id
  if (-not (Test-Path -LiteralPath $account)) {
    Write-Log 'chats: the target account has no folder yet; it gets them on a later switch'
    return 0
  }
  $targets = @(Get-ChildItem -LiteralPath $account -Directory)
  $newest = @{}
  foreach ($from in Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -ne $Id }) {
    foreach ($record in Get-ChildItem -LiteralPath $from.FullName -Directory | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter 'local_*.json' -File }) {
      $known = $newest[$record.Name]
      if ($null -eq $known -or $record.LastWriteTimeUtc -gt $known.LastWriteTimeUtc) { $newest[$record.Name] = $record }
    }
  }
  $manifestPath = Join-Path $StoreDir 'chats-copied.json'
  $manifest = @{}
  if (Test-Path -LiteralPath $manifestPath) {
    foreach ($entry in (Read-JsonFile $manifestPath).PSObject.Properties) { $manifest[$entry.Name] = @($entry.Value) }
  }
  $backups = Join-Path $StoreDir 'chat-backups'
  $backup = Join-Path $backups (Get-Stamp)
  $came = @{}
  foreach ($target in $targets) {
    $key = "$Id\$($target.Name)"
    $copiedHere = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($name in @($manifest[$key])) { if ($name) { [void] $copiedHere.Add([string] $name) } }
    foreach ($record in $newest.Values) {
      $path = Join-Path $target.FullName $record.Name
      $exists = Test-Path -LiteralPath $path
      if (-not $exists -and $copiedHere.Contains($record.Name)) { continue }
      if ($exists -and (Get-Item -LiteralPath $path).LastWriteTimeUtc -ge $record.LastWriteTimeUtc) { continue }
      if ($exists) {
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        Copy-Item -LiteralPath $path -Destination (Join-Path $backup "$($target.Name)-$($record.Name)") -Force
      }
      Copy-Item -LiteralPath $record.FullName -Destination $path -Force
      [void] $copiedHere.Add($record.Name)
      $came[$record.Name] = $true
    }
    $manifest[$key] = @($copiedHere)
  }
  Write-JsonFile $manifestPath $manifest
  if (Test-Path -LiteralPath $backups) {
    Get-ChildItem -LiteralPath $backups -Directory | Sort-Object Name -Descending |
      Select-Object -Skip 5 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Log "chats: $($came.Count) came across into $Id ($($targets.Count) organization folders)"
  $came.Count
}

function Write-Result([bool] $Ok, $From, $Problem) {
  Write-JsonFile (Join-Path $StoreDir 'last-swap.json') ([ordered]@{
      ok    = $Ok
      mode  = $Mode
      from  = $From
      to    = $To
      at    = Get-Now
      error = $Problem
      chats = $ChatsCopied
    })
}

$exe = $null
$from = $null
$ChatsCopied = 0
$lock = $null
try {
  $lock = [IO.File]::Open((Join-Path $StoreDir 'swap.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Log "another switch is under way; this one (mode=$Mode to=$To) did nothing"
  exit 3
}
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
  # Known before closing, so the app starts again whatever fails after this.
  $exe = Get-AppExe
  Stop-App
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
    # The app must still be able to read what was written, and find the
    # account it was switched to (or none, for "new").
    $written = Read-JsonFile $ConfigPath
    $writtenId = [string] $written.lastKnownAccountUuid
    if ($Mode -eq 'switch' -and $writtenId -ne $To) { throw "config.json names $writtenId after the switch, not $To" }
    if ($Mode -eq 'new' -and @($AuthKeys | Where-Object { $written.PSObject.Properties[$_] }).Count -gt 0) {
      throw 'config.json still holds a sign-in after signing out'
    }
  } catch {
    Write-Log "rolling back: $_"
    Restore-Backup $backup
    throw
  }
  # The sign-in is already in place: a problem here must not undo the switch.
  if ($SyncChats -and $Mode -eq 'switch') {
    try { $ChatsCopied = Sync-Chats $To } catch { Write-Log "chats: not copied: $_" }
  }
  Write-Log "done: from=$from to=$To"
  Write-Result $true $from $null
  $exitCode = 0
} catch {
  Write-Log "failed: $_"
  Write-Result $false $from "$_"
  $exitCode = 1
} finally {
  if ($exe -and -not $NoRelaunch) {
    try { Start-App $exe } catch { Write-Log "could not start the app again: $_" }
  }
  if ($lock) { $lock.Dispose() }
}
exit $exitCode
