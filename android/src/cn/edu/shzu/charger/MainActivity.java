package cn.edu.shzu.charger;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 单 Activity WebView 外壳：
 *  - 首次启动引导填 relay 地址（校验 + /api/health 测试连接）
 *  - 之后每次启动直接加载保存的地址
 *  - 加载失败/超时 → 本地离线页（assets/offline.html），带「重试 / 修改地址」
 *  - 返回键：能后退则后退，否则双击退出
 *  - 外部链接交给系统浏览器；允许文件下载
 */
public class MainActivity extends Activity {

    private static final String TAG = "ShzuCharger";
    private static final String ASSET_OFFLINE = "file:///android_asset/offline.html";
    private static final String ASSET_APP = "file:///android_asset/app/index.html";
    private static final long LOAD_TIMEOUT_MS = 15000L;
    private static final int REQ_WRITE_STORAGE = 1001;

    private WebView webView;
    private ProgressBar progress;
    private ScrollView errorPanel;
    private ScrollView setupPanel;
    private TextView errorTitle;
    private TextView errorBody;
    private TextView setupStatus;
    private EditText editRelay;
    private ImageButton btnSettings;
    private Button btnBundled;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastBackPressAt = 0L;
    private boolean pageShown = false;
    private boolean showingOffline = false;
    private boolean offlineAssetLoaded = false;
    private String pendingDownloadUrl;
    private String pendingDownloadMime;

    private final Runnable loadTimeout = new Runnable() {
        @Override
        public void run() {
            if (!pageShown) {
                Log.w(TAG, "load timeout after " + LOAD_TIMEOUT_MS + "ms");
                showOffline(getString(R.string.msg_test_fail));
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        errorPanel = findViewById(R.id.errorPanel);
        setupPanel = findViewById(R.id.setupPanel);
        errorTitle = findViewById(R.id.errorTitle);
        errorBody = findViewById(R.id.errorBody);
        setupStatus = findViewById(R.id.setupStatus);
        editRelay = findViewById(R.id.editRelay);
        btnSettings = findViewById(R.id.btnSettings);

        configureWebView();

        findViewById(R.id.btnRetry).setOnClickListener(v -> reloadRelay());
        findViewById(R.id.btnOffline).setOnClickListener(v -> openOfflineAsset(null));
        btnBundled = findViewById(R.id.btnBundled);
        btnBundled.setOnClickListener(v -> loadBundledApp());
        btnBundled.setVisibility(bundledAppExists() ? View.VISIBLE : View.GONE);

        // 中继服务相关的设置入口全部隐藏：地址内置，前端自己决定用局域网还是公共频道。
        btnSettings.setVisibility(View.GONE);
        hidePanelKeys();

        // 启动路径：永远不弹 setupPanel。
        // 有已存地址用它，没有就用内置的 DEFAULT_RELAY，然后直接起内置 UI，
        // 把地址以 ?relay= 传进去 —— 前端先试局域网，失败自动转公共频道。
        if (bundledAppExists()) {
            loadBundledApp();
        } else if (!TextUtils.isEmpty(RelayConfig.effectiveRelay(this))) {
            // 没有内置 UI（没跑 -WithApp）时才会走到这里：直接开 relay 页面。
            hidePanels();
            loadRelay();
        } else {
            showNativeError("");
        }
    }

    /** 把「改中继地址」相关的控件全部藏掉（布局里可能还有残留）。 */
    private void hidePanelKeys() {
        View change = findViewById(R.id.btnChangeRelay);
        if (change != null) {
            change.setVisibility(View.GONE);
        }
    }


    // ---------------------------------------------------------------- WebView

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // http relay 是局域网地址，允许混合内容（WebView 默认在 5.0+ 会拦截）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            s.setAllowUniversalAccessFromFileURLs(true);
            s.setAllowFileAccessFromFileURLs(true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new ShellChromeClient());
        webView.addJavascriptInterface(new ShellBridge(), "ShzuShell");
        webView.setDownloadListener(new ShellDownloadListener());
        webView.setLongClickable(true);
        webView.setOnLongClickListener(v -> false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }

    private class ShellChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            progress.setProgress(newProgress);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            super.onReceivedTitle(view, title);
        }
    }

