# Installs (or updates) the files-transfer mod into the Herdr app on Windows and points the
# Files panel of the layout on screen at it. The Windows twin of install.sh: Herdr's own
# layouts are read-only, so a shipped one is cloned first (as <layout>-files-transfer) and
# the window switches to the clone.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1     install, or update the mod's files
#
# Undo: switch back with ctrl-shift-l, then delete ~\.config\herdr-app\mods\files-transfer
# and the cloned layout file.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config\herdr-app' }
$mod = Join-Path $app 'mods\files-transfer'

if (-not (Get-Command herdr-app -ErrorAction SilentlyContinue)) {
  Write-Error 'herdr-app not found: install the Herdr desktop app and start it once.'; exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $app 'mods'))) {
  Write-Error "No Herdr app folder at ${app}: start Herdr once first."; exit 1
}

# herdr-app takes JSON arguments. Start-Process hands the command line over verbatim, so the
# quotes survive every PowerShell version (5.1 mangles them when calling a program directly).
function Invoke-HerdrApp {
  param([string[]]$Words)
  $q = [char]34
  $argv = $Words | ForEach-Object { $q + $_.Replace('"', '\"') + $q }
  $p = Start-Process -FilePath herdr-app -ArgumentList $argv -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

# 1. The mod. An update replaces its files; nothing else in the app folder is touched.
if (Test-Path -LiteralPath $mod) { Write-Host "Updating $mod"; Remove-Item -LiteralPath $mod -Recurse -Force }
else { Write-Host "Installing $mod" }
Copy-Item -LiteralPath (Join-Path $here 'mods\files-transfer') -Destination $mod -Recurse
if ((Invoke-HerdrApp @('check', $mod)) -ne 0) { exit 1 }

# 2. The layout on screen. Needs a running Herdr window.
$status = (& herdr-app status 2>$null) -join "`n"
$layout = if ($status -match '"layout":\s*"([^"]*)"') { $Matches[1] } else { '' }
if (-not $layout) {
  Write-Warning "Herdr isn't running: start it and run this again to switch the Files panel."; exit 0
}
if ($layout -in @('main', 'terminals', 'win98')) {
  $clone = "$layout-files-transfer"
  $cloneFile = Join-Path $app "layouts\$clone.json"
  if (-not (Test-Path -LiteralPath $cloneFile)) {
    [void](Invoke-HerdrApp @('do', 'layout.clone', ('{"name":"' + $layout + '","as":"' + $clone + '"}')))
    $i = 0; while (-not (Test-Path -LiteralPath $cloneFile) -and $i -lt 50) { Start-Sleep -Milliseconds 100; $i++ }
  } else {
    [void](Invoke-HerdrApp @('do', 'layout.switch', ('{"name":"' + $clone + '"}')))
  }
  $layout = $clone
}
$file = Join-Path $app "layouts\$layout.json"
$text = Get-Content -LiteralPath $file -Raw

if ($text -match '"mod":\s*"files-transfer"') {
  Write-Host "Layout $layout already uses files-transfer."
} elseif ($text -match '"mod":\s*"(files|file-icons)"') {
  $text = $text -replace '"mod":\s*"(files|file-icons)"', '"mod": "files-transfer"'
  [IO.File]::WriteAllText($file, $text)
  Write-Host "Layout ${layout}: the Files panel now uses files-transfer."
} else {
  Write-Warning "Layout $layout has no Files panel. Add a block with ""content"": { ""mod"": ""files-transfer"" } where you want it."
}
Write-Host 'Done. Right-click a file or folder in Files.'
