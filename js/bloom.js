/* ============================================================
 * 粒子花朵引擎 (Canvas 2D) · Nocturne
 * ------------------------------------------------------------
 * 一朵花 = 三层「花轮」(whorl)，每层若干片参数化花瓣：
 *   · 伪 3D：花瓣以 tilt 角斜立，open 时摊平、closed 时竖起包成花苞；
 *     花平面按 flatten 压成椭圆，形成斜俯视的立体感。
 *   · 每片花瓣 = 平滑贝塞尔轮廓 + 根到尖渐变瓣面 + 三层瓣缘描边
 *     + 主脉 / 侧脉 / 瓣尖高光 + 稀疏填充微粒。
 *   · 花心 = 黄金角颗粒 + 辐射雄蕊细丝 + 柔光晕。
 *   · 分层开放：外层 lag=0 先舒展，内层 lag>0 后跟，张手时依次绽开。
 *   · 弹簧-阻尼跟随目标位形；降质时按 rank 砍填充点，永远保住轮廓。
 * 黑底用 lighter 叠加，樱花粉 / 蜜桃粉 / 粉白，发光但不糊。
 * 轮廓质感由矢量层保证（不随性能降质），粒子层只负责闪烁细节。
 * ============================================================ */
(function (global) {
  'use strict';

  var Y = global.YSHNB;
  var F = Y.CFG.flower;
  var P = Y.CFG.physics;
  var R = Y.CFG.render;
  var C = Y.CFG.palette;
  var L = Y.CFG.light;
  var WH = F.whorls;
  var TAU = Math.PI * 2;
  var SHADES = 5;                 // 每层花瓣从根到尖的色阶数
  var PER = SHADES + 1;           // 每层 sprite 数（色阶 + 1 个高光）
  var CORE_I = WH.length * PER;   // 花心 sprite 下标
  var SPARK_I = CORE_I + 1;       // 火花
  var GLINT_I = CORE_I + 2;       // 纯白高光
  var HALO_I = CORE_I + 3;        // 粉白柔光（瓣心 / 花心大晕）
  var MOTE_I = CORE_I + 4;        // 粉白光粒（环境浮游）

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function hexRgb(hex) {
    var h = hex.replace('#', '');
    return { r: parseInt(h.substring(0, 2), 16),
             g: parseInt(h.substring(2, 4), 16),
             b: parseInt(h.substring(4, 6), 16) };
  }
  function rgba(hex, a) {
    var c = hexRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function mixHex(a, b, t) {
    var x = hexRgb(a), y = hexRgb(b);
    function h(n) { var s = Math.round(n).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(lerp(x.r, y.r, t)) + h(lerp(x.g, y.g, t)) + h(lerp(x.b, y.b, t));
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- 离屏柔光点 ---------- */
  function makeSprite(hex, size) {
    var s = size || R.spriteSize;
    var cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    var g = cv.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, rgba(hex, 1));
    grd.addColorStop(0.14, rgba(hex, 0.94));
    grd.addColorStop(0.38, rgba(hex, 0.42));
    grd.addColorStop(0.72, rgba(hex, 0.09));
    grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return cv;
  }
  function buildPalette() {
    var arr = [], w, s;
    for (w = 0; w < WH.length; w++) {
      for (s = 0; s < SHADES; s++) {
        arr.push(makeSprite(mixHex(WH[w].root, WH[w].tip, s / (SHADES - 1))));
      }
      arr.push(makeSprite(WH[w].glow));        // base + SHADES：零星高光点
    }
    arr.push(makeSprite(C.core));
    arr.push(makeSprite(C.spark));
    arr.push(makeSprite('#FFFFFF'));
    arr.push(makeSprite('#FFE6F2'));   // HALO_I：粉白柔光
    arr.push(makeSprite('#FFEFF7'));   // MOTE_I：粉白光粒
    return arr;
  }

  /* ---------- 花瓣参数化位形（相对花心） ---------- */
  function petalPoint(wh, count, p, u, v, o, sway, out) {
    var lag = wh.lag || 0;
    var oe = clamp((o - lag) / (1 - lag), 0, 1);

    var len = lerp(wh.lenClosed, wh.lenOpen, oe);
    var rad = lerp(wh.radiusClosed, wh.radiusOpen, oe);
    var wid = lerp(wh.widthClosed, wh.widthOpen, oe);
    var curl = lerp(wh.curlClosed, wh.curlOpen, oe);
    var tilt = lerp(wh.tiltClosed, wh.tiltOpen, oe);

    /* 纺锤形轮廓：瓣根收、中段宽、瓣尖收；
     * 主浪 + 高频细浪叠加，做出真花瓣那种不完全规整的柔顺瓣缘。 */
    var prof = Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), wh.profilePow);
    var wave = F.ripple * Math.sin(u * Math.PI * 3 + p * 1.7)
             + (F.ripple2 || 0) * Math.sin(u * Math.PI * 9 + p * 2.9 + (wh.rot || 0) * 11);
    var halfW = wid * len * prof * (1 + wave);
    var tang = v * halfW;

    var ang = ((p + (wh.phase || 0)) / count) * TAU + (wh.rot || 0)
              + (wh.twistDir || 1) * F.twist * o + sway;
    var ux = Math.sin(ang), uy = -Math.cos(ang);   // 径向外
    var tx = Math.cos(ang), ty = Math.sin(ang);    // 切向

    /* 斜立 → 摊平：tilt 大时花瓣向上长（花苞），小时向外铺（盛放） */
    var proj = len * Math.cos(tilt);
    var rise = len * Math.sin(tilt);
    var u2 = u * u;
    var radial = rad + u * proj - curl * u2 * len * 0.18;
    var z = u * rise + curl * u2 * len * 0.55;     // 瓣尖上卷 / 内扣

    var px = radial * ux + tang * tx;
    var py = radial * uy + tang * ty;
    out.x = px;
    out.y = py * F.flatten - z * F.zScale;
    out.oe = oe;
    return out;
  }

  /* ---------- 单个粒子 ---------- */
  function mkPt(w, p, u, v, kind, tmp, rnd) {
    var base = w * PER;
    var ci = base + Math.min(SHADES - 1, Math.floor(u * SHADES));
    if (kind === 'edge' && rnd() > 0.80) ci = base + SHADES;   // 瓣缘零星纯色高光
    var size, rank, al;
    if (kind === 'edge') {
      size = 1.35 + rnd() * 1.05; rank = 0.10 + rnd() * 0.14; al = R.edgeAlpha;
    } else if (kind === 'vein') {
      size = 1.20 + rnd() * 0.95; rank = 0.27 + rnd() * 0.20; al = R.veinAlpha;
    } else {
      size = 1.90 + rnd() * 1.90; rank = 0.55 + rnd() * 0.45; al = R.fillAlpha;
    }
    return {
      kind: kind, w: w, p: p, u: u, v: v, ci: ci,
      cx: tmp.x, cy: tmp.y,
      x: tmp.x, y: tmp.y, vx: 0, vy: 0,
      size: size, al: al, rank: rank, phase: rnd() * TAU
    };
  }

  /* ---------- 一朵花 ---------- */
  function Flower(seed) {
    this.seed = seed || 0;
    this.particles = [];
    this.stamens = [];
    this.x = 0; this.y = 0;
    this.openness = 0; this.scale = 1; this.alpha = 1;
    this.build();
  }

  Flower.prototype.build = function () {
    var pts = this.particles;
    var rnd = mulberry(Math.floor(this.seed * 9973) + 7);
    var tmp = { x: 0, y: 0, oe: 0 };
    var w, p, i, b, k, q, side, u, v;

    for (w = 0; w < WH.length; w++) {
      var wh = WH[w], count = wh.count;
      for (p = 0; p < count; p++) {
        /* 瓣缘：两侧各 edgeBands 束，密集小亮点连成清晰轮廓 */
        for (side = -1; side <= 1; side += 2) {
          for (b = 0; b < F.edgeBands; b++) {
            for (i = 0; i < F.rings; i++) {
              u = (i + 0.5) / F.rings;
              v = side * (0.97 - b * 0.055);
              petalPoint(wh, count, p, u, v, 0, 0, tmp);
              pts.push(mkPt(w, p, u, v, 'edge', tmp, rnd));
            }
          }
        }
        /* 侧脉：从瓣根到瓣尖的细线 */
        for (k = 0; k < F.veinCount; k++) {
          v = F.veinCount === 1 ? 0 : ((k / (F.veinCount - 1)) * 2 - 1) * 0.62;
          for (i = 0; i < F.rings; i++) {
            u = (i + 0.5) / F.rings;
            petalPoint(wh, count, p, u, v, 0, 0, tmp);
            pts.push(mkPt(w, p, u, v, 'vein', tmp, rnd));
          }
        }
        /* 填充：稀疏、随机、低亮，像花粉与纱的质感 */
        for (i = 0; i < F.rings; i++) {
          for (q = 0; q < F.fillPerRow; q++) {
            u = (i + rnd()) / F.rings;
            v = (rnd() * 2 - 1) * 0.88;
            petalPoint(wh, count, p, u, v, 0, 0, tmp);
            pts.push(mkPt(w, p, u, v, 'fill', tmp, rnd));
          }
        }
      }
    }

    /* 花心：黄金角分布，闭合时紧、盛放时铺开 */
    var cr = WH[2].radiusClosed * 0.92;
    var orr = WH[0].radiusOpen * 0.52;
    for (i = 0; i < F.coreCount; i++) {
      var t = (i + 0.5) / F.coreCount;
      var rr = Math.sqrt(t);
      var a = i * 2.399963229728653;
      var cx = Math.cos(a) * rr * cr, cy = Math.sin(a) * rr * cr * F.flatten;
      pts.push({
        kind: 'core', w: 2, p: 0, u: 0, v: 0, ci: CORE_I,
        cx: cx, cy: cy, ox: Math.cos(a) * rr * orr, oy: Math.sin(a) * rr * orr * F.flatten,
        x: cx, y: cy, vx: 0, vy: 0,
        size: 1.7 + rnd() * 2.1, al: R.coreAlpha,
        rank: 0.08 + rnd() * 0.22, phase: rnd() * TAU
      });
    }

    /* 雄蕊细丝 */
    for (i = 0; i < F.stamenCount; i++) {
      this.stamens.push({
        a: (i / F.stamenCount) * TAU + rnd() * 0.14,
        ph: rnd() * TAU,
        len: 0.58 + rnd() * 0.42
      });
    }
    /* 环境光粒：绕花缓慢浮游的细碎亮点，各自有轨道、相位与色温 */
    this.motes = [];
    var outer = WH[0].radiusOpen * L.moteRadius;
    for (i = 0; i < L.motesPerFlower; i++) {
      var ma = rnd() * TAU;
      var mr = Math.sqrt(rnd()) * outer;
      var pick = rnd();
      this.motes.push({
        a: ma, r: mr, drift: (rnd() - 0.5) * 2,
        ph: rnd() * TAU, bob: 0.6 + rnd() * 0.9,
        size: L.moteSizeMin + rnd() * (L.moteSizeMax - L.moteSizeMin),
        ci: pick < 0.42 ? MOTE_I : (pick < 0.70 ? GLINT_I : (pick < 0.87 ? CORE_I : SHADES))
      });
    }
    /* 星芒：稀疏纯白十字，闪现即隐，制造细碎高光 */
    this.glints = [];
    for (i = 0; i < L.glintsPerFlower; i++) {
      var ga = rnd() * TAU;
      var gr = (0.18 + rnd() * 0.92) * WH[0].radiusOpen;
      this.glints.push({
        x: Math.cos(ga) * gr, y: Math.sin(ga) * gr * F.flatten,
        ph: rnd() * TAU, len: 0.55 + rnd() * 0.85,
        ci: rnd() > 0.4 ? GLINT_I : HALO_I
      });
    }
    this.count = pts.length;
  };

  Flower.prototype.place = function (x, y, o, scale, alpha) {
    this.x = x; this.y = y;
    this.openness = o; this.scale = scale;
    this.alpha = alpha === undefined ? 1 : alpha;
  };

  Flower.prototype.burst = function () {
    var pts = this.particles;
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var d = Math.sqrt(pt.x * pt.x + pt.y * pt.y) || 1;
      var k = (0.5 + Math.random() * 0.8) * P.burstSpeed;
      pt.vx += (pt.x / d) * k;
      pt.vy += (pt.y / d) * k;
    }
  };

  /* ---------- 引擎 ---------- */
  function Engine(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.W = 1; this.H = 1; this.dpr = 1;
    this.flowers = {};
    this.sparks = [];
    this.wind = { x: 0, y: 0 };
    this.quality = 1;
    this.frameTimes = [];
    this.pal = buildPalette();
    this.reduce = global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.lastNow = 0;
    this._tmp = { x: 0, y: 0, oe: 0 };
  }

  Engine.prototype.resize = function (W, H) {
    this.dpr = Math.min(global.devicePixelRatio || 1, R.maxDpr);
    this.W = W; this.H = H;
    this.canvas.width = Math.round(W * this.dpr);
    this.canvas.height = Math.round(H * this.dpr);
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = C.bg;
    this.ctx.fillRect(0, 0, W, H);
  };

  Engine.prototype.getFlower = function (desc) {
    var f = this.flowers[desc.id];
    if (!f) { f = new Flower(desc.seed); this.flowers[desc.id] = f; }
    return f;
  };

  Engine.prototype.addSparks = function (x, y, n, which) {
    var idx = (which === 'glint' || which === 1) ? GLINT_I
            : (which === 'core' || which === 3) ? CORE_I : SPARK_I;
    for (var i = 0; i < n; i++) {
      if (this.sparks.length >= R.sparkMax) break;
      var a = Math.random() * TAU;
      var sp = 0.8 + Math.random() * 3.8;
      this.sparks.push({
        x: x, y: y, px: x, py: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.5,
        born: performance.now(), size: 2.4 + Math.random() * 4.2,
        color: Math.random() < 0.22 ? GLINT_I : idx
      });
    }
  };

  Engine.prototype.handleEvents = function (events, desc) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'pulse') {
        Object.keys(this.flowers).forEach(function (k) {
          if (this.flowers[k] && desc.flowers.some(function (d) { return String(d.id) === k; })) {
            this.flowers[k].burst();
          }
        }, this);
        this.addSparks(e.x, e.y, P.burstCount, 'spark');
      } else if (e.type === 'newbud') {
        this.addSparks(e.x, e.y, 30, 'core');
      } else if (e.type === 'gust') {
        this.wind.x += clamp(e.x, -1, 1) * P.windStrength * (e.vx || 1);
        this.wind.y += clamp(e.y, -1, 1) * P.windStrength * (e.vy || 1);
        this.addSparks(this.W / 2, this.H / 2, 20, 'glint');
      }
    }
  };

  /* 极淡粉灰线茎与叶：暗底上只留一线微光，不抢花 */
  Engine.prototype.drawStem = function (x, y, o) {
    if (!F.drawStem) return;
    var g = this.ctx;
    var top = y + lerp(WH[2].radiusClosed, WH[2].radiusOpen, o) * 0.42;
    var bottom = this.H + 24;
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = rgba(C.stem, 0.10);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, top);
    g.bezierCurveTo(x - 16, top + 150, x + 20, bottom - 170, x + 5, bottom);
    g.stroke();
    for (var k = 0; k < 2; k++) {
      var ly = top + 190 + k * 150;
      var dir = k % 2 === 0 ? -1 : 1;
      g.beginPath();
      g.moveTo(x + 3, ly);
      g.quadraticCurveTo(x + dir * 52, ly - 34, x + dir * 76, ly + 6);
      g.quadraticCurveTo(x + dir * 46, ly + 30, x + 3, ly);
      g.strokeStyle = rgba(C.stem, 0.065);
      g.stroke();
    }
  };

  Engine.prototype.drawSkeleton = function (ctx, hand, w, h) {
    if (!hand || !hand.landmarks || !hand.landmarks.length) return;
    var LM = hand.landmarks;
    var CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
                [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
                [13,17],[17,18],[18,19],[19,20],[0,17]];
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

  Engine.prototype.render = function (desc, frame, now) {
    var g = this.ctx, W = this.W, H = this.H;
    var dt = this.lastNow ? Math.min(now - this.lastNow, 40) : 16;
    this.lastNow = now;

    /* 铺底：接近不透明，留极短光轨，避免 lighter 累积过曝成白团 */
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = rgba(C.bg, this.reduce ? 1 : R.trailFade);
    g.fillRect(0, 0, W, H);

    this.wind.x *= P.windDecay;
    this.wind.y *= P.windDecay;
    var pointer = desc.pointer || (frame.hands[0] ? frame.hands[0].tip : null);
    var pr = P.pointerRadius, pf = P.pointerForce;

    var all = desc.flowers.concat(desc.buds || []);
    var activeIds = {};
    for (var n = 0; n < all.length; n++) {
      var d = all[n];
      activeIds[d.id] = true;
      var fx = W * (0.5 + (d.x - 0.5) * 0.72);
      var fy = H * (0.5 + (d.y - 0.5) * 0.66);
      var flower = this.getFlower(d);
      flower.place(fx, fy, d.openness, d.scale || 1, d.alpha === undefined ? 1 : d.alpha);
      if (d.kind === 'primary') this.drawStem(fx, fy, d.openness);
      this.drawFlower(flower, d, now, dt, pointer, pr, pf);
    }
    Object.keys(this.flowers).forEach(function (k) {
      if (!activeIds[k]) delete this.flowers[k];
    }, this);

    this.drawSparks(now, dt);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  };

  /* 用「中点 + 二次贝塞尔」把采样点连成连续光滑曲线。
   * 旧版是 10 段 lineTo 直接勾勒，放大后折线感明显、瓣缘粗陋；
   * 这里让曲线经过每个采样点的邻接中点，得到柔顺的 C1 连续瓣缘。 */
  function traceSmooth(g, pts) {
    var n = pts.length;
    if (n < 3) {
      for (var q = 0; q < n; q++) {
        if (q === 0) g.moveTo(pts[q].x, pts[q].y);
        else g.lineTo(pts[q].x, pts[q].y);
      }
      return;
    }
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < n - 1; i++) {
      var mx = (pts[i].x + pts[i + 1].x) * 0.5;
      var my = (pts[i].y + pts[i + 1].y) * 0.5;
      g.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    var last = pts[n - 1];
    g.quadraticCurveTo(last.x, last.y, last.x, last.y);
  }

  /* 采样一条瓣缘（v 固定，u: 0→1），返回屏幕坐标点列 */
  Engine.prototype._edgePoints = function (wh, count, p, v, o, sway, sc, flower, SEG) {
    var tmp = this._tmp, pts = [];
    for (var i = 0; i <= SEG; i++) {
      petalPoint(wh, count, p, i / SEG, v, o, sway, tmp);
      pts.push({ x: flower.x + tmp.x * sc, y: flower.y + tmp.y * sc });
    }
    return pts;
  };

  /* 花瓣面 + 瓣缘：给粒子层垫一层「纱」，花才有实体而非散点。
   * 轮廓、渐变、描边都是矢量绘制，不随性能降质，永远保住精致度。 */
  Engine.prototype.drawPetals = function (flower, now, alpha, isBud) {
    if (isBud || flower.openness < 0.035) return;
    var g = this.ctx, o = flower.openness, sc = flower.scale;
    var sway = F.swayAmp * Math.sin(now * F.swaySpeed + flower.seed);
    var tmp = this._tmp;
    var SEG = F.petalSeg || 26;
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    g.lineCap = 'round';

    for (var w = 0; w < WH.length; w++) {
      var wh = WH[w], count = wh.count;
      /* 该层的有效开放度决定面与描边的可见度 */
      var oe = clamp((o - (wh.lag || 0)) / (1 - (wh.lag || 0)), 0, 1);
      if (oe < 0.02) continue;
      for (var p = 0; p < count; p++) {
        /* 瓣心柔光：让每片花瓣自己透亮，而非只有边缘亮 */
        petalPoint(wh, count, p, 0.55, 0, o, sway, tmp);
        var halo = wh.lenOpen * L.haloScale * oe * sc;
        g.globalAlpha = L.haloAlpha * oe * alpha;
        g.drawImage(this.pal[HALO_I],
          flower.x + tmp.x * sc * 0.72 - halo / 2,
          flower.y + tmp.y * sc * 0.72 - halo / 2, halo, halo);
        g.globalAlpha = 1;

        /* 根点 / 尖点：给瓣面与主脉的渐变定方向 */
        petalPoint(wh, count, p, 0.02, 0, o, sway, tmp);
        var rx = flower.x + tmp.x * sc, ry = flower.y + tmp.y * sc;
        petalPoint(wh, count, p, 0.98, 0, o, sway, tmp);
        var tx = flower.x + tmp.x * sc, ty = flower.y + tmp.y * sc;

        /* 闭合轮廓：左缘 0→1、右缘 1→0，贝塞尔连成光滑曲线 */
        var left = this._edgePoints(wh, count, p, -1, o, sway, sc, flower, SEG);
        var right = this._edgePoints(wh, count, p, 1, o, sway, sc, flower, SEG);
        var ring = left.concat(right.slice().reverse());
        g.beginPath();
        traceSmooth(g, ring);
        g.closePath();

        /* 瓣面：根深尖透的线性渐变，薄纱透光 */
        var grd = g.createLinearGradient(rx, ry, tx, ty);
        grd.addColorStop(0, rgba(wh.root, F.faceAlpha * oe * alpha));
        grd.addColorStop(0.42, rgba(wh.glow, F.faceAlpha * 0.72 * oe * alpha));
        grd.addColorStop(1, rgba(wh.tip, F.faceTipAlpha * oe * alpha));
        g.fillStyle = grd;
        g.fill();

        /* 三层瓣缘：柔光宽边 → 亮边，勾出轮廓与体积 */
        g.strokeStyle = rgba(wh.glow, F.edgeSoftAlpha * oe * alpha);
        g.lineWidth = 2.0;
        g.stroke();
        g.strokeStyle = rgba(wh.tip, F.edgeLineAlpha * oe * alpha);
        g.lineWidth = 0.7;
        g.stroke();

        /* 内缩细线：沿花心方向收 3.5%，做出瓣缘翻卷的厚度 */
        g.beginPath();
        for (var ii = 0; ii < ring.length; ii++) {
          var ip = ring[ii];
          var ix = flower.x + (ip.x - flower.x) * 0.965;
          var iy = flower.y + (ip.y - flower.y) * 0.965;
          if (ii === 0) g.moveTo(ix, iy); else g.lineTo(ix, iy);
        }
        g.closePath();
        g.strokeStyle = rgba(wh.glow, F.edgeInnerAlpha * oe * alpha);
        g.lineWidth = 0.55;
        g.stroke();

        /* 主脉：根→尖渐隐的细线，给花瓣一条挺立的中脊 */
        var mid = this._edgePoints(wh, count, p, 0, o, sway, sc, flower, SEG);
        g.beginPath();
        traceSmooth(g, mid);
        var mg = g.createLinearGradient(rx, ry, tx, ty);
        mg.addColorStop(0, rgba(wh.root, F.midribAlpha * oe * alpha));
        mg.addColorStop(0.7, rgba(wh.glow, F.midribAlpha * 0.45 * oe * alpha));
        mg.addColorStop(1, rgba(wh.tip, 0));
        g.strokeStyle = mg;
        g.lineWidth = 0.6;
        g.stroke();

        /* 侧脉：两条从瓣根发散到瓣缘的极淡弧线 */
        for (var vd = -1; vd <= 1; vd += 2) {
          g.beginPath();
          for (var si = 0; si <= 8; si++) {
            var su = si / 8;
            petalPoint(wh, count, p, 0.04 + su * 0.86, vd * (0.20 + su * 0.62), o, sway, tmp);
            var sx = flower.x + tmp.x * sc, sy = flower.y + tmp.y * sc;
            if (si === 0) g.moveTo(sx, sy); else g.lineTo(sx, sy);
          }
          g.strokeStyle = rgba(wh.glow, F.veinLineAlpha * oe * alpha);
          g.lineWidth = 0.5;
          g.stroke();
        }

        /* 瓣尖高光：极小的亮点，像停在瓣尖的露珠 */
        g.globalAlpha = F.tipGlintAlpha * oe * alpha;
        var tg = 2.6 * sc;
        g.drawImage(this.pal[GLINT_I], tx - tg, ty - tg, tg * 2, tg * 2);
        g.globalAlpha = 1;
      }
    }
  };

  Engine.prototype.drawFlower = function (flower, desc, now, dt, pointer, pr, pf) {
    var g = this.ctx;
    var o = flower.openness, sc = flower.scale;
    var alpha = flower.alpha;
    var isBud = desc.kind === 'bud';
    var pts = flower.particles;
    var breathT = now * P.breathSpeed + flower.seed;
    var sway = this.reduce ? 0 : F.swayAmp * Math.sin(now * F.swaySpeed + flower.seed);
    var jitter = this.reduce ? 0 : P.jitter;
    var q = this.quality * (isBud ? 0.58 : 1);
    var tmp = this._tmp;
    var pal = this.pal;

    /* --- 花心双层柔光晕：外层暖晕铺开，内层白核提亮 --- */
    g.globalCompositeOperation = 'lighter';
    var gs = L.coreGlowSize * sc * (0.62 + o * 0.38);
    g.globalAlpha = L.coreGlowAlpha * alpha * (0.48 + o * 0.52);
    g.drawImage(pal[HALO_I], flower.x - gs / 2, flower.y - gs / 2, gs, gs);
    var gs2 = L.coreGlow2Size * sc * (0.70 + o * 0.30);
    g.globalAlpha = L.coreGlow2Alpha * alpha * (0.50 + o * 0.50);
    g.drawImage(pal[GLINT_I], flower.x - gs2 / 2, flower.y - gs2 / 2, gs2, gs2);

    /* --- 花瓣面 / 描边 --- */
    this.drawPetals(flower, now, alpha, isBud);

    /* --- 粒子 --- */
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      if (pt.rank > q) continue;                  // 降质先砍填充，轮廓与脉络始终保留

      var tx, ty;
      if (pt.kind === 'core') {
        tx = lerp(pt.cx, pt.ox, o);
        ty = lerp(pt.cy, pt.oy, o);
      } else {
        petalPoint(WH[pt.w], WH[pt.w].count, pt.p, pt.u, pt.v, o, sway, tmp);
        tx = tmp.x; ty = tmp.y;
      }
      /* 呼吸 + 个体相位，让花始终在极轻微地「活」 */
      tx += Math.sin(breathT + pt.phase) * P.breathAmp;
      ty += Math.cos(breathT * 0.8 + pt.phase) * P.breathAmp;

      var ax = (tx - pt.x) * P.stiffness;
      var ay = (ty - pt.y) * P.stiffness;

      /* 指尖排斥（转到花的局部坐标） */
      if (pointer) {
        var lpx = (pointer.x - flower.x) / sc;
        var lpy = (pointer.y - flower.y) / sc;
        var dx = lpx - pt.x, dy = lpy - pt.y;
        var d2 = dx * dx + dy * dy;
        var radius = pr / sc;
        if (d2 < radius * radius) {
          var d = Math.sqrt(d2) || 1;
          var f = (1 - d / radius) * pf;
          ax -= (dx / d) * f;
          ay -= (dy / d) * f;
        }
      }

      pt.vx = (pt.vx + ax + this.wind.x * 0.055) * P.damping;
      pt.vy = (pt.vy + ay + this.wind.y * 0.055) * P.damping;
      pt.x += pt.vx + (Math.random() - 0.5) * jitter;
      pt.y += pt.vy + (Math.random() - 0.5) * jitter;

      var px = flower.x + pt.x * sc;
      var py = flower.y + pt.y * sc;
      var size = pt.size * sc * (pt.kind === 'core' ? (0.82 + o * 0.42) : (0.86 + o * 0.30));
      var twinkle = (1 - L.twinkleDepth * 0.5) + L.twinkleDepth * 0.5 *
                     Math.sin(now * L.twinkleSpeed + pt.phase);
      g.globalAlpha = pt.al * R.particleAlpha * alpha * twinkle;
      g.drawImage(pal[pt.ci], px - size, py - size, size * 2, size * 2);
    }

    /* --- 雄蕊：细丝 + 顶端亮点 --- */
    if (!isBud && o > 0.12) {
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = rgba(C.core, 0.26 * alpha * o);
      g.lineWidth = 0.7;
      for (var s = 0; s < flower.stamens.length; s++) {
        var st = flower.stamens[s];
        var a = st.a + sway + Math.sin(now * 0.0009 + st.ph) * 0.03;
        var stLen = lerp(5, 30, o) * st.len * sc;
        var ex = flower.x + Math.sin(a) * stLen;
        var ey = flower.y - Math.cos(a) * stLen * F.flatten;
        g.beginPath();
        g.moveTo(flower.x, flower.y);
        g.lineTo(ex, ey);
        g.stroke();
        g.globalAlpha = 0.55 * alpha * o;
        g.drawImage(pal[GLINT_I], ex - 1.8, ey - 1.8, 3.6, 3.6);
      }
    }

    /* --- 环境光粒与星芒：细碎亮点让整朵花透亮、有呼吸 --- */
    this.drawMotes(flower, now, alpha, o);
    this.drawGlints(flower, now, alpha, o);
    g.globalAlpha = 1;
  };

  /* 环境光粒：绕花缓慢浮游，带各自轨道 / 明暗呼吸 / 色温 */
  Engine.prototype.drawMotes = function (flower, now, alpha, o) {
    var g = this.ctx, sc = flower.scale;
    var motes = flower.motes;
    if (!motes || !motes.length) return;
    g.globalCompositeOperation = 'lighter';
    var n = Math.round(motes.length * (0.55 + 0.45 * this.quality));
    for (var i = 0; i < n; i++) {
      var m = motes[i];
      var a = m.a + now * L.moteDrift * m.drift;
      var rr = m.r * (0.52 + o * 0.55) * sc;
      var x = flower.x + Math.cos(a) * rr;
      var y = flower.y + Math.sin(a) * rr * F.flatten
              + Math.sin(now * L.moteBob * m.bob + m.ph) * 6 * sc;
      var half = 0.5 + 0.5 * Math.sin(now * L.twinkleSpeed * 1.6 + m.ph);
      var tw = 0.28 + 0.72 * half * half;
      var sz = m.size * sc * (0.70 + 0.50 * tw);
      g.globalAlpha = L.moteAlpha * alpha * tw * (0.45 + o * 0.55);
      g.drawImage(this.pal[m.ci], x - sz, y - sz, sz * 2, sz * 2);
    }
    g.globalAlpha = 1;
  };

  /* 十字星芒：稀疏纯白，闪现一下即隐，是最细的一层高光 */
  Engine.prototype.drawGlints = function (flower, now, alpha, o) {
    var g = this.ctx, sc = flower.scale;
    var gl = flower.glints;
    if (!gl || !gl.length || o < 0.08) return;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 0.7;
    for (var i = 0; i < gl.length; i++) {
      var s = gl[i];
      var t = Math.max(0, Math.sin(now * L.twinkleSpeed * 1.15 + s.ph));
      var tw = t * t;
      if (tw < 0.06) continue;
      var x = flower.x + s.x * sc * (0.55 + o * 0.45);
      var y = flower.y + s.y * sc * (0.55 + o * 0.45);
      var len = L.glintLen * s.len * sc * tw;
      g.globalAlpha = L.glintAlpha * alpha * tw * o;
      g.beginPath();
      g.moveTo(x - len, y); g.lineTo(x + len, y);
      g.moveTo(x, y - len * 0.72); g.lineTo(x, y + len * 0.72);
      g.stroke();
      g.drawImage(this.pal[GLINT_I], x - 1.6, y - 1.6, 3.2, 3.2);
    }
    g.globalAlpha = 1;
  };

  Engine.prototype.drawSparks = function (now) {
    var g = this.ctx, pal = this.pal;
    g.globalCompositeOperation = 'lighter';
    var keep = [];
    for (var i = 0; i < this.sparks.length; i++) {
      var s = this.sparks[i];
      var age = now - s.born;
      if (age > R.sparkLifeMs) continue;
      s.px = s.x; s.py = s.y;
      s.vx *= 0.972; s.vy = s.vy * 0.972 + 0.022;
      s.x += s.vx; s.y += s.vy;
      var a = 1 - age / R.sparkLifeMs;
      /* 一道极细的流星拖影 */
      g.globalAlpha = a * 0.26;
      g.strokeStyle = rgba(C.spark, 1);
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(s.px, s.py);
      g.lineTo(s.x, s.y);
      g.stroke();
      g.globalAlpha = a * 1.0;
      g.drawImage(pal[s.color], s.x - s.size, s.y - s.size, s.size * 2, s.size * 2);
      keep.push(s);
    }
    this.sparks = keep;
    g.globalAlpha = 1;
  };

  Engine.prototype.reportFrame = function (ms) {
    if (!R.autoQuality) return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    if (this.frameTimes.length < 20) return;
    var sum = 0;
    for (var i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    var avg = sum / this.frameTimes.length;
    if (avg > R.targetFrameMs) this.quality = Math.max(R.minQuality, this.quality - 0.05);
    else if (avg < 15) this.quality = Math.min(1, this.quality + 0.02);
  };

  Y.Bloom = {
    create: function (canvas) { return new Engine(canvas); },
    rgba: rgba
  };
})(window);