    private class ShellClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            return handleUrl(url);
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url);
        }

        /** 非 relay 的同域链接一律丢给系统浏览器 */
        private boolean handleUrl(String url) {
            if (url == null) {
                return false;
            }
            // 内置 assets（离线页 / 内置 UI）留在 WebView 里加载
            if (url.startsWith("file:///android_asset/")) {
                return false;
            }
            if (url.startsWith("http://") || url.startsWith("https://")) {
                Uri u = Uri.parse(url);
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
                // 局域网 IP 之间互相跳（比如 relay 页面上链到另一台机器的监控页）
                // 也留在 App 内，只有真正的公网域名才外跳。
                if (host.equals(relayHost()) || host.isEmpty() || isPrivateHost(host)) {
                    return false; // 同域/局域网：WebView 内部加载
                }
                openExternal(url);
                return true;
            }
            // tel: mailto: market: intent: 等交给系统
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                Log.w(TAG, "cannot open scheme: " + url, e);
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (url != null && url.startsWith("file:///android_asset/")) {
                return; // 离线页不算超时
            }
            pageShown = false;
            showingOffline = false;
            handler.removeCallbacks(loadTimeout);
            handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url != null && url.startsWith("file:///android_asset/")) {
                offlineAssetLoaded = true;
                hidePanels();
                return;
            }
            pageShown = true;
            handler.removeCallbacks(loadTimeout);
            hidePanels();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && !request.isForMainFrame()) {
                return; // 只关心主文档失败，子资源失败忽略
            }
            String failing = request != null && request.getUrl() != null
                    ? request.getUrl().toString() : "";
            if (failing.startsWith("file:///android_asset/")) {
                // 本地兜底页自身失败：直接上原生面板，别递归
                showNativeError("");
                return;
            }
            String desc = "";
            if (error != null && error.getDescription() != null) {
                desc = error.getDescription().toString();
            }
            Log.w(TAG, "main frame error: " + desc);
            handler.removeCallbacks(loadTimeout);
            showOffline(desc);
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (failingUrl == null || failingUrl.startsWith("file:///android_asset/")) {
                return;
            }
            handler.removeCallbacks(loadTimeout);
            showOffline(description);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler2, android.net.http.SslError error) {
            // relay 通常是 http；若用户填了 https 自签证书，这里放行，避免白屏
            handler2.proceed();
        }
    }

    private class ShellDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimetype, long contentLength) {
            if (url == null) {
                return;
            }
            if (url.startsWith("http://") || url.startsWith("https://")) {
                enqueueDownload(url, mimetype);
            } else {
                openExternal(url);
            }
        }
    }

    // ------------------------------------------------------------- JS 桥

    private class ShellBridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::reloadRelay);
        }

        @JavascriptInterface
        public void changeRelay() {
            // 中继地址已内置，界面上不再提供修改入口
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    R.string.msg_relay_builtin, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String relayUrl() {
            return RelayConfig.effectiveRelay(MainActivity.this);
        }

        /** 离线页用它决定要不要显示「打开内置离线版」按钮 */
        @JavascriptInterface
        public boolean hasBundledApp() {
            return bundledAppExists();
        }

        /** 加载打进 assets 的 app/index.html（relay 通过 ?relay= 传进去，避免同源限制） */
        @JavascriptInterface
        public void openBundledApp() {
            runOnUiThread(MainActivity.this::loadBundledApp);
        }

        @JavascriptInterface
        public void toast(String msg) {
            if (msg != null) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
            }
        }
    }

    // ------------------------------------------------------------- 加载

    private String relayHost() {
        return RelayConfig.host(this);
    }

    /** 10./172.16-31./192.168./127. 以及 *.local / 不带点的内网主机名 */
    private static boolean isPrivateHost(String host) {
        if (host == null || host.isEmpty()) {
            return true;
        }
        if (host.startsWith("127.") || "localhost".equals(host)
                || host.endsWith(".local") || host.endsWith(".lan")
                || host.endsWith(".home")) {
            return true;
        }
        if (host.indexOf('.') < 0) {
            return true; // 裸主机名，肯定是局域网
        }
        if (host.startsWith("10.") || host.startsWith("192.168.")) {
            return true;
        }
        if (host.startsWith("172.")) {
            int dot = host.indexOf('.', 4);
            if (dot > 4) {
                try {
                    int second = Integer.parseInt(host.substring(4, dot));
                    return second >= 16 && second <= 31;
                } catch (NumberFormatException ignored) {
                    return false;
                }
            }
        }
        return false;
    }

    private void loadRelay() {
        String base = RelayConfig.effectiveRelay(this);
        if (TextUtils.isEmpty(base)) {
            // 地址已内置，正常情况下不会走到这里（preferPublicFeed 被手工打开时才会）
            loadBundledApp();
            return;
        }
        hidePanels();
        pageShown = false;
        showingOffline = false;
        offlineAssetLoaded = false;
        // 只加载 relay 根地址，不附加任何查询串（避免干扰队友的静态路由）
        Uri u = Uri.parse(base);
        String path = u.getPath();
        String url = (path == null || path.isEmpty()) ? base + "/" : base;
        Log.i(TAG, "load " + url);
        handler.removeCallbacks(loadTimeout);
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        webView.loadUrl(url);
    }

    private void reloadRelay() {
        hidePanels();
        loadRelay();
    }

    // ------------------------------------------------------- 内置离线版 app

    /** assets 里有没有打进 app/index.html（build.ps1 -WithApp 或自动检测到 ..\app 时为真） */
    private Boolean bundledAppExistsCache;

    private boolean bundledAppExists() {
        if (bundledAppExistsCache == null) {
            boolean exists = false;
            java.io.InputStream in = null;
            try {
                in = getAssets().open("app/index.html");
                exists = true;
            } catch (Exception ignored) {
                exists = false;
            } finally {
                if (in != null) {
                    try {
                        in.close();
                    } catch (Exception ignored) {
                    }
                }
            }
            bundledAppExistsCache = Boolean.valueOf(exists);
        }
        return bundledAppExistsCache.booleanValue();
    }

    /**
     * 加载打进 APK 的静态 UI，作为 relay 完全不可达时的兜底。
     * 把 relay 地址作为 ?relay= 传进去，让前端的 config.js 知道往哪打 API
     * （WebView 打开了 allowUniversalAccessFromFileURLs，file:// 页面可以直接 XHR http）。
     */
    private void loadBundledApp() {
        if (!bundledAppExists()) {
            Toast.makeText(this, R.string.msg_no_bundled, Toast.LENGTH_SHORT).show();
            return;
        }
        String base = RelayConfig.effectiveRelay(this);
        hidePanels();
        handler.removeCallbacks(loadTimeout);
        showingOffline = false;
        offlineAssetLoaded = false;
        // 内置 UI 是本地文件，不会"加载超时"，所以不挂 loadTimeout
        pageShown = true;
        String url = ASSET_APP + (TextUtils.isEmpty(base) ? "" : "?relay=" + Uri.encode(base));
        Log.i(TAG, "load bundled app: " + url);
        webView.loadUrl(url);
    }

    /**
     * 显示本地离线页（assets/offline.html）。离线页本身若也没加载出来，退回原生错误面板，绝不白屏。
     */
    private void showOffline(String reason) {
        String base = RelayConfig.effectiveRelay(this);
        showingOffline = true;
        pageShown = false;
        offlineAssetLoaded = false;
        handler.removeCallbacks(loadTimeout);
        String url = ASSET_OFFLINE + "?relay=" + Uri.encode(base)
                + (TextUtils.isEmpty(reason) ? "" : "&reason=" + Uri.encode(reason));
        Log.i(TAG, "show offline page: " + url);
        webView.loadUrl(url);
        handler.postDelayed(() -> {
            if (!offlineAssetLoaded) {
                Log.w(TAG, "offline asset failed to load, fallback to native panel");
                showNativeError(reason);
            }
        }, 1500L);
    }

    private void openOfflineAsset(String reason) {
        webView.loadUrl(ASSET_OFFLINE + "?relay=" + Uri.encode(RelayConfig.effectiveRelay(this)));
        hidePanels();
        hidePanelKeys();
    }

    private void showNativeError(String reason) {
        String base = RelayConfig.effectiveRelay(this);
        if (TextUtils.isEmpty(base)) {
            base = RelayConfig.DEFAULT_RELAY;
        }
        setupPanel.setVisibility(View.GONE);
        errorBody.setText(getString(R.string.offline_body, base));
        errorPanel.setVisibility(View.VISIBLE);
        if (!TextUtils.isEmpty(reason)) {
            errorTitle.setText(getString(R.string.offline_title) + " · " + reason);
        } else {
            errorTitle.setText(R.string.offline_title);
        }
        btnSettings.setVisibility(View.GONE);
        hidePanelKeys();
    }

    // ------------------------------------------------------------- 引导页（已废弃）

    /**
     * 【已废弃】中继地址内置在 RelayConfig.DEFAULT_RELAY，用户不需要也不能配置。
     * 这里刻意不再显示 setupPanel：即便将来有代码误调这个方法，也只会回到内置 UI，
     * 不可能让「填地址」的界面出现在用户面前。
     */
    @Deprecated
    private void showSetup(boolean firstRun) {
        Log.w(TAG, "showSetup() is deprecated - relay address is built in, going to bundled UI");
        loadBundledApp();
    }

    private void hidePanels() {
        setupPanel.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        // 中继地址已内置，设置入口对最终用户隐藏
        btnSettings.setVisibility(View.GONE);
        hidePanelKeys();
    }

    private void onSaveRelay() {
        String normalized = RelayConfig.normalize(editRelay.getText().toString());
        if (normalized == null) {
            setupStatus.setTextColor(getColorCompat(R.color.danger));
            setupStatus.setText(R.string.msg_bad_url);
            return;
        }
        RelayConfig.set(this, normalized);
        // 用户主动填了地址 = 明确要走局域网 relay，关掉「只用公共频道」默认开关。
        RelayConfig.setPreferPublicFeed(this, false);
        editRelay.setText(normalized);
        setupStatus.setTextColor(getColorCompat(R.color.accent));
        setupStatus.setText("已保存：" + normalized + "，正在连接…");
        hidePanels();
        loadRelay();
    }

    private void onTestRelay() {
        String normalized = RelayConfig.normalize(editRelay.getText().toString());
        if (normalized == null) {
            setupStatus.setTextColor(getColorCompat(R.color.danger));
            setupStatus.setText(R.string.msg_bad_url);
            return;
        }
        setupStatus.setTextColor(getColorCompat(R.color.text_dim));
        setupStatus.setText(R.string.msg_testing);
        final String target = RelayConfig.healthUrl(normalized);
        final long started = System.currentTimeMillis();
        new Thread(() -> {
            final String[] result = new String[2];
            java.net.HttpURLConnection conn = null;
            try {
                java.net.URL u = new java.net.URL(target);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/json");
                int code = conn.getResponseCode();
                java.io.InputStream in = code >= 200 && code < 300
                        ? conn.getInputStream() : conn.getErrorStream();
                String body = "";
                if (in != null) {
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        bos.write(buf, 0, n);
                        if (bos.size() > 8192) {
                            break;
                        }
                    }
                    in.close();
                    body = new String(bos.toByteArray(), "UTF-8");
                }
                long cost = System.currentTimeMillis() - started;
                if (code >= 200 && code < 300) {
                    result[0] = "OK";
                    result[1] = "连接成功（HTTP " + code + "，" + cost + "ms）\n" + trim(body, 160);
                } else {
                    result[0] = "FAIL";
                    result[1] = "服务器返回 HTTP " + code + "\n" + trim(body, 160);
                }
            } catch (Exception e) {
                result[0] = "FAIL";
                result[1] = "连接失败：" + e.getClass().getSimpleName()
                        + (e.getMessage() == null ? "" : " " + e.getMessage());
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
            runOnUiThread(() -> {
                setupStatus.setTextColor(getColorCompat(
                        "OK".equals(result[0]) ? R.color.accent : R.color.danger));
                setupStatus.setText(result[1]);
            });
        }).start();
    }

    private static String trim(String s, int max) {
        if (s == null) {
            return "";
        }
        s = s.replace("\r", "").replace("\n", " ");
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private int getColorCompat(int resId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return getResources().getColor(resId, getTheme());
        }
        //noinspection deprecation
        return getResources().getColor(resId);
    }

    // ------------------------------------------------------------- 下载

    private void enqueueDownload(String url, String mime) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url;
            pendingDownloadMime = mime;
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    REQ_WRITE_STORAGE);
            return;
        }
        doEnqueueDownload(url, mime);
    }

    private void doEnqueueDownload(String url, String mime) {
        try {
            String fileName = Uri.parse(url).getLastPathSegment();
            if (TextUtils.isEmpty(fileName)) {
                fileName = "download-" + System.currentTimeMillis();
            }
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mime);
            req.setTitle(fileName);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) {
                req.addRequestHeader("Cookie", cookies);
            }
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(req);
                Toast.makeText(this, "已开始下载：" + fileName, Toast.LENGTH_SHORT).show();
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "download manager failed", e);
        }
        openExternal(url);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WRITE_STORAGE) {
            String url = pendingDownloadUrl;
            String mime = pendingDownloadMime;
            pendingDownloadUrl = null;
            pendingDownloadMime = null;
            if (url == null) {
                return;
            }
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                doEnqueueDownload(url, mime);
            } else {
                openExternal(url);
            }
        }
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "没有可以打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------- 生命周期 / 返回键

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 引导页永不出现（地址已内置），返回键只会后退 / 双击退出。
            if (webView.canGoBack() && !showingOffline) {
                webView.goBack();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - lastBackPressAt < 2000L) {
                finish();
            } else {
                lastBackPressAt = now;
                Toast.makeText(this, R.string.msg_press_again_exit, Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            // 菜单键不再打开中继地址设置（地址已内置，无需配置）
            Toast.makeText(this, R.string.msg_relay_builtin, Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        webView.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        try {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.setWebViewClient(null);
            webView.destroy();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
