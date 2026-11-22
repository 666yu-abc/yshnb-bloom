/* ============================================================
 * yshnb · 指尖生花  —  参数总表（Nocturne / 暗色精细版）
 * 所有可调数值集中在这里，一处改动、全站生效。
 * ============================================================ */
(function (global) {
  'use strict';

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
          root: '#3B5372', tip: '#D6E6F6', glow: '#EAF4FF' },
        /* 中层：淡玫瑰，错开半个瓣位 */
        { count: 8, phase: 0.50, rot: 0.36,
          lenClosed: 38, lenOpen: 178, radiusClosed: 16, radiusOpen: 48,
          widthClosed: 0.18, widthOpen: 0.33,
          curlClosed: 1.04, curlOpen: 0.14,
          tiltClosed: 1.12, tiltOpen: 0.22,
          profilePow: 0.66, lag: 0.12, twistDir: -1,
          root: '#6B4C66', tip: '#F2D6E0', glow: '#FFEAF1' },
        /* 内层：奶油金，最卷、最后开，包住花心 */
        { count: 6, phase: 0.28, rot: 0.72,
          lenClosed: 30, lenOpen: 116, radiusClosed: 12, radiusOpen: 30,
          widthClosed: 0.16, widthOpen: 0.30,
          curlClosed: 1.10, curlOpen: 0.26,
          tiltClosed: 1.18, tiltOpen: 0.14,
          profilePow: 0.72, lag: 0.24, twistDir: 1,
          root: '#8A643E', tip: '#F8E4C2', glow: '#FFF4DC' }
      ],
      rings: 11,          // 沿瓣长采样行数
      edgeBands: 2,       // 每条瓣缘的粒子束数（描边密度）
      veinCount: 3,       // 每片花瓣的侧脉数
      fillPerRow: 2,      // 每行填充散点数
      coreCount: 190,     // 花心颗粒
      stamenCount: 26,    // 雄蕊细丝
      flatten: 0.82,      // 花平面透视压缩（<1 呈椭圆，斜俯视）
      zScale: 0.92,       // 卷曲高度投影系数
      twist: 0.16,        // 开放时花瓣缓慢旋展的角度 (rad)
      faceAlpha: 0.055,   // 瓣面填充透明度
      edgeLineAlpha: 0.13,// 瓣缘高光线透明度
      ripple: 0.055,      // 瓣缘细波浪起伏
      swayAmp: 0.019,     // 整朵摇曳角度
      swaySpeed: 0.00042, // 摇曳角速度
      drawStem: true      // 极淡银线茎与叶（暗底克制装饰）
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
      burstCount: 96
    },

    /* ---------- 手势识别 ---------- */
    gesture: {
      emaAlpha: 0.24,
      opennessEma: 0.17,
      palmPairs: [[0, 9], [5, 17]],
      openMin: 1.15,
      openMax: 2.75,
      spreadWeight: 0.62,
      interWeight: 0.38,
      fistThreshold: 0.20,
      bloomThreshold: 0.64,
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
      trailFade: 0.58,     // 每帧铺底不透明度：留极短光轨，避免叠加过曝
      particleAlpha: 0.66, // 粒子总亮度系数
      coreAlpha: 0.85,
      edgeAlpha: 0.88,     // 瓣缘：亮而密，勾出轮廓
      veinAlpha: 0.55,     // 侧脉
      fillAlpha: 0.36,     // 填充：淡，像花粉
      spriteSize: 20,
      sparkMax: 260,
      sparkLifeMs: 1250,
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
      core: '#F6DCA6',     // 花心
      spark: '#F8E9CD',    // 火花
      stem: '#8FA3B2',     // 极淡银茎
      glow: '#E8C88C'      // 花心光晕
    },

    /* ---------- 识别模型 ---------- */
    vision: {
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.50,
      minTrackingConfidence: 0.50,
      delegate: 'GPU',
      bundleUrl: './vendor/vision_bundle.mjs',
      wasmPath: './vendor/wasm',
      modelPath: './vendor/hand_landmarker.task'
    }
  };

  global.YSHNB = global.YSHNB || {};
  global.YSHNB.CFG = CFG;
})(window);
