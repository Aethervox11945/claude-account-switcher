# Runs the smoke tests, then builds dist\ClaudeAccountSwitcher.exe.

$ErrorActionPreference = 'Stop'

dotnet run --project "$PSScriptRoot\SmokeTests\SmokeTests.csproj"
if ($LASTEXITCODE -ne 0) { throw 'The smoke tests failed.' }

$dist = Join-Path (Split-Path $PSScriptRoot) 'dist'
dotnet publish "$PSScriptRoot\AccountSwitcher\AccountSwitcher.csproj" -c Release -o $dist
if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }

Get-Item (Join-Path $dist 'ClaudeAccountSwitcher.exe') | Select-Object FullName, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
