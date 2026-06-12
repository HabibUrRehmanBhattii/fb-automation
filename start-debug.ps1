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

Write-Host "Starting app (visible terminal)..."
$startCmd = "npm start"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c $startCmd" -WorkingDirectory $PSScriptRoot

exit 0
