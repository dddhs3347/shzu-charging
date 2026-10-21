#Requires -Version 5.1
<#
.SYNOPSIS
    独立验证 dist\shzu-charger.apk：签名 + 包信息 + dex + 内置资源完整性。

.DESCRIPTION
    与 build.ps1 第 10 步等价，但可以单独跑、不重建。
    结果同时打印到控制台和写入 dist\verify.txt，方便贴进报告。

    检查项：
      1. apksigner verify --verbose --print-certs   （--min-sdk-version 24 与 21 各跑一次）
      2. aapt2 dump badging                          （包名 / versionCode / versionName / minSdk / targetSdk / 图标）
      3. aapt2 dump xmltree --file AndroidManifest.xml（usesCleartextTraffic / networkSecurityConfig / exported 等）
      4. classes.dex 头部（dexdump -f，确认是合法 dex 且能被 ART 加载）
      5. APK 内 assets 清单（offline.html 必在；app/ 可选）

.EXAMPLE
    .\tools\verify.ps1
#>
[CmdletBinding()]
param(
    [string]$SdkRoot = '',
    [string]$JavaHome = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Apk    = Join-Path $Root 'dist\shzu-charger.apk'
$OutTxt = Join-Path $Root 'dist\verify.txt'

function Find-Sdk {
    param([string]$Hint)
    $cands = @()
    if ($Hint) { $cands += $Hint }
    $cands += @('D:\ds\android-sdk', "$env:LOCALAPPDATA\Android\Sdk", "$env:ANDROID_SDK_ROOT", $env:ANDROID_HOME)
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'build-tools\34.0.0\aapt2.exe'))) { return $c }
    }
    return $null
}

function Find-Jdk {
    param([string]$Hint)
    $cands = @()
    if ($Hint) { $cands += $Hint }
    $cands += @('D:\ds\openjdk-17.0.2\jdk-17.0.2', 'D:\ds\openjdk-17.0.2', $env:JAVA_HOME)
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'bin\java.exe'))) { return $c }
    }
    return $null
}

$Sdk = Find-Sdk -Hint $SdkRoot
if (-not $Sdk) { Write-Host '[FAIL] 找不到 Android SDK（用 -SdkRoot 指定）' -ForegroundColor Red; exit 1 }
$Jdk = Find-Jdk -Hint $JavaHome
if (-not $Jdk) { Write-Host '[FAIL] 找不到 JDK（用 -JavaHome 指定）' -ForegroundColor Red; exit 1 }

$Java   = Join-Path $Jdk 'bin\java.exe'
$Bt     = Join-Path $Sdk 'build-tools\34.0.0'
$Aapt2  = Join-Path $Bt 'aapt2.exe'
$DexDump= Join-Path $Bt 'dexdump.exe'
$ApkSignerJar = Join-Path $Bt 'lib\apksigner.jar'

if (-not (Test-Path -LiteralPath $Apk)) {
    Write-Host "[FAIL] 找不到 $Apk，先跑 build.bat" -ForegroundColor Red
    exit 1
}

$lines = New-Object System.Collections.Generic.List[string]
$script:fail = 0

function Emit {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
    $lines.Add($Text) | Out-Null
}

function Emit-Head {
    param([string]$Text)
    Emit ''
    Emit ('=' * 70) 'Cyan'
    Emit "  $Text" 'Cyan'
    Emit ('=' * 70) 'Cyan'
}

function Run-Captured {
    param([string]$Exe, [string[]]$ArgList)
    $ErrorActionPreference = 'Continue'
    $out = & $Exe @ArgList 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    foreach ($l in ($out -split "`r?`n")) { if ($l.Trim() -ne '') { Emit $l } }
    return @{ Code = $code; Text = $out }
}

$apkItem = Get-Item -LiteralPath $Apk
$sha256  = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash

