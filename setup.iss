; 问渠下载器安装脚本 - Inno Setup
; 生成一键安装exe，双击自动安装

#define MyAppName "问渠下载器"
#define MyAppVersion "3.0.2"
#define MyAppPublisher "问渠百科"
#define MyAppURL "https://wenquso.cn"
#define MyAppExeName "start.vbs"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\WenQuDownloader
DisableProgramGroupPage=yes
LicenseFile=LICENSE.txt
OutputDir=dist
OutputBaseFilename=WenQuDownloader_Setup_v{#MyAppVersion}
SetupIconFile=icons\icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1; Check: not IsAdminInstallMode
Name: "startup"; Description: "开机自动启动"; GroupDescription: "启动选项:"; Flags: checked

[Files]
Source: "*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; NOTE: Don't use "Flags: ignoreversion" on any shared system files

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\install.bat"; Description: "运行安装配置"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName}"; Flags: nowait postinstall skipifsilent

[Registry]
; 开机自启
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "WenQuDownloader"; ValueData: "\"{app}\start.vbs\""; Tasks: startup

; Chrome 扩展策略 (ExtensionInstallForcelist)
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"; ValueType: string; ValueName: "1"; ValueData: "{app}\extension"
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist"; ValueType: string; ValueName: "1"; ValueData: "wenqu-downloader-extension"

; Edge 扩展策略
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist"; ValueType: string; ValueName: "1"; ValueData: "{app}\extension"
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist"; ValueType: string; ValueName: "1"; ValueData: "wenqu-downloader-extension"

[UninstallRun]
Filename: "{app}\uninstall.bat"; Flags: runhidden
