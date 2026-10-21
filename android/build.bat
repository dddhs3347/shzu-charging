@echo off
rem ===================================================================
rem  SHZU Charger APK build entry (Windows)
rem
rem  Usage:
rem      build.bat                    normal build (auto-detect SDK/JDK)
rem      build.bat -Clean             wipe build\ and dist\ first
rem      build.bat -WithApp           force package ..\app into assets
rem      build.bat -NoApp             shell only, do not package app
rem      build.bat -RecreateKeystore  regenerate debug keystore
rem      build.bat -SkipVerify        skip apksigner/aapt2 verification
rem
rem  Note: PowerShell 5.1 only parses a .ps1 as UTF-8 when it has a BOM.
rem  This wrapper adds the BOM automatically before invoking build.ps1,
rem  so the script keeps working no matter which editor saved it.
rem ===================================================================
setlocal
pushd "%~dp0" >nul

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$p='build.ps1'; $b=[System.IO.File]::ReadAllBytes($p); if(-not ($b.Length -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191)) { $t=[System.Text.Encoding]::UTF8.GetString($b); [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true))); Write-Host '  [fix] build.ps1 UTF-8 BOM added' }"
if errorlevel 1 (
    echo [FAIL] cannot check build.ps1 encoding
    popd >nul
    exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "build.ps1" %*
set "RC=%ERRORLEVEL%"

popd >nul
exit /b %RC%
