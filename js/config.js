/* ============================================================
 * yshnb · 指尖生花  —  参数总表（Nocturne / 暗色精细版 · Rosé）
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
     * 每片花瓣 = 平滑贝塞尔轮廓 + 根→尖渐变瓣面 + 三层瓣缘描边
     *            + 主脉 / 侧脉 / 瓣尖高光 + 稀疏填充粒子。
     * 轮廓质感由矢量层保证（不随性能降质），粒子层只负责闪烁细节。
     * 伪 3D：花瓣以 tilt 角斜立，花平面按 flatten 压成椭圆（斜俯视）。
     */
    flower: {
      whorls: [
        /* 外层：樱花粉白，最长、最先舒展 */
        { count: 9, phase: 0.00, rot: 0.00,
          lenClosed: 46, lenOpen: 236, radiusClosed: 20, radiusOpen: 66,
          widthClosed: 0.20, widthOpen: 0.36,
          curlClosed: 0.98, curlOpen: 0.08,
          tiltClosed: 1.06, tiltOpen: 0.30,
          profilePow: 0.62, lag: 0.00, twistDir: 1,
          root: '#F2B4CE', tip: '#FFF6FA', glow: '#FFE8F3' },
        /* 中层：淡玫瑰粉，错开半个瓣位 */
        { count: 8, phase: 0.50, rot: 0.36,
          lenClosed: 38, lenOpen: 178, radiusClosed: 16, radiusOpen: 48,
          widthClosed: 0.18, widthOpen: 0.33,
          curlClosed: 1.04, curlOpen: 0.14,
          tiltClosed: 1.12, tiltOpen: 0.22,
          profilePow: 0.66, lag: 0.12, twistDir: -1,
          root: '#E39BBE', tip: '#FFEDF6', glow: '#FFDCEC' },
        /* 内层：蜜桃暖粉，最卷、最后开，包住花心 */
        { count: 6, phase: 0.28, rot: 0.72,
          lenClosed: 30, lenOpen: 116, radiusClosed: 12, radiusOpen: 30,
          widthClosed: 0.16, widthOpen: 0.30,
          curlClosed: 1.10, curlOpen: 0.26,
          tiltClosed: 1.18, tiltOpen: 0.14,
          profilePow: 0.72, lag: 0.24, twistDir: 1,
          root: '#E9A6B4', tip: '#FFF3EE', glow: '#FFE2DC' }
      ],
      /* 粒子预算刻意保持旧值：瓣缘的精细度由 26 段贝塞尔矢量层承担，
       * 比加密粒子更平滑，也不会重蹈之前粒子过多掉帧的覆辙。 */
      rings: 11,          // 沿瓣长采样行数
      edgeBands: 2,       // 每条瓣缘的粒子束数（描边密度）
      veinCount: 3,       // 每片花瓣的侧脉数
      fillPerRow: 2,      // 每行填充散点数
      coreCount: 200,     // 花心颗粒
      stamenCount: 28,    // 雄蕊细丝
      flatten: 0.82,      // 花平面透视压缩（<1 呈椭圆，斜俯视）
      zScale: 0.92,       // 卷曲高度投影系数
      twist: 0.16,        // 开放时花瓣缓慢旋展的角度 (rad)
      /* 矢量层：花瓣边缘的精细度主要靠这几项（旧版是 10 段直线 + 纯色面） */
      petalSeg: 26,        // 平滑曲线采样段数
      ripple: 0.075,       // 瓣缘主波浪起伏
      ripple2: 0.020,      // 瓣缘高频细浪，做出自然褶皱
      faceAlpha: 0.105,    // 瓣面渐变根部不透明度
      faceTipAlpha: 0.018, // 瓣尖近乎透明，薄纱透光
      edgeLineAlpha: 0.32, // 瓣缘亮边
      edgeSoftAlpha: 0.11, // 瓣缘柔光宽边
      edgeInnerAlpha: 0.10,// 内缩细线（瓣缘厚度）
      midribAlpha: 0.15,   // 主脉
      veinLineAlpha: 0.055,// 矢量侧脉
      tipGlintAlpha: 0.55, // 瓣尖高光点
      swayAmp: 0.019,      // 整朵摇曳角度
      swaySpeed: 0.00042,  // 摇曳角速度
      drawStem: true       // 极淡粉灰线茎与叶（暗底克制装饰）
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

    /* ---------- 手势识别 ---------- */
    gesture: {
      emaAlpha: 0.24,
      opennessEma: 0.17,
      palmPairs: [[0, 9], [5, 17]],
      /* 张开度标定：旧版取最近 150 帧的 min/max，长时间保持握拳时窗口
       * 里的张手高值会全部过期，span 被撑住而 mid 掉到握拳值，握拳便被
       * 误算成中等张开度甚至「自动绽放」。现在改为长期极值 + 极慢回归：
       * 新极值立即吸收（自适应手型 / 远近），否则按 26 秒时间常数缓慢
       * 收敛，静态保持一个姿势几秒不会让标定坍缩。 */
      openMin: 0.80,          // 初始标定下限
      openMax: 1.30,          // 初始标定上限
      calibForgetMs: 26000,   // 极值遗忘时间常数
      adaptSpanMin: 0.30,     // 最小标定跨度
      deadZone: 0.08,         // 低位死区，削掉握拳噪声
      fistCurlMin: 3,         // ≥3 指弯曲视为握拳（几何硬事实）
      spreadWeight: 0.62,
      interWeight: 0.38,
      fistThreshold: 0.20,
      bloomThreshold: 0.60,
      bloomConfirmMs: 110,    // 盛放需连续确认，防单帧尖峰
      hysteresis: 0.075,
      fistHoldMs: 200,
      fastOpenMs: 420,
      pulseCooldownMs: 1100,
      /* 捏合：握拳时拇指与食指同样靠得很近，只看指尖距离会把每次握拳
       * 都误判成捏合（乱生小花，且状态卡住导致真捏合不响应）。因此要求
       * 拇指-食指够近 + 其余三指伸展 + 手整体张开，三者同时成立才算。 */
      pinchRefDist: 1.0,      // 归一化参考距离（掌宽倍数）
      pinchOn: 0.55,          // 捏合接近度阈值
      pinchOff: 0.34,         // 复位阈值（滞回）
      pinchMinOpen: 0.34,     // 手整体张开度门槛
      pinchOtherExtend: 2,    // 中/无名/小指至少伸展根数
      pinchHoldMs: 90,        // 需持续捏住才触发生花
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

    /* ---------- 配色：深墨底 + 淡粉月光花 ---------- */
    palette: {
      bg: '#0A0B0E',
      ink: '#EDE8DE',
      sage: '#D6A9C0',     // 骨架线（玫瑰粉）
      clay: '#F2C9DC',     // 骨架点（浅粉）
      core: '#FFF2F6',     // 花心（粉白）
      spark: '#FFE9F3',    // 火花
      stem: '#B79AA8',     // 极淡粉灰茎
      glow: '#FFC9DE'      // 花心光晕
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
