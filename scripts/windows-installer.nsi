!include "MUI2.nsh"

!ifndef SOURCE_DIR
  !error "SOURCE_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef APP_ICON
  !error "APP_ICON is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef APP_BUILD_NUMBER
  !error "APP_BUILD_NUMBER is required"
!endif

Name "TermPilot"
OutFile "${OUTPUT_FILE}"
VIProductVersion "${APP_VERSION}.${APP_BUILD_NUMBER}"
VIAddVersionKey /LANG=1033 "ProductName" "TermPilot"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}.${APP_BUILD_NUMBER}"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}.${APP_BUILD_NUMBER}"
InstallDir "$LOCALAPPDATA\Programs\TermPilot"
InstallDirRegKey HKCU "Software\TermPilot" "InstallDir"
RequestExecutionLevel user
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\TermPilot.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "TermPilot" SecMain
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\TermPilot" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPilot" "DisplayName" "TermPilot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPilot" "DisplayVersion" "${APP_VERSION}.${APP_BUILD_NUMBER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPilot" "Publisher" "TermPilot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPilot" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  CreateDirectory "$SMPROGRAMS\TermPilot"
  CreateShortcut "$SMPROGRAMS\TermPilot\TermPilot.lnk" "$INSTDIR\TermPilot.exe"
  CreateShortcut "$DESKTOP\TermPilot.lnk" "$INSTDIR\TermPilot.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\TermPilot.lnk"
  Delete "$SMPROGRAMS\TermPilot\TermPilot.lnk"
  RMDir "$SMPROGRAMS\TermPilot"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\TermPilot"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPilot"
SectionEnd
