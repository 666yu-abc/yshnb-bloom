/* ============================================================
 * 手势识别层
 * 职责：摄像头 → MediaPipe 21 关键点 → 镜像校正 / 归一化 / 平滑
 *       → 统一的 frame 结构；任何环节失败都降级为鼠标模式。
 * 关键点索引（MediaPipe Hands 标准 21 点）：
 *   0 腕 | 1-4 拇指 | 5-8 食指 | 9-12 中指 | 13-16 无名指 | 17-20 小指
 *   指尖 = 4,8,12,16,20；PIP = 3,6,10,14,18
 * ============================================================ */
(function (global) {
  'use strict';

  var Y = global.YSHNB;
  var G = Y.CFG.gesture;
  var V = Y.CFG.vision;

  var TIPS = [4, 8, 12, 16, 20];
  var PIPS = [3, 6, 10, 14, 18];
  var FOUR_TIPS = [8, 12, 16, 20];
  var FOUR_PIPS = [6, 10, 14, 18];
  var OTHER_TIPS = [12, 16, 20];
  var OTHER_PIPS = [10, 14, 18];

  var state = {
    mode: 'idle',              // idle | camera | pointer
    landmarker: null,
    video: null,
    stream: null,
    prevLandmarks: [],         // 上一帧平滑后的关键点，用于 EMA
    prevCenters: [],
    prevOpenness: [],          // 按手索引分别平滑，避免两只手互相污染
    calib: [],                 // 按手索引的长期张开度标定 {lo, hi, lastAt}
    lastSeenAt: 0,
    lastTs: -1,
    onStatus: function () {},
    pointer: { x: 0.5, y: 0.5, px: 0, py: 0, down: false, downAt: 0, moved: false },
    width: 1, height: 1
  };

  function status(kind, detail) { state.onStatus(kind, detail); }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 手掌尺度：取两组基准距离的较大者，避免透视变化时尺度漂移 */
  function palmScale(l) {
    var pairs = G.palmPairs || [[0, 9], [5, 17]];
    var m = 0.0001;
    for (var i = 0; i < pairs.length; i++) {
      var d = dist(l[pairs[i][0]], l[pairs[i][1]]);
      if (d > m) m = d;
    }
    return m;
  }

  /* 指数平滑：对 21 个点逐个做 EMA，抑制检测抖动 */
  function smoothLandmarks(raw, index) {
    var prev = state.prevLandmarks[index];
    var out;
    if (!prev || prev.length !== raw.length) {
      out = raw.map(function (p) { return { x: p.x, y: p.y, z: p.z || 0 }; });
    } else {
      out = raw.map(function (p, i) {
        return {
          x: prev[i].x + (p.x - prev[i].x) * G.emaAlpha,
          y: prev[i].y + (p.y - prev[i].y) * G.emaAlpha,
          z: (prev[i].z || 0) + ((p.z || 0) - (prev[i].z || 0)) * G.emaAlpha
        };
      });
    }
    state.prevLandmarks[index] = out;
    return out;
  }

  /* 单只手 → 描述子 */
  function describe(l, index, now, W, H) {
    var s = palmScale(l);

    /* 伸展度：四指指尖到腕的平均距离 / 掌宽 */
    var spread = 0;
    for (var i = 0; i < FOUR_TIPS.length; i++) spread += dist(l[FOUR_TIPS[i]], l[0]) / s;
    spread /= FOUR_TIPS.length;

    /* 指间散开：相邻指尖间距 / 掌宽 */
    var inter = 0;
    inter += dist(l[8], l[12]) / s;
    inter += dist(l[12], l[16]) / s;
    inter += dist(l[16], l[20]) / s;
    inter += dist(l[4], l[8]) / s;
    inter /= 4;

    var raw = G.spreadWeight * spread + G.interWeight * inter;

    /* ---- 张开度标定：长期极值 + 极慢回归 ----
     * 旧版取最近 150 帧的 min/max：长时间保持握拳时，窗口里的张手高值
     * 会全部过期，span 被 adaptSpanMin 撑住、mid 却掉到握拳值，握拳便被
     * 误算成中等张开度，噪声一抖就「自动绽放」。现在新极值立即吸收
     * （自适应手型 / 远近），其余时候按 26 秒时间常数极慢收敛，静态
     * 保持一个姿势几秒不会让标定坍缩。按手索引分开，双手互不污染。 */
    var cal = state.calib[index] || (state.calib[index] = {
      lo: G.openMin, hi: G.openMax, lastAt: now
    });
    var dt = clamp(now - cal.lastAt, 0, 120);
    cal.lastAt = now;
    if (raw < cal.lo) cal.lo = raw;
    if (raw > cal.hi) cal.hi = raw;
    var k = 1 - Math.exp(-dt / G.calibForgetMs);
    cal.lo += (raw - cal.lo) * k * 0.5;
    cal.hi += (raw - cal.hi) * k * 0.5;
    if (cal.hi - cal.lo < G.adaptSpanMin) {
      var cm = (cal.hi + cal.lo) * 0.5;
      cal.lo = cm - G.adaptSpanMin * 0.5;
      cal.hi = cm + G.adaptSpanMin * 0.5;
    }
    var rawOpen = clamp((raw - cal.lo) / (cal.hi - cal.lo), 0, 1);
    /* 低位死区：把底部一小段压成 0，握拳时的微小抖动不会放大成张开 */
    rawOpen = clamp((rawOpen - G.deadZone) / (1 - G.deadZone), 0, 1);

    /* ---- 卷曲计数：指尖比近节更靠近腕，说明这根手指弯了 ----
     * 这是几何硬事实，不受标定漂移影响。 */
    var curled = 0;
    for (var j = 0; j < FOUR_TIPS.length; j++) {
      if (dist(l[FOUR_TIPS[j]], l[0]) < dist(l[FOUR_PIPS[j]], l[0]) * 1.02) curled++;
    }
    var isFist = curled >= G.fistCurlMin;
    /* 双保险：明确握拳时强制张开度归零，无论标定怎么漂都不绽放 */
    if (isFist) rawOpen = 0;

    var prevO = state.prevOpenness[index] || 0;
    var openness = prevO + (rawOpen - prevO) * G.opennessEma;
    state.prevOpenness[index] = openness;

    /* ---- 捏合 ----
     * 握拳时拇指与食指也靠得很近，只看指尖距离会把每次握拳都当成捏合
     * （乱生小花，且 pinchActive 卡住导致真捏合反而不响应）。因此要求
     * ①拇指-食指尖足够近 ②中/无名/小指至少 2 根伸展 ③手整体张开度
     * 超过门槛，三者同时成立才算有效捏合。 */
    var pinchRaw = dist(l[4], l[8]) / s;
    var pinchClose = clamp((G.pinchRefDist - pinchRaw) / (G.pinchRefDist * 0.85), 0, 1);
    var otherExt = 0;
    for (var e = 0; e < 3; e++) {
      if (dist(l[OTHER_TIPS[e]], l[0]) > dist(l[OTHER_PIPS[e]], l[0]) * 1.12) otherExt++;
    }
    var pinchEligible = !isFist &&
      otherExt >= G.pinchOtherExtend &&
      openness > G.pinchMinOpen;
    var pinch = pinchEligible ? pinchClose : 0;

    /* 自拍镜像：video 显示时水平翻转，故 x 取 1-x 才与画面一致 */
    var cx = (1 - (l[0].x + l[9].x) / 2) * W;
    var cy = ((l[0].y + l[9].y) / 2) * H;
    var center = { x: cx, y: cy };

    var prevC = state.prevCenters[index];
    var velocity = { x: 0, y: 0 };
    if (prevC) {
      velocity.x = (cx - prevC.x) / (s * W);
      velocity.y = (cy - prevC.y) / (s * H);
    }
    state.prevCenters[index] = { x: cx, y: cy };

    /* 用于绘制骨架：同样做镜像 */
    var screen = l.map(function (p) {
      return { x: (1 - p.x) * W, y: p.y * H, z: p.z || 0 };
    });

    return {
      index: index,
      center: center,
      tip: { x: (1 - l[8].x) * W, y: l[8].y * H },
      landmarks: screen,
      palmScale: s,
      openness: openness,
      isFist: isFist,
      pinch: pinch,
      pinchRaw: pinchRaw,
      pinchClose: pinchClose,
      pinchEligible: pinchEligible,
      velocity: velocity
    };
  }

  /* ---------- 摄像头模式 ---------- */
  function startCamera(video, W, H) {
    state.video = video;
    state.width = W; state.height = H;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status('insecure', '当前环境不支持摄像头（需要 https 或 localhost）');
      return Promise.resolve(false);
    }

    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(function (stream) {
      state.stream = stream;
      video.srcObject = stream;
      return video.play().catch(function () {});
    }).then(function () {
      status('model', '正在唤醒手势识别…');
      return loadLandmarker();
    }).then(function (lm) {
      state.landmarker = lm;
      state.mode = 'camera';
      state.lastSeenAt = performance.now();
      status('ready', '摄像头已就绪');
      return true;
    }).catch(function (err) {
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        status('denied', '摄像头权限被拒绝');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        status('nocamera', '没有找到摄像头');
      } else {
        status('modelfailed', '手势模型加载失败：' + ((err && err.message) || name || '未知错误'));
      }
      stopCamera();
      return false;
    });
  }

  var TAG = '[yshnb/vision]';

  function log() {
    if (global.console && console.info) console.info.apply(console, arguments);
  }
  function warn() {
    if (global.console && console.warn) console.warn.apply(console, arguments);
  }

  /* 超时会标记 __timeout：超时的实例底层仍在运行，绝不能「再建一个」
   * 取代它，否则两个 createFromOptions 会争夺全局 ModuleFactory 而双双挂起。 */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error(label + ' 超时（>' + Math.round(ms / 1000) + 's）');
        e.__timeout = true;
        reject(e);
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /* ---------- 资源预下载：整站只下载一次，带真实字节进度 ----------
   * 旧实现把未压缩的模型与 wasm 下载压在 createFromOptions 的 45s 超时里，慢网必炸；
   * 且开始页并发预热 4 个文件，与初始化重复下载、互抢带宽。
   * 现在由单例 Promise 统管：优先 gzip 流式解压（约 10 MB），结果以
   * ArrayBuffer 缓存；初始化改用 blob URL + modelAssetBuffer，零网络请求，
   * 超时只用于本地 wasm 编译。失败也保留已下载资源，重试不再重复拉取。 */
  var boot = {
    promise: null,      // 整个加载的单例（首次 / 预热 / 重试共用，绝不并发）
    assets: null        // 已下载资源缓存
  };

  function canGunzip() {
    try {
      return typeof global.DecompressionStream === 'function' &&
             typeof global.Response === 'function' &&
             typeof global.Blob === 'function';
    } catch (e) { return false; }
  }

  /* AbortController 超时会真正中止请求，不像旧 withTimeout 只拒绝外层
   * Promise、把底层 fetch 留在后台继续占带宽。 */
  function fetchBuffer(url, timeoutMs, onBytes, cancelSignal) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    var onCancel = null;
    /* 竞速输掉的源会被外部 abort；把外部信号接到内部 controller 上 */
    if (ctrl && cancelSignal) {
      if (cancelSignal.aborted) ctrl.abort();
      else {
        onCancel = function () { try { ctrl.abort(); } catch (e) {} };
        cancelSignal.addEventListener('abort', onCancel);
      }
    }
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (onCancel && cancelSignal && cancelSignal.removeEventListener) {
        try { cancelSignal.removeEventListener('abort', onCancel); } catch (e) {}
      }
    }
    var opts = { credentials: 'same-origin' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + url.split('/').pop());
      var total = Number(r.headers && r.headers.get('content-length')) || 0;
      if (!r.body || !r.body.getReader) {
        return r.arrayBuffer().then(function (b) {
          if (onBytes) onBytes(b.byteLength, total || b.byteLength);
          return b;
        });
      }
      var reader = r.body.getReader();
      var chunks = [], received = 0;
      return new Promise(function (resolve, reject) {
        function pump() {
          reader.read().then(function (step) {
            if (step.done) {
              var out = new Uint8Array(received), off = 0;
              for (var i = 0; i < chunks.length; i++) {
                out.set(chunks[i], off); off += chunks[i].length;
              }
              resolve(out.buffer);
              return;
            }
            chunks.push(step.value);
            received += step.value.length;
            if (onBytes) onBytes(received, total);
            pump();
          }, reject);
        }
        pump();
      });
    }).then(function (buf) {
      cleanup();
      return buf;
    }, function (e) {
      cleanup();
      if (e && e.name === 'AbortError') e = new Error('下载超时/取消：' + url.split('/').pop());
      throw e;
    });
  }

  function gunzip(buf) {
    var ds = new global.DecompressionStream('gzip');
    var stream = new Blob([buf]).stream().pipeThrough(ds);
    return new global.Response(stream).arrayBuffer();
  }

  /* ---------- 多源竞速 ----------
   * 同一资源同时从多个镜像发起下载，谁先完整下完用谁，其余立即 abort。
   * 真机实测：GitHub Pages 15~20KB/s（9.9MB 要 10 分钟，必超时），
   * jsDelivr gh 代理 140~260KB/s。并发先到先得，自动挑出当前网络下
   * 最快的源，也避免慢源一直占着带宽拖到超时。 */
  function hostOf(u) {
    try { return new URL(u, document.baseURI).host; } catch (e) { return String(u); }
  }
  function fetchRace(urls, timeoutMs, onBytes, label) {
    var list = (urls && urls.length) ? urls : null;
    if (!list) return Promise.reject(new Error(label + ' 无可用下载地址'));
    if (list.length === 1) return fetchBuffer(list[0], timeoutMs, onBytes);
    return new Promise(function (resolve, reject) {
      var settled = false, remaining = list.length, lastErr = null, ctrls = [];
      var best = 0, bestTotal = 0;
      /* 多个源并发上报进度会互相打架，取最大值保证进度条单调不倒退 */
      function report(r, t) {
        if (r > best) best = r;
        if (t && t > bestTotal) bestTotal = t;
        if (onBytes) onBytes(best, bestTotal);
      }
      list.forEach(function (u, i) {
        var c = (typeof AbortController === 'function') ? new AbortController() : null;
        ctrls.push(c);
        fetchBuffer(u, timeoutMs, report, c ? c.signal : null).then(function (buf) {
          if (settled) return;
          settled = true;
          for (var j = 0; j < ctrls.length; j++) {
            if (j !== i && ctrls[j]) { try { ctrls[j].abort(); } catch (e) {} }
          }
          log(TAG, label + ' 竞速命中 ' + hostOf(u) +
              ' (' + (buf.byteLength / 1048576).toFixed(2) + ' MB)');
          resolve(buf);
        }, function (e) {
          lastErr = e;
          remaining--;
          if (remaining <= 0 && !settled) {
            settled = true;
            reject(lastErr || new Error(label + ' 全部下载源失败'));
          }
        });
      });
    });
  }

  /* ---------- 本地持久化缓存（Cache Storage） ----------
   * 第一次成功后把【解压后的最终资源】写进浏览器缓存；之后每次打开
   * 直接命中，完全不联网、秒开。key 带版本号，资源更新时自动失效。
   * 任何一步不支持/失败都静默降级为纯下载，不影响主流程。 */
  var CACHE_NAME = 'yshnb-vision-' + (V.cacheVersion || 'v1');
  function cacheKey(name) {
    try { return new URL('./__visioncache__/' + name, document.baseURI).href; }
    catch (e) { return './__visioncache__/' + name; }
  }
  function cacheGet(name) {
    if (!V.cacheEnabled || !global.caches) return Promise.resolve(null);
    return global.caches.open(CACHE_NAME).then(function (c) {
      return c.match(cacheKey(name));
    }).then(function (r) {
      return r ? r.arrayBuffer() : null;
    }).catch(function () { return null; });
  }
  function cachePut(name, buf) {
    if (!V.cacheEnabled || !global.caches || !global.Response) return Promise.resolve();
    try {
      /* 返回 Promise：首次加载会等它写完，保证第二次打开必定命中 */
      return global.caches.open(CACHE_NAME).then(function (c) {
        return c.put(cacheKey(name), new global.Response(buf, {
          headers: { 'Content-Type': 'application/octet-stream' }
        }));
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  /* 单个资源：gzip 优先，任何环节失败都回退原始文件。
   * magic 是目标文件头（wasm = 00 61 73 6d，task = 50 4b 'PK'），
   * 用于识别「CDN 已自动解压」的情况：此时 body 已是原文，不能再 gunzip。 */
  /* 单个资源：先查本地缓存 → 未命中再 gzip 竞速（失败回退原始文件竞速），
   * 成功后异步写回缓存。gzUrls / rawUrls 现在是【URL 数组】。 */
  function fetchAsset(gzUrls, rawUrls, timeoutMs, onBytes, label, magic, estBytes) {
    var name = label + '.bin';
    return cacheGet(name).then(function (cached) {
      if (cached && cached.byteLength) {
        log(TAG, label + ' 命中本地缓存 ' + cached.byteLength + ' B（免下载）');
        if (onBytes) onBytes(estBytes || cached.byteLength, estBytes || cached.byteLength);
        return cached;
      }
      return downloadAsset(gzUrls, rawUrls, timeoutMs, onBytes, label, magic)
        .then(function (buf) {
          return cachePut(name, buf).then(function () { return buf; },
                                         function () { return buf; });
        });
    });
  }

  function downloadAsset(gzUrls, rawUrls, timeoutMs, onBytes, label, magic) {
    if (canGunzip() && gzUrls && gzUrls.length) {
      return fetchRace(gzUrls, timeoutMs, onBytes, label).then(function (buf) {
        var h = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
        var isGz = h[0] === 0x1f && h[1] === 0x8b;
        /* .task 文件在 PK 头前可能带前缀，故在文件头内搜索签名而非硬比前 4 字节 */
        var isRaw = false;
        if (magic) {
          for (var i = 0; i + magic.length <= h.length; i++) {
            var hit = true;
            for (var j = 0; j < magic.length; j++) {
              if (h[i + j] !== magic[j]) { hit = false; break; }
            }
            if (hit) { isRaw = true; break; }
          }
        }
        if (isRaw) { log(TAG, label + ' 响应已被自动解压，跳过 gunzip'); return buf; }
        if (isGz) return gunzip(buf);
        throw new Error('响应既非 gzip 也非目标文件');
      }).catch(function (e) {
        warn(TAG, label + ' gzip 路径不可用，回退原始文件：', e && e.message);
        return fetchRace(rawUrls, timeoutMs, onBytes, label);
      });
    }
    return fetchRace(rawUrls, timeoutMs, onBytes, label);
  }

  function prepareAssets() {
    if (boot.assets) return Promise.resolve(boot.assets);
    var prog = [{ r: 0, t: 0 }, { r: 0, t: 0 }];
    var lastEmit = 0;
    function emitAll(force) {
      var now = Date.now();
      if (!force && now - lastEmit < V.progressThrottleMs) return;
      lastEmit = now;
      var loaded = prog[0].r + prog[1].r;
      /* 分母取「响应头长度 / 已收字节 / 预估体积」三者最大值：
       * 两个资源不会同时回报长度，用预估值兜底可避免首帧百分比虚高。 */
      var totalB = Math.max(prog[0].t, prog[0].r, V.wasmGzBytes || 1) +
                   Math.max(prog[1].t, prog[1].r, V.modelGzBytes || 1);
      var pct = force ? 100 : Math.min(99, Math.round(loaded / totalB * 100));
      status('download', '正在加载手势模型 ' +
        (loaded / 1048576).toFixed(1) + ' / ' + (totalB / 1048576).toFixed(1) +
        ' MB · ' + pct + '%');
    }
    function emit(i) {
      return function (received, total) {
        prog[i].r = received;
        if (total) prog[i].t = total;
        emitAll(false);
      };
    }
    return Promise.all([
      fetchAsset(V.wasmGzUrls || [V.wasmGzPath], V.wasmRawUrls || [V.wasmBinaryPath],
                 V.downloadTimeoutMs, emit(0), 'wasm', [0x00, 0x61, 0x73, 0x6d], V.wasmGzBytes),
      fetchAsset(V.modelGzUrls || [V.modelGzPath], V.modelRawUrls || [V.modelPath],
                 V.downloadTimeoutMs, emit(1), 'model', [0x50, 0x4b, 0x03, 0x04], V.modelGzBytes)
    ]).then(function (arr) {
      var wasmBuf = arr[0], modelBuf = arr[1];
      /* blob URL 让 glue 的 locateFile 命中内存，初始化阶段不再发网络请求 */
      var wasmUrl = V.wasmBinaryPath;
      try {
        wasmUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));
      } catch (e) { warn(TAG, 'blob URL 不可用，回退文件 URL'); }
      boot.assets = {
        fileset: { wasmLoaderPath: V.wasmLoaderPath, wasmBinaryPath: wasmUrl },
        modelBuffer: new Uint8Array(modelBuf)
      };
      emitAll(true);   // 补一次 100% 终态，避免节流把最后一帧吞掉
      status('download', '资源就绪，正在初始化…');
      log(TAG, '资源已缓存：wasm ' + wasmBuf.byteLength + ' B, model ' + modelBuf.byteLength + ' B');
      return boot.assets;
    });
  }

  function makeOptions(delegate, assets) {
    return {
      baseOptions: { modelAssetBuffer: assets.modelBuffer, delegate: delegate },
      runningMode: 'VIDEO',
      numHands: V.numHands,
      minHandDetectionConfidence: V.minHandDetectionConfidence,
      minHandPresenceConfidence: V.minHandPresenceConfidence,
      minTrackingConfidence: V.minTrackingConfidence
    };
  }

  function buildFast(mod, delegate, assets) {
    return withTimeout(
      mod.HandLandmarker.createFromOptions(assets.fileset, makeOptions(delegate, assets)),
      V.initTimeoutMs, '模型初始化(' + delegate + ')'
    );
  }

  /* 兜底：退回 FilesetResolver + 原始 wasm URL，万一某浏览器不接受
   * blob URL 仍能救回来；模型仍用已缓存的 buffer，避免再下载一次。 */
  function buildLegacy(mod, assets) {
    return mod.FilesetResolver.forVisionTasks(V.wasmPath).then(function (fileset) {
      return withTimeout(mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: assets.modelBuffer, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: V.numHands,
        minHandDetectionConfidence: V.minHandDetectionConfidence,
        minHandPresenceConfidence: V.minHandPresenceConfidence,
        minTrackingConfidence: V.minTrackingConfidence
      }), V.initTimeoutMs, '标准初始化(CPU)');
    });
  }

  function initLandmarker(mod, assets) {
    /* 严格串行：只有「明确报错」才换后端重来；超时说明底层实例还在跑，
     * 此时另起一个 createFromOptions 会与它争全局 ModuleFactory，必挂。 */
    return buildFast(mod, V.delegate, assets).catch(function (e) {
      if (e && e.__timeout) throw e;
      warn(TAG, V.delegate + ' 后端不可用，改用 CPU：', e && e.message);
      return buildFast(mod, 'CPU', assets);
    }).catch(function (e) {
      if (e && e.__timeout) throw e;
      warn(TAG, '内存资源初始化失败，回退标准加载：', e && e.message);
      return buildLegacy(mod, assets);
    });
  }

  /* ESM 入口：动态 import 无法中止，改为多源并发、先成功先用。
   * bundle 只有 156KB，正常 <2s；多源是为了本站也慢时能借 CDN 提速。 */
  function importBundle() {
    var urls = (V.bundleUrls && V.bundleUrls.length) ? V.bundleUrls : [V.bundleUrl];
    return new Promise(function (resolve, reject) {
      var remaining = urls.length, lastErr = null, done = false;
      urls.forEach(function (u) {
        import(u).then(function (mod) {
          if (!done) { done = true; resolve(mod); }
        }, function (e) {
          lastErr = e;
          remaining--;
          if (remaining <= 0 && !done) reject(lastErr || new Error('ESM 模块不可用'));
        });
      });
    });
  }

  function doLoad() {
    return withTimeout(importBundle(), 30000, 'ESM 模块').then(function (mod) {
      if (!mod || !mod.FilesetResolver || !mod.HandLandmarker) {
        throw new Error('ESM 模块导出异常（FilesetResolver / HandLandmarker 缺失）');
      }
      log(TAG, 'bundle 已加载');
      return prepareAssets()
        .then(function (assets) { return initLandmarker(mod, assets); })
        .then(function (lm) { log(TAG, 'HandLandmarker 就绪'); return lm; });
    });
  }

  /* 单例：首次、开始页预热、失败重试全部复用同一个 Promise。
   * 只有彻底失败才清空，但 boot.assets 保留 → 重试不再下载约 10 MB。 */
  function loadLandmarker() {
    if (boot.promise) return boot.promise;
    boot.promise = doLoad().catch(function (err) {
      if (global.console && console.error) {
        console.error(TAG, '加载失败：', (err && err.message) || err, err);
      }
      boot.promise = null;
      throw err;
    });
    return boot.promise;
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    if (state.video) state.video.srcObject = null;
    state.landmarker = null;
    state.mode = 'idle';
    state.prevOpenness.length = 0;
    state.prevLandmarks.length = 0;
    state.prevCenters.length = 0;
    state.calib.length = 0;
  }

  /* ---------- 鼠标 / 触摸降级 ---------- */
  function usePointer(W, H) {
    state.mode = 'pointer';
    state.width = W; state.height = H;
    status('pointer', '已切换到鼠标模式');
  }

  function setPointer(x, y, W, H, down, now) {
    var p = state.pointer;
    p.x = x / W; p.y = y / H;
    p.px = x; p.py = y;
    p.moved = true;
    if (down === true && !p.down) { p.down = true; p.downAt = now; }
    if (down === false && p.down) { p.down = false; p.upAt = now; }
  }

  /* ---------- 每帧统一出口 ---------- */
  function update(now, W, H) {
    state.width = W; state.height = H;
    var frame = {
      now: now, mode: state.mode, hands: [], pointer: null,
      lastSeenAt: state.lastSeenAt, events: []
    };

    if (state.mode === 'camera' && state.landmarker && state.video && state.video.readyState >= 2) {
      /* 时间戳必须严格递增，否则 MediaPipe 会抛错 */
      var ts = now > state.lastTs ? now : state.lastTs + 1;
      state.lastTs = ts;
      try {
        var res = state.landmarker.detectForVideo(state.video, ts);
        var rawHands = (res && res.landmarks) || [];
        if (rawHands.length) {
          state.lastSeenAt = now;
          /* 先按镜像后的掌心 x 排序原始关键点，再分配索引：平滑状态与
           * 花朵 id 共用同一稳定顺序，双手时不会互相污染或左右乱跳。 */
          var ordered = rawHands.slice().sort(function (a, b) {
            var ax = 1 - (a[0].x + a[9].x) / 2;
            var bx = 1 - (b[0].x + b[9].x) / 2;
            return ax - bx;
          });
          state.prevLandmarks.length = ordered.length;
          state.prevCenters.length = ordered.length;
          frame.hands = ordered.map(function (raw, i) {
            return describe(smoothLandmarks(raw, i), i, now, W, H);
          });
        }
      } catch (e) {
        /* 单帧检测失败不打断主循环 */
      }
    } else if (state.mode === 'pointer') {
      var p = state.pointer;
      var held = p.down;
      /* 按住 = 握拳；松开 = 绽放；水平位置做细微调制 */
      var openness = held ? 0.05 : (0.78 + 0.22 * clamp(p.x, 0, 1));
      var po = state.prevOpenness[0] || 0;
      openness = po + (openness - po) * 0.12;
      state.prevOpenness[0] = openness;
      frame.pointer = { x: p.px, y: p.py, openness: openness, isFist: held };
      frame.hands = [{
        index: 0, center: { x: p.px, y: p.py }, tip: { x: p.px, y: p.py },
        landmarks: [], palmScale: 1, openness: openness, isFist: held,
        pinch: 0, pinchRaw: 1, pinchClose: 0, pinchEligible: false,
        velocity: { x: 0, y: 0 }
      }];
      state.lastSeenAt = now;
      if (p.upAt && !p.down) {
        if (p.upAt - p.downAt >= G.fistHoldMs) frame.events.push({ type: 'pulse' });
        p.upAt = 0;
      }
    }

    frame.lastSeenAt = state.lastSeenAt;
    return frame;
  }

  Y.Hand = {
    init: function (opts) { state.onStatus = opts.onStatus || function () {}; },
    /* 开始页后台预热：与 startCamera 共用同一个单例 Promise，
     * 用户读说明的几秒里就把资源拉进内存，进入体验页时直接命中。 */
    preload: function () { return loadLandmarker().catch(function () {}); },
    startCamera: startCamera,
    stopCamera: stopCamera,
    usePointer: usePointer,
    setPointer: setPointer,
    update: update,
    get mode() { return state.mode; },
    get pointer() { return state.pointer; }
  };
})(window);