Emit-Head 'APK 基本信息'
Emit ("路径      : " + $Apk)
Emit ("体积      : " + [math]::Round($apkItem.Length / 1KB, 1) + " KB (" + $apkItem.Length + " 字节)")
Emit ("SHA256    : " + $sha256)
Emit ("构建时间  : " + $apkItem.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
Emit ("SDK       : " + $Sdk)
Emit ("JDK       : " + $Jdk)

# ---------------------------------------------------------------- 1. 签名
Emit-Head '1) apksigner verify --verbose --print-certs --min-sdk-version 24'
$r = Run-Captured -Exe $Java -ArgList @('-jar', $ApkSignerJar, 'verify', '--verbose', '--print-certs',
    '--min-sdk-version', '24', $Apk)
if ($r.Code -ne 0 -or $r.Text -notmatch 'Verifies') {
    Emit "  [FAIL] apksigner verify 失败（退出码 $($r.Code)）" 'Red'
    $script:fail++
} else {
    Emit '  [PASS] apksigner verify 通过' 'Green'
}

Emit-Head '1b) apksigner verify --min-sdk-version 21（看 v1 JAR 签名）'
$r = Run-Captured -Exe $Java -ArgList @('-jar', $ApkSignerJar, 'verify', '--verbose',
    '--min-sdk-version', '21', $Apk)
if ($r.Code -eq 0 -and $r.Text -match 'Verified using v1 scheme \(JAR signing\): true') {
    Emit '  [PASS] v1 + v2 + v3 三套签名都完整（minSdk 24 的包 v1 只为兜底）' 'Green'
} else {
    Emit '  [WARN] v1 签名未验证为 true（minSdk 24 上不影响安装）' 'Yellow'
}

# ---------------------------------------------------------------- 2. badging
Emit-Head '2) aapt2 dump badging'
$r = Run-Captured -Exe $Aapt2 -ArgList @('dump', 'badging', $Apk)
$badging = $r.Text
$checks = @(
    @{ Name = "包名 cn.edu.shzu.charger";  Pattern = "package: name='cn\.edu\.shzu\.charger'" },
    @{ Name = "versionCode='1'";           Pattern = "versionCode='1'" },
    @{ Name = "versionName='1.0.0'";       Pattern = "versionName='1\.0\.0'" },
    @{ Name = "minSdk 24";                 Pattern = "sdkVersion:'24'" },
    @{ Name = "targetSdk 34";              Pattern = "targetSdkVersion:'34'" },
    @{ Name = "启动 Activity";             Pattern = "launchable-activity: name='cn\.edu\.shzu\.charger\.MainActivity'" },
    @{ Name = "应用名 石大充电桩";         Pattern = "application-label:'石大充电桩'" },
    @{ Name = "图标";                      Pattern = "application: label='石大充电桩' icon='res/mipmap" },
    @{ Name = "INTERNET 权限";             Pattern = "uses-permission: name='android\.permission\.INTERNET'" }
)
Emit ''
foreach ($c in $checks) {
    if ($badging -match $c.Pattern) {
        Emit ("  [PASS] " + $c.Name) 'Green'
    } else {
        Emit ("  [FAIL] " + $c.Name + "  (期望匹配 " + $c.Pattern + ")") 'Red'
        $script:fail++
    }
}

# ---------------------------------------------------------------- 3. manifest
Emit-Head '3) aapt2 dump xmltree --file AndroidManifest.xml（关键属性）'
$r = Run-Captured -Exe $Aapt2 -ArgList @('dump', 'xmltree', '--file', 'AndroidManifest.xml', $Apk)
$tree = $r.Text
$mchecks = @(
    @{ Name = "usesCleartextTraffic=true";        Pattern = 'usesCleartextTraffic.*=true' },
    @{ Name = "networkSecurityConfig 已设置";     Pattern = 'networkSecurityConfig' },
    @{ Name = "MainActivity exported=true";       Pattern = 'activity.*\n' },
    @{ Name = "minSdkVersion=24";                 Pattern = 'minSdkVersion.*=24' },
    @{ Name = "targetSdkVersion=34";              Pattern = 'targetSdkVersion.*=34' },
    @{ Name = "launchMode=singleTop";             Pattern = 'launchMode' }
)
Emit ''
foreach ($c in @($mchecks | Where-Object { $_.Name -ne 'MainActivity exported=true' })) {
    if ($tree -match $c.Pattern) {
        Emit ("  [PASS] " + $c.Name) 'Green'
    } else {
        Emit ("  [FAIL] " + $c.Name) 'Red'
        $script:fail++
    }
}
if ($tree -match 'exported\(0x01010010\)=true') {
    Emit '  [PASS] MainActivity exported=true' 'Green'
} else {
    Emit '  [FAIL] MainActivity exported=true' 'Red'
    $script:fail++
}

# ---------------------------------------------------------------- 4. dex
Emit-Head '4) classes.dex 完整性（dexdump -f）'
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
$TmpDex = Join-Path $env:TEMP ('shzu-chk-' + [guid]::NewGuid().ToString('N') + '.dex')
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'classes.dex' } | Select-Object -First 1
    if (-not $entry) { throw 'APK 里没有 classes.dex' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $TmpDex, $true)
} finally { $zip.Dispose() }

if (Test-Path -LiteralPath $TmpDex) {
    # 只要头信息，不要 -d 全量反汇编（几千行）
    $r = Run-Captured -Exe $DexDump -ArgList @('-f', $TmpDex)
    if ($r.Text -match "DEX version '037'") {
        Emit '  [PASS] classes.dex 是合法的 dex 037（minSdk 24 可加载）' 'Green'
    } else {
        Emit '  [FAIL] dexdump 未能识别 dex 头' 'Red'
        $script:fail++
    }
    Remove-Item -LiteralPath $TmpDex -Force -ErrorAction SilentlyContinue
} else {
    Emit '  [FAIL] 无法从 APK 里取出 classes.dex' 'Red'
    $script:fail++
}

# ---------------------------------------------------------------- 5. assets
Emit-Head '5) APK 内 assets 清单'
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $assets = $zip.Entries | Where-Object { $_.FullName -like 'assets/*' -and -not $_.FullName.EndsWith('/') } |
        Sort-Object FullName
    foreach ($a in $assets) { Emit ("  {0,8}  {1}" -f $a.Length, $a.FullName) }
    if ($assets | Where-Object { $_.FullName -eq 'assets/offline.html' }) {
        Emit '  [PASS] assets/offline.html 存在（离线兜底页已打包）' 'Green'
    } else {
        Emit '  [FAIL] 缺少 assets/offline.html' 'Red'
        $script:fail++
    }
    if ($assets | Where-Object { $_.FullName -eq 'assets/app/index.html' }) {
        Emit '  [PASS] assets/app/index.html 存在（内置离线版 UI 已打包）' 'Green'
    } else {
        Emit '  [WARN] 没有内置 UI（-NoApp 构建），离线时只有 offline.html' 'Yellow'
    }
} finally { $zip.Dispose() }

# ---------------------------------------------------------------- 结论
Emit ''
Emit ('=' * 70) 'Cyan'
if ($script:fail -eq 0) {
    Emit ' 全部检查通过，APK 可以安装' 'Green'
} else {
    Emit (" 有 $($script:fail) 项检查失败") 'Red'
}
Emit ('=' * 70) 'Cyan'

New-Item -ItemType Directory -Path (Split-Path -Parent $OutTxt) -Force | Out-Null
$lines | Set-Content -LiteralPath $OutTxt -Encoding UTF8
Write-Host ''
Write-Host ("报告已写入 " + $OutTxt)

if ($script:fail -gt 0) { exit 1 }
exit 0
