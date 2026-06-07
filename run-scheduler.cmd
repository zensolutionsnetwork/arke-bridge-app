@echo off
REM Launcher for the Arke 24/7 scheduler daemon (Windows Task Scheduler runs this at logon).
REM Output is appended to a log the agent can read; the daemon itself ticks forever.
cd /d C:\Arke\bridge-app
npm run scheduler >> "C:\Arke\bridge-app\.sessions\scheduler.out.log" 2>&1
