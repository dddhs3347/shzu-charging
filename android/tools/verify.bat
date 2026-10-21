@echo off
rem ===================================================================
rem  SHZU Charger APK verify entry (Windows)
rem
rem  Usage:
rem      verify.bat                       verify dist\shzu-charger.apk
rem      verify.bat -SdkRoot E:\sdk       custom SDK location
rem      verify.bat -JavaHome D:\jdk17    custom JDK location
rem
rem  Why a .bat wrapper: PowerShell 5.1 only parses a .ps1 as UTF-8 when
rem  it has a BOM. Editors (and patch tools) routinely drop the BOM, which
rem  makes every Chinese string in the script turn into mojibake and the
rem  script then fails to parse. This wrapper re-adds the BOM first.
rem ===================================================================
setlocal
pushd "%~dp0.." >nul

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$p='tools\verify.ps1'; $b=[System.IO.File]::ReadAllBytes($p); if(-not ($b.Length -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191)) { $t=[System.Text.Encoding]::UTF8.GetString($b); [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true))); Write-Host '  [fix] tools\verify.ps1 UTF-8 BOM added' }"
if errorlevel 1 (
    echo [FAIL] cannot check tools\verify.ps1 encoding
    popd >nul
    exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "tools\verify.ps1" %*
set "RC=%ERRORLEVEL%"

popd >nul
exit /b %RC%
