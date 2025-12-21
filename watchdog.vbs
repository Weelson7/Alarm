' Watchdog that keeps scheduler running (restarts if console is closed)
Option Explicit

Const CHECK_INTERVAL_MS = 5000 ' how often to verify the scheduler
Const START_COOLDOWN_MS = 7000 ' wait after launching to avoid duplicate starts
Const HEARTBEAT_STALE_MS = 15000 ' heartbeat older than this means scheduler is down
Const RUN_VERB = "open" ' use "runas" if you explicitly want UAC prompt

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

' Verify batch file exists
If Not objFSO.FileExists(strBatFile) Then
    WScript.Echo "Error: run.bat not found at " & strBatFile
    WScript.Quit 1
End If

lastLaunch = 0

Call LaunchScheduler()

Do
    ' If scheduler requested a stop, exit watchdog too
    If objFSO.FileExists(stopFlagFile) Then
        WScript.Quit 0
    End If

    If Not IsSchedulerRunning() Then
        If lastLaunch = 0 Or ElapsedSince(lastLaunch) > START_COOLDOWN_MS Then
            Call LaunchScheduler()
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
    If nowMs >= ts Then
        ElapsedSince = nowMs - ts
    Else
        ' Handle midnight wrap (Timer resets to 0)
        ElapsedSince = (86400000 - ts) + nowMs
    End If
End Function
