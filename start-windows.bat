@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo  石大充电桩 - 本地服务启动
echo ================================================================
echo.
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -X utf8 start.py %*
    goto :done
)
where python >nul 2>nul
if %errorlevel%==0 (
    python -X utf8 start.py %*
    goto :done
)
echo [错误] 没找到 Python。请先到 https://www.python.org/downloads/windows/ 安装，
echo        安装时务必勾选 "Add python.exe to PATH"，然后重新双击本文件。
:done
echo.
pause