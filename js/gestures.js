/* ============================================================
 * 手势 → 语义状态机
 * 把连续的 openness / pinch / velocity 变成「绽放、闭合、脉冲、
 * 新生花苞、风」等事件，并输出每帧的花朵描述子供渲染层消费。
 * 关键设计：所有阈值都带滞回或冷却，避免指尖轻微抖动导致闪烁；
 * 盛放与捏合都需要「持续确认」，单帧尖峰不会误触发事件。
 * ============================================================ */
(function (global) {
  'use strict';

  var Y = global.YSHNB;
  var G = Y.CFG.gesture;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function newHandState() {
    return {
      state: 'BUD',
      lowSince: 0, lowDuration: 0,
      bloomSince: 0, pinchSince: 0,
      lastPulseAt: -1e9, lastPinchAt: -1e9, lastSwipeAt: -1e9,
      pinchActive: false,
      x: 0.5, y: 0.5,                // 平滑后的花心（归一化）
      hasCenter: false,
      openness: 0
    };
  }

  function Engine() {
    this.hands = [newHandState(), newHandState()];
    this.buds = [];                 // 捏合生成的小花苞
    this.nextBudId = 100;
    this.primaryCount = 1;
    this.lastEvent = '';
    this.lastEventAt = 0;
  }

  Engine.prototype._label = function (text, now) {
    this.lastEvent = text;
    this.lastEventAt = now;
  };

  Engine.prototype._spawnBud = function (x, y, now) {
    if (this.buds.length >= 6) this.buds.shift();
    this.buds.push({
      id: this.nextBudId++, x: x, y: y, born: now,
      openness: 0, scale: 0.001, alpha: 0
    });
  };

  Engine.prototype.update = function (frame, W, H) {
    var now = frame.now;
    var out = {
      openness: 0, state: 'IDLE', handCount: 0,
      flowers: [], buds: [], pointer: null, events: [],
      label: ''
    };
    var rawHands = frame.hands || [];
    out.handCount = rawHands.length;

    /* ------ 逐只手：状态机 + 事件 ------ */
    for (var i = 0; i < 2; i++) {
      var hs = this.hands[i];
      var hand = rawHands[i];

      if (!hand) {
        /* 手丢了：缓缓闭合，不瞬间消失；同时复位捏合，回来可重新触发 */
        hs.openness = Math.max(0, hs.openness - G.idleCloseSpeed * 16);
        if (hs.openness < G.fistThreshold) hs.state = 'BUD';
        hs.bloomSince = 0; hs.pinchSince = 0;
        hs.pinchActive = false;
        continue;
      }

      var o = hand.openness;
      hs.openness = o;

      /* 花心跟随掌心，做一次位置平滑，跟手但不抖 */
      var nx = hand.center.x / W, ny = hand.center.y / H;
      if (!hs.hasCenter) { hs.x = nx; hs.y = ny; hs.hasCenter = true; }
      else { hs.x += (nx - hs.x) * 0.16; hs.y += (ny - hs.y) * 0.16; }

      /* 状态机（滞回 + 盛放时间确认：单帧尖峰不会误判盛放） */
      if (hs.state === 'BLOOM') {
        if (o < G.bloomThreshold - G.hysteresis) {
          hs.state = 'CLOSING'; hs.bloomSince = 0;
        }
      } else if (o > G.bloomThreshold + G.hysteresis) {
        if (!hs.bloomSince) hs.bloomSince = now;
        hs.state = (now - hs.bloomSince >= G.bloomConfirmMs) ? 'BLOOM' : 'OPENING';
      } else {
        hs.bloomSince = 0;
        hs.state = (o > G.fistThreshold + G.hysteresis) ? 'OPENING' : 'BUD';
      }

      /* 记录「低位停留」，用于识别「握紧 → 猛地张开」 */
      if (o < G.fistThreshold) {
        if (!hs.lowSince) hs.lowSince = now;
        hs.lowDuration = now - hs.lowSince;
      } else if (o > G.bloomThreshold) {
        if (hs.lowSince && hs.lowDuration >= G.fistHoldMs &&
            (now - (hs.lowSince + hs.lowDuration)) <= G.fastOpenMs &&
            (now - hs.lastPulseAt) > G.pulseCooldownMs) {
          out.events.push({ type: 'pulse', x: hand.center.x, y: hand.center.y, hand: i });
          hs.lastPulseAt = now;
          this._label('绽放', now);
        }
        hs.lowSince = 0; hs.lowDuration = 0;
      }

      /* 捏合 → 指尖生出一朵新花苞。
       * pinchEligible / pinchClose 由识别层给出，已排除握拳姿态；
       * 这里再要求持续 pinchHoldMs，避免快握快放的瞬时误触。 */
      var pc = hand.pinchClose || 0;
      var eligible = !!hand.pinchEligible;
      if (!hs.pinchActive && eligible && pc > G.pinchOn) {
        if (!hs.pinchSince) hs.pinchSince = now;
        if ((now - hs.pinchSince) >= G.pinchHoldMs &&
            (now - hs.lastPinchAt) > G.pinchCooldownMs) {
          hs.pinchActive = true;
          hs.lastPinchAt = now;
          hs.pinchSince = 0;
          this._spawnBud(hand.tip.x / W, hand.tip.y / H, now);
          out.events.push({ type: 'newbud', x: hand.tip.x, y: hand.tip.y, hand: i });
          this._label('指尖生花', now);
        }
      } else {
        hs.pinchSince = 0;
        /* 松开（或不再满足捏合姿态）才复位，下一次捏合才能重新触发 */
        if (hs.pinchActive && (!eligible || pc < G.pinchOff)) hs.pinchActive = false;
      }

      /* 快速挥手 → 一阵风 */
      var sp = Math.sqrt(hand.velocity.x * hand.velocity.x + hand.velocity.y * hand.velocity.y);
      if (sp > G.swipeSpeed && (now - hs.lastSwipeAt) > G.swipeCooldownMs) {
        hs.lastSwipeAt = now;
        out.events.push({
          type: 'gust', x: hand.velocity.x, y: hand.velocity.y,
          vx: Math.sign(hand.velocity.x), vy: Math.sign(hand.velocity.y)
        });
        this._label('一阵风', now);
      }

      out.state = hs.state;
      out.openness = Math.max(out.openness, o);
      out.flowers.push({
        id: i, kind: 'primary', x: hs.x, y: hs.y,
        openness: o, scale: 1, alpha: 1, seed: i * 17.3
      });
    }

    /* pointer 模式透传 pulse 事件：补上花心坐标，火花才不会画到无效位置 */
    (frame.events || []).forEach(function (e) {
      if (e.type === 'pulse' && e.x == null) {
        var hp = this.hands[0];
        e.x = (hp.hasCenter ? hp.x : 0.5) * W;
        e.y = (hp.hasCenter ? hp.y : 0.52) * H;
      }
      out.events.push(e);
      if (e.type === 'pulse') this._label('绽放', now);
    }, this);

    /* 一只手也没有：保留上一朵主花，慢慢合拢 */
    if (!out.flowers.length) {
      var h0 = this.hands[0];
      out.flowers.push({
        id: 0, kind: 'primary', x: h0.hasCenter ? h0.x : 0.5,
        y: h0.hasCenter ? h0.y : 0.52,
        openness: h0.openness, scale: 1, alpha: 1, seed: 0
      });
      out.state = h0.openness < G.fistThreshold ? 'BUD' : 'CLOSING';
      if (now - frame.lastSeenAt > G.lostHandMs) out.state = 'IDLE';
    }

    /* 小花苞随时间长大、盛放、再静静淡去 */
    var keep = [];
    for (var b = 0; b < this.buds.length; b++) {
      var bud = this.buds[b];
      var age = now - bud.born;
      var grow = clamp(age / 1400, 0, 1);
      var fade = age > 5200 ? clamp(1 - (age - 5200) / 1800, 0, 1) : 1;
      bud.openness = 1 - Math.pow(1 - grow, 3);
      bud.scale = 0.34 * (0.35 + 0.65 * grow);
      bud.alpha = fade;
      if (fade > 0) {
        keep.push(bud);
        out.buds.push({
          id: bud.id, kind: 'bud', x: bud.x, y: bud.y,
          openness: bud.openness, scale: bud.scale, alpha: bud.alpha, seed: bud.id
        });
      }
    }
    this.buds = keep;

    if (frame.pointer) out.pointer = frame.pointer;
    /* 沉浸模式：不再向画面输出「绽放 / 指尖生花 / 一阵风」这类手势字幕。
     * 事件与状态机照常运行，只是不把文字贴到花上。 */
    out.label = '';
    return out;
  };

  Y.Gestures = { create: function () { return new Engine(); } };
})(window);
