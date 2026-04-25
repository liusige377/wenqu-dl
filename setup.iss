; 问渠下载器安装脚本 - Inno Setup
; 生成一键安装exe，双击自动安装
; v3.0.4 - 优化用户体验：无黑框启动、node检测、友好提示

#define MyAppName "问渠下载器"
#define MyAppVersion "3.0.4"
#define MyAppPublisher "问渠百科"
#define MyAppURL "https://wenquso.cn"
#define MyAppExeName "start.vbs"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\WenQuDownloader
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=WenQuDownloader_Setup_v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\web\icon\logo-48.png
UnDisplayName={#MyAppName}

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "startup"; Description: "开机自动启动"; GroupDescription: "启动选项:"; Flags: checkedonce

[Files]
Source: "server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "start.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "start.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "install.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "build.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "node.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs
Source: "extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\start.vbs"""; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\start.vbs"""; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{autoprograms}\{#MyAppName} (控制台)"; Filename: "{app}\start.bat"; WorkingDir: "{app}"

[Run]
Filename: "cmd.exe"; Parameters: "/c cd /d ""{app}"" && npm install --production --no-audit --no-fund"; Description: "正在安装依赖..."; Flags: runhidden waituntilterminated
Filename: "cmd.exe"; Parameters: "/c cd /d ""{app}"" && install.bat"; Description: "正在配置环境..."; Flags: runhidden waituntilterminated
Filename: "wscript.exe"; Parameters: """{app}\start.vbs"""; Description: "启动问渠下载器"; Flags: nowait postinstall skipifsilent

[Registry]
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "WenQuDownloader"; ValueData: """wscript.exe"" ""{app}\start.vbs"""; Tasks: startup
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"; ValueType: string; ValueName: "1"; ValueData: "{app}\extension"
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist"; ValueType: string; ValueName: "1"; ValueData: "wenqu-downloader-extension"
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist"; ValueType: string; ValueName: "1"; ValueData: "{app}\extension"
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist"; ValueType: string; ValueName: "1"; ValueData: "wenqu-downloader-extension"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  if Exec('cmd.exe', '/c where node', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then begin
    Result := True;
    Exit;
  end;
  if MsgBox('检测到您的电脑尚未安装 Node.js 运行环境。'#13#10#13#10'问渠下载器需要 Node.js 才能运行。'#13#10'是否立即打开 Node.js 官网下载页面？'#13#10'(推荐选择 LTS 长期支持版)', mbConfirmation, MB_YESNO) = IDYES then begin
    ShellExec('open', 'https://nodejs.org/zh-cn/download/', '', '', SW_SHOW, ewNoWait, ResultCode);
    Result := False;
  end else begin
    Result := True;
  end;
end;
