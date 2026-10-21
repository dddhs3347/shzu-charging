/* 公用频道线路数据的解码器：base64url → gzip inflate → UTF-8 文本
 * ===================================================================
 * 为什么要自己解 gzip
 * ------------------
 * 发布端把整份线路数据 gzip 后塞进 ntfy 消息正文（正文留 12 小时，附件只有
 * 3 小时 —— 手机冷启动时附件早过期了，正文还在，这是 2026-10-20 实测踩出来的
 * 兜底通道）。浏览器解 gzip 的原生 API 是 DecompressionStream，但它是
 * Chrome 80+ 才有的，本项目要兼容到 Chrome 80（微信 X5 / 老安卓 WebView），
 * 所以这里自带一个纯 JS inflate。
 *
 * 实现要点
 * --------
 * - 只支持 gzip 包装的 DEFLATE（RFC 1951）。zlib 头和 gzip 头都能认，
 *   纯 raw deflate 也能解 —— 发布端用的是标准 gzip，这里三种都能兜住，
 *   代价只是几十行。
 * - 固定 Huffman 块用长度表直接算（inflate_fast 的简化版）；
 *   动态 Huffman 走规范的 code-length 表构造。
 * - 输出是 UTF-8 文本，这里顺带解码（不用 TextDecoder：老 WebView 里
 *   构造参数行为不一致，文本已经进 JSON 了）。
 *
 * 用法：SHZU.inflate.gunzipToText(base64urlString) → string
 * 失败抛 Error（调用方负责回落），不返回 null —— 让「解码失败」和
 * 「解出空字符串」在调用方那里能被区分开。
 */
