@echo off
setlocal enabledelayedexpansion

REM Maximum restart attempts to prevent infinite loops
set MAX_RETRIES=5
set RETRY_COUNT=0

:start
set /a RETRY_COUNT+=1

REM Check if we've exceeded max retries
if %RETRY_COUNT% GTR %MAX_RETRIES% (
    echo Error: Scheduler crashed %MAX_RETRIES% times. Please check for errors.
    exit /b 1
)

REM Set restart flag for current process
set SCHEDULER_RESTARTED=true

REM Run node.js directly (inherits environment from parent)
node scheduler.js

REM Check exit code
if %ERRORLEVEL% EQU 0 (
    REM Clean exit
    exit /b 0
) else (
    REM Crash detected - restart after 2 seconds
    timeout /t 2 /nobreak
    goto start
)
