; installer.nsh — eORB Premium NSIS installer customizations
; Preserves license.dat and database.db across reinstalls/upgrades.

!macro customRemoveFiles
  ; Intentionally do NOT delete the userData folder on uninstall.
  ; Customers reinstalling should keep their license + data.
!macroend
