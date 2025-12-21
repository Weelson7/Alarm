' Watchdog that runs run.bat as admin
Set objShell = CreateObject("Shell.Application")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Get the directory of this script
strScriptPath = objFSO.GetParentFolderName(WScript.ScriptFullName)
strBatFile = objFSO.BuildPath(strScriptPath, "run.bat")

' Verify batch file exists
if Not objFSO.FileExists(strBatFile) Then
    WScript.Echo "Error: run.bat not found at " & strBatFile
    WScript.Quit 1
End If

' Run run.bat as admin with error handling
On Error Resume Next
objShell.ShellExecute "cmd.exe", "/c \"" & strBatFile & "\"", strScriptPath, "runas", 0

' Check for execution errors
if Err.Number <> 0 Then
    WScript.Echo "Error: Failed to launch scheduler. " & Err.Description
    WScript.Quit 1
End If

On Error Goto 0
WScript.Quit 0
