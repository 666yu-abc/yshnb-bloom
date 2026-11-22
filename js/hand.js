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

  var state = {
    mode: 'idle',              // idle | camera | pointer
    landmarker: null,
    video: null,
    stream: null,
    prevLandmarks: [],         // 上一帧平滑后的关键点，用于 EMA
    prevCenters: [],
    prevOpenness: [],          // 按手索引分别平滑，避免两只手互相污染
    rawWindows: [],            // 按手索引的张开度观测窗口（自适应标定）
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
    /* 自适应标定：取最近约 2.5 秒观测值的 min/max 做动态拉伸。
     * 手型大小、离镜头远近因人而异，固定阈值无法兼顾；只要做过一次
     * 握拳→张手，窗口即覆盖完整量程，openness 自然铺满 0~1。
     * 窗口按手索引分开，双手时互不污染。 */
    var win = state.rawWindows[index] || (state.rawWindows[index] = []);
    win.push(raw);
    if (win.length > G.rawWindowFrames) win.shift();
    var lo, hi;
    if (win.length >= 20) {
      var mn = Infinity, mx = -Infinity;
      for (var qi = 0; qi < win.length; qi++) {
        if (win[qi] < mn) mn = win[qi];
        if (win[qi] > mx) mx = win[qi];
      }
      var span = Math.max(G.adaptSpanMin, mx - mn);
      var mid = (mn + mx) * 0.5;
      lo = mid - span * 0.5;
      hi = mid + span * 0.5;
    } else {
      lo = G.openMin; hi = G.openMax;
    }
    var rawOpen = clamp((raw - lo) / (hi - lo), 0, 1);
    var prevO = state.prevOpenness[index] || 0;
    var openness = prevO + (rawOpen - prevO) * G.opennessEma;
    state.prevOpenness[index] = openness;

    /* 卷曲计数：指尖比近节更靠近腕，说明这根手指弯了 */
    var curled = 0;
    for (var j = 0; j < FOUR_TIPS.length; j++) {
      if (dist(l[FOUR_TIPS[j]], l[0]) < dist(l[FOUR_PIPS[j]], l[0]) * 1.02) curled++;
    }
    var isFist = curled >= 3 && openness < G.fistThreshold;

    var pinchRaw = dist(l[4], l[8]) / s;
    var pinch = clamp((pinchRaw - 0.15) / 1.1, 0, 1);

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
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) reject(new Error(label + ' 超时（>' + Math.round(ms / 1000) + 's）'));
      }, ms);
      promise.then(function (v) { done = true; clearTimeout(timer); resolve(v); },
                   function (e) { done = true; clearTimeout(timer); reject(e); });
    });
  }

  function loadLandmarker() {
    /* 动态 import 本地 ESM bundle；不依赖任何外部 CDN。
     * 每一步单独包超时并打日志，任何一环失败都能在控制台看到确切原因，
     * 错误信息也会回传到界面提示，而不是笼统的「网络或路径问题」。 */
    return withTimeout(import(V.bundleUrl), 20000, 'ESM 模块').then(function (mod) {
      if (!mod || !mod.FilesetResolver || !mod.HandLandmarker) {
        throw new Error('ESM 模块导出异常（FilesetResolver / HandLandmarker 缺失）');
      }
      log(TAG, 'bundle 已加载');
      return withTimeout(
        mod.FilesetResolver.forVisionTasks(V.wasmPath), 20000, 'wasm 路径解析'
      ).then(function (fileset) {
        function build(delegate) {
          return withTimeout(
            mod.HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: V.modelPath, delegate: delegate },
              runningMode: 'VIDEO',
              numHands: V.numHands,
              minHandDetectionConfidence: V.minHandDetectionConfidence,
              minHandPresenceConfidence: V.minHandPresenceConfidence,
              minTrackingConfidence: V.minTrackingConfidence
            }), 45000, '模型初始化(' + delegate + ')'
          );
        }
        /* 有些设备没有可用的 WebGL 后端，GPU 建不起来时自动退回 CPU 推理 */
        return build(V.delegate).catch(function (gpuErr) {
          if (global.console && console.warn) {
            console.warn(TAG, 'GPU 后端不可用，改用 CPU：', gpuErr && gpuErr.message);
          }
          return build('CPU');
        });
      }).then(function (lm) {
        log(TAG, 'HandLandmarker 就绪');
        return lm;
      });
    }).catch(function (err) {
      if (global.console && console.error) {
        console.error(TAG, '加载失败：', (err && err.message) || err, err);
        console.error(TAG, '资源路径：', V.bundleUrl, V.wasmPath, V.modelPath);
      }
      throw err;
    });
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
    state.rawWindows.length = 0;
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
        pinch: 0, pinchRaw: 1, velocity: { x: 0, y: 0 }
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
    startCamera: startCamera,
    stopCamera: stopCamera,
    usePointer: usePointer,
    setPointer: setPointer,
    update: update,
    get mode() { return state.mode; },
    get pointer() { return state.pointer; }
  };
})(window);
