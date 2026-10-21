# 石大充电桩 · Android 壳 APK

把 `../app/` 的 PWA 包成一个**能装到手机上、点开就能用、零配置**的 APK。

- 包名：`cn.edu.shzu.charger`
- 版本：`1.0.0`（versionCode 1）
- minSdk **24**（Android 7.0）/ targetSdk **34**（Android 14）
- 产物：`dist/shzu-charger.apk`（已签名，可直接安装）
  - 体积约 **242 KB**（248,182 字节，含内置 UI；`-NoApp` 纯壳约 125 KB）；SHA256 **每次重建都会变**
    （zip 条目时间戳 + 签名时间 + 内置 UI 快照），以 `build.bat` 结尾打印的那一行为准，
    当前这份是 `71343599209A88D8B5938767CC81D7161C63ECA7A190485AA02B2B27F5547338`。
    真正不变的是签名证书指纹（见第五节）和 `versionCode`。
- 不用 gradle、不用 Android Studio、不用 Kotlin：整条链路是
  `aapt2 compile → aapt2 link → javac → d8 → 注入 dex → zipalign → apksigner`

> **开箱即用，零配置**：APK 启动后直接用**内置 UI**，数据先试局域网中继
> `http://192.168.0.100:8080`，连不上自动转**公共频道**（ntfy.sh）。
> 界面上**没有**任何中继地址设置入口，装好点开就行。
> relay 地址改在 `src/cn/edu/shzu/charger/RelayConfig.java` 的 `DEFAULT_RELAY`，改完重打 APK。

---

## 一、装到手机上

APK 是**自签名**的（调试签名，见第五节），所以手机要允许「安装未知来源应用」。

### 方法 A：直接传文件（最常用，不需要数据线）

1. 把 `dist/shzu-charger.apk` 传到手机：微信「文件传输助手」发给自己、QQ 我的电脑、
   或者数据线拷进 `Download/`、或者用 `python -m http.server` 起个临时服务在手机浏览器下载。
2. 手机上点开这个 `.apk` 文件 → 「安装」。
3. 首次会弹「未知来源」/「外部来源应用」授权，允许「文件管理」或「微信」安装应用即可。
4. 装完桌面出现图标「**石大充电桩**」（深色底 + 绿色闪电 + 电量条）。**点开即用，无需任何设置。**

### 方法 B：adb install（有数据线时）

本机 adb 在 `C:\Users\Administrator\AppData\Local\Android\platform-tools\adb.exe`：

```powershell
$adb = "C:\Users\Administrator\AppData\Local\Android\platform-tools\adb.exe"
& $adb devices              # 手机上打开「开发者选项 → USB 调试」并授权后能列出设备
& $adb install -r "D:\ds\charging\android\dist\shzu-charger.apk"
```

装完直接启动：

```powershell
& $adb shell am start -n cn.edu.shzu.charger/.MainActivity
```

卸载：

```powershell
& $adb uninstall cn.edu.shzu.charger
```

> `install -r` 是覆盖安装，会保留本地缓存；想清空配置就 `adb shell pm clear cn.edu.shzu.charger`。

---

## 二、首次启动：什么都不用做

App 是**壳 + 内置前端**：`assets/app/` 里打包了一份 `../app/` 的静态页面，
启动直接加载它（`file:///android_asset/app/index.html`），没有引导页、没有地址输入框、没有设置按钮。

数据来源（内置前端自己按顺序试，壳层不干预）：

1. **局域网中继** `http://192.168.0.100:8080` —— 手机和平板在同一 Wi-Fi 时最快最新，
   壳子把地址以 `?relay=` 参数传进去（见 `MainActivity.loadBundledApp()`）
2. **公共频道**（ntfy.sh topic `shzu-charger-7f3a9c2e`）—— 上面那步连不上就自动降级到这里，
   只要求手机能上网，不需要在校园网里
3. 本地缓存 `localStorage` / Service Worker —— 断网时显示上一次的数据

所以把 APK 发给同学，对方**不用填任何地址**就能看到数据。

想让局域网中继生效：平板（Termux）上先把 relay 跑起来（`cd relay && python server.py --port 8080`），
并确认平板在局域网里的 IP 是 `192.168.0.100`；不是的话改
`src/cn/edu/shzu/charger/RelayConfig.java` 的 `DEFAULT_RELAY` 后重新 `build.bat`。

