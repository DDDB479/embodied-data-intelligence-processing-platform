Option Explicit
Dim shell, fso, root, ps, script, q
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
script = root & "\platform-launcher.ps1"
q = Chr(34)
shell.Run q & ps & q & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & script & q, 0, False
