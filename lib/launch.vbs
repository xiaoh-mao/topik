' launch.vbs - start lib\server.ps1 with no console window (Windows Terminal ignores SW_HIDE,
' so never create a visible console at all). Prefers pwsh 7, falls back to Windows PowerShell 5.1.
' Shared core file (jlpt\ and topik\ keep identical copies): after editing run lib\sync-core.ps1.
Option Explicit
Dim sh, fso, root, ps, dirs, d, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

ps = ""
dirs = Split(sh.ExpandEnvironmentStrings("%ProgramFiles%\PowerShell\7;%PATH%"), ";")
For i = 0 To UBound(dirs)
  d = Trim(dirs(i))
  If ps = "" And Len(d) > 0 Then
    If Right(d, 1) <> "\" Then d = d & "\"
    If fso.FileExists(d & "pwsh.exe") Then ps = d & "pwsh.exe"
  End If
Next
If ps = "" Then ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

sh.Run """" & ps & """ -NoProfile -ExecutionPolicy Bypass -File """ & root & "\lib\server.ps1""", 0, False
