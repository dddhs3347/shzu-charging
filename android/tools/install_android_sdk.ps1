<#
.SYNOPSIS
    从零安装本机 APK 构建所需的最小 Android SDK（无 Android Studio、无 gradle）。

.DESCRIPTION
    本文件就是本项目 android 模块的「工具链下载记录 + 可复现安装脚本」。
    下面每一行 URL / 命令都是实际执行过的，脚本按顺序重放即可在干净机器上复现。

    实际落地版本（2026-10 实测）：
      commandline-tools  channel 0, revision 12.0  (commandlinetools-win-11076708_latest.zip)
      build-tools        34.0.0
      platform-tools     37.0.1
      platforms          android-34 (platform-34-ext7_r03)
      JDK                17.0.2  D:\ds\openjdk-17.0.2\jdk-17.0.2

.PARAMETER SdkRoot
    SDK 安装目录，默认 D:\ds\android-sdk（刻意不放 C 盘系统目录）。

.PARAMETER JavaHome
    JDK 17 根目录（含 bin\javac.exe），默认自动探测 D:\ds\openjdk-17.0.2\jdk-17.0.2。

.EXAMPLE
    .\install_android_sdk.ps1
    .\install_android_sdk.ps1 -SdkRoot E:\android-sdk

.NOTES
    约 600 MB 下载 / 1.5 GB 落盘。全程不需要网络代理，dl.google.com 直连可达。
#>
[CmdletBinding()]
param(
    [string]$SdkRoot = 'D:\ds\android-sdk',
    [string]$JavaHome
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$CliZipUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$CliZipName = 'commandlinetools-win-11076708_latest.zip'

function Write-Step { param([string]$t) Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail { param([string]$m) Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------
Write-Step '检查 JDK 17'

if (-not $JavaHome) {
    foreach ($candidate in @(
            'D:\ds\openjdk-17.0.2\jdk-17.0.2',
            'D:\ds\openjdk-17.0.2',
            $env:JAVA_HOME)) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\javac.exe'))) {
            $JavaHome = $candidate
            break
        }
    }
}
if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\javac.exe'))) {
    Fail '找不到 JDK（需要 bin\javac.exe）。用 -JavaHome 指定，例如 -JavaHome "D:\ds\openjdk-17.0.2\jdk-17.0.2"'
}
$env:JAVA_HOME = $JavaHome
$env:PATH = (Join-Path $JavaHome 'bin') + ';' + $env:PATH
$javacVer = (& cmd /c "`"$(Join-Path $JavaHome 'bin\javac.exe')`" -version 2>&1") -join ' '
Write-Host "    JDK         $JavaHome"
Write-Host "    javac       $javacVer"

# SDK 刻意放在 D 盘：C 盘系统目录不需要写权限，也避免把 1.5 GB SDK 塞进用户目录
if (-not (Test-Path -LiteralPath $SdkRoot)) {
    New-Item -ItemType Directory -Path $SdkRoot -Force | Out-Null
    Write-Host "    新建 SDK 目录 $SdkRoot"
}

$DownloadDir = Join-Path $SdkRoot '_download'
New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. 下载 Android command-line tools
# ---------------------------------------------------------------------------
Write-Step '下载 Android command-line tools'
$CliZip = Join-Path $DownloadDir $CliZipName

if (Test-Path -LiteralPath $CliZip) {
    Write-Host "    已存在，跳过下载：$CliZip"
} else {
    Write-Host "    URL  $CliZipUrl"
    # 实测 153,583,359 字节；这里用 Invoke-WebRequest 直连 dl.google.com
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $CliZipUrl -OutFile $CliZip -UseBasicParsing
    $ProgressPreference = 'Continue'
    $len = (Get-Item -LiteralPath $CliZip).Length
    if ($len -lt 50MB) { Fail "下载的 zip 太小（$len 字节），可能失败" }
    Write-Host "    OK   $len 字节"
}

# ---------------------------------------------------------------------------
# 2. 解压并摆到 <sdk>\cmdline-tools\latest
# ---------------------------------------------------------------------------
Write-Step '解压 command-line tools'
$SdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (Test-Path -LiteralPath $SdkManager) {
    Write-Host "    已安装，跳过：$SdkManager"
} else {
    $ExtractDir = Join-Path $DownloadDir 'cli-extract'
    if (Test-Path -LiteralPath $ExtractDir) { Remove-Item -LiteralPath $ExtractDir -Recurse -Force }
    Expand-Archive -LiteralPath $CliZip -DestinationPath $ExtractDir -Force

    # zip 里的顶层目录就叫 cmdline-tools，sdkmanager 要求它位于 <sdk>\cmdline-tools\latest
    $Inner = Join-Path $ExtractDir 'cmdline-tools'
    if (-not (Test-Path -LiteralPath $Inner)) { Fail "解压结果里没有 cmdline-tools 目录：$ExtractDir" }

    $CmdlineToolsRoot = Join-Path $SdkRoot 'cmdline-tools'
    New-Item -ItemType Directory -Path $CmdlineToolsRoot -Force | Out-Null
    $Latest = Join-Path $CmdlineToolsRoot 'latest'
    if (Test-Path -LiteralPath $Latest) { Remove-Item -LiteralPath $Latest -Recurse -Force }
    Move-Item -LiteralPath $Inner -Destination $Latest
    Write-Host "    OK   $Latest"
}

$env:ANDROID_SDK_ROOT = $SdkRoot
$env:ANDROID_HOME = $SdkRoot
if (-not (Test-Path -LiteralPath $SdkManager)) { Fail "sdkmanager 不存在：$SdkManager" }
$sdkVer = (& cmd /c "`"$SdkManager`" --version 2>&1") -join ' '
Write-Host "    sdkmanager $sdkVer"

# ---------------------------------------------------------------------------
# 3. 接受 licenses
# ---------------------------------------------------------------------------
# sdkmanager --licenses 会反复读 stdin 问 y/N。实测在 Windows 下用
# `cmd /c "... --licenses < ys.txt"` 喂一个全是 y 的文件最稳：
#   - 直接管道 `"y`n" * 30 | sdkmanager --licenses` 有时被 PowerShell 的
#     编码/换行处理搞坏，sdkmanager 拿不到合法输入
#   - 重定向文件用的是 CRT 的 stdin，不给 BOM 就是纯 ASCII，万无一失
Write-Step '接受 SDK licenses'
$LicensesDir = Join-Path $SdkRoot 'licenses'
$YFile = Join-Path $DownloadDir 'ys.txt'
if (-not (Test-Path -LiteralPath $YFile)) {
    # 100 行 "y\r\n"，UTF-8 无 BOM，不带尾随 -NoNewline 之外的修饰
    [System.IO.File]::WriteAllText($YFile, ("y`r`n" * 100), (New-Object System.Text.UTF8Encoding($false)))
}
& cmd /c "`"$SdkManager`" --licenses < `"$YFile`" 2>&1" | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Fail "sdkmanager --licenses 退出码 $LASTEXITCODE" }

$licCount = 0
if (Test-Path -LiteralPath $LicensesDir) {
    $licCount = @(Get-ChildItem -LiteralPath $LicensesDir -File).Count
}
Write-Host "    OK   $LicensesDir 下 $licCount 个 license 文件"

# ---------------------------------------------------------------------------
# 4. 安装最小包集合
# ---------------------------------------------------------------------------
# 说明：
#   platforms;android-34  提供 android.jar（编译期 classpath，也是 apksigner 的 --min-sdk 校验依据）
#   build-tools;34.0.0    提供 aapt2 / zipalign / lib\d8.jar / lib\apksigner.jar
#   platform-tools        adb（只有 install 用得到，可选）
Write-Step '安装 platforms;android-34 + build-tools;34.0.0 + platform-tools'
& cmd /c "`"$SdkManager`" --sdk_root=`"$SdkRoot`" `"platforms;android-34`" `"build-tools;34.0.0`" `"platform-tools`" 2>&1" |
    ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Fail "sdkmanager 安装包集合退出码 $LASTEXITCODE" }

