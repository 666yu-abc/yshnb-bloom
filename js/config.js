/* ============================================================
 * yshnb · 指尖生花  —  参数总表（Nocturne / 暗色精细版 · Lumen）
 * 所有可调数值集中在这里，一处改动、全站生效。
 * ============================================================ */
(function (global) {
  'use strict';

  /* 资源一律解析成绝对 URL：
   * 站点可能部署在子目录（/yshnb-bloom/）或本地服务，MediaPipe 内部
   * 用 fetch / import 加载 wasm 与模型，相对路径的解析基准不固定，
   * 用绝对地址才能稳定命中，避免「模型加载失败」。 */
  function abs(p) {
    try { return new URL(p, document.baseURI).href; }
    catch (e) { return p; }
  }

  var CFG = {
    /* ---------- 花朵几何：三层花轮，外层先开、内层后开 ----------
     * 每片花瓣由「瓣缘高光 + 侧脉 + 稀疏填充」三类粒子构成，
     * 并另绘极低透明度瓣面与极细瓣缘描边，形成纱质实体感。
     * 伪 3D：花瓣以 tilt 角斜立，花平面按 flatten 压成椭圆（斜俯视）。
     */
    flower: {
      whorls: [
        /* 外层：冷蓝珠光，最长、最先舒展 */
        { count: 9, phase: 0.00, rot: 0.00,
          lenClosed: 46, lenOpen: 236, radiusClosed: 20, radiusOpen: 66,
          widthClosed: 0.20, widthOpen: 0.36,
          curlClosed: 0.98, curlOpen: 0.08,
          tiltClosed: 1.06, tiltOpen: 0.30,
          profilePow: 0.62, lag: 0.00, twistDir: 1,
          root: '#6E9AD2', tip: '#F2FAFF', glow: '#E6F3FF' },
        /* 中层：淡玫瑰，错开半个瓣位 */
        { count: 8, phase: 0.50, rot: 0.36,
          lenClosed: 38, lenOpen: 178, radiusClosed: 16, radiusOpen: 48,
          widthClosed: 0.18, widthOpen: 0.33,
          curlClosed: 1.04, curlOpen: 0.14,
          tiltClosed: 1.12, tiltOpen: 0.22,
          profilePow: 0.66, lag: 0.12, twistDir: -1,
          root: '#C284AC', tip: '#FFF0F8', glow: '#FFE4F0' },
        /* 内层：奶油金，最卷、最后开，包住花心 */
        { count: 6, phase: 0.28, rot: 0.72,
          lenClosed: 30, lenOpen: 116, radiusClosed: 12, radiusOpen: 30,
          widthClosed: 0.16, widthOpen: 0.30,
          curlClosed: 1.10, curlOpen: 0.26,
          tiltClosed: 1.18, tiltOpen: 0.14,
          profilePow: 0.72, lag: 0.24, twistDir: 1,
          root: '#DBA964', tip: '#FFF6DC', glow: '#FFEDC4' }
      ],
      rings: 11,          // 沿瓣长采样行数
      edgeBands: 2,       // 每条瓣缘的粒子束数（描边密度）
      veinCount: 3,       // 每片花瓣的侧脉数
      fillPerRow: 2,      // 每行填充散点数
      coreCount: 200,     // 花心颗粒
      stamenCount: 28,    // 雄蕊细丝
      flatten: 0.82,      // 花平面透视压缩（<1 呈椭圆，斜俯视）
      zScale: 0.92,       // 卷曲高度投影系数
      twist: 0.16,        // 开放时花瓣缓慢旋展的角度 (rad)
      faceAlpha: 0.088,   // 瓣面填充透明度（提亮）
      edgeLineAlpha: 0.22,// 瓣缘高光线透明度
      ripple: 0.055,      // 瓣缘细波浪起伏
      swayAmp: 0.019,     // 整朵摇曳角度
      swaySpeed: 0.00042, // 摇曳角速度
      drawStem: true      // 极淡银线茎与叶（暗底克制装饰）
    },

    /* ---------- 光粒与辉光：让花「发亮」而不是干涩的点 ---------- */
    light: {
      haloAlpha: 0.20,       // 每片花瓣中心的柔光晕
      haloScale: 0.44,       // 相对瓣长
      motesPerFlower: 96,    // 环绕花朵缓慢浮游的光粒
      moteRadius: 1.42,      // 相对外轮半径
      moteAlpha: 0.72,
      moteSizeMin: 1.2,
      moteSizeMax: 3.6,
      moteDrift: 0.00032,    // 浮游角速度
      moteBob: 0.0011,       // 明暗呼吸速度
      glintsPerFlower: 30,   // 十字星芒（稀疏、纯白、闪烁）
      glintAlpha: 0.80,
      glintLen: 7,
      coreGlowAlpha: 0.40,   // 花心主光晕
      coreGlowSize: 132,
      coreGlow2Alpha: 0.30,  // 花心内层白核
      coreGlow2Size: 58,
      twinkleSpeed: 0.0021,
      twinkleDepth: 0.32
    },

    /* ---------- 粒子物理 ---------- */
    physics: {
      stiffness: 0.058,
      damping: 0.872,
      jitter: 0.16,
      breathAmp: 2.1,
      breathSpeed: 0.00078,
      pointerRadius: 150,
      pointerForce: 0.50,
      windDecay: 0.92,
      windStrength: 5.0,
      burstSpeed: 6.0,
      burstCount: 140
    },

    /* ---------- 手势识别 ----------
     * 旧值 1.15 / 2.75 远高于 MediaPipe 实际几何量（握拳 raw≈0.8、
     * 张手 raw≈1.2），导致 openness 长期偏低、永远触不到盛放阈值。
     * 现在改为「滑动窗口 min/max 动态拉伸」：手型与远近因人而异，
     * 只要做过一次握拳→张手，窗口即覆盖完整量程，openness 铺满 0~1。 */
    gesture: {
      emaAlpha: 0.24,
      opennessEma: 0.17,
      palmPairs: [[0, 9], [5, 17]],
      openMin: 0.80,           // 窗口未积累时的初始标定
      openMax: 1.30,
      rawWindowFrames: 150,    // 约 2.5 秒观测窗口
      adaptSpanMin: 0.30,      // 最小跨度，静止时不过度放大噪声
      spreadWeight: 0.62,
      interWeight: 0.38,
      fistThreshold: 0.20,
      bloomThreshold: 0.60,
      hysteresis: 0.075,
      fistHoldMs: 200,
      fastOpenMs: 420,
      pulseCooldownMs: 1100,
      pinchOn: 0.42,
      pinchOff: 0.62,
      pinchCooldownMs: 900,
      swipeSpeed: 0.0075,
      swipeCooldownMs: 700,
      lostHandMs: 420,
      idleCloseSpeed: 0.0012
    },

    /* ---------- 渲染 ---------- */
    render: {
      maxDpr: 2,
      trailFade: 0.46,     // 铺底不透明度：略降 → 光轨更长、花更亮
      particleAlpha: 0.94, // 粒子总亮度系数
      coreAlpha: 1.0,
      edgeAlpha: 1.0,      // 瓣缘：亮而密，勾出轮廓
      veinAlpha: 0.74,     // 侧脉
      fillAlpha: 0.54,     // 填充：淡，像花粉
      spriteSize: 20,
      sparkMax: 420,
      sparkLifeMs: 1350,
      skeletonAlpha: 0.52,
      autoQuality: true,
      targetFrameMs: 24,
      minQuality: 0.42
    },

    /* ---------- 配色：深墨底 + 月光花 ---------- */
    palette: {
      bg: '#0A0B0E',
      ink: '#EDE8DE',
      sage: '#9CB4C4',     // 骨架线（银蓝）
      clay: '#E0BC84',     // 骨架点（香槟金）
      core: '#FFF0C8',     // 花心（更亮）
      spark: '#FFF4DC',    // 火花
      stem: '#8FA3B2',     // 极淡银茎
      glow: '#FFDCA0'      // 花心光晕
    },

    /* ---------- 识别模型（绝对 URL，杜绝子目录解析歧义） ---------- */
    vision: {
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.50,
      minTrackingConfidence: 0.50,
      delegate: 'GPU',
      bundleUrl: abs('./vendor/vision_bundle.mjs'),
      wasmPath: abs('./vendor/wasm'),
      modelPath: abs('./vendor/hand_landmarker.task')
    }
  };

  global.YSHNB = global.YSHNB || {};
  global.YSHNB.CFG = CFG;
})(window);