---

## 三、改中继地址（平板换 IP 了怎么办）

**界面上没有入口**（用户要求隐藏）。三种改法：

| 场景 | 做法 |
|---|---|
| 只是平板换了 IP | 改 `RelayConfig.java` 的 `DEFAULT_RELAY` → `build.bat` → 覆盖安装 |
| 临时让某台设备连别的地址 | 打开内置页并带参数：`file:///android_asset/app/index.html?relay=http://10.0.0.5:8080`（`../app/config.js` 会把 `?relay=` 写进 `localStorage`） |
| 想彻底关掉局域网探测 | `RelayConfig.preferPublicFeed()` 默认 `false`（= 先试局域网）；让它读 `true` 就只用公共频道 |

`../app/config.js` 的 relay 解析优先级：URL 参数 `?relay=` → `localStorage["shzu.relay"]` → 同源。
壳层每次启动都会用 `?relay=<内置地址>` 覆盖一遍，保证「先试局域网」不被历史值带偏。

---

## 四、连不上时 App 会做什么

不会白屏。

1. **内置 UI 本身是本地文件**，永远能打开；relay 连不上时是前端自己在内部降级到公共频道，
   用户看到的是正常界面 + 一行提示，**不会**跳到错误页，也不需要用户做任何操作。
2. 万一内置 UI 那个文件都加载不出来（极罕见）→ 显示原生错误面板（纯 Java 布局，
   文案「正在使用公共频道」），再不行才退回 `assets/offline.html` 离线页。
3. 用 `-NoApp` 只做壳（不打 `../app/`）时，App 会直接加载 relay 地址；
   那种情况下 relay 不可达才会走离线页 —— 正常交付的 APK 不是这种模式。

`usesCleartextTraffic="true"` + `network_security_config.xml` 允许明文 http：
relay 是局域网 http，不加这个 Android 9+ 会直接拦掉。
https 自签证书也会放行（`onReceivedSslError` 里 proceed），避免填了 https 反而白屏。

---

## 五、签名（keystore 说明）

只有自己用，所以用的是**提交在仓库里的调试签名**，密码明文写在下面，
换机器/换人也能继续覆盖安装（同一签名才能 `install -r` 升级）。

| 项 | 值 |
|---|---|
| keystore | `keystore/shzu-charger.jks`（PKCS12） |
| alias | `shzu-charger` |
| storepass | `shzu-charger-2024` |
| keypass | `shzu-charger-2024` |
| keyalg / keysize | RSA / 2048 |
| validity | 10000 天 |
| DN | `CN=SHZU Charger Debug, OU=Android, O=SHZU, L=Shihezi, ST=Xinjiang, C=CN` |

keystore 不存在时 `build.ps1` 会自动生成。想换一套新的（比如要发给你同学装）：

```powershell
.\build.bat -RecreateKeystore    # 删掉旧 jks 重新生成，之后所有 APK 要用同样方式重装
```

> 换了签名后，手机上必须先卸载旧 App 才能装新的（签名不一致 Android 拒绝覆盖安装）。

---

## 六、重新构建

### 前置：SDK 与 JDK

本机原本**没有 Android SDK、没有 gradle**，是先手装的最小工具链：

```powershell
# 一键复现（含 URL / licenses / 包集合，全部可重跑）
.\tools\install_android_sdk.ps1
```

它做的事（也是实际执行过的命令）：

```powershell
# 1. 下载 command-line tools（共 153,583,359 字节）
#    https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip
#    解压后把顶层 cmdline-tools 摆到 D:\ds\android-sdk\cmdline-tools\latest
# 2. 接受 licenses：把 100 行 "y\r\n" 写进 ys.txt，再用 CRT 重定向喂给 sdkmanager
cmd /c ""D:\ds\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses < ys.txt"
#    → 输出 "All SDK package licenses accepted"，生成 licenses\ 下 8 个文件
# 3. 装最小包集合
cmd /c ""D:\ds\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=D:\ds\android-sdk `
        "platforms;android-34" "build-tools;34.0.0" "platform-tools""