(function (global) {
  'use strict';

  var SHZU = global.SHZU = global.SHZU || {};

  /* ---------- base64url → 字节数组 ---------- */
  /* 发布端用的是 urlsafe alphabet（- _），并且把结尾的 = 全部剥掉了。 */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64MAP = (function () {
    var m = {};
    for (var i = 0; i < B64.length; i++) { m[B64.charAt(i)] = i; }
    /* 顺手兼容标准 alphabet，旧的线路数据万一是 base64 而不是 base64url 也不至于解不开 */
    m['+'] = 62; m['/'] = 63;
    return m;
  }());

  function base64ToBytes(text) {
    var s = String(text || '').replace(/[\s=]/g, '');
    var out = [];
    var acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64MAP[s.charAt(i)];
      if (v === undefined) { continue; }         /* 非法字符直接跳过，不中断 */
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xFF);
      }
    }
    return out;
  }

  /* ---------- 位读取器 ---------- */
  function BitReader(bytes, pos) {
    this.b = bytes;
    this.p = pos || 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  BitReader.prototype.readBits = function (n) {
    while (this.bitCnt < n) {
      if (this.p >= this.b.length) { throw new Error('inflate: 数据提前结束'); }
      this.bitBuf |= this.b[this.p++] << this.bitCnt;
      this.bitCnt += 8;
    }
    var v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>= n;
    this.bitCnt -= n;
    return v;
  };
  BitReader.prototype.alignByte = function () {
    this.bitBuf = 0; this.bitCnt = 0;
  };

  /* ---------- 规范 Huffman 表 ---------- */
  /* counts[n] = 长度 n 的码有多少个；symbols 按 canonical 顺序（码长升序、
   * 同码长内符号值升序）排列。这是 RFC 1951 §3.2.2 规定的唯一顺序，
   * 也是 inflate 能不解码器只靠 counts+symbols 走树的原因。 */
  function Huffman(counts, symbols) {
    this.counts = counts;
    this.symbols = symbols;
  }
  Huffman.prototype.decode = function (br) {
    /* 逐位走规范码树。first 是「当前码长下最小码值」，每轮翻倍；
     * index 是 symbols 里属于当前码长区间的起点。
     * （顺序细节照 zlib puff：比较 → index += count → first = (first+count)<<1
     *   → code <<= 1） */
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= 15; len++) {
      code |= br.readBits(1);
      var count = this.counts[len];
      if (code - first < count) { return this.symbols[index + (code - first)]; }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: 无效的 Huffman 码');
  };

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                   35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                   257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                   8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  /* 从「每个符号的码长」数组构造规范 Huffman 表。
   * 这是 zlib puff 的 construct()：先数各码长的个数，再按「码长升序、
   * 同码长内符号值升序」把符号填进 symbols。**这是唯一可靠的写法** ——
   * 我前面手写固定表和 code-length 表时先后踩了「传输顺序 ≠ 码序」的坑，
   * 手推符号列表很容易错，而这段算法只有十几行且不会错。 */
  function constructFromLengths(lengths) {
    var counts = new Array(16);
    var i;
    for (i = 0; i < 16; i++) { counts[i] = 0; }
    for (i = 0; i < lengths.length; i++) {
      if (lengths[i] < 0 || lengths[i] > 15) { throw new Error('inflate: 非法码长 ' + lengths[i]); }
      counts[lengths[i]]++;
    }
    /* 偏移量：offs[len] = 比 len 短的码的总数 */
    var offs = new Array(16);
    offs[0] = 0; offs[1] = 0;
    for (i = 1; i < 15; i++) { offs[i + 1] = offs[i] + counts[i]; }
    var symbols = new Array(lengths.length);
    for (i = 0; i < lengths.length; i++) {
      if (lengths[i]) { symbols[offs[lengths[i]]++] = i; }
    }
    return new Huffman(counts, symbols);
  }

  var FIXED = null;

  function fixedTables() {
    /* RFC 1951 §3.2.6 固定表：256..279 → 7 位、0..143 → 8 位、
     * 280..287 → 8 位、144..255 → 9 位。直接给码长，让 constructFromLengths
     * 去生成 canonical 顺序，避免手推符号列表。 */
    var litLens = new Array(288);
    var n;
    for (n = 0; n < 144; n++) { litLens[n] = 8; }
    for (n = 144; n < 256; n++) { litLens[n] = 9; }
    for (n = 256; n < 280; n++) { litLens[n] = 7; }
    for (n = 280; n < 288; n++) { litLens[n] = 8; }
    var distLens = new Array(30);
    for (n = 0; n < 30; n++) { distLens[n] = 5; }
    return { lit: constructFromLengths(litLens), dist: constructFromLengths(distLens) };
  }

  function readDynamicTables(br) {
    var hlit = br.readBits(5) + 257;
    var hdist = br.readBits(5) + 1;
    var hclen = br.readBits(4) + 4;
    var clenLens = new Array(19);
    var i;
    for (i = 0; i < 19; i++) { clenLens[i] = 0; }
    for (i = 0; i < hclen; i++) { clenLens[CLEN_ORDER[i]] = br.readBits(3); }
    var clenTable = constructFromLengths(clenLens);

    var lengths = [];
    var total = hlit + hdist;
    while (lengths.length < total) {
      var sym = clenTable.decode(br);
      if (sym < 16) { lengths.push(sym); }
      else if (sym === 16) {
        if (!lengths.length) { throw new Error('inflate: 重复码无前导'); }
        var prev = lengths[lengths.length - 1];
        var rep = 3 + br.readBits(2);
        while (rep-- > 0) { lengths.push(prev); }
      } else if (sym === 17) {
        var rep17 = 3 + br.readBits(3);
        while (rep17-- > 0) { lengths.push(0); }
      } else {
        var rep18 = 11 + br.readBits(7);
        while (rep18-- > 0) { lengths.push(0); }
      }
    }
    if (lengths.length > total) { lengths.length = total; }

    var litLens = lengths.slice(0, hlit);
    var distLens = lengths.slice(hlit);
    return { lit: constructFromLengths(litLens), dist: constructFromLengths(distLens) };
  }

  function inflateRaw(bytes, startPos) {
    var br = new BitReader(bytes, startPos);
    var out = [];
    var last = 0;
    do {
      last = br.readBits(1);
      var type = br.readBits(2);
      if (type === 0) {
        /* stored：先对齐到字节边界 */
        br.alignByte();
        if (br.p + 4 > bytes.length) { throw new Error('inflate: stored 块头不完整'); }
        var len = bytes[br.p] | (bytes[br.p + 1] << 8);
        br.p += 4;                     /* LEN(2) + NLEN(2) */
        if (br.p + len > bytes.length) { throw new Error('inflate: stored 块数据不完整'); }
        for (var s = 0; s < len; s++) { out.push(bytes[br.p++]); }
      } else if (type === 1 || type === 2) {
        var tables = type === 1 ? (FIXED || (FIXED = fixedTables())) : readDynamicTables(br);
        for (;;) {
          var sym = tables.lit.decode(br);
          if (sym < 256) { out.push(sym); continue; }
          if (sym === 256) { break; }
          var li = sym - 257;
          if (li >= LEN_BASE.length) { throw new Error('inflate: 长度码越界 ' + sym); }
          var length = LEN_BASE[li] + br.readBits(LEN_EXTRA[li]);
          var dsym = tables.dist.decode(br);
          if (dsym >= DIST_BASE.length) { throw new Error('inflate: 距离码越界 ' + dsym); }
          var dist = DIST_BASE[dsym] + br.readBits(DIST_EXTRA[dsym]);
          if (dist > out.length) { throw new Error('inflate: 距离超出已输出长度'); }
          var from = out.length - dist;
          for (var c = 0; c < length; c++) { out.push(out[from + c]); }
        }
      } else {
        throw new Error('inflate: 保留的块类型 ' + type);
      }
    } while (!last);
    return { bytes: out, pos: br.p };
  }

  /* ---------- UTF-8 解码 ---------- */
  /* 手工实现而不是 TextDecoder：老 WebView 的 TextDecoder 构造参数行为不一致，
   * 而线路数据里必然有中文站名，不能赌。 */
  function utf8Decode(byteList) {
    var s = '';
    var i = 0, n = byteList.length;
    /* 按 4K 一批拼字符串，避免一次 push 上万个字符把参数栈撑爆 */
    while (i < n) {
      var chunk = '';
      var end = Math.min(n, i + 4096);
      for (; i < end; i++) {
        var b = byteList[i];
        if (b < 0x80) { chunk += String.fromCharCode(b); }
        else if (b >= 0xC0 && b < 0xE0) {
          chunk += String.fromCharCode(((b & 0x1F) << 6) | (byteList[++i] & 0x3F));
        } else if (b >= 0xE0 && b < 0xF0) {
          chunk += String.fromCharCode(((b & 0x0F) << 12) |
                                       ((byteList[++i] & 0x3F) << 6) |
                                       (byteList[++i] & 0x3F));
        } else if (b >= 0xF0) {
          var cp = ((b & 0x07) << 18) | ((byteList[++i] & 0x3F) << 12) |
                   ((byteList[++i] & 0x3F) << 6) | (byteList[++i] & 0x3F);
          cp -= 0x10000;
          chunk += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        } else {
          chunk += String.fromCharCode(b);   /* 非法字节不中断整体解码 */
        }
      }
      s += chunk;
    }
    return s;
  }

  /* ---------- 对外 ---------- */
  /* 入口：发布端 embed_line() 产出的 "SHZU1Z|<base64url>" 里的 base64url 部分。 */
  function gunzipToText(b64) {
    var bytes = base64ToBytes(b64);
    if (bytes.length < 2) { throw new Error('inflate: 数据太短'); }

    var start = 0;
    var isGzip = false;
    /* gzip 头：1f 8b … 10 字节（含可选字段） */
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      var flg = bytes[3];
      isGzip = true;
      start = 10;
      if (flg & 4) { start += 2 + (bytes[10] | (bytes[11] << 8)); }   /* FEXTRA */
      if (flg & 8) { while (bytes[start]) { start++; } start++; }     /* FNAME */
      if (flg & 16) { while (bytes[start]) { start++; } start++; }    /* FCOMMENT */
      if (flg & 2) { start += 2; }                                     /* FHCRC */
    } else if (bytes[0] === 0x78) {
      /* zlib 头：CMF/FLG，校验 (CMF*256+FLG) % 31 == 0 */
      start = 2;
    }

    var res = inflateRaw(bytes, start);
    /* ISIZE（解出字节数的小端 32 位）位于 gzip 流**末尾**（CRC32 之后），
     * 不是 inflate 结束时的字节位置 —— 结束位可能落在字节中间，BitReader.pos
     * 会跳过尾部那几位算不准。我第一版从 res.pos 读，结果拿到的其实是
     * deflate 数据的中间字节，误报「截断」。
     * 用它校验的价值：ntfy 对超长正文是**静默截断**，base64 被砍一截时
     * inflate 有可能仍解出大部分内容，只有长度对得上才敢当成完整数据用。 */
    if (isGzip) {
      var tail = bytes.length - 4;
      if (tail > start) {
        var isize = (bytes[tail] | (bytes[tail + 1] << 8) |
                     (bytes[tail + 2] << 16) | (bytes[tail + 3] << 24)) >>> 0;
        if (isize !== res.bytes.length) {
          throw new Error('inflate: 解出长度与 ISIZE 不符（' + res.bytes.length +
                          ' != ' + isize + '），数据可能被截断');
        }
      }
    }
    return utf8Decode(res.bytes);
  }

  SHZU.inflate = {
    gunzipToText: gunzipToText,
    inflateToText: function (b64) {
      /* raw deflate：直接按存储块解，不剥任何头 */
      return utf8Decode(inflateRaw(base64ToBytes(b64), 0).bytes);
    },
    base64ToBytes: base64ToBytes
  };
}(typeof window !== 'undefined' ? window : this));