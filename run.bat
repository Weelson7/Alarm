@echo off
setlocal enabledelayedexpansion

REM Always run from the script's directory to avoid starting in System32 or elsewhere
pushd "%~dp0"

REM Maximum restart attempts to prevent infinite loops
set MAX_RETRIES=5
set RETRY_COUNT=0
set "STOP_FILE=%~dp0stop.flag"

:start
set /a RETRY_COUNT+=1

REM Clear any previous graceful-stop marker so unexpected exits restart
if exist "%STOP_FILE%" del /q "%STOP_FILE%"

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
if exist "%STOP_FILE%" (
    REM Graceful shutdown requested by scheduler
    del /q "%STOP_FILE%"
    exit /b 0
)

REM If scheduler exited cleanly without stop marker, treat as crash
if %ERRORLEVEL% NEQ 0 (
    REM Crash detected - restart after 2 seconds
    timeout /t 2 /nobreak
    goto start
)

REM Unexpected clean exit without stop marker - restart
timeout /t 2 /nobreak
goto start
