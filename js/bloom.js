/* ============================================================
 * 粒子花朵引擎 (WebGL 点精灵) · Nocturne / Rosé
 * ------------------------------------------------------------
 * 一朵花 = 三层花轮 + 花心 + 放射迸发流 + 环境浮尘 + 星芒，
 * 合计约 4.7 万个发光粒子，全部在 GPU 上以叠加混合绘制。
 *
 * 设计要点：
 *  · 位形烘焙：CPU 端用参数化花瓣几何算出每个粒子「全开」与「全闭」
 *    两个局部坐标，连同颜色 / 尺寸 / 亮度 / 相位 / 分层延迟一起塞进
 *    静态 VBO。每帧只更新 uniform，位置在顶点着色器里插值 ——
 *    4.7 万点 ≈ 一次 drawArrays，比 Canvas 2D 逐点画几千点还快。
 *  · 分层开放：每层花轮有 lag，张手时外层先舒展、内层后跟。
 *  · 重要性排序：粒子按 rank 降序烘焙，降质时直接少画尾部，
 *    先丢浮尘、再丢瓣面填充，花心与瓣缘永远保留。
 *  · 叠加混合 (SRC_ALPHA, ONE)：花心层层累积自然过曝成亮核，
 *    这就是参考图那种「中心爆亮、四周星云」的成因。
 *  · 安全网：WebGL 不可用或着色器编译失败时，自动回退 Canvas 2D
 *    精致版 (bloom2d.js)，绝不黑屏。
 * ============================================================ */
