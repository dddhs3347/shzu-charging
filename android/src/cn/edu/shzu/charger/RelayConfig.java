package cn.edu.shzu.charger;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * relay 地址的存取与校验。
 * 地址形如 http://192.168.0.100:8080 或 https://example.com/charger
 * 允许用户省略 scheme（自动补 http://），允许带路径前缀。
 */
final class RelayConfig {

    static final String PREFS = "shzu_charger";
    static final String KEY_RELAY = "relay_url";
    /** KEY_SKIP_RELAY 为真时，用户明确说了「不连 relay，只用公共频道」。 */
    static final String KEY_SKIP_RELAY = "skip_relay";

    /**
     * 内置的局域网中继地址：启动即作为「先试局域网」的目标传给前端。
     * 前端收到 ?relay=<地址> 后先打它，连不上自动降级到公共频道。
     * 用户不需要、也无法在界面上修改它（改这里 → 重打 APK）。
     */
    static final String DEFAULT_RELAY = "http://192.168.0.100:8080";

    /**
     * 保留的「只用公共频道、完全不试局域网」开关。
     * 默认 false —— 新需求是「打开软件先自动试中继服务/局域网」。
     * 置 true 可整体关掉局域网探测用于排障。
     */
    static boolean preferPublicFeed(Context c) {
        return prefs(c).getBoolean(KEY_SKIP_RELAY, false);
    }

    /**
     * 启动时该用的 relay 地址：已存地址优先，没有就用内置的 DEFAULT_RELAY。
     * 永远不会返回空串，除非 preferPublicFeed 打开。
     */
    static String effectiveRelay(Context c) {
        if (preferPublicFeed(c)) {
            return "";
        }
        String s = get(c);
        return s.isEmpty() ? DEFAULT_RELAY : s;
    }

    static void setPreferPublicFeed(Context c, boolean value) {
        prefs(c).edit().putBoolean(KEY_SKIP_RELAY, value).apply();
    }

    /** scheme://host[:port][/path]，host 支持 IPv4 / 域名 / [IPv6] */
    private static final Pattern URL_PATTERN = Pattern.compile(
            "^(https?)://([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]+\\])"
                    + "(?::(\\d{1,5}))?(/\\S*)?$");

    private RelayConfig() {
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String get(Context c) {
        String s = prefs(c).getString(KEY_RELAY, "");
        return s == null ? "" : s;
    }

    static boolean has(Context c) {
        return !get(c).isEmpty();
    }

    static void set(Context c, String url) {
        prefs(c).edit().putString(KEY_RELAY, url).apply();
    }

    static void clear(Context c) {
        prefs(c).edit().remove(KEY_RELAY).apply();
    }

    /**
     * 校验并规范化用户输入。返回 null 表示格式非法。
     */
    static String normalize(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().replace(" ", "").replace("\u3000", "");
        if (s.isEmpty()) {
            return null;
        }
        if (s.contains("?") || s.contains("#")) {
            return null;
        }
        String lower = s.toLowerCase(Locale.US);
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            // ok
        } else if (s.contains("://")) {
            return null;
        } else {
            s = "http://" + s;
        }
        while (s.length() > 1 && s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        Matcher m = URL_PATTERN.matcher(s);
        if (!m.matches()) {
            return null;
        }
        int port = -1;
        if (m.group(3) != null) {
            try {
                port = Integer.parseInt(m.group(3));
            } catch (NumberFormatException e) {
                return null;
            }
            if (port < 1 || port > 65535) {
                return null;
            }
        }
        String path = m.group(4);
        if (path != null && (path.isEmpty() || "/".equals(path))) {
            path = null;
        }
        String scheme = m.group(1).toLowerCase(Locale.US);
        String host = m.group(2);
        StringBuilder sb = new StringBuilder(scheme).append("://").append(host);
        if (port > 0) {
            sb.append(':').append(port);
        }
        if (path != null) {
            sb.append(path);
        }
        String normalized = sb.toString();
        Uri u = Uri.parse(normalized);
        if (u.getHost() == null || u.getHost().isEmpty()) {
            return null;
        }
        return normalized;
    }

    static String host(Context c) {
        String u = get(c);
        if (u.isEmpty()) {
            return "";
        }
        String h = Uri.parse(u).getHost();
        return h == null ? "" : h.toLowerCase(Locale.US);
    }

    static int port(Context c) {
        String u = get(c);
        if (u.isEmpty()) {
            return -1;
        }
        Uri p = Uri.parse(u);
        int port = p.getPort();
        if (port > 0) {
            return port;
        }
        return "https".equalsIgnoreCase(p.getScheme()) ? 443 : 80;
    }

    static String healthUrl(String base) {
        return base + "/api/health";
    }
}