```

踩过的坑：`sdkmanager` 是 `.bat`，在 PowerShell 里直接管道喂 `y` 有时拿不到输入，
用 `cmd /c "... < ys.txt"` 的 CRT stdin 重定向才稳定；
`$env:JAVA_HOME` 必须显式设成 `D:\ds\openjdk-17.0.2\jdk-17.0.2`（**注意多一层 `jdk-17.0.2` 子目录**，
`D:\ds\openjdk-17.0.2\bin\java.exe` 这个路径是不存在的）。

> 如果哪天 `sdkmanager` 因为网络或许可问题彻底装不上，退路是直接下两个单包手工摆：
> `https://dl.google.com/android/repository/build-tools_r34-windows.zip`（aapt2/zipalign/d8/apksigner）
> 和 `https://dl.google.com/android/repository/platform-34-ext7_r03.zip`（android.jar），
> 解压成 `<sdk>\build-tools\34.0.0\` 与 `<sdk>\platforms\android-34\` 即可，不需要 licenses。

### 构建

```powershell
cd D:\ds\charging\android
.\build.bat              # 正常构建
.\build.bat -Clean       # 先删 build\ 和 dist\ 再全量构建
.\build.bat -WithApp     # 强制把 ..\app\ 打进 assets（默认检测到 ..\app\index.html 就会打）
.\build.bat -NoApp       # 只做壳，不打包 app（体积更小，离线时只有 offline.html）
.\build.bat -SkipVerify  # 跳过最后的 apksigner verify / aapt2 dump badging
.\build.bat -SdkRoot E:\android-sdk -JavaHome "D:\jdk17"   # 换 SDK/JDK 位置
.\build.bat -RecreateKeystore   # 删掉旧 jks 重新生成签名
```

构建前想先自检资源引用（不调 SDK，秒出）:

```
python tools\check_refs.py
```

改过 `.ps1` 里的中文而构建报「Missing expression / string is missing the terminator」
这类怪语法错，是文件丢了 UTF-8 BOM，跑一下就能好：

```
python tools\fix_bom.py
```

`build.bat` 是个薄壳，作用是先给 `build.ps1` 补 UTF-8 BOM（PowerShell 5.1 只认带 BOM 的
`.ps1` 为 UTF-8，否则中文全乱、字符串比较直接崩），然后 `powershell -File build.ps1`。
也可以直接 `powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1`，
前提是这个文件本身已经存成 **UTF-8 with BOM**。

构建日志落在 `build/build.log`，控制台会同步打印。10 个阶段：

```
[1/10] 定位工具链        ← 探测 SDK/build-tools/android.jar/JDK
[2/10] 组装 assets       ← webassets/offline.html + 可选 ..\app\ → build\assets
[3/10] aapt2 compile     ← res/ → build\res-flat.zip
[4/10] aapt2 link        ← 生成 build\base-unsigned.apk + build\gen\...\R.java
[5/10] javac             ← src\ + R.java → build\classes
[6/10] d8                ← classes.jar → build\dex\classes.dex
[7/10] 注入 classes.dex  ← tools\pack_apk.py 把 dex 塞进 base apk
[8/10] zipalign          ← -p -f 4
[9/10] 签名              ← apksigner（v1+v2+v3）
[10/10] 验证产物         ← apksigner verify --verbose --print-certs + aapt2 dump badging
```

为什么需要 `tools/pack_apk.py` 这一步：`aapt2 link` 只会产出**资源 apk，不含 dex**，
而 build-tools 里没有 `aapt add` 这种能顺手塞 dex 的命令（`aapt add` 也不处理对齐）。
所以先用 Python 标准库 `zipfile` 把 `classes.dex` 按正确方式追加进去（保留其余条目的
压缩方式/时间戳），再交给 zipalign。**顺序不能反**：先 zipalign 再塞 dex 会破坏 4 字节对齐，
apksigner 也会拒绝。

改代码后重建只要重跑 `build.bat`，约 15 秒。改图标跑 `python tools\make_icons.py`
（PIL 自绘，超采样 4x，输出 5 个密度的 `ic_launcher.png` / `ic_launcher_round.png`）。

---

## 七、验证产物

一条命令跑完全部检查（签名 / badging / manifest xmltree / 资源 / dex / assets 清单），
报告写到 `dist\verify.txt`，退出码 0 = 全部通过：

```
cd D:\ds\charging\android
tools\verify.bat
```

等价的手工命令（报告里贴的就是这两条的原始输出）：

```powershell
cd D:\ds\charging\android
$java = 'D:\ds\openjdk-17.0.2\jdk-17.0.2\bin\java.exe'
$as   = 'D:\ds\android-sdk\build-tools\34.0.0\lib\apksigner.jar'
$aapt2 = 'D:\ds\android-sdk\build-tools\34.0.0\aapt2.exe'