# ---------------------------------------------------------------------------
# 5. 验收
# ---------------------------------------------------------------------------
Write-Step '验收关键文件'
$Required = @(
    'build-tools\34.0.0\aapt2.exe',
    'build-tools\34.0.0\zipalign.exe',
    'build-tools\34.0.0\lib\d8.jar',
    'build-tools\34.0.0\lib\apksigner.jar',
    'platforms\android-34\android.jar'
)
$missing = 0
foreach ($rel in $Required) {
    $p = Join-Path $SdkRoot $rel
    if (Test-Path -LiteralPath $p) {
        Write-Host ("    [OK]   {0}  {1} 字节" -f $rel, (Get-Item -LiteralPath $p).Length) -ForegroundColor Green
    } else {
        Write-Host ("    [缺失] $rel") -ForegroundColor Red
        $missing++
    }
}
if ($missing -gt 0) { Fail "$missing 个关键文件缺失" }

Write-Host ''
Write-Host '==========================================' -ForegroundColor Green
Write-Host ' Android SDK 就绪，可以构建 APK 了' -ForegroundColor Green
Write-Host '==========================================' -ForegroundColor Green
Write-Host (" SDK_ROOT : " + $SdkRoot)
Write-Host (" JAVA_HOME: " + $JavaHome)
Write-Host ' 下一步   : .\build.bat -Clean'
Write-Host ''
Write-Host '【离线退路】若 sdkmanager 因网络/许可失败，可直接拉单包：'
Write-Host '  build-tools : https://dl.google.com/android/repository/build-tools_r34-windows.zip'
Write-Host '  platform 34 : https://dl.google.com/android/repository/platform-34-ext7_r03.zip'
Write-Host '  解压后手工摆成 <sdk>\build-tools\34.0.0\ 与 <sdk>\platforms\android-34\'
Write-Host '  （前一个包给 aapt2/zipalign/d8/apksigner，后一个包给 android.jar），'
Write-Host '  然后 build.bat -SdkRoot <sdk> 即可，不需要 licenses 目录。'
Write-Host ''
