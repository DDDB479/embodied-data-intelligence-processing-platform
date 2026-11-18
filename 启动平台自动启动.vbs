Option Explicit
Dim shell, fso, root, node, script, mode, extra, command, q
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = root & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node.exe"
script = root & "\platform-launcher.cjs"
mode = "ensure"
If WScript.Arguments.Count > 0 Then mode = LCase(WScript.Arguments(0))
If mode = "open" Then
  extra = " --open-browser"
Else
  extra = " --ensure"
End If
q = Chr(34)
command = q & node & q & " " & q & script & q & extra
shell.Run command, 0, False