# 签名校验
& $java -jar $as verify --verbose --print-certs --min-sdk-version 24 dist\shzu-charger.apk

# 包信息
& $aapt2 dump badging dist\shzu-charger.apk
```

`apksigner verify` 的预期输出（实测，2026-10 构建）：

```
Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
Signer #1 certificate DN: CN=SHZU Charger Debug, OU=Android, O=SHZU, L=Shihezi, ST=Xinjiang, C=CN
Signer #1 certificate SHA-256 digest: a4e10c50b4f8c7c0467f8fb3f025902104c4a723b897ef1d499dfbadf97978eb
Signer #1 certificate SHA-1 digest: 878b2924b74cee592eb4705d977c5d1ce514c62d
Signer #1 certificate MD5 digest: 2f460858e044eabe3f7803cf262378bb
Signer #1 key algorithm: RSA
Signer #1 key size (bits): 2048
Signer #1 public key SHA-256 digest: 34f57e66ed74292a6b9ed177c6b48e1526600bc459087e1b902455adb6b08ed9
Signer #1 public key SHA-1 digest: bfc76c962ddb1d0f687bd1cef851d19dd71e0030
Signer #1 public key MD5 digest: 5e646190091e4bb58e9e2dc56a066ef8
```

`Verified using v1 scheme: false` 是**正常的**：v1 只对 minSdk < 24 的机器有意义，
apksigner 见到 `--min-sdk-version 24` 就不生成 v1（也验证不到）。
用 `--min-sdk-version 21` 去 verify 就能看到 v1 = true，说明三套签名都完整：

```powershell
& $java -jar $as verify --verbose --min-sdk-version 21 dist\shzu-charger.apk
# Verified using v1 scheme (JAR signing): true
# Verified using v2 scheme (APK Signature Scheme v2): true
# Verified using v3 scheme (APK Signature Scheme v3): true
```

`aapt2 dump badging` 的预期关键行：

```
package: name='cn.edu.shzu.charger' versionCode='1' versionName='1.0.0' platformBuildVersionName='14' platformBuildVersionCode='34' compileSdkVersion='34' compileSdkVersionCodename='14'
sdkVersion:'24'
targetSdkVersion:'34'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.ACCESS_WIFI_STATE'
uses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='28'
application-label:'石大充电桩'
application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'
application: label='石大充电桩' icon='res/mipmap-mdpi-v4/ic_launcher.png'
launchable-activity: name='cn.edu.shzu.charger.MainActivity'  label='' icon=''
supports-screens: 'small' 'normal' 'large' 'xlarge'
densities: '160' '240' '320' '480' '640'
```

---

## 八、目录结构

```
android/
├─ AndroidManifest.xml          包名/版本/权限/主题（minSdk、targetSdk 由 aapt2 link 参数注入）
├─ build.bat                    构建入口（补齐 BOM 后调 build.ps1）
├─ build.ps1                    无 gradle 的完整构建链路 + 验证
├─ src/cn/edu/shzu/charger/
│  ├─ MainActivity.java         单 Activity + WebView：启动即内置 UI/超时/离线兜底/返回键/下载/JS 桥
│  └─ RelayConfig.java          relay 地址校验与 SharedPreferences 存取
├─ res/
│  ├─ layout/activity_main.xml  WebView + 进度条 + 原生错误面板（引导页/齿轮布局保留但默认隐藏）
│  ├─ values/{strings,styles,colors}.xml
│  ├─ xml/network_security_config.xml   允许明文 http
│  ├─ drawable/ic_launcher_big.png
│  └─ mipmap-{m,h,x,xx,xxx}dpi/       自绘图标（普通 + round）
├─ webassets/offline.html       内置离线页（中文，用公共频道/重试/打开内置 UI）
├─ tools/
│  ├─ install_android_sdk.ps1   从零装 SDK（下载记录 + 可重跑）
│  ├─ pack_apk.py               往 aapt2 产出的 apk 里注入 classes.dex
│  ├─ make_icons.py             PIL 自绘图标
│  ├─ verify.bat                验证入口（补 BOM 后调 verify.ps1）
│  ├─ verify.ps1                全量静态校验，报告写 dist\verify.txt
│  ├─ fix_bom.py                给 .ps1 补 UTF-8 BOM（PS 5.1 必需，幂等）
│  ├─ check_refs.py             构建前静态检查：资源引用是否都能解析
│  ├─ check_offline.py          离线页 offline.html 静态校验（node 沙箱）
│  └─ check_bundled_app.py      内置 UI（assets/app）静态校验（node 沙箱）
├─ keystore/shzu-charger.jks    调试签名（密码见第五节）
├─ build/                       中间产物 + build.log（可删，重建会重新生成）
└─ dist/shzu-charger.apk        ★ 最终产物
```

---

## 九、实现要点（给以后改代码的人）

- **单 Activity**：`MainActivity extends Activity`（没引 AppCompat，省依赖）。
  界面用 `res/layout/activity_main.xml` 叠层：`WebView` 铺满，上面盖
  `errorPanel`（原生错误）。`setupPanel`（曾经的 relay 引导页）和 `btnSettings`（齿轮）
  的布局还在，但**默认全 GONE、代码里也不再显示**——中继地址内置，用户无需配置。
- **启动路径**：`onCreate` 里 `bundledAppExists()` 为真就 `loadBundledApp()`
  （`file:///android_asset/app/index.html?relay=<RelayConfig.effectiveRelay()>`），
  否则直接 `loadRelay()`。**任何分支都不会调 `showSetup()`。**
  `RelayConfig.effectiveRelay()` = 已存地址优先 → 没有就用 `DEFAULT_RELAY`
  （`http://192.168.0.100:8080`）；`preferPublicFeed()` 默认 `false`。
