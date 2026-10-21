#Requires -Version 5.1
<#
.SYNOPSIS
    石大充电桩 Android APK 构建脚本 —— 完全绕过 gradle。

.DESCRIPTION
    只用 Android SDK build-tools 里的命令行工具手工串起整条链路：

        aapt2 compile  ->  res/*.flat
        aapt2 link     ->  未签名基础 APK（含 resources.arsc / manifest / assets）
        javac          ->  *.class   (--release 8，classpath = android.jar)
        d8             ->  classes.dex
        注入 dex       ->  完整未签名 APK
        zipalign       ->  4 字节对齐
        apksigner sign ->  dist\shzu-charger.apk（v1+v2+v3 签名）
        验证           ->  apksigner verify + aapt2 dump badging

    幂等：可反复运行，已有产物会被覆盖；产物正常时可跳过重复的 SDK 检查。

.EXAMPLE
    .\build.ps1
.EXAMPLE
    .\build.ps1 -Clean
.EXAMPLE
    .\build.ps1 -WithApp          # 强制把 ..\app 静态文件打进 assets\app
.EXAMPLE
    .\build.ps1 -RecreateKeystore # 重建调试签名 keystore
#>
[CmdletBinding()]
param(
    # 构建前删除 build\ 与 dist\
    [switch]$Clean,
    # 强制把 ..\app 打包进 assets（离线兜底 UI）
    [switch]$WithApp,
    # 强制不打包 app
    [switch]$NoApp,
    # 跳过最后的验证步骤
    [switch]$SkipVerify,
    # 删除并重建 keystore
    [switch]$RecreateKeystore,
    # Android SDK 根目录（默认自动探测）
    [string]$SdkRoot = '',
    # JDK 根目录（默认自动探测）
    [string]$JavaHome = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ---------------------------------------------------------------------------
# 0. 路径常量
# ---------------------------------------------------------------------------
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ResDir     = Join-Path $Root 'res'
$SrcDir     = Join-Path $Root 'src'
$Manifest   = Join-Path $Root 'AndroidManifest.xml'
$WebAssets  = Join-Path $Root 'webassets'
$AppDir     = Join-Path (Split-Path -Parent $Root) 'app'
$BuildDir   = Join-Path $Root 'build'
$DistDir    = Join-Path $Root 'dist'
$KeystoreDir= Join-Path $Root 'keystore'
$Keystore   = Join-Path $KeystoreDir 'shzu-charger.jks'
$KsAlias    = 'shzu-charger'
$KsPass     = 'shzu-charger-2024'
$ApkName    = 'shzu-charger.apk'
$FinalApk   = Join-Path $DistDir $ApkName

$GenDir     = Join-Path $BuildDir 'gen'
$ClassesDir = Join-Path $BuildDir 'classes'
$DexDir     = Join-Path $BuildDir 'dex'
$AssetsDir  = Join-Path $BuildDir 'assets'
$FlatZip    = Join-Path $BuildDir 'res-flat.zip'
$BaseApk    = Join-Path $BuildDir 'base-unsigned.apk'
$DexedApk   = Join-Path $BuildDir 'dexed-unsigned.apk'
$AlignedApk = Join-Path $BuildDir 'aligned-unsigned.apk'
$LogFile    = Join-Path $BuildDir 'build.log'

$MinSdk = 24
$TargetSdk = 34

# ---------------------------------------------------------------------------
# 1. 小工具
# ---------------------------------------------------------------------------
$script:StepIndex = 0
$script:StepTotal = 10

function Write-Step {
    param([string]$Text)
    $script:StepIndex++
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $script:StepIndex, $script:StepTotal, $Text) -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Text)
    Write-Host ("        " + $Text) -ForegroundColor DarkGray
}

function Write-Ok {
    param([string]$Text)
    Write-Host ("        OK  " + $Text) -ForegroundColor Green
}

function Fail {
    param([string]$Text)
    Write-Host ''
    Write-Host ("[FAIL] " + $Text) -ForegroundColor Red
    Write-Host ("       工作目录: " + $Root) -ForegroundColor DarkGray
    Write-Host ("       构建日志: " + $LogFile) -ForegroundColor DarkGray
    Write-Host ''
    throw $Text
}

# 运行一个外部程序；失败则抛错，并在消息里带上命令与退出码
function Invoke-Tool {
    param(
        [parameter(Mandatory)][string]$Exe,
        [parameter(Mandatory)][string[]]$ArgList,
        [parameter(Mandatory)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Exe)) {
        Fail "找不到可执行文件: $Exe（$Label）"
    }
    Write-Detail ("$Exe " + ($ArgList -join ' '))
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @ArgList 2>&1 | ForEach-Object {
            $line = [string]$_
            Write-Host ("        " + $line) -ForegroundColor DarkGray
            Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) {
        Fail "$Label 失败（退出码 $code）"
    }
}

# ---------------------------------------------------------------------------
# 2. 定位工具链
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '==========================================' -ForegroundColor White
Write-Host ' 石大充电桩 APK 构建（无 gradle 手工链路）' -ForegroundColor White
Write-Host '==========================================' -ForegroundColor White

function Resolve-SdkRoot {
    param([string]$Hint)
    $cands = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $cands.Add($Hint) }
    if ($env:ANDROID_SDK_ROOT) { $cands.Add($env:ANDROID_SDK_ROOT) }
    if ($env:ANDROID_HOME) { $cands.Add($env:ANDROID_HOME) }
    $cands.Add('D:\ds\android-sdk')
    $cands.Add((Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'build-tools'))) { return $c }
    }
    Fail "找不到 Android SDK。请用 -SdkRoot 指定，或先运行 tools\setup-sdk.ps1 安装。已尝试: $($cands -join ', ')"
}

function Resolve-JavaHome {
    param([string]$Hint)
    $cands = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $cands.Add($Hint) }
    if ($env:JAVA_HOME) { $cands.Add($env:JAVA_HOME) }
    $cands.Add('D:\ds\openjdk-17.0.2\jdk-17.0.2')
    $cands.Add('D:\ds\openjdk-17.0.2')
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'bin\javac.exe'))) { return $c }
    }
    # 兜底：扫描 D:\ds 下的 openjdk* 目录（含一层子目录）
    Get-ChildItem -LiteralPath 'D:\ds' -Directory -Filter 'openjdk*' -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\javac.exe')) { $cands.Add($_.FullName) }
        Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\javac.exe')) { $cands.Add($_.FullName) }
        }
    }
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'bin\javac.exe'))) { return $c }
    }
    Fail "找不到 JDK 17（需要 bin\javac.exe）。请用 -JavaHome 指定。已尝试: $($cands -join ', ')"
}

function Resolve-BuildTools {
    param([string]$Sdk)
    $dir = Join-Path $Sdk 'build-tools'
    $wanted = '34.0.0'
    $exact = Join-Path $dir $wanted
    if (Test-Path -LiteralPath (Join-Path $exact 'aapt2.exe')) { return $exact }
    $best = $null
    $bestVer = $null
    Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe')) {
            $v = $null
            if ([version]::TryParse($_.Name, [ref]$v)) {
                if ($null -eq $bestVer -or $v -gt $bestVer) { $bestVer = $v; $best = $_.FullName }
            }
        }
    }
    if ($best) {
        Write-Host ("        未找到 build-tools $wanted，改用 " + (Split-Path -Leaf $best)) -ForegroundColor Yellow
        return $best
    }
    Fail "找不到 build-tools（需要 aapt2.exe）。请先运行 tools\setup-sdk.ps1 安装 build-tools;34.0.0"
}

function Resolve-PlatformJar {
    param([string]$Sdk)
    $p = Join-Path $Sdk 'platforms\android-34\android.jar'
    if (Test-Path -LiteralPath $p) { return $p }
    $found = Get-ChildItem -LiteralPath (Join-Path $Sdk 'platforms') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object {
            $jar = Join-Path $_.FullName 'android.jar'
            if (Test-Path -LiteralPath $jar) { $jar }
        } | Select-Object -First 1
    if ($found) {
        Write-Host ("        未找到 platforms\android-34，改用 " + $found) -ForegroundColor Yellow
        return $found
    }
    Fail "找不到 android.jar（platforms\android-34）。请先运行 tools\setup-sdk.ps1"
}

# ---------------------------------------------------------------------------
# 3. 清理
# ---------------------------------------------------------------------------
if ($Clean) {
    Write-Host ''
    Write-Host '[clean] 删除 build\ 与 dist\' -ForegroundColor Yellow
    foreach ($d in @($BuildDir, $DistDir)) {
        if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    }
}

foreach ($d in @($BuildDir, $DistDir, $GenDir, $ClassesDir, $DexDir, $AssetsDir, $KeystoreDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
if (-not (Test-Path -LiteralPath $script:LogFile)) { New-Item -ItemType File -Path $script:LogFile -Force | Out-Null }
'' | Set-Content -LiteralPath $LogFile -Encoding UTF8
Add-Content -LiteralPath $LogFile -Value ("build started " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8

Write-Step '定位工具链'
$Sdk        = Resolve-SdkRoot  -Hint $SdkRoot
$Jdk        = Resolve-JavaHome -Hint $JavaHome
$BuildTools = Resolve-BuildTools -Sdk $Sdk
$AndroidJar = Resolve-PlatformJar -Sdk $Sdk

$Aapt2      = Join-Path $BuildTools 'aapt2.exe'
$ZipAlign   = Join-Path $BuildTools 'zipalign.exe'
$ApkSignerJar = Join-Path $BuildTools 'lib\apksigner.jar'
$D8Jar      = Join-Path $BuildTools 'lib\d8.jar'
$JavaExe    = Join-Path $Jdk 'bin\java.exe'
$JavacExe   = Join-Path $Jdk 'bin\javac.exe'
$JarExe     = Join-Path $Jdk 'bin\jar.exe'
$KeytoolExe = Join-Path $Jdk 'bin\keytool.exe'

if (-not (Test-Path -LiteralPath $JarExe))       { Fail "缺少 jar.exe（JDK 不完整？）: $JarExe" }
if (-not (Test-Path -LiteralPath $ApkSignerJar)) { Fail "缺少 apksigner.jar: $ApkSignerJar" }
if (-not (Test-Path -LiteralPath $D8Jar))       { Fail "缺少 d8.jar: $D8Jar" }

Write-Ok "SDK         $Sdk"
Write-Ok "build-tools $BuildTools"
Write-Ok "android.jar $AndroidJar"
Write-Ok "JDK         $Jdk"

# 让 build-tools 的 .bat 与 apksigner 内部能找到 java
$env:JAVA_HOME = $Jdk
$env:Path = (Join-Path $Jdk 'bin') + ';' + $env:Path

# ---------------------------------------------------------------------------
# 4. 组装 assets
# ---------------------------------------------------------------------------
Write-Step '组装 assets'
if (Test-Path -LiteralPath $AssetsDir) { Remove-Item -LiteralPath $AssetsDir -Recurse -Force }
New-Item -ItemType Directory -Path $AssetsDir -Force | Out-Null

# 4.1 离线兜底页（必带）
$offlineSrc = Join-Path $WebAssets 'offline.html'
if (-not (Test-Path -LiteralPath $offlineSrc)) { Fail "缺少离线兜底页: $offlineSrc" }
Copy-Item -LiteralPath $offlineSrc -Destination $AssetsDir -Force
Write-Ok 'assets\offline.html'

# 4.2 可选：把 ..\app 的静态文件打包进 assets\app 作为离线界面
$packApp = $false
if ($WithApp) {
    $packApp = $true
} elseif ($NoApp) {
    $packApp = $false
} else {
    $packApp = Test-Path -LiteralPath (Join-Path $AppDir 'index.html')
}

if ($packApp) {
    $appIndex = Join-Path $AppDir 'index.html'
    if (-not (Test-Path -LiteralPath $appIndex)) {
        Fail "-WithApp 指定了打包 app，但找不到 $appIndex"
    }
    $AppAssets = Join-Path $AssetsDir 'app'
    New-Item -ItemType Directory -Path $AppAssets -Force | Out-Null
    $allowed = @('.html', '.js', '.css', '.json', '.webmanifest', '.png', '.jpg', '.jpeg',
                 '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.map')
    $skipDirs = @('tests', 'tools', 'node_modules', '.git')
    $script:copied = 0
    $script:bytes = 0
    Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $rel = $_.FullName.Substring($AppDir.Length).TrimStart('\', '/')
        $parts = $rel -split '[\\/]'
        $skip = $false
        foreach ($p in $parts) {
            if ($skipDirs -contains $p) { $skip = $true; break }
        }
        if ($skip) { return }
        if ($allowed -notcontains $_.Extension.ToLowerInvariant()) { return }
        $dest = Join-Path $AppAssets $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        $script:copied = $script:copied + 1
        $script:bytes = $script:bytes + $_.Length
    }
    Write-Ok ("assets\app  " + $script:copied + " 个文件, " + [math]::Round($script:bytes/1024, 1) + " KB")
} else {
    Write-Detail '跳过 assets\app（..\app\index.html 不存在或 -NoApp）'
}

# ---------------------------------------------------------------------------
# 5. aapt2 compile
# ---------------------------------------------------------------------------
Write-Step 'aapt2 compile（编译资源）'
if (Test-Path -LiteralPath $FlatZip) { Remove-Item -LiteralPath $FlatZip -Force }
Invoke-Tool -Exe $Aapt2 -ArgList @('compile', '--dir', $ResDir, '-o', $FlatZip) -Label 'aapt2 compile'
Write-Ok ("res-flat.zip  " + [math]::Round((Get-Item -LiteralPath $FlatZip).Length/1KB, 1) + ' KB')

# ---------------------------------------------------------------------------
# 6. aapt2 link
# ---------------------------------------------------------------------------
Write-Step 'aapt2 link（生成基础 APK + R.java）'
if (Test-Path -LiteralPath $GenDir) { Remove-Item -LiteralPath $GenDir -Recurse -Force }
New-Item -ItemType Directory -Path $GenDir -Force | Out-Null
if (Test-Path -LiteralPath $BaseApk) { Remove-Item -LiteralPath $BaseApk -Force }

$linkArgs = @(
    'link',
    '-o', $BaseApk,
    '-I', $AndroidJar,
    '--manifest', $Manifest,
    '--java', $GenDir,
    '-A', $AssetsDir,
    '--min-sdk-version', "$MinSdk",
    '--target-sdk-version', "$TargetSdk",
    '--auto-add-overlay',
    $FlatZip
)
Invoke-Tool -Exe $Aapt2 -ArgList $linkArgs -Label 'aapt2 link'
if (-not (Test-Path -LiteralPath $BaseApk)) { Fail "aapt2 link 未产出 $BaseApk" }
Write-Ok ("base-unsigned.apk  " + [math]::Round((Get-Item -LiteralPath $BaseApk).Length/1KB, 1) + ' KB')

# ---------------------------------------------------------------------------
# 7. javac + d8
# ---------------------------------------------------------------------------
Write-Step 'javac 编译 Java 源码'
if (Test-Path -LiteralPath $ClassesDir) { Remove-Item -LiteralPath $ClassesDir -Recurse -Force }
New-Item -ItemType Directory -Path $ClassesDir -Force | Out-Null

$javaFiles = @(Get-ChildItem -LiteralPath $SrcDir -Recurse -Filter '*.java' -File | ForEach-Object { $_.FullName })
$rJava = @(Get-ChildItem -LiteralPath $GenDir -Recurse -Filter '*.java' -File | ForEach-Object { $_.FullName })
$allJava = @($javaFiles + $rJava)
if ($allJava.Count -eq 0) { Fail "在 $SrcDir 下没有找到任何 .java 文件" }
Write-Detail ("源码 " + $javaFiles.Count + " 个 + 生成的 R.java " + $rJava.Count + " 个")

$javacArgs = @(
    '-encoding', 'UTF-8',
    # javac 的诊断信息跟随 JVM 的 locale，中文 Windows 上会输出 GBK 字节流，
    # 被 PowerShell 按 UTF-8 收进 build.log 就成乱码。强制英文消息，日志才干净。
    '-J-Duser.language=en',
    '-J-Duser.country=US',
    '-source', '8',
    '-target', '8',
    '-nowarn',
    '-Xlint:-options',
    '-classpath', $AndroidJar,
    '-d', $ClassesDir
) + $allJava
Invoke-Tool -Exe $JavacExe -ArgList $javacArgs -Label 'javac'

$classCount = @(Get-ChildItem -LiteralPath $ClassesDir -Recurse -Filter '*.class' -File).Count
if ($classCount -eq 0) { Fail 'javac 没有产出任何 .class' }
Write-Ok ("$classCount 个 .class")

Write-Step 'd8（class -> dex）'
if (Test-Path -LiteralPath $DexDir) { Remove-Item -LiteralPath $DexDir -Recurse -Force }
New-Item -ItemType Directory -Path $DexDir -Force | Out-Null

# d8 只吃单个 .class 文件或 .jar，直接把 classes 目录丢给它会被判为
# "Unsupported source file type"。所以先打成 jar 再喂（jar 里不含 META-INF
# 也能用；这里排除签名相关条目避免扰动）。
$ClassesJar = Join-Path $BuildDir 'classes.jar'
if (Test-Path -LiteralPath $ClassesJar) { Remove-Item -LiteralPath $ClassesJar -Force }
$jarArgs = @('cf', $ClassesJar, '-C', $ClassesDir, '.')
Invoke-Tool -Exe $JarExe -ArgList $jarArgs -Label 'jar (classes)'
Write-Ok ("classes.jar  " + [math]::Round((Get-Item -LiteralPath $ClassesJar).Length/1KB, 1) + ' KB')

$d8Args = @(
    '-cp', $D8Jar,
    'com.android.tools.r8.D8',
    '--release',
    '--min-api', "$MinSdk",
    '--lib', $AndroidJar,
    '--output', $DexDir,
    $ClassesJar
)
Invoke-Tool -Exe $JavaExe -ArgList $d8Args -Label 'd8'

$dexFile = Join-Path $DexDir 'classes.dex'
if (-not (Test-Path -LiteralPath $dexFile)) { Fail "d8 未产出 $dexFile" }
Write-Ok ("classes.dex  " + [math]::Round((Get-Item -LiteralPath $dexFile).Length/1KB, 1) + ' KB')

# ---------------------------------------------------------------------------
# 8. 注入 dex -> zipalign
# ---------------------------------------------------------------------------
Write-Step '注入 classes.dex 到 APK'
$PackScript = Join-Path $Root 'tools\pack_apk.py'
if (-not (Test-Path -LiteralPath $PackScript)) { Fail "缺少注入脚本: $PackScript" }
if (Test-Path -LiteralPath $DexedApk) { Remove-Item -LiteralPath $DexedApk -Force }
$pythonCmd = $null
foreach ($py in @('python', 'python3', 'py')) {
    $cmd = Get-Command $py -ErrorAction SilentlyContinue
    if ($cmd) { $pythonCmd = $cmd.Source; break }
}
if (-not $pythonCmd) { Fail '找不到 python，无法注入 classes.dex（也可以手动把 classes.dex 加进 APK）' }
Invoke-Tool -Exe $pythonCmd -ArgList @($PackScript, $BaseApk, $dexFile, $DexedApk) -Label 'pack_apk'
Write-Ok ("dexed-unsigned.apk  " + [math]::Round((Get-Item -LiteralPath $DexedApk).Length/1KB, 1) + ' KB')

Write-Step 'zipalign（4 字节对齐）'
if (Test-Path -LiteralPath $AlignedApk) { Remove-Item -LiteralPath $AlignedApk -Force }
Invoke-Tool -Exe $ZipAlign -ArgList @('-p', '-f', '4', $DexedApk, $AlignedApk) -Label 'zipalign'
Write-Ok ("aligned  " + [math]::Round((Get-Item -LiteralPath $AlignedApk).Length/1KB, 1) + ' KB')

# ---------------------------------------------------------------------------
# 9. 签名
# ---------------------------------------------------------------------------
Write-Step '签名 APK'
if ($RecreateKeystore -and (Test-Path -LiteralPath $Keystore)) {
    Write-Detail "删除旧 keystore: $Keystore"
    Remove-Item -LiteralPath $Keystore -Force
}
if (-not (Test-Path -LiteralPath $Keystore)) {
    Write-Detail 'keystore 不存在，正在生成（自用调试签名）'
    $dname = 'CN=SHZU Charger Debug, OU=Android, O=SHZU, L=Shihezi, ST=Xinjiang, C=CN'
    $keytoolArgs = @(
        '-genkeypair',
        '-keystore', $Keystore,
        '-storetype', 'PKCS12',
        '-alias', $KsAlias,
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-storepass', $KsPass,
        '-keypass', $KsPass,
        '-dname', $dname,
        '-noprompt'
    )
    Invoke-Tool -Exe $KeytoolExe -ArgList $keytoolArgs -Label 'keytool -genkeypair'
    Write-Ok "keystore 已生成: $Keystore"
} else {
    Write-Ok "复用已有 keystore: $Keystore"
}

if (Test-Path -LiteralPath $FinalApk) { Remove-Item -LiteralPath $FinalApk -Force }
$signArgs = @(
    '-jar', $ApkSignerJar,
    'sign',
    '--ks', $Keystore,
    '--ks-key-alias', $KsAlias,
    '--ks-pass', "pass:$KsPass",
    '--key-pass', "pass:$KsPass",
    '--min-sdk-version', "$MinSdk",
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    '--out', $FinalApk,
    $AlignedApk
)
Invoke-Tool -Exe $JavaExe -ArgList $signArgs -Label 'apksigner sign'
if (-not (Test-Path -LiteralPath $FinalApk)) { Fail "apksigner 未产出 $FinalApk" }
Write-Ok ("dist\$ApkName  " + [math]::Round((Get-Item -LiteralPath $FinalApk).Length/1KB, 1) + ' KB')

# ---------------------------------------------------------------------------
# 10. 验证
# ---------------------------------------------------------------------------
if ($SkipVerify) {
    Write-Host ''
    Write-Host '[-SkipVerify] 跳过验证' -ForegroundColor Yellow
} else {
    Write-Step '验证产物'
    Write-Host ''
    Write-Host '--- apksigner verify --verbose --print-certs ---' -ForegroundColor Yellow
    $ErrorActionPreference = 'Continue'
    & $JavaExe -jar $ApkSignerJar verify --verbose --print-certs --min-sdk-version $MinSdk $FinalApk 2>&1 |
        ForEach-Object { Write-Host $_ ; Add-Content -LiteralPath $LogFile -Value $_ -Encoding UTF8 }
    $verifyCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($verifyCode -ne 0) { Fail "apksigner verify 失败（退出码 $verifyCode）" }

    Write-Host ''
    Write-Host '--- aapt2 dump badging ---' -ForegroundColor Yellow
    $ErrorActionPreference = 'Continue'
    & $Aapt2 dump badging $FinalApk 2>&1 |
        ForEach-Object { Write-Host $_ ; Add-Content -LiteralPath $LogFile -Value $_ -Encoding UTF8 }
    $badgingCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($badgingCode -ne 0) { Fail "aapt2 dump badging 失败（退出码 $badgingCode）" }

    # 关键字段断言
    Write-Host ''
    $badging = & $Aapt2 dump badging $FinalApk 2>&1 | Out-String
    $checks = @(
        @{ Name = 'package name'; Pattern = "package: name='cn\.edu\.shzu\.charger'" },
        @{ Name = 'versionCode';  Pattern = "versionCode='\d+'" },
        @{ Name = 'minSdk';       Pattern = "sdkVersion:'$MinSdk'" },
        @{ Name = 'targetSdk';    Pattern = "targetSdkVersion:'$TargetSdk'" },
        @{ Name = 'launchable';   Pattern = "launchable-activity: name='cn\.edu\.shzu\.charger\.MainActivity'" }
    )
    $failed = 0
    foreach ($c in $checks) {
        if ($badging -match $c.Pattern) {
            Write-Host ("  [PASS] " + $c.Name) -ForegroundColor Green
        } else {
            Write-Host ("  [FAIL] " + $c.Name + "  (期望匹配 " + $c.Pattern + ")") -ForegroundColor Red
            $failed++
        }
    }
    if ($failed -gt 0) { Fail "badging 关键字段校验未通过（$failed 项）" }
    Write-Host ''
    Write-Host '  [PASS] apksigner verify 通过' -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 完成
# ---------------------------------------------------------------------------
$finalSize = (Get-Item -LiteralPath $FinalApk).Length
$sha256 = (Get-FileHash -LiteralPath $FinalApk -Algorithm SHA256).Hash

Write-Host ''
Write-Host '==========================================' -ForegroundColor Green
Write-Host ' 构建成功' -ForegroundColor Green
Write-Host '==========================================' -ForegroundColor Green
Write-Host (" APK    : " + $FinalApk)
Write-Host (" 体积   : " + [math]::Round($finalSize/1KB, 1) + " KB (" + $finalSize + " 字节)")
Write-Host (" SHA256 : " + $sha256)
Write-Host (" 日志   : " + $LogFile)
Write-Host (' 安装   : adb install -r "' + $FinalApk + '"')
Write-Host ''

Add-Content -LiteralPath $LogFile -Value ("build OK " + $FinalApk + " " + $finalSize + " bytes sha256=" + $sha256) -Encoding UTF8