(function (global) {
  'use strict';

  var Y = global.YSHNB;
  var CFG = Y.CFG;
  var F = CFG.flower;
  var P = CFG.physics;
  var R = CFG.render;
  var C = CFG.palette;
  var PC = CFG.particles;
  var WH = F.whorls;
  var TAU = Math.PI * 2;

  /* ---------- 小工具 ---------- */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / Math.max(b - a, 0.0001), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function hexRgb(hex) {
    var h = hex.replace('#', '');
    return { r: parseInt(h.substring(0, 2), 16),
             g: parseInt(h.substring(2, 4), 16),
             b: parseInt(h.substring(4, 6), 16) };
  }
  function hex01(hex) {
    var c = hexRgb(hex);
    return [c.r / 255, c.g / 255, c.b / 255];
  }
  function mixRgb(a, b, t) {
    t = clamp(t, 0, 1);
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }
  function rgba(hex, a) {
    var c = hexRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- 花瓣参数化位形（含伪 3D 高度 z） ----------
   * 与 2D 回退层完全同一套几何：纺锤轮廓 + 主浪/细浪 + 斜立→摊平。
   * o=1 得「全开」位形，o=0 得「花苞」位形，烘焙时各取一次。 */
  function petalPoint(wh, count, p, u, v, o, out) {
    var lag = wh.lag || 0;
    var oe = clamp((o - lag) / (1 - lag), 0, 1);

    var len = lerp(wh.lenClosed, wh.lenOpen, oe);
    var rad = lerp(wh.radiusClosed, wh.radiusOpen, oe);
    var wid = lerp(wh.widthClosed, wh.widthOpen, oe);
    var curl = lerp(wh.curlClosed, wh.curlOpen, oe);
    var tilt = lerp(wh.tiltClosed, wh.tiltOpen, oe);

    var prof = Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), wh.profilePow);
    var wave = F.ripple * Math.sin(u * Math.PI * 3 + p * 1.7)
             + (F.ripple2 || 0) * Math.sin(u * Math.PI * 9 + p * 2.9 + (wh.rot || 0) * 11);
    var halfW = wid * len * prof * (1 + wave);
    var tang = v * halfW;

    var ang = ((p + (wh.phase || 0)) / count) * TAU + (wh.rot || 0)
              + (wh.twistDir || 1) * F.twist * o;
    var ux = Math.sin(ang), uy = -Math.cos(ang);
    var tx = Math.cos(ang), ty = Math.sin(ang);

    var proj = len * Math.cos(tilt);
    var rise = len * Math.sin(tilt);
    var u2 = u * u;
    var radial = rad + u * proj - curl * u2 * len * 0.18;
    var z = u * rise + curl * u2 * len * 0.55;

    out.x = radial * ux + tang * tx;
    out.y = (radial * uy + tang * ty) * F.flatten - z * F.zScale;
    out.z = z;
    return out;
  }

  /* ---------- 单层花瓣边界：给定「某一层 + 参数角 a」，返回该方向丝长 ----------
   * 轮廓用 |cos(N·Δ/2)| 的幂函数拟合：瓣中为 1、瓣间为 0。
   * 指数取 2.2：指数小的话瓣间只塌一半，瓣与瓣之间糊成一片；放大后
   * 瓣间塌得彻底，9 片瓣才有清晰的缝。
   *
   * 注意这是【单层】——早先按三层取 max 是错的：三层 rot 互相错开
   * （0 / 0.36 / 0.72），一层的瓣间正好被另一层的瓣中填满，轮廓被抹成
   * 圆形，花瓣感全丢。放射丝必须按层各自生成，长度只用本层轮廓。
   * 注：a 是「参数空间」角，屏幕上是椭圆（乘了 flatten），与花瓣一致。 */
  function layerEdge(wh, a) {
    var rel = a - (wh.rot || 0);
    var lobe = Math.pow(Math.abs(Math.cos(rel * wh.count * 0.5)), 2.2);
    return wh.radiusOpen * (0.26 + 0.74 * lobe) + wh.lenOpen * lobe;
  }

  /* ============================================================
   * 位形烘焙：生成全部粒子的静态属性
   * 数据布局（每粒子 13 个 float）：
   *   0,1  open  xy      2,3  close xy
   *   4,5,6 color rgb    7    size
   *   8    bright        9    phase
   *   10   lag           11   kind
   *   12   shade     花苞态专用明暗（着色器按 oe 混回 1）
   * ============================================================ */
  var STRIDE_F = 13;

  function bake() {
    var rnd = mulberry(20261122);
    var tmp = { x: 0, y: 0, z: 0 };
    var pts = [];
    var R0 = WH[0].radiusOpen + WH[0].lenOpen;    // 外轮最远半径（局部单位）

    var CORE_HOT = hex01(PC.coreHot), CORE_WARM = hex01(PC.coreWarm),
        CORE_ROSE = hex01(PC.coreRose);
    var P_ROOT = hex01(PC.petalRoot), P_MID = hex01(PC.petalMid),
        P_TIP = hex01(PC.petalTip), P_GLOW = hex01(PC.petalGlow);
    var R_NEAR = hex01(PC.radialNear), R_MID = hex01(PC.radialMid),
        R_FAR = hex01(PC.radialFar);
    var D_PINK = hex01(PC.dustPink), D_ICE = hex01(PC.dustIce);
    var GLINT = hex01(PC.glint);

    var i, w, p, wh, u, v;

    /* ---------- 1) 花瓣本体：径向「光瓣」 ----------
     * 参考图不是靠描边勾瓣形，而是从中心向外喷的光流：中间最密、
     * 向两侧与瓣尖自然消隐。所以不再用「贴边点列」勾轮廓 ——
     * 那正是锯齿硬边的来源 —— 改为横向高斯分布 + 沿瓣长衰减，
     * 没有硬边、天然没有台阶，近看也只是一层层渐变的光。 */
    var totalLen = 0;
    for (w = 0; w < WH.length; w++) {
      totalLen += WH[w].lenOpen * WH[w].count;
    }

    for (w = 0; w < WH.length; w++) {
      wh = WH[w];
      var tag = wh.lag || 0;
      /* 按「瓣长 × 瓣数」加权分配预算：外层瓣更长更大，分到更多点。
       * 注意这里是「每片花瓣」的点数，总预算 = petalFill。 */
      var nPer = Math.max(300, Math.round(PC.petalFill * wh.lenOpen / totalLen));
      for (p = 0; p < wh.count; p++) {
        for (i = 0; i < nPer; i++) {
          /* u 偏根密：光流近花心处最密，越往外越稀 */
          u = Math.pow(rnd(), 0.68);
          /* 横向高斯（4 个均匀分布之和 ≈ 正态）：瓣中密、边缘稀到消失 */
          v = clamp((rnd() + rnd() + rnd() + rnd() - 2.0) * 0.62, -0.98, 0.98);

          petalPoint(wh, wh.count, p, u, v, 1, tmp);
          var pox = tmp.x, poy = tmp.y, poz = tmp.z;
          petalPoint(wh, wh.count, p, u, v, 0, tmp);

          /* 瓣根玫红 → 瓣中亮粉 → 瓣尖暖粉白；靠内叠一点暖金，
           * 与过曝的花心自然衔接，避免"白核 / 粉瓣"的断层。 */
          var pc2 = mixRgb(P_ROOT, P_MID, Math.min(1, u * 1.6));
          pc2 = mixRgb(pc2, P_TIP, Math.max(0, (u - 0.45) / 0.55));
          if (u < 0.24) pc2 = mixRgb(pc2, CORE_WARM, (0.24 - u) / 0.24 * 0.50);

          /* 这一层只做「薄纱」：花瓣的体积感靠它，形完全交给放射丝。
           * 所以亮度压低、沿瓣长更快渐隐，避免糊成一团雾。 */
          var fade = 1.0 - 0.34 * u;
          var pt2 = 0.92 + rnd() * 0.20;
          pts.push({
            ox: pox, oy: poy,
            cx: tmp.x, cy: tmp.y,
            col: [pc2[0] * pt2, pc2[1] * pt2, pc2[2] * pt2],
            size: lerp(PC.sizePetal[1], PC.sizePetal[0], Math.pow(u, 0.70)) * (0.82 + rnd() * 0.50),
            bright: PC.brightPetal * fade * (0.78 + rnd() * 0.44),
            phase: rnd() * TAU,
            lag: tag,
            kind: 0,
            rank: 0.86 + rnd() * 0.06 - 0.10 * u,
            z: poz
          });
        }
      }
    }

    /* ---------- 2) 花心：过曝的暖白亮核 ---------- */
    for (i = 0; i < PC.coreCount; i++) {
      var t = (i + 0.5) / PC.coreCount;
      var rr = Math.sqrt(t);
      /* 黄金角 + 较强抖动：纯黄金角螺旋在密集小点上会显出规则的「网格/
       * 编织纹」，加抖动把点阵打散，中心才是一团连续的白热光而不是点阵。 */
      var a = i * 2.399963229728653 + rr * 1.6 + (rnd() - 0.5) * 0.85;
      var cr = 17 * rr + (rnd() - 0.5) * 4.0;
      var orr = 28 * rr + (rnd() - 0.5) * 4.6;
      if (cr < 0) cr = 0;
      if (orr < 0) orr = 0;
      var ccx = Math.cos(a) * cr, ccy = Math.sin(a) * cr * F.flatten;
      var cox = Math.cos(a) * orr, coy = Math.sin(a) * orr * F.flatten;
      var ccol = rr < 0.55
        ? mixRgb(CORE_HOT, CORE_WARM, rr / 0.55)
        : mixRgb(CORE_WARM, CORE_ROSE, (rr - 0.55) / 0.45);
      pts.push({
        ox: cox, oy: coy, cx: ccx, cy: ccy,
        col: ccol,
        size: lerp(PC.sizeCore[1], PC.sizeCore[0], rr) * (0.70 + rnd() * 0.70),
        bright: PC.brightCore * (1.15 - 0.50 * rr) * (0.80 + rnd() * 0.45),
        phase: rnd() * TAU,
        lag: 0,
        kind: 1,
        rank: 1.0,
        z: (rnd() - 0.5) * 36
      });
    }

    /* ---------- 2.5) 近核暖金光环 ----------
     * 纯白核直接接粉瓣会有一道断层，参考图里白心外面是一圈明显的
     * 橙金热区。单独铺一圈稀疏的暖金点：密度不高，不会被白核的叠加
     * 吃掉，颜色才留得住。 */
    for (i = 0; i < PC.goldRingCount; i++) {
      var ga2 = rnd() * TAU;
      var rr2 = PC.goldRingIn + Math.pow(rnd(), 0.72) * (PC.goldRingOut - PC.goldRingIn);
      var gx2 = Math.cos(ga2) * rr2;
      var gy2 = Math.sin(ga2) * rr2 * F.flatten;
      var gc = mixRgb(R_NEAR, R_MID, Math.min(1, (rr2 - PC.goldRingIn) / (PC.goldRingOut - PC.goldRingIn)));
      pts.push({
        ox: gx2, oy: gy2, cx: gx2 * 0.22, cy: gy2 * 0.22,
        col: gc,
        size: 3.2 + rnd() * 4.6,
        bright: PC.brightRadial * (0.52 + rnd() * 0.38),
        phase: rnd() * TAU,
        lag: rnd() * 0.08,
        kind: 2,
        rank: 0.84 + rnd() * 0.05,
        z: (rnd() - 0.5) * 40
      });
    }

    /* ---------- 3) 放射细丝：花的主体 ----------
     * 参考图的「爆炸感」= 数百条极细的放射丝从花心笔直喷出，每条丝
     * 长度不同（由所属花瓣层的轮廓决定），越长越稀越暗，丝间留黑。
     *
     * 三个关键：
     *  · 外层循环 = 一条丝，丝内沿半径【等距分层】放点。纯随机会形成
     *    泊松式的「斑块 + 空隙」，看起来是断续碎点；分层才连成光流。
     *  · 丝按三层分配，每条丝只用【本层】轮廓算长度 —— 三层 rot 错开，
     *    合起来才是「9 大瓣 + 8 中瓣 + 6 内瓣」的层次，不会互相填平。
     *  · 长度各带溢出系数，参差的丝尖就是毛边，不需要任何描边。 */
    var beamCount = Math.max(24, Math.round(PC.radialBeams || 620));
    var perBeam = Math.max(2, Math.round(PC.radialCount / beamCount));

    /* 丝数按 lenOpen^1.6 加权分配（而不是线性）：外层瓣最长，单位角度
     * 覆盖的弧长最大，必须分到远多于线性的丝数，否则瓣尖处丝间距能到
     * 7px（点径才 4.8px），一眼就是点阵。指数 1.6 之后外层约拿 51%，
     * 瓣尖的丝间距压到 3px 以内，才连成光带。 */
    var sumLenW = 0;
    for (w = 0; w < WH.length; w++) sumLenW += Math.pow(WH[w].lenOpen, 1.6);
    var beamBudget = [];
    var remainBeams = beamCount;
    for (w = 0; w < WH.length; w++) {
      var nb = (w === WH.length - 1) ? remainBeams
             : Math.max(6, Math.round(beamCount * Math.pow(WH[w].lenOpen, 1.6) / sumLenW));
      beamBudget.push(nb);
      remainBeams -= nb;
    }

    /* 层缩比：外层全伸展，中/内层大幅收进来。
     * 否则中层丝（226）会伸到外层瓣间（17）的区域，把 9 片瓣的缝填平，
     * 三层的长度差被压到只剩 25%，视觉上就还是一团圆形星云。
     * 收短之后：中心 0~55 被内层填实，55~130 是中层，130~302 只剩外层
     * 9 片长瓣 —— 瓣形立刻出来，也正是真实花里「内瓣被外瓣遮住」的样子。 */
    var layerShort = [1.0, 0.58, 0.38];
    for (w = 0; w < WH.length; w++) {
      var whS = WH[w];
      var nbS = beamBudget[w];
      if (nbS <= 0) continue;
      var layerLag = whS.lag || 0;
      var shorten = layerShort[w] || 1.0;
      var halfW = Math.PI / whS.count;   // 单瓣的半角宽
      for (var bi = 0; bi < nbS; bi++) {
        /* 丝的角度：按瓣轮转分配，再在瓣内【等分铺开】。
         *  · 均匀铺满 360° 是错的：瓣间也有丝，9 片瓣的缝被磨平，只剩
         *    一圈放射星云。
         *  · 纯随机（三角分布）也不行：每瓣分到的丝数不定，瓣形不对称，
         *    有的瓣爆长有的瓣空缺，看着像朵畸形的花。
         * 等分之后每瓣形状一致，长度仍由 lobe 决定（瓣中长、瓣缘短），
         * 瓣尖自然收窄 —— 规整的花形不需要任何描边。 */
        var pIdx = bi % whS.count;
        var jIdx = Math.floor(bi / whS.count);
        var nPerPetal = Math.max(1, Math.round(nbS / whS.count));
        var pAxis = (pIdx + (whS.phase || 0)) / whS.count * TAU + (whS.rot || 0);
        var frac = (jIdx + 0.5) / nPerPetal - 0.5;
        var a0 = pAxis + frac * 2 * halfW * 0.94 + (rnd() - 0.5) * 0.018;
        var maxR = layerEdge(whS, a0) * shorten;
        /* 飞散只发生在瓣缘【外侧】：从 0.66 倍瓣长处起，向外喷到 1.0~1.9 倍。
         * 早先让丝从圆心一路喷到瓣尖是错的 —— 那会把「瓣面」画成骨架，
         * 花瓣中间全是黑缝。现在瓣面由真实花瓣几何高密度填充（实心光瓣），
         * 丝只负责瓣缘爆散出的毛边与火星，两层叠加才是参考图的样子。 */
        var over = 1.04 + rnd() * 0.34;
        if (rnd() < 0.22) over = 1.34 + rnd() * 0.55;   // 少量长丝，炸得更远
        var reachR = maxR * over;
        var startR = maxR * 0.62;
        var lagB = layerLag + rnd() * 0.12;
        for (var k = 0; k < perBeam; k++) {
          var rn = (k + rnd()) / perBeam;
          var ru = rn;
          var rad = startR + ru * (reachR - startR);
          /* 丝自身极细；抖动随半径加速增长，远端自然散成絮状 */
          var a2 = a0 + (rnd() - 0.5) * (0.0030 + 0.013 * ru * ru);
          var sw = PC.radialSwirl * (rad / R0) * 0.045;
          var ang = a2 + sw;
          var rox = Math.cos(ang) * rad, roy = Math.sin(ang) * rad * F.flatten;
          /* 闭合位形：收成有层次的光蕾，不挤成一坨白点 */
          var cr2 = 0.05 + 0.10 * ru;
          var rcx = Math.cos(ang) * rad * cr2, rcy = Math.sin(ang) * rad * cr2 * F.flatten;
          /* 飞散丝：起点接瓣缘（粉白）→ 中段玫红 → 远端暗红渐隐，
           * 这样瓣缘是一圈亮边，往外像被吹散的余烬。 */
          var rc = mixRgb(P_MID, R_MID, Math.min(1, ru * 1.5));
          rc = mixRgb(rc, R_FAR, Math.max(0, (ru - 0.45) / 0.55));
          /* 起点略提亮，瓣缘才有「亮起来」的收尾 */
          var tipBoost = ru < 0.18 ? 1.0 + (0.18 - ru) * 2.2 : 1.0;
          pts.push({
            ox: rox, oy: roy, cx: rcx, cy: rcy,
            col: rc,
            size: lerp(PC.sizeRadial[1], PC.sizeRadial[0], Math.pow(ru, 0.34)) * (0.72 + rnd() * 0.62),
            bright: PC.brightRadial * (1.0 - 0.44 * ru) * (0.72 + rnd() * 0.62) * tipBoost,
            phase: rnd() * TAU,
            lag: lagB,
            kind: 2,
            rank: 0.72 - 0.36 * ru,
            z: (rnd() - 0.5) * 78
          });
        }
      }
    }

    /* ---------- 4) 环境浮尘：大范围缓慢浮游，制造空间深度 ---------- */
    for (i = 0; i < PC.dustCount; i++) {
      var da = rnd() * TAU;
      /* 从中心附近一直铺到画面边缘：参考图不只是「环状尘埃」，
       * 整个放射区都散落着细碎光点，这才是星云感。 */
      var dr = R0 * (0.10 + Math.sqrt(rnd()) * 3.1);
      var dx = Math.cos(da) * dr;
      var dy = Math.sin(da) * dr * (0.86 + rnd() * 0.20);
      var dcol = rnd() < 0.82 ? D_PINK : D_ICE;
      var dt2 = 0.80 + rnd() * 0.30;
      pts.push({
        ox: dx, oy: dy, cx: dx, cy: dy,
        col: [dcol[0] * dt2, dcol[1] * dt2, dcol[2] * dt2],
        size: lerp(PC.sizeDust[0], PC.sizeDust[1], rnd()),
        bright: PC.brightDust * (0.50 + rnd() * 0.80),
        phase: rnd() * TAU,
        lag: 0,
        kind: 3,
        rank: 0.10 + rnd() * 0.10,
        z: (rnd() - 0.5) * 40
      });
    }

    /* ---------- 5) 十字星芒：稀疏闪现的高光 ---------- */
    for (i = 0; i < PC.glintCount; i++) {
      var ga = rnd() * TAU;
      var gr = R0 * (0.18 + rnd() * 1.50);
      var gx = Math.cos(ga) * gr, gy = Math.sin(ga) * gr * F.flatten;
      pts.push({
        ox: gx, oy: gy, cx: gx * 0.18, cy: gy * 0.18,
        col: GLINT,
        size: lerp(PC.sizeGlint[0], PC.sizeGlint[1], rnd()),
        bright: PC.brightGlint * (0.60 + rnd() * 0.60),
        phase: rnd() * TAU,
        lag: rnd() * 0.20,
        kind: 4,
        rank: 0.40 + rnd() * 0.06,
        z: 0
      });
    }

    /* ---------- 6) 花苞位形：九片花瓣合拢成的光蕾 ----------
     * 旧版把所有粒子按全开极角摊到一个椭圆盘上，结果就是「一堆粒子」：
     * 没有瓣的边界、没有瓣缝、没有前后层次。
     *
     * 现在把每个粒子重新组织进「9 片竖直包拢的花瓣」：
     *   · 瓣归属 k 由全开极角 a 决定（9 等分），瓣内相位 p ∈ [-1, 1]
     *   · 沿瓣高度 t 由全开半径 r 决定 → 同一根放射丝变成一片花瓣里
     *     从根到尖的一条纵向脉络，蕾身才有丝绒般的方向感，而不是噪点
     *   · 每片花瓣是一条竖直纺锤叶：中段宽、两端收
     *   · 9 瓣贴在一个立着的「蕾体」圆周上：正对镜头的瓣宽而亮，
     *     侧过去的瓣窄而暗，正后方的被前面遮住 —— 体积感就来自这里
     *   · 顶部横向收拢（pinch），瓣尖聚成一个收口；瓣尖再微微外翻
     *   · 瓣内横向压暗成「瓣缝」，9 片花瓣才分得开（不做描边）
     */
    var SP = TAU / 9;
    var BUD_Y_BASE = 80, BUD_Y_TIP = -150;
    var BUD_H = BUD_Y_BASE - BUD_Y_TIP;
    var RING_MAX = 57, PETAL_HALF = 24;
    for (i = 0; i < pts.length; i++) {
      var bp = pts[i];
      var kk = bp.kind;
      bp.shade = 1;                              // 浮尘等环境层：花苞态不压暗
      if (kk === 3) continue;                    // 浮尘铺满全屏，不参与收拢
      var oa = Math.atan2(bp.oy / F.flatten, bp.ox);
      var orr0 = Math.sqrt(bp.ox * bp.ox + bp.oy * bp.oy);

      if (kk === 1) {
        /* 花心：藏在蕾里的一团暖光。叠加混合下它太亮会把蕾心烧成一个洞，
         * 只留一点从瓣缝里透出来的暖调。 */
        var crad = Math.sqrt(rnd());
        bp.cx = Math.cos(oa) * 13 * crad;
        bp.cy = 12 + Math.sin(oa) * 19 * crad;
        bp.shade = 0.14;
        continue;
      }
      if (kk === 4) {
        /* 星芒：轻度收拢，仍在花蕾外围闪，保留空间感 */
        bp.cx *= 0.44; bp.cy = bp.cy * 0.44 - 20;
        bp.shade = 0.60;
        continue;
      }

      /* 瓣归属 + 瓣内相位 */
      var k9 = Math.round(oa / SP);
      var p9 = clamp((oa - k9 * SP) / (SP * 0.5), -1, 1);
      /* 原分布是「瓣中密、瓣缘稀」的高斯，照搬会让瓣缘糊成雾、看不出
       * 是一片花瓣。开 0.56 次方把粒子摊向两侧，瓣面才有宽度。 */
      p9 = (p9 < 0 ? -1 : 1) * Math.pow(Math.abs(p9), 0.18);

      /* 沿瓣长：外轮从蕾底铺到蕾尖，内层只到下段 —— 真实的「外瓣包内瓣」 */
      /* 分层上限：外轮铺到蕾尖，中轮 0.80、内轮 0.60 —— 外层包住内层 */
      var layerT = bp.lag < 0.06 ? 1.0 : (bp.lag < 0.18 ? 0.80 : 0.60);
      var rawT = clamp((orr0 - 0.16 * R0) / (R0 - 0.16 * R0), 0, 1);
      var t9 = Math.pow(rawT, 0.80) * layerT;
      /* 底部抖动：瓣根 / 金环 / 内轮的 r 都很小，全挤在 t≈0，会在蕾底
       * 叠出一圈死白的横环。把低 t 的粒子抖散到 0~0.22 的高度上。 */
      t9 = Math.min(layerT, t9 + rnd() * 0.22 * (1 - Math.min(1, rawT * 2)));
      /* 横向位置改为均匀重排：原来的 p 来自全开极角，而极角在瓣内是
       * 「中间密、两边稀」的高斯 —— 照搬过来，每片瓣的中线就会叠成一条
       * 死白的竖线，整朵蕾看着像几根发光条纹。均匀铺开才是「一片瓣」。 */
      p9 = rnd() * 2 - 1;
      /* 放射丝在花苞里若还沿纵向排，会把蕾画成一根根竖条。整片打散成云，
       * 只负责填满瓣面；纵向的丝绒纹理交给 t 的明暗渐变。 */
      if (kk === 2) { t9 = rnd() * layerT; }

      /* 螺旋包卷：瓣中线随高度旋转，瓣缘在屏幕上变成斜弧线，
       * 一片压住另一片的一角 —— 这才是「合拢的花」而不是「竖条列」。 */
      var phi = k9 * SP + SP * 0.85 * t9;
      var s9 = Math.sin(phi), c9 = Math.cos(phi);
      /* 蕾体轮廓：下圆、中饱、上收 —— 一枚竖直的水滴形光蕾 */
      var prof = Math.pow(Math.sin(Math.PI * (0.15 + 0.76 * t9)), 0.46);
      /* 顶部收口：t→1 时横向急剧收拢，9 片瓣尖聚成一点 */
      var pinch = 1 - 0.30 * t9 * t9 * t9;
      /* 1 = 正对镜头，0 = 正后方 */
      var face = 0.5 + 0.5 * c9;

      var ringR = RING_MAX * prof * pinch;
      /* 侧面的瓣被透视压窄，背面的最窄（本来也被前面遮住） */
      var tipSharp = 1 - 0.22 * Math.pow(Math.max(0, (t9 - 0.70) / 0.30), 1.3);
      var halfW = PETAL_HALF * prof * (0.42 + 0.58 * face) * tipSharp;
      /* 瓣中亮、瓣缝暗（不描边，靠暗谷把 9 片瓣分开） */
      var fold = Math.pow(Math.cos(Math.min(1, Math.abs(p9)) * 1.414), 1.1)
                 * (1 + 0.60 * Math.pow(Math.abs(p9), 10));

      bp.cx = ringR * s9 + p9 * halfW;
      /* 背面瓣稍高、正面瓣稍低：从正面看有前后错落，不是一张平面 */
      var tipJit = (((k9 * 7) % 5) - 2) * 5.0;
      bp.cy = BUD_Y_BASE - BUD_H * t9 + c9 * 10 * prof + tipJit * t9 * prof;
      /* 瓣尖拱起：瓣中最高、瓣缘低，每片瓣的顶缘才是一条弧 ——
       * 有了这条弧，看到的才是「一片花瓣」，而不是一根竖条。 */
      bp.cy -= 14.0 * (1 - p9 * p9) * t9 * t9 * t9;
      /* 瓣尖外翻一点点，含苞待放的味道 */
      bp.cx += (p9 < 0 ? -1 : 1) * 4.0 * t9 * t9 * t9 * t9;

      /* 花苞态亮度层次：正面亮 / 侧面暗、瓣中亮 / 瓣缝暗、内层被包裹更暗。
       * 编码进 a_shade，着色器按 oe 混回 1，绝不污染全开态。 */
      bp.shade = (0.06 + 0.80 * Math.pow(face, 2.2)) * (0.40 + 0.60 * fold)
               * (1 - 0.60 * clamp(bp.lag, 0, 1));
      /* 瓣缘「受光的一道亮线 + 外侧迅速收黑」：加法混合没有遮挡，
       * 相邻瓣重叠时只会叠亮、糊成一片。压黑瓣缘，重叠区就只剩上层，
       * 视觉上才是「一片压住另一片」。 */
      var ap = Math.abs(p9);
      var edgeGlow = 1 + 0.85 * Math.exp(-Math.pow((ap - 0.82) / 0.09, 2));
      var edgeCut = 1 - smoothstep(0.88, 1.0, ap);
      bp.shade *= edgeGlow * edgeCut;
      /* 正中一条纵缝：真实合拢的花苞正面是两片最外层花瓣的交界线，
       * 是暗的。没有这条缝，正中间会叠成一条死白的亮线。 */
      bp.shade *= 1 - 0.38 * Math.exp(-(bp.cx * bp.cx) / (20 * 20));
      /* 上亮下暗：光从上方来，蕾底沉在影里，才有立着的体积感 */
      bp.shade *= 0.62 + 0.38 * (1 - t9);
    }

    /* ---------- 排序：rank 降序，降质时少画尾部即可 ---------- */
    pts.sort(function (a, b) { return b.rank - a.rank; });

    var n = pts.length;
    var data = new Float32Array(n * STRIDE_F);
    for (i = 0; i < n; i++) {
      var q = pts[i], o = i * STRIDE_F;
      data[o] = q.ox; data[o + 1] = q.oy;
      data[o + 2] = q.cx; data[o + 3] = q.cy;
      data[o + 4] = q.col[0]; data[o + 5] = q.col[1]; data[o + 6] = q.col[2];
      data[o + 7] = q.size;
      data[o + 8] = q.bright;
      data[o + 9] = q.phase;
      data[o + 10] = q.lag;
      data[o + 11] = q.kind;
      data[o + 12] = q.shade === undefined ? 1 : q.shade;
    }
    return { data: data, total: n };
  }

  /* ============================================================
   * 着色器（WebGL1 / GLSL ES 1.00，写法刻意保守以兼容老驱动）
   * ============================================================ */

  var VS_BG = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = a_pos * 0.5 + 0.5;',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_BG = [
    'precision mediump float;',
    'varying vec2 v_uv;',
    'uniform vec2 u_res;',
    'uniform vec2 u_center;',
    'uniform float u_glow;',
    'uniform vec3 u_deep;',
    'uniform vec3 u_glowCol;',
    'uniform float u_vig;',
    'void main() {',
    '  vec2 d = (v_uv * u_res - u_center) / max(u_res.y, 1.0);',
    '  float r = length(d);',
    '  float halo = exp(-r * r * 2.4) * (0.30 + 0.70 * u_glow);',
    '  vec3 col = u_deep + u_glowCol * halo;',
    /* 中心八向星芒：参考图的白核外面有清晰的镜头光芒，纯靠粒子堆不出来。
     * cos(4θ) 在 2π 内有 8 个峰，pow 收紧成尖细的光条，再按半径快速衰减。
     * 画在背景层 → 中心的实心白核会盖住它，只有伸出去的部分留在花外。 */
    '  float ang = atan(d.y, d.x + 0.00001);',
    '  float rays = pow(abs(cos(ang * 4.0)), 42.0);',
    '  float rayLen = exp(-r * 3.6);',
    '  col += vec3(0.98, 0.62, 0.78) * rays * rayLen * (0.03 + 0.09 * u_glow);',
    '  vec2 c = v_uv - vec2(0.5);',
    '  float vig = 1.0 - u_vig * smoothstep(0.34, 0.96, length(c));',
    '  col *= vig;',
    '  float n = fract(sin(dot(v_uv * u_res, vec2(12.9898, 78.233))) * 43758.5453);',
    '  col += vec3((n - 0.5) * 0.008);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var VS_PT = [
    'precision highp float;',
    'attribute vec2 a_open;',
    'attribute vec2 a_close;',
    'attribute vec3 a_color;',
    'attribute float a_size;',
    'attribute float a_bright;',
    'attribute float a_phase;',
    'attribute float a_lag;',
    'attribute float a_kind;',
    'attribute float a_shade;',
    'uniform float u_time;',
    'uniform float u_open;',
    'uniform vec2 u_center;',
    'uniform float u_scale;',
    'uniform vec2 u_res;',
    'uniform float u_dpr;',
    'uniform vec2 u_pointer;',
    'uniform float u_pointerOn;',
    'uniform vec2 u_wind;',
    'uniform float u_pulse;',
    'uniform float u_seed;',
    'uniform float u_bright;',
    'uniform float u_alpha;',
    'uniform float u_maxSize;',
    'uniform float u_twinkle;',
    'varying vec3 v_color;',
    'varying float v_alpha;',
    'varying float v_kind;',
    'void main() {',
    '  float lag = clamp(a_lag, 0.0, 0.92);',
    '  float oe = clamp((u_open - lag) / max(1.0 - lag, 0.001), 0.0, 1.0);',
    '  oe = oe * oe * (3.0 - 2.0 * oe);',
    '  float kind = a_kind;',
    /* 位形插值分两段。
     * 花苞是「竖直圆柱上的 9 片瓣」，全开是「摊平的辐射盘」，两者尺寸也差
     * 三倍 —— 一路直线 mix 到全开，中间态会散成一朵「烟花」：一边摊平、
     * 一边半径暴涨。所以先在 0→0.42 把花苞展开成一朵缩小版的全开花
     * （半径 0.4），再 0.42→1 纯缩放长大。后半段是等比缩放，绝对平滑。 */
    '  vec2 local;',
    '  if (kind > 2.5) {',
    '    local = mix(a_close, a_open, oe);',        // 浮尘 / 星芒：环境层
    '  } else if (kind > 0.5 && kind < 1.5) {',
    /* 花心提前归位：它本来就一直在中心，同步插值会中途被摊成一圈环 */
    '    local = mix(a_close, a_open, min(1.0, oe * 1.5));',
    '  } else {',
    '    vec2 mid = a_open * 0.78;',
    '    float k1 = 0.32;',
    '    if (oe < k1) { local = mix(a_close, mid, pow(oe / k1, 1.45)); }',
    '    else { local = mix(mid, a_open, (oe - k1) / (1.0 - k1)); }',
    '  }',
    '  float ph = a_phase + u_seed;',
    '  float t = u_time;',
    '  local += vec2(sin(t * 0.85 + ph), cos(t * 0.66 + ph * 1.3)) * 1.6 * (1.0 + 1.4 * oe);',
    '  if (kind > 1.5 && kind < 2.5) {',
    '    float flow = 0.5 + 0.5 * sin(t * 1.5 + ph);',
    '    local *= 1.0 + 0.05 * flow;',
    '  }',
    '  if (kind > 2.5 && kind < 3.5) {',
    '    local += vec2(sin(t * 0.17 + ph), cos(t * 0.13 + ph * 1.7)) * 16.0;',
    '  }',
    '  local *= 1.0 + u_pulse * 0.16;',
    '  local += u_wind;',
    '  vec2 pointerLocal = (u_pointer - u_center) / max(u_scale, 0.0001);',
    '  vec2 dp = local - pointerLocal;',
    '  float dpLen = length(dp) + 0.0001;',
    '  float infl = u_pointerOn * max(0.0, 1.0 - dpLen / 150.0);',
    '  local += (dp / dpLen) * infl * infl * 34.0;',
    '  vec2 screen = u_center + local * u_scale;',
    '  vec2 clip = (screen / u_res) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  float tw = 0.70 + 0.30 * sin(t * u_twinkle + ph * 6.2831);',
    '  float depth = 1.0 + 0.42 * (1.0 - clamp(length(a_open) / 420.0, 0.0, 1.0));',
    '  float ps = a_size * u_scale * u_dpr * depth * tw * (1.0 + u_pulse * 0.55) * (1.06 - 0.06 * oe);',
    '  gl_PointSize = clamp(ps, 1.0, u_maxSize);',
    '  float kindA = 1.0;',
    '  if (kind > 0.5 && kind < 1.5) { kindA = 1.35; }',
    '  else if (kind > 1.5 && kind < 2.5) { kindA = 1.05; }',
    '  else if (kind > 2.5 && kind < 3.5) { kindA = 0.55; }',
    '  else if (kind > 3.5) { kindA = 0.90; }',
    '  float a = a_bright * kindA * u_bright * u_alpha * (0.55 + 0.45 * tw);',
    '  if (kind > 3.5) { a *= tw * tw * tw; }',
    /* 放射丝在花苞态是「针」：压暗到幕后，蕾身交回花瓣本体，
     * 丝只留一点丝绒纹理；绽放后再恢复成主角。 */
    '  if (kind > 1.5 && kind < 2.5) {',
    '    a *= 0.20 + 0.80 * min(1.0, oe / 0.5);',
    '  }',
    /* 花苞的明暗层次全在烘焙里算好了（a_shade：正面亮 / 侧面暗、
     * 瓣中亮 / 瓣缝暗、内层被包裹更暗）。这里按 oe 混回 1，绝不污染全开态。
     * 兜底：万一属性没绑定上（默认 0），退回 1，避免整朵蕾黑掉。 */
    '  float shadeV = a_shade;',
    '  if (shadeV < 0.001) { shadeV = 1.0; }',
    '  a *= mix(shadeV, 1.0, min(1.0, oe / 0.45));',
    /* 花苞是安静待放的，不该和全开一样白热 */
    '  a *= 0.50 + 0.50 * min(1.0, oe / 0.5);',
    /* 展开途中花是「缩小的」，中心密度是满开的三倍，会叠成一块死白。
     * 只在中间段把核心压一点，两端（花苞 / 全开）都不动。 */
    '  float midM = smoothstep(0.02, 0.30, oe) * (1.0 - smoothstep(0.62, 0.92, oe));',
    '  float coreM = 1.0 - smoothstep(0.04, 0.40, length(local) / 220.0);',
    '  a *= (1.0 - 0.28 * midM) * (1.0 - 0.46 * midM * coreM);',
    '  if (kind > 0.5 && kind < 1.5) { a *= 0.12 + 0.88 * smoothstep(0.50, 0.95, oe); }',
    /* 收拢时向白色提亮一点点：花瓣在蕾里是「背光透光」的，深玫红会发黑。
     * 新几何已有清晰结构，混多了会发白，只留 8%。 */
    '  v_color = mix(a_color, vec3(1.0), 0.08 * (1.0 - oe));',
    '  v_alpha = a;',
    '  v_kind = kind;',
    '}'
  ].join('\n');

  var FS_PT = [
    'precision mediump float;',
    'varying vec3 v_color;',
    'varying float v_alpha;',
    'varying float v_kind;',
    'void main() {',
    '  vec2 pc = gl_PointCoord - vec2(0.5);',
    '  float d2 = dot(pc, pc) * 4.0;',
    '  if (d2 > 1.0) { discard; }',
    /* 点的衰减更柔：核心别太尖、光晕给足，几万个点才会融成一片光雾，
     * 而不是一粒粒能数出来的沙子。 */
    '  float core = exp(-d2 * 1.75);',
    '  float halo = exp(-d2 * 1.05) * 0.62;',
    '  float a = core + halo;',
    '  if (v_kind > 3.5) {',
    '    float cx = 1.0 / (1.0 + 120.0 * abs(pc.x)) * exp(-abs(pc.y) * 11.0);',
    '    float cy = 1.0 / (1.0 + 120.0 * abs(pc.y)) * exp(-abs(pc.x) * 11.0);',
    '    a = core * 0.8 + halo * 0.5 + (cx + cy) * 0.34;',
    '  }',
    '  float alpha = a * v_alpha;',
    '  if (alpha < 0.004) { discard; }',
    '  vec3 c = v_color * (0.86 + 1.12 * core) + vec3(core * core * 0.52);',
    '  gl_FragColor = vec4(c * alpha, alpha);',
    '}'
  ].join('\n');

  var VS_SP = [
    'precision highp float;',
    'attribute vec2 a_pos;',
    'attribute vec3 a_color;',
    'attribute float a_size;',
    'attribute float a_alpha;',
    'uniform vec2 u_res;',
    'uniform float u_dpr;',
    'uniform float u_maxSize;',
    'varying vec3 v_color;',
    'varying float v_alpha;',
    'void main() {',
    '  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  gl_PointSize = clamp(a_size * u_dpr, 1.0, u_maxSize);',
    '  v_color = a_color;',
    '  v_alpha = a_alpha;',
    '}'
  ].join('\n');

  var FS_SP = [
    'precision mediump float;',
    'varying vec3 v_color;',
    'varying float v_alpha;',
    'void main() {',
    '  vec2 pc = gl_PointCoord - vec2(0.5);',
    '  float d2 = dot(pc, pc) * 4.0;',
    '  if (d2 > 1.0) { discard; }',
    '  float core = exp(-d2 * 10.0);',
    '  float halo = exp(-d2 * 2.4) * 0.5;',
    '  float a = (core + halo) * v_alpha;',
    '  if (a < 0.004) { discard; }',
    '  gl_FragColor = vec4(v_color * (0.8 + 1.1 * core) * a, a);',
    '}'
  ].join('\n');

  /* ============================================================ */
  function Engine(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.ok = false;
    this.baked = false;
    this.total = 0;
    this.quality = 1;
    this.frameTimes = [];
    this.W = 1; this.H = 1; this.dpr = 1; this.fit = 1;
    this.flowers = {};
    this.sparks = [];
    this.sparkData = new Float32Array(PC.sparkMax * 7);
    this.wind = { x: 0, y: 0 };
    this.pulse = 0;
    this.lastNow = 0;
    this.locCache = {};
    this.sparkCore = hex01(C.spark);
    this.sparkCoreHot = hex01(PC.coreHot);
    this.sparkWhite = [1, 1, 1];
  }

  /* ---------- 着色器编译 ---------- */
  Engine.prototype._shader = function (type, src, tag) {
    var gl = this.gl;
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      if (global.console && console.error) {
        console.error('[yshnb/bloom] 着色器编译失败 (' + tag + ')：', gl.getShaderInfoLog(s));
      }
      gl.deleteShader(s);
      return null;
    }
    return s;
  };

  Engine.prototype._program = function (vsSrc, fsSrc, tag) {
    var gl = this.gl;
    var vs = this._shader(gl.VERTEX_SHADER, vsSrc, tag + '.vs');
    var fs = this._shader(gl.FRAGMENT_SHADER, fsSrc, tag + '.fs');
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      if (global.console && console.error) {
        console.error('[yshnb/bloom] 程序链接失败 (' + tag + ')：', gl.getProgramInfoLog(prog));
      }
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  };

  Engine.prototype._u = function (pn, name) {
    var k = pn + '|' + name;
    if (!(k in this.locCache)) {
      this.locCache[k] = this.gl.getUniformLocation(this['prog' + pn.toUpperCase()], name);
    }
    return this.locCache[k];
  };
  Engine.prototype._a = function (pn, name) {
    var k = 'a' + pn + '|' + name;
    if (!(k in this.locCache)) {
      this.locCache[k] = this.gl.getAttribLocation(this['prog' + pn.toUpperCase()], name);
    }
    return this.locCache[k];
  };

  Engine.prototype._init = function () {
    var gl = this.gl;
    this.progBG = this._program(VS_BG, FS_BG, 'bg');
    this.progPT = this._program(VS_PT, FS_PT, 'pt');
    this.progSP = this._program(VS_SP, FS_SP, 'sp');
    if (!this.progBG || !this.progPT || !this.progSP) { this.ok = false; return; }

    this.vboQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.vboSP = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboSP);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkData.byteLength, gl.DYNAMIC_DRAW);

    this.vboPT = gl.createBuffer();

    this.bgDeep = hex01(PC.bgDeep);
    this.bgGlow = hex01(PC.bgGlow);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    /* 片元输出的是预乘颜色 (c*a, a)，所以必须用 ONE/ONE 做加法；
     * 若写成 SRC_ALPHA/ONE，亮度会被 alpha 再乘一次（平方），粒子明显发暗。 */
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(this.bgDeep[0], this.bgDeep[1], this.bgDeep[2], 1);
    this.ok = true;
  };

  /* ---------- 烘焙（延后到首次绘制，避免拖慢首屏） ---------- */
  Engine.prototype._bakeNow = function () {
    if (this.baked) return;
    this.baked = true;
    var gl = this.gl;
    var res = bake();
    this.total = res.total;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPT);
    gl.bufferData(gl.ARRAY_BUFFER, res.data, gl.STATIC_DRAW);
  };

  Engine.prototype.resize = function (W, H) {
    this.dpr = Math.min(global.devicePixelRatio || 1, PC.dprCap);
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    var cw = Math.max(1, Math.round(this.W * this.dpr));
    var ch = Math.max(1, Math.round(this.H * this.dpr));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.gl.viewport(0, 0, cw, ch);
    /* 基准 660 而不是 820：旧值下花只占画面约 3/4 高，参考图是铺满，
     * 逐步把花瓣推到接近画幅边缘才有那种「炸开」的压迫感。 */
    this.fit = clamp(Math.min(this.W, this.H) / 660, 0.60, 2.10);
  };

  /* ---------- 事件 ---------- */
  Engine.prototype.addSparks = function (x, y, n, which) {
    var W = this.W, H = this.H;
    if (typeof x !== 'number' || !isFinite(x)) x = W * 0.5;
    if (typeof y !== 'number' || !isFinite(y)) y = H * 0.52;
    var col = (which === 'glint' || which === 1) ? this.sparkWhite
            : (which === 'core' || which === 3) ? this.sparkCoreHot
            : this.sparkCore;
    /* 出生时间必须和 render 的 now 同一时钟源：优先复用上一帧时间戳，
     * 否则一旦 performance.now() 与 rAF 时间戳基准不同，火花就永不消亡。 */
    var now = this.lastNow ||
      ((global.performance && global.performance.now) ? global.performance.now() : Date.now());
    for (var i = 0; i < n; i++) {
      if (this.sparks.length >= PC.sparkMax) break;
      var a = Math.random() * TAU;
      var sp = 0.8 + Math.random() * 4.2;
      this.sparks.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.4,
        born: now,
        size: 2.2 + Math.random() * 4.8,
        col: Math.random() < 0.18 ? this.sparkWhite : col
      });
    }
  };

  Engine.prototype.handleEvents = function (events, desc) {
    var W = this.W, H = this.H;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'pulse') {
        this.pulse = 1;
        this.addSparks(e.x, e.y, P.burstCount, 'spark');
      } else if (e.type === 'newbud') {
        this.pulse = Math.max(this.pulse, 0.55);
        this.addSparks(e.x, e.y, 34, 'core');
      } else if (e.type === 'gust') {
        this.wind.x += clamp(e.x, -1, 1) * P.windStrength * (e.vx || 1);
        this.wind.y += clamp(e.y, -1, 1) * P.windStrength * (e.vy || 1);
        this.addSparks(W / 2, H / 2, 22, 'glint');
      }
    }
  };

  /* ---------- 摄像头小窗骨架（仍是 2D，画在独立的 skeleton canvas 上） ---------- */
  Engine.prototype.drawSkeleton = function (ctx, hand, w, h) {
    if (!ctx || !hand || !hand.landmarks || !hand.landmarks.length) return;
    var LM = hand.landmarks;
    var CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
                [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
                [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = rgba(C.sage, R.skeletonAlpha);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (var i = 0; i < CONN.length; i++) {
      var a = LM[CONN[i][0]], b = LM[CONN[i][1]];
      ctx.moveTo(a.x * (w / this.W), a.y * (h / this.H));
      ctx.lineTo(b.x * (w / this.W), b.y * (h / this.H));
    }
    ctx.stroke();
    ctx.fillStyle = rgba(C.clay, 0.9);
    for (var t = 0; t < LM.length; t++) {
      ctx.beginPath();
      ctx.arc(LM[t].x * (w / this.W), LM[t].y * (h / this.H), t % 4 === 0 ? 2.2 : 1.5, 0, TAU);
      ctx.fill();
    }
  };

  /* ---------- 每朵花画多少点：小花苞按 scale 取前缀 ---------- */
  Engine.prototype._drawCount = function (d) {
    var base = this.total * this.quality;
    if (d.kind === 'bud') {
      var f = clamp((d.scale || 0.34) * 1.55, 0.16, 0.62);
      return Math.max(400, Math.floor(base * f));
    }
    return Math.floor(base);
  };

  /* ---------- 主渲染 ---------- */
  Engine.prototype.render = function (desc, frame, now) {
    var gl = this.gl, W = this.W, H = this.H;
    if (!W || !H || !this.ok) return;
    if (!this.baked) this._bakeNow();

    var dt = this.lastNow ? Math.min(now - this.lastNow, 48) : 16;
    this.lastNow = now;
    var t = now * 0.001;

    this.pulse *= PC.pulseDecay;
    this.wind.x *= P.windDecay;
    this.wind.y *= P.windDecay;

    var all = desc.flowers.concat(desc.buds || []);
    var main = null, maxO = 0;
    for (var mi = 0; mi < all.length; mi++) {
      var md = all[mi];
      if (md.kind === 'primary' || !main) {
        if (!main || (md.openness || 0) >= maxO) { main = md; maxO = md.openness || 0; }
      }
    }
    var cx = main ? W * (0.5 + (main.x - 0.5) * 0.72) : W * 0.5;
    var cy = main ? H * (0.5 + (main.y - 0.5) * 0.66) : H * 0.52;

    var pointer = desc.pointer || (frame.hands && frame.hands[0] && frame.hands[0].tip) || null;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    /* ===== 1) 背景：暗紫红渐晕 + 四周压暗 + 细噪点 ===== */
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progBG);
    var aPos = this._a('bg', 'a_pos');
    if (aPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboQuad);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }
    gl.uniform2f(this._u('bg', 'u_res'), W, H);
    gl.uniform2f(this._u('bg', 'u_center'), cx, cy);
    /* 花苞（maxO≈0）也要有一团可见的红晕，否则完全闭合时整屏近乎全黑，
     * 看不出「有一朵花在那儿等着」。0.34 起步，随绽放再升到 0.68。 */
    gl.uniform1f(this._u('bg', 'u_glow'), 0.44 + 0.26 * clamp(maxO, 0, 1));
    gl.uniform3f(this._u('bg', 'u_deep'), this.bgDeep[0], this.bgDeep[1], this.bgDeep[2]);
    gl.uniform3f(this._u('bg', 'u_glowCol'), this.bgGlow[0], this.bgGlow[1], this.bgGlow[2]);
    gl.uniform1f(this._u('bg', 'u_vig'), PC.vignette);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* ===== 2) 粒子花（叠加混合） ===== */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.progPT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPT);
    /* 第三列是【float 索引】，下面乘 4 换成字节偏移。
     * 早先这里误写成字节偏移（8/16/28…）又乘了一次 4：
     * a_lag 的指针实际落到 160 字节外，读到的是别的粒子颜色通道（≈0.8）。
     * 于是 oe = (u_open - 0.8) / 0.2 —— 张开度低于 0.8 时整朵花 oe≈0，
     * 只剩花心一个白点；只有全开（oe=1）才看起来正常。
     * 这个 bug 让「半开/花苞」一直是坏的，也让手势控制像失灵。 */
    var layout = [
      ['a_open', 2, 0], ['a_close', 2, 2], ['a_color', 3, 4],
      ['a_size', 1, 7], ['a_bright', 1, 8], ['a_phase', 1, 9],
      ['a_lag', 1, 10], ['a_kind', 1, 11], ['a_shade', 1, 12]
    ];
    for (var li = 0; li < layout.length; li++) {
      var loc = this._a('pt', layout[li][0]);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, layout[li][1], gl.FLOAT, false, STRIDE_F * 4, layout[li][2] * 4);
    }

    gl.uniform1f(this._u('pt', 'u_time'), t);
    gl.uniform2f(this._u('pt', 'u_res'), W, H);
    gl.uniform1f(this._u('pt', 'u_dpr'), this.dpr);
    gl.uniform2f(this._u('pt', 'u_pointer'), pointer ? pointer.x : 0, pointer ? pointer.y : 0);
    gl.uniform1f(this._u('pt', 'u_pointerOn'), pointer ? 1 : 0);
    gl.uniform2f(this._u('pt', 'u_wind'), this.wind.x * 1.2, this.wind.y * 1.2);
    gl.uniform1f(this._u('pt', 'u_pulse'), this.pulse);
    /* 属性偏移修好后，点径从 1px 回到真实的 4~9px，覆盖面积大了几十倍，
     * 旧的 1.5 会把整朵花糊成一团白。0.42 是重新平衡后的总亮度。 */
    gl.uniform1f(this._u('pt', 'u_bright'), 0.45);
    gl.uniform1f(this._u('pt', 'u_maxSize'), PC.maxPointSize);
    gl.uniform1f(this._u('pt', 'u_twinkle'), PC.twinkleSpeed);

    for (var fi = 0; fi < all.length; fi++) {
      var d = all[fi];
      if (!d || d.alpha === 0) continue;
      var fx = W * (0.5 + (d.x - 0.5) * 0.72);
      var fy = H * (0.5 + (d.y - 0.5) * 0.66);
      gl.uniform2f(this._u('pt', 'u_center'), fx, fy);
      gl.uniform1f(this._u('pt', 'u_scale'), (d.scale || 1) * this.fit);
      gl.uniform1f(this._u('pt', 'u_open'), clamp(d.openness || 0, 0, 1));
      gl.uniform1f(this._u('pt', 'u_alpha'), d.alpha === undefined ? 1 : d.alpha);
      gl.uniform1f(this._u('pt', 'u_seed'), (d.seed || 0) * 0.37);
      gl.drawArrays(gl.POINTS, 0, Math.min(this.total, this._drawCount(d)));
    }

    /* ===== 3) 火花：事件迸发 / 双击落花雨 ===== */
    var nSpark = this._updateSparks(now, dt);
    if (nSpark > 0) {
      gl.useProgram(this.progSP);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboSP);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkData.subarray(0, nSpark * 7));
      /* 同样：第三列是 float 索引（7 个 float / 粒子） */
      var sLayout = [['a_pos', 2, 0], ['a_color', 3, 2], ['a_size', 1, 5], ['a_alpha', 1, 6]];
      for (var si = 0; si < sLayout.length; si++) {
        var sl = this._a('sp', sLayout[si][0]);
        if (sl < 0) continue;
        gl.enableVertexAttribArray(sl);
        gl.vertexAttribPointer(sl, sLayout[si][1], gl.FLOAT, false, 7 * 4, sLayout[si][2] * 4);
      }
      gl.uniform2f(this._u('sp', 'u_res'), W, H);
      gl.uniform1f(this._u('sp', 'u_dpr'), this.dpr);
      gl.uniform1f(this._u('sp', 'u_maxSize'), PC.maxPointSize);
      gl.drawArrays(gl.POINTS, 0, nSpark);
    }
  };

  Engine.prototype._updateSparks = function (now, dt) {
    var life = PC.sparkLifeMs;
    var k = (dt || 16) / 16.67;
    var out = this.sparkData;
    var n = 0;
    var keep = [];
    for (var i = 0; i < this.sparks.length; i++) {
      var s = this.sparks[i];
      var age = now - s.born;
      if (age > life) continue;
      s.vx *= Math.pow(0.972, k);
      s.vy = s.vy * Math.pow(0.972, k) + 0.022 * k;
      s.x += s.vx * k;
      s.y += s.vy * k;
      var lifeK = 1 - age / life;
      var o = n * 7;
      out[o] = s.x; out[o + 1] = s.y;
      out[o + 2] = s.col[0]; out[o + 3] = s.col[1]; out[o + 4] = s.col[2];
      out[o + 5] = s.size * (0.55 + 0.45 * lifeK);
      out[o + 6] = lifeK * 0.9;
      n++;
      keep.push(s);
    }
    this.sparks = keep;
    return n;
  };

  Engine.prototype.reportFrame = function (ms) {
    if (!PC.autoQuality) return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    if (this.frameTimes.length < 20) return;
    var sum = 0;
    for (var i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    var avg = sum / this.frameTimes.length;
    if (avg > PC.targetFrameMs) this.quality = Math.max(PC.minQuality, this.quality - 0.05);
    else if (avg < 16) this.quality = Math.min(1, this.quality + 0.02);
  };

  /* ============================================================
   * 回退：WebGL 不可用 / 着色器编译失败 → Canvas 2D 精致版
   * 用叠加层 canvas 绕开「同一 canvas 已绑定 webgl 就不能再取 2d」的限制。
   * ============================================================ */
  function makeOverlay(canvas) {
    var ov = document.createElement('canvas');
    ov.setAttribute('aria-hidden', 'true');
    ov.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
    if (canvas.parentNode) canvas.parentNode.insertBefore(ov, canvas.nextSibling);
    return Y.Bloom2D.create(ov);
  }

  Y.Bloom = {
    create: function (canvas, overrides) {
      try {
        if (!canvas || !canvas.getContext) throw new Error('canvas 不可用');
        var opts = {
          alpha: false, antialias: false, depth: false, stencil: false,
          premultipliedAlpha: false, preserveDrawingBuffer: false,
          powerPreference: 'high-performance'
        };
        /* 仅离线截图验证会传 overrides（如 preserveDrawingBuffer:true），
         * 让 headless 截图能稳定抓到缓冲内容；线上调用不传，行为不变。 */
        if (overrides) {
          for (var ok in overrides) {
            if (Object.prototype.hasOwnProperty.call(overrides, ok)) opts[ok] = overrides[ok];
          }
        }
        var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        if (!gl) throw new Error('浏览器未提供 WebGL 上下文');
        var eng = new Engine(canvas, gl);
        eng._init();
        if (!eng.ok) throw new Error('着色器初始化失败');
        /* 烘焙 4.7 万粒子约 100 ms；用户还在开始页读说明，提前烘好，
         * 点「开始」时就能直接画，不会在淡入动画里卡一下。 */
        setTimeout(function () { try { eng._bakeNow(); } catch (e) {} }, 700);
        return eng;
      } catch (err) {
        if (global.console && console.warn) {
          console.warn('[yshnb/bloom] WebGL 不可用，回退 2D 粒子层：', (err && err.message) || err);
        }
        if (Y.Bloom2D) return makeOverlay(canvas);
        throw err;
      }
    },
    /* 供离线校验使用（不影响运行） */
    __bake: bake,
    __shaders: { bg: VS_BG + '\n' + FS_BG, pt: VS_PT + '\n' + FS_PT, sp: VS_SP + '\n' + FS_SP },
    __units: {
      bg: { vs: VS_BG, fs: FS_BG },
      pt: { vs: VS_PT, fs: FS_PT },
      sp: { vs: VS_SP, fs: FS_SP }
    },
    __params: PC
  };
})(window);