- **超时**：`LOAD_TIMEOUT_MS = 15000`，`onPageStarted` 里 `postDelayed`，
  `onPageFinished` 里 `removeCallbacks`。asset 页面（离线页/内置 UI）不计时，
  所以内置 UI 这条路**永远不会**因为 relay 超时而弹离线面板。
- **离线页不会被自己的失败递归**：`onReceivedError` 里判断 failingUrl 是不是
  `file:///android_asset/` 开头，是就直接上原生面板。
- **同源判断**：`shouldOverrideUrlLoading` 里，host 等于 relay host、是局域网私有地址
  （10./172.16-31./192.168./127./裸主机名/*.local）都留在 WebView；公网域名才外跳系统浏览器。
  `tel:` `mailto:` `intent:` 等交给系统。
- **返回键**：`canGoBack()` 就 `goBack()`，否则 2 秒内连按两次才 `finish()`。
  菜单键（`KEYCODE_MENU`）只弹一句「地址已内置，无需配置」，不再打开设置。
- **JS 桥**：`webView.addJavascriptInterface(new ShellBridge(), "ShzuShell")`，
  暴露 `retry()` / `changeRelay()` / `relayUrl()` / `hasBundledApp()` /
  `openBundledApp()` / `toast(msg)`，给离线页和内置 UI 用。
  `changeRelay()` 现在只弹 Toast（界面上没有改地址入口了）。
- **下载**：`setDownloadListener` → `DownloadManager` 存到系统「下载」目录；
  Android ≤ 9 才需要动态申请 `WRITE_EXTERNAL_STORAGE`（manifest 里已加
  `maxSdkVersion="28"`），失败就退回系统浏览器打开。
- **WebView 设置**：JS / DOM Storage / Database / mixed content always allow /
  `setAllowUniversalAccessFromFileURLs(true)`（让 `file://` 的内置 UI 能 XHR 到 http relay）/
  关 SafeBrowsing（局域网 IP 会被误判）。
- **不碰 `../app/`**：本模块只读它。要更新内置那份 UI，改完 `../app/` 重新 `build.bat`。
