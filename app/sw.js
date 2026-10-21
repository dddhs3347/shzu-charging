/* sw.js — Service Worker：App Shell 预缓存 + 网络优先/缓存兜底
 *
 * 策略一览：
 *   1. 导航请求（打开页面）  → network-first（带超时），失败回落预缓存的 index.html（保证离线能开）
 *   2. 静态资源（js/css/png）→ stale-while-revalidate：先给缓存（秒开），后台静默更新
 *                              —— 既是缓存优先，又能在下一次打开拿到新版本，不会「改了没生效」
 *   3. /api/* 请求          → network-first，失败回落最近一次缓存（最多保留 API_MAX_AGE），
 *                              回落时会打上 X-From-SW-Cache 头，页面据此提示「离线缓存」
 *
 * 防「旧缓存卡死」：
 *   - CACHE_VERSION 变更时，activate 阶段把旧前缀缓存全部删掉
 *   - 静态资源后台静默更新，最多「旧一个版本」，刷新一次即可自愈
 *   - API 缓存单独命名空间，且有最大年龄，过期直接丢弃，不返回陈旧到离谱的数据
 *   - 页面里点「检查更新」会调 reg.update()，SW 有更新立刻 skipWaiting + clients.claim
 */

var VERSION = 'v1.4.51';
var SHELL_CACHE = 'shzu-shell-' + VERSION;
var API_CACHE = 'shzu-api-' + VERSION;
var API_MAX_AGE = 30 * 60 * 1000;   // API 缓存最多用 30 分钟，再旧就当没有
var API_CACHE_MAX_ITEMS = 24;       // 最多留这么多个 API 响应
var NAV_TIMEOUT = 6000;             // 导航网络超时，超过就直接用缓存壳（弱网秒开）

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './config.js',
  './util.js',
  './charts.js',
  './inflate.js',
  './api.js',
  './publicfeed.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 把 App Shell 清单逐个**串行**写进缓存（缺什么补什么）。
 *
 * 为什么不能用 Promise.all 并发：cache.add() 内部是 fetch + cache.put，同一个
 * Cache 实例上并发 put 会互相干扰（Chrome 实测 13 个资源并发只成功 10 个，
 * '/'、'/index.html'、'/icons/icon-512.png' 稳定丢失）。而 install 只在
 * VERSION 变化时跑一次 —— 一旦漏了 index.html，就变成「联网一切正常、
 * 一断网就白屏」，非常难查。串行只多花几十毫秒，换来的是确定性。
 *
 * 串行 + 先 match 再 add，也顺带让 repair 只补缺失项，不会重复下载。
 */
function addShellAssets(cache, urls) {
  return urls.reduce(function (p, url) {
    return p.then(function () {
      return cache.match(url, { ignoreSearch: true }).then(function (hit) {
        if (hit) { return null; }
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
          // 单个资源失败不阻塞整体，交给下一次 repair 重试
          return null;
        });
      });
    });
  }, Promise.resolve());
}

/* ---------------------------------------------------------------- 安装 */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return addShellAssets(cache, SHELL_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* ---------------------------------------------------------------- 激活 */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== API_CACHE &&
            (key.indexOf('shzu-shell-') === 0 || key.indexOf('shzu-api-') === 0)) {
          return caches.delete(key);
        }
        return null;
      }));
    })
      // 补齐残缺的 App Shell（见 repairShellCache 注释），再去接管页面
      .then(function () { return repairShellCache(); })
      .then(function () { return self.clients.claim(); })
  );
});

/* 自愈：确认 App Shell 缓存完整，缺什么补什么。
 *
 * 为什么需要这一步：install 里是「逐个 add 且失败不阻塞」，如果安装过程中
 * 设备被杀 / 存储配额出错 / 被外部清了缓存，SHELL_CACHE 会变成**残缺**的
 * （实测见过只缓存了 11 项里的 8 项，缺 index.html）。而同一个 VERSION 下
 * install 不会重跑，残缺状态就永久留着 —— 表现是「联网一切正常，一断网就白屏」。
 * 这里在每次 activate 时对清单补一遍，最多多花几十毫秒。
 */
function repairShellCache() {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return addShellAssets(cache, SHELL_ASSETS);
  }).catch(function () { return null; });
}

/* ---------------------------------------------------------------- 工具 */

function isApiRequest(url) {
  return url.pathname.indexOf('/api/') !== -1 || /\/api\//.test(url.pathname);
}

