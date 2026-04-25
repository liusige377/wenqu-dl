' WenQu Downloader v3.0 - Silent Start (No Black Window)
On Error Resume Next
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

installDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeCmd = ""

' Check 1: bundled node in install dir
If fso.FileExists(installDir & "\node.exe") Then
    nodeCmd = installDir & "\node.exe"
End If

' Check 2: QClaw node
If nodeCmd = "" Then
    t1 = WshShell.ExpandEnvironmentStrings("%APPDATA%") & "\QClaw\npm-global\node.exe"
    If fso.FileExists(t1) Then nodeCmd = t1
End If

' Check 3: Ollama node
If nodeCmd = "" Then
    t2 = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Ollama\node.exe")
    If fso.FileExists(t2) Then nodeCmd = t2
End If

' Check 4: system node via registry HKLM
If nodeCmd = "" Then
    Err.Clear
    rv = WshShell.RegRead("HKLM\SOFTWARE\node.js\InstallPath\")
    If Err.Number = 0 Then
        t3 = rv & "\node.exe"
        If fso.FileExists(t3) Then nodeCmd = t3
    End If
End If

' Check 5: system node via registry HKCU
If nodeCmd = "" Then
    Err.Clear
    rv = WshShell.RegRead("HKCU\SOFTWARE\node.js\InstallPath\")
    If Err.Number = 0 Then
        t4 = rv & "\node.exe"
        If fso.FileExists(t4) Then nodeCmd = t4
    End If
End If

' Check 6: where node in PATH
If nodeCmd = "" Then
    Err.Clear
    Set objExec = WshShell.Exec("where node")
    If Err.Number = 0 Then
        nodeCmd = objExec.StdOut.ReadLine()
    End If
End If

On Error GoTo 0

' Not found - show friendly message and open download page
If nodeCmd = "" Or (Not fso.FileExists(nodeCmd)) Then
    MsgBox "WenQu Downloader requires Node.js runtime." & vbCrLf & vbCrLf & _
           "Please install Node.js first:" & vbCrLf & _
           "https://nodejs.org/zh-cn/download/" & vbCrLf & vbCrLf & _
           "Choose LTS version, check ""Add to PATH"" during install.", _
           vbExclamation, "WenQu Downloader"
    WshShell.Run "https://nodejs.org/zh-cn/download/"
    WScript.Quit 1
End If

' Launch silently (window mode 0 = hide)
WshShell.Run Chr(34) & nodeCmd & Chr(34) & " " & Chr(34) & installDir & "\server.js" & Chr(34), 0, False
