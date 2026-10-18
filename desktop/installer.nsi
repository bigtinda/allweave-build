Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"
!define APP_KEY "Software\AllWeave\Build"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AllWeaveBuild"

!macro RemoveManagedDirectory DIRECTORY
  StrCpy $R4 0
  ${Do}
    RMDir /r "${DIRECTORY}"
    ${IfNot} ${FileExists} "${DIRECTORY}\."
      ${Break}
    ${EndIf}
    IntOp $R4 $R4 + 1
    ${If} $R4 >= 20
      MessageBox MB_ICONSTOP "Runtime files are still in use. Close AllWeave Build and try again." /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
    Sleep 250
  ${Loop}
!macroend

Name "AllWeave Build ${APP_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\AllWeaveBuild"
InstallDirRegKey HKCU "${APP_KEY}" "InstallLocation"
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "AllWeave Build"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "FileDescription" "AllWeave Build installer"
VIAddVersionKey "LegalCopyright" "AllWeave Build contributors"
!define MUI_ICON "src-tauri\icons\icon.ico"
!define MUI_UNICON "src-tauri\icons\icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This application requires 64-bit Windows." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} "$0" "${APP_VERSION}" $1
    ${If} $1 == 1
      MessageBox MB_ICONSTOP "A newer version ($0) is already installed. Downgrading is blocked to protect your data." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CheckPrerequisites
  ; Opening a running executable for writing fails without terminating user tasks.
  IfFileExists "$INSTDIR\AllWeaveBuild.exe" 0 check_webview
  ClearErrors
  FileOpen $0 "$INSTDIR\AllWeaveBuild.exe" a
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Close AllWeave Build before installing or upgrading." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  FileClose $0
check_webview:
  !if /FileExists "${PAYLOAD}\webview2-runtime\msedgewebview2.exe"
    Return
  !endif
  ReadRegStr $0 HKLM "Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_ICONSTOP "Microsoft Edge WebView2 Runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and run this installer again." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "AllWeave Build"
  Call CheckPrerequisites
  ; Only replace managed runtime files. User data and authorized roots persist.
  SetOutPath "$INSTDIR"
  !insertmacro RemoveManagedDirectory "$INSTDIR\runtime"
  SetOverwrite on
  File "${PAYLOAD}\AllWeaveBuild.exe"
  File "${PAYLOAD}\LICENSE"
  File "${PAYLOAD}\README.txt"
  File "${PAYLOAD}\version.txt"
  File /r "${PAYLOAD}\runtime"
  !if /FileExists "${PAYLOAD}\webview2-runtime\msedgewebview2.exe"
    !insertmacro RemoveManagedDirectory "$INSTDIR\webview2-runtime"
    File /r "${PAYLOAD}\webview2-runtime"
  !endif
  SetOverwrite off
  File "${PAYLOAD}\workspace-roots.txt"
  SetOverwrite on
  CreateDirectory "$INSTDIR\workspaces"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "AllWeave Build"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\AllWeaveBuild.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  CreateShortcut "$SMPROGRAMS\AllWeave Build.lnk" "$INSTDIR\AllWeaveBuild.exe"
  CreateShortcut "$DESKTOP\AllWeave Build.lnk" "$INSTDIR\AllWeaveBuild.exe"
SectionEnd

Function un.onInit
  SetRegView 64
  ClearErrors
  FileOpen $0 "$INSTDIR\AllWeaveBuild.exe" a
  ${IfNot} ${Errors}
    FileClose $0
  ${Else}
    MessageBox MB_ICONSTOP "Close AllWeave Build before uninstalling." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  !insertmacro RemoveManagedDirectory "$INSTDIR\runtime"
  !insertmacro RemoveManagedDirectory "$INSTDIR\webview2-runtime"
  Delete "$INSTDIR\AllWeaveBuild.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\version.txt"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\AllWeave Build.lnk"
  Delete "$DESKTOP\AllWeave Build.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  ; Keep data, workspaces and workspace-roots.txt, including after uninstall.
  RMDir "$INSTDIR"
SectionEnd