function isShellAsset(url, request) {
  if (url.origin !== self.location.origin) { return false; }
  if (request.destination === 'document') { return false; }
  return /\.(?:css|js|json|webmanifest|png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname) ||
         url.pathname === '/' || url.pathname === '';
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error('timeout'));
    }, ms);
    promise.then(function (v) {
      clearTimeout(timer);
      resolve(v);
    }, function (e) {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/* API 缓存：存 response 本体 + 自定义头记录时间；读取时校验年龄。 */
function putApiCache(request, response) {
  if (!response || response.status !== 200) { return Promise.resolve(); }
  var copy = response.clone();
  return caches.open(API_CACHE).then(function (cache) {
    // 先清一下条数，防止无限膨胀
    return cache.keys().then(function (keys) {
      if (keys.length <= API_CACHE_MAX_ITEMS) { return null; }
      var drop = keys.slice(0, keys.length - API_CACHE_MAX_ITEMS);
      return Promise.all(drop.map(function (k) { return cache.delete(k); }));
    }).then(function () {
      // 用带时间戳的伪 URL 做 key，方便判断年龄
      var stampKey = new Request(request.url + (request.url.indexOf('?') >= 0 ? '&' : '?') + '__sw_stamp=' + Date.now(), { method: 'GET' });
      return cache.put(stampKey, copy);
    });
  }).catch(function () { return null; });
}

function matchApiCache(url) {
  return caches.open(API_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      var base = url.origin + url.pathname;
      var candidates = [];
      for (var i = 0; i < keys.length; i++) {
        var cu = keys[i].url;
        if (cu.indexOf(base) !== 0) { continue; }
        // 去掉 ?ts= 与 __sw_stamp 后比较路径 + 查询键（ts 除外）
        var m = /__sw_stamp=(\d+)/.exec(cu);
        var stamp = m ? Number(m[1]) : 0;
        candidates.push({ key: keys[i], stamp: stamp });
      }
      candidates.sort(function (a, b) { return b.stamp - a.stamp; });
      for (var j = 0; j < candidates.length; j++) {
        if (Date.now() - candidates[j].stamp > API_MAX_AGE) { continue; }
        // 只在 query 去掉 ts 后能对得上时使用
        var wanted = stripVolatile(url);
        var got = stripVolatile(new URL(candidates[j].key.url));
        if (wanted !== got) { continue; }
        return cache.match(candidates[j].key).then(function (res) {
          if (!res) { return null; }
          // 打标记：页面据此知道「这是离线缓存数据」，会显示 staleness 提示而不是装作实时
          return markFromSwCache(res);
        });
      }
      return null;
    });
  }).catch(function () { return null; });
}

function stripVolatile(u) {
  var params = [];
  try {
    u.searchParams.forEach(function (v, k) {
      if (k === 'ts' || k === '__sw_stamp') { return; }
      params.push(k + '=' + v);
    });
  } catch (e) {
    var q = (u.search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < q.length; i++) {
      if (!q[i] || /^ts=/.test(q[i]) || /^__sw_stamp=/.test(q[i])) { continue; }
      params.push(q[i]);
    }
  }
  params.sort();
  return u.pathname + '?' + params.join('&');
}

/* 给「来自 SW 缓存」的响应打标记头。
 * 注意：不能直接改原 response（body 已消费风险），要 clone 出新 Response。
 * 加两个头：X-Shzu-Source: sw-cache 和 X-Shzu-Cache-Age: 秒数。
 */
function markFromSwCache(res) {
  try {
    var headers = new Headers(res.headers);
    headers.set('X-Shzu-Source', 'sw-cache');
    var age = 0;
    try {
      var d = res.headers.get('Date');
      if (d) { age = Math.max(0, Math.round((Date.now() - Date.parse(d)) / 1000)) || 0; }
    } catch (e0) { age = 0; }
    headers.set('X-Shzu-Cache-Age', String(age));
    return res.blob().then(function (body) {
      return new Response(body, { status: res.status, statusText: res.statusText, headers: headers });
    }).catch(function () { return res; });
  } catch (e) {
    return Promise.resolve(res);
  }
}

/* ---------------------------------------------------------------- fetch */

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') { return; }

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // 1) API：网络优先，失败回落最近缓存
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).then(function (res) {
        // 只缓存 200 且是 JSON 的可解析响应
        var ct = res.headers.get('content-type') || '';
        if (res.status === 200 && ct.indexOf('json') !== -1) {
          putApiCache(request, res);
        }
        return res;
      }).catch(function () {
        return matchApiCache(url).then(function (cached) {
          if (cached) { return cached; }
          // 没有缓存 → 回一个明确的 503 JSON，页面会走错误分支
          return new Response(
            JSON.stringify({ error: 'offline', message: '离线且无缓存' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  // 2) 导航请求：网络优先（带超时），失败回落壳
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      withTimeout(fetch(request), NAV_TIMEOUT).then(function (res) {
        return res;
      }).catch(function () {
        return caches.open(SHELL_CACHE).then(function (cache) {
          return cache.match('./index.html').then(function (hit) {
            return hit || cache.match('./') || new Response(
              '<!doctype html><meta charset="utf-8"><title>离线</title>' +
              '<body style="background:#0b0f15;color:#eef3fa;font:15px system-ui;padding:40px 24px">' +
              '<h3>离线，且本地没有缓存</h3><p>请先联网打开一次本页面。</p></body>',
              { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
        });
      })
    );
    return;
  }

  // 3) 静态资源：stale-while-revalidate（先给缓存秒开，后台静默更新）
  if (isShellAsset(url, request)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(request, { ignoreSearch: true }).then(function (hit) {
          var network = fetch(request).then(function (res) {
            if (res && res.status === 200 && res.type === 'basic') {
              cache.put(request, res.clone()).catch(function () { return null; });
            }
            return res;
          }).catch(function () {
            return null;
          });
          if (hit) {
            // 不阻塞返回：缓存先给，网络更新放后台（event.waitUntil 保活）
            event.waitUntil(network.catch(function () { return null; }));
            return hit;
          }
          return network.then(function (res) {
            return res || new Response('', { status: 504, statusText: 'Offline' });
          });
        });
      })
    );
    return;
  }

  // 其它（跨域等）：直接走网络，不拦截
});

/* ---------------------------------------------------------------- 消息 */

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'CLEAR_API_CACHE') {
    caches.delete(API_CACHE);
  }
});
