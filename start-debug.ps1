# start-debug.ps1
# Clean visible rollback launcher.
# Bot Chrome VISIBLE, terminal VISIBLE. No dialog.

Write-Host "=== Marketplace Automation (Visible Rollback) ===" -ForegroundColor Cyan
Write-Host "Bot Chrome: VISIBLE"
Write-Host "Terminal: VISIBLE"
Write-Host "Log into FB only in the bot Chrome."

$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$debugPort = 9222
$userDataDir = "C:\chrome-automation-profile"

Write-Host "Cleaning up previous zombie processes to release file locks..." -ForegroundColor Yellow
# Kill previous Chrome bot instances
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.CommandLine -and ($_.CommandLine -like "*chrome-automation-profile*" -or $_.CommandLine -like "*remote-debugging-port=9222*")) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Kill previous Electron instances
Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Get-Process "FB Marketplace Automation" -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

if (Test-Path $chromePath) {
    Write-Host "Launching VISIBLE bot Chrome..."
    $chromeArgs = @(
        "--remote-debugging-port=$debugPort",
        "--user-data-dir=`"$userDataDir`"",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized"
    )
    Start-Process -FilePath $chromePath -ArgumentList $chromeArgs
    Start-Sleep -Seconds 2
}

Write-Host "Starting app (hidden terminal)..."
$env:ELECTRON_RUN_AS_NODE = $null
$startCmd = "npm.cmd start"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c $startCmd" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden

exit 0
