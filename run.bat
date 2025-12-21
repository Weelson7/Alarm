@echo off
setlocal enabledelayedexpansion

REM Always run from the script's directory to avoid starting in System32 or elsewhere
pushd "%~dp0"

REM Track restart counter with expiration
REM Counter is reset if the scheduler has been running successfully for more than 5 minutes
set MAX_RETRIES=5
set RETRY_COUNT=0
set "STOP_FILE=%~dp0stop.flag"
set LAST_START_SECONDS=0

:start
REM FIX: Strip leading spaces from all time components and calculate current time in seconds
set "CURRENT_HOUR=%TIME:~0,2%"
set "CURRENT_HOUR=%CURRENT_HOUR: =0%"
set "CURRENT_MIN=%TIME:~3,2%"
set "CURRENT_MIN=%CURRENT_MIN: =0%"
set "CURRENT_SEC=%TIME:~6,2%"
set "CURRENT_SEC=%CURRENT_SEC: =0%"
REM Ensure variables are treated as numbers by forcing numeric context
set /a CURRENT_SECONDS=(%CURRENT_HOUR%+0)*3600 + (%CURRENT_MIN%+0)*60 + (%CURRENT_SEC%+0)

REM FIX: Reset retry counter if last run was successful for > 5 minutes
if %LAST_START_SECONDS% GTR 0 (
    set /a TIME_DIFF=%CURRENT_SECONDS% - %LAST_START_SECONDS%
    REM Handle negative time diff (midnight crossing) - properly account for wrap
    if !TIME_DIFF! LSS 0 (
        set /a TIME_DIFF=86400 + !TIME_DIFF!
    )
    REM If scheduler has been stable for 5+ minutes, reset crash counter
    if !TIME_DIFF! GEQ 300 (
        set RETRY_COUNT=0
    )
)
REM Update last start time for next iteration
set LAST_START_SECONDS=%CURRENT_SECONDS%

REM Clear any previous graceful-stop marker so unexpected exits restart
if exist "%STOP_FILE%" del /q "%STOP_FILE%"

REM Check if we've exceeded max retries
if %RETRY_COUNT% GTR %MAX_RETRIES% (
    echo Error: Scheduler crashed %MAX_RETRIES% times. Please check for errors.
    exit /b 1
)

REM Set restart flag only on actual restart
if %RETRY_COUNT% GTR 0 (
    set SCHEDULER_RESTARTED=true
)

REM Run node.js directly (inherits environment from parent)
node scheduler.js

REM Check exit code
if exist "%STOP_FILE%" (
    REM Graceful shutdown requested by scheduler
    del /q "%STOP_FILE%"
    exit /b 0
)

REM If scheduler exited cleanly without stop marker, treat as crash
if %ERRORLEVEL% EQU 0 (
    REM Treat clean exit without stop flag as unexpected crash
    set /a RETRY_COUNT+=1
    if %RETRY_COUNT% GTR %MAX_RETRIES% (
        echo Error: Scheduler exited cleanly %MAX_RETRIES% times without stop marker.
        echo This suggests a logic error. Please check scheduler.js.
        exit /b 1
    )
    echo Warning: Unexpected clean exit. Restarting...
    timeout /t 2 /nobreak
    goto start
)

REM Non-zero exit code - treat as crash
set /a RETRY_COUNT+=1
timeout /t 2 /nobreak
goto start
