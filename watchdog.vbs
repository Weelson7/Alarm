' Watchdog that keeps scheduler running (restarts if console is closed)
Option Explicit

Const CHECK_INTERVAL_MS = 5000 ' how often to verify the scheduler
Const START_COOLDOWN_MS = 7000 ' wait after launching to avoid duplicate starts
Const HEARTBEAT_STALE_MS = 15000 ' heartbeat older than this means scheduler is down
Const RUN_VERB = "open" ' use "runas" if you explicitly want UAC prompt
Const MAX_RESTARTS = 10 ' maximum restarts before giving up
Const RESTART_RESET_MS = 300000 ' reset counter after 5 minutes of stability (300,000ms)

Dim objShell, objFSO, objWMI
Dim strScriptPath, strBatFile, lastLaunch

Set objShell = CreateObject("Shell.Application")
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objWMI = GetObject("winmgmts:\\.\root\cimv2")

' Get the directory of this script
strScriptPath = objFSO.GetParentFolderName(WScript.ScriptFullName)
strBatFile = objFSO.BuildPath(strScriptPath, "run.bat")
Dim heartbeatFile
heartbeatFile = objFSO.BuildPath(strScriptPath, "heartbeat.txt")
Dim stopFlagFile
stopFlagFile = objFSO.BuildPath(strScriptPath, "stop.flag")
Dim restartCountFile
restartCountFile = objFSO.BuildPath(strScriptPath, "restart_count.txt")

' Verify batch file exists
If Not objFSO.FileExists(strBatFile) Then
    WScript.Echo "Error: run.bat not found at " & strBatFile
    WScript.Quit 1
End If

lastLaunch = 0
Dim restartCount
Dim lastSuccessfulStart

' Load restart count from file
On Error Resume Next
restartCount = 0
If objFSO.FileExists(restartCountFile) Then
    Dim countFile, savedCount
    Set countFile = objFSO.OpenTextFile(restartCountFile, 1)
    savedCount = countFile.ReadLine()
    countFile.Close
    If IsNumeric(savedCount) Then
        restartCount = CInt(savedCount)
    End If
End If
Err.Clear
On Error GoTo 0

lastSuccessfulStart = 0

' Clear any stale graceful-stop marker on startup so a new launch isn't blocked
On Error Resume Next
If objFSO.FileExists(stopFlagFile) Then
    objFSO.DeleteFile stopFlagFile, True
End If
Err.Clear
On Error GoTo 0

Call LaunchScheduler()

Do
    ' If scheduler requested a stop, exit watchdog too
    If objFSO.FileExists(stopFlagFile) Then
        ' Clean up the flag and exit to honor graceful shutdown
        On Error Resume Next
        objFSO.DeleteFile stopFlagFile, True
        Err.Clear
        On Error GoTo 0
        WScript.Quit 0
    End If

    If Not IsSchedulerRunning() Then
        If restartCount >= MAX_RESTARTS Then
            WScript.Echo "Error: Scheduler has crashed " & restartCount & " times. Giving up to prevent infinite loop."
            WScript.Echo "Please check scheduler.js for errors and restart watchdog manually."
            WScript.Quit 1
        End If
        
        If lastLaunch = 0 Or ElapsedSince(lastLaunch) > START_COOLDOWN_MS Then
            restartCount = restartCount + 1
            ' Save restart count to file
            On Error Resume Next
            Dim saveFile
            Set saveFile = objFSO.CreateTextFile(restartCountFile, True)
            saveFile.WriteLine CStr(restartCount)
            saveFile.Close
            Err.Clear
            On Error GoTo 0
            Call LaunchScheduler()
        End If
    Else
        ' Scheduler is running - check if it's been stable
        If lastSuccessfulStart = 0 Then
            lastSuccessfulStart = GetTickCount()
        ElseIf ElapsedSince(lastSuccessfulStart) > RESTART_RESET_MS Then
            ' Reset restart counter after 5 minutes of stability
            restartCount = 0
            ' Save reset count to file
            On Error Resume Next
            Dim resetFile
            Set resetFile = objFSO.CreateTextFile(restartCountFile, True)
            resetFile.WriteLine "0"
            resetFile.Close
            Err.Clear
            On Error GoTo 0
            lastSuccessfulStart = GetTickCount()
        End If
    End If
    WScript.Sleep CHECK_INTERVAL_MS
Loop

Sub LaunchScheduler()
    On Error Resume Next
    objShell.ShellExecute strBatFile, "", strScriptPath, RUN_VERB, 1
    lastLaunch = GetTickCount()
    If Err.Number <> 0 Then
        WScript.Echo "Error: Failed to launch scheduler. " & Err.Description & " (" & Err.Number & ")"
    End If
    Err.Clear
    On Error GoTo 0
End Sub

Function IsSchedulerRunning()
    ' Prefer heartbeat file to avoid WMI command line permission issues
    On Error Resume Next
    IsSchedulerRunning = False

    If objFSO.FileExists(heartbeatFile) Then
        Dim hbFile, hbMod, hbAge
        Set hbFile = objFSO.GetFile(heartbeatFile)
        hbMod = hbFile.DateLastModified
        hbAge = DateDiff("s", hbMod, Now()) * 1000 ' ms
        If hbAge >= 0 And hbAge < HEARTBEAT_STALE_MS Then
            IsSchedulerRunning = True
            On Error GoTo 0
            Exit Function
        End If
    End If

    ' Fallback to WMI command line detection
    Dim proc, cmdLine
    For Each proc In objWMI.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'")
        cmdLine = LCase(proc.CommandLine & "")
        If InStr(cmdLine, "scheduler.js") > 0 Then
            IsSchedulerRunning = True
            Exit For
        End If
    Next
    On Error GoTo 0
End Function

Function GetTickCount()
    ' Timer() wraps daily; convert to ms and handle wrap in ElapsedSince
    GetTickCount = CLng(Timer * 1000)
End Function

Function ElapsedSince(ts)
    Dim nowMs
    nowMs = GetTickCount()
    
    ' FIX: Validate timestamp is in valid range (0 to slightly over 86400000 for wrap boundary)
    Const MS_PER_DAY = 86400000
    ' Allow timestamps up to 90 seconds after wrap to handle boundary conditions
    Const WRAP_TOLERANCE = 90000
    If ts < 0 Or ts > (MS_PER_DAY + WRAP_TOLERANCE) Then
        ' Corrupted or invalid timestamp - return safe large value to allow restart
        ElapsedSince = START_COOLDOWN_MS + 1000
        Exit Function
    End If
    
    If nowMs >= ts Then
        ElapsedSince = nowMs - ts
    Else
        ' Handle midnight wrap (Timer resets to 0 every 24 hours)
        ' When timer wraps: ts is large (e.g., 86399000), nowMs is small (e.g., 1000)
        ' Elapsed = (time from ts to midnight) + (time from midnight to nowMs)
        Dim elapsed
        ' Use original ts for calculation since it's already validated
        elapsed = (MS_PER_DAY - ts) + nowMs
        ' CRITICAL: Protect against invalid results from hibernation/pause/clock adjustment
        ' If calculation produces unreasonable result, return safe value to allow restart
        If elapsed < 0 Or elapsed > MS_PER_DAY * 1.5 Then
            ' Return a value larger than START_COOLDOWN_MS to allow restart
            ElapsedSince = START_COOLDOWN_MS + 1000
        Else
            ElapsedSince = elapsed
        End If
    End If
End Function
