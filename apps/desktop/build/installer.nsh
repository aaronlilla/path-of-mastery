# electron-builder picks this file up as nsis.include (build/installer.nsh).
# An optional setup window runs this installer with /S and these extra flags.

!macro customInstall
  # --no-start-menu: the setup window's "Add to Start menu" box was unticked (--no-desktop-shortcut is built in).
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--no-start-menu" $R1
  ${IfNot} ${Errors}
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
  ${EndIf}

  # The optional setup window doubles as the uninstall screen (built by npm run package:setup).
  # Plain npm run package has no setup-ui.exe and keeps the stock uninstaller entry.
  !if /FileExists "${BUILD_RESOURCES_DIR}\setup-ui.exe"
    File "/oname=$INSTDIR\Path of Mastery Setup.exe" "${BUILD_RESOURCES_DIR}\setup-ui.exe"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\Path of Mastery Setup.exe" --uninstall'
  !endif
!macroend
