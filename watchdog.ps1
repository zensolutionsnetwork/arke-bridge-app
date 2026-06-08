# Watchdog — revives the Arke daemon if its heartbeat goes stale (silent hang or death).
# Registered as a scheduled task that runs every few minutes.
$hb = 'C:\Arke\bridge-app\.sessions\daemon.heartbeat'
$stale = $true
if (Test-Path $hb) {
  $age = (New-TimeSpan -Start (Get-Item $hb).LastWriteTimeUtc -End ([DateTime]::UtcNow)).TotalSeconds
  if ($age -lt 180) { $stale = $false }
}
if ($stale) {
  "$([DateTime]::UtcNow.ToString('o')) watchdog: heartbeat stale -> restarting ArkeScheduler" |
    Out-File -Append -Encoding utf8 'C:\Arke\bridge-app\.sessions\watchdog.log'
  Stop-ScheduledTask -TaskName 'ArkeScheduler' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName 'ArkeScheduler'
}
