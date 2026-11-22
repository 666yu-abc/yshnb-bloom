/* ============================================================
 * 装配层：视图切换、主循环、HUD、事件绑定、降级提示
 * ============================================================ */
(function (global) {
  'use strict';

  var Y = global.YSHNB;
  var V = Y.CFG.vision;

  var el = {};
  var engine, gestures;
  var W = 1, H = 1;
  var running = false;
  var frameCount = 0;
  var lastLoopAt = 0;
  var fps = 0, fpsAt = 0, fpsFrames = 0;
  var camVisible = true;

  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    ['landing', 'stage', 'btn-start', 'btn-pointer', 'canvas', 'video',
     'skeleton', 'cam-wrap', 'hud-mode', 'hud-state', 'hud-open', 'hud-bar',
     'hud-fps', 'hud-hands', 'hud-label', 'status', 'btn-back', 'btn-cam',
     'btn-reset', 'btn-full', 'notice', 'notice-text', 'notice-btn',
     'notice-retry', 'load-note'].forEach(function (id) { el[id] = $(id); });
  }

  function setStatus(text, tone) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.dataset.tone = tone || 'info';
  }

  function showNotice(text, btnText, onClick, retryText, onRetry) {
    if (!el.notice) return;
    el['notice-text'].textContent = text;
    el['notice-btn'].textContent = btnText || '知道了';
    el['notice-btn'].onclick = function () {
      el.notice.hidden = true;
      if (onClick) onClick();
    };
    if (retryText && el['notice-retry']) {
      el['notice-retry'].textContent = retryText;
      el['notice-retry'].hidden = false;
      el['notice-retry'].onclick = function () {
        el.notice.hidden = true;
        if (onRetry) onRetry();
      };
    } else if (el['notice-retry']) {
      el['notice-retry'].hidden = true;
    }
    el.notice.hidden = false;
  }

  /* ---------- 视图 ---------- */
  function enterStage(mode) {
    el.landing.classList.add('is-gone');
    el.stage.classList.add('is-on');
    document.body.classList.add('in-stage');
    resize();
    if (!running) { running = true; requestAnimationFrame(loop); }
    if (mode === 'pointer') {
      Y.Hand.usePointer(W, H);
      camVisible = false;
      el['cam-wrap'].classList.add('is-hidden');
      el['btn-cam'].textContent = '显示画面';
      setStatus('鼠标模式：按住＝握拳，松开＝绽放，双击＝指尖生花', 'info');
    } else {
      camVisible = true;
      el['cam-wrap'].classList.remove('is-hidden');
      el['btn-cam'].textContent = '隐藏画面';
      setStatus('正在请求摄像头权限…', 'info');
      Y.Hand.startCamera(el.video, W, H).then(function (ok) {
        if (!ok) {
          Y.Hand.usePointer(W, H);
          camVisible = false;
          el['cam-wrap'].classList.add('is-hidden');
          el['btn-cam'].textContent = '显示画面';
          setStatus('已自动切换到鼠标模式，体验不受影响', 'warn');
        }
      });
    }
  }

  function leaveStage() {
    running = false;
    lastLoopAt = 0;
    Y.Hand.stopCamera();
    el.stage.classList.remove('is-on');
    el.landing.classList.remove('is-gone');
    document.body.classList.remove('in-stage');
    setStatus('', 'info');
  }

  function resize() {
    var rect = el.stage.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    if (engine) engine.resize(W, H);
    el.skeleton.width = 160;
    el.skeleton.height = 120;
  }

  /* ---------- 主循环 ---------- */
  function loop(now) {
    if (!running) return;
    var dt = lastLoopAt ? Math.min(now - lastLoopAt, 60) : 16;
    lastLoopAt = now;
    var frame = Y.Hand.update(now, W, H);
    var desc = gestures.update(frame, W, H);
    engine.handleEvents(desc.events, desc);
    engine.render(desc, frame, now);

    /* 摄像头小窗叠加骨架 */
    if (Y.Hand.mode === 'camera' && frame.hands.length && camVisible) {
      engine.drawSkeleton(el.skeleton.getContext('2d'), frame.hands[0], 160, 120);
    } else {
      el.skeleton.getContext('2d').clearRect(0, 0, 160, 120);
    }

    /* HUD */
    fpsFrames++;
    if (now - fpsAt > 600) {
      fps = Math.round(fpsFrames * 1000 / (now - fpsAt));
      fpsAt = now; fpsFrames = 0;
    }
    frameCount++;
    if (frameCount % 5 === 0) updateHud(desc);

    engine.reportFrame(dt);
    requestAnimationFrame(loop);
  }

  function updateHud(desc) {
    var stateMap = {
      BUD: '花苞', OPENING: '舒展中', BLOOM: '盛放',
      CLOSING: '收拢', IDLE: '静候'
    };
    el['hud-mode'].textContent = Y.Hand.mode === 'camera' ? '摄像头' : '鼠标';
    el['hud-state'].textContent = stateMap[desc.state] || desc.state;
    el['hud-open'].textContent = Math.round(desc.openness * 100) + '%';
    el['hud-bar'].style.width = (desc.openness * 100).toFixed(1) + '%';
    el['hud-hands'].textContent = desc.handCount + ' / 2';
    el['hud-fps'].textContent = fps + ' fps';
    el['hud-label'].textContent = desc.label || '';
    el['hud-label'].classList.toggle('show', !!desc.label);
  }

  /* ---------- 事件 ---------- */
  function bind() {
    el['btn-start'].addEventListener('click', function () { enterStage('camera'); });
    el['btn-pointer'].addEventListener('click', function () { enterStage('pointer'); });
    el['btn-back'].addEventListener('click', leaveStage);
    el['btn-reset'].addEventListener('click', function () {
      engine.flowers = {};
      engine.sparks = [];
      engine.wind = { x: 0, y: 0 };
      gestures = Y.Gestures.create();
      setStatus('已重置', 'info');
    });
    el['btn-cam'].addEventListener('click', function () {
      camVisible = !camVisible;
      el['cam-wrap'].classList.toggle('is-hidden', !camVisible);
      el['btn-cam'].textContent = camVisible ? '隐藏画面' : '显示画面';
    });
    el['btn-full'].addEventListener('click', function () {
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    });

    var cv = el.canvas;
    function pos(e) {
      var r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    cv.addEventListener('pointermove', function (e) {
      if (Y.Hand.mode !== 'pointer') return;
      var p = pos(e);
      Y.Hand.setPointer(p.x, p.y, W, H, null, performance.now());
    });
    cv.addEventListener('pointerdown', function (e) {
      if (Y.Hand.mode !== 'pointer') return;
      var p = pos(e);
      Y.Hand.setPointer(p.x, p.y, W, H, true, performance.now());
    });
    cv.addEventListener('pointerup', function (e) {
      if (Y.Hand.mode !== 'pointer') return;
      var p = pos(e);
      Y.Hand.setPointer(p.x, p.y, W, H, false, performance.now());
    });
    cv.addEventListener('dblclick', function (e) {
      if (Y.Hand.mode !== 'pointer') return;
      var p = pos(e);
      engine.addSparks(p.x, p.y, 30, 3);
      setStatus('指尖生花', 'info');
    });

    global.addEventListener('resize', function () { if (document.body.classList.contains('in-stage')) resize(); });
    global.addEventListener('keydown', function (e) {
      if (!document.body.classList.contains('in-stage')) return;
      if (e.key === 'Escape') leaveStage();
      if (e.key === 'r' || e.key === 'R') el['btn-reset'].click();
      if (e.key === 'm' || e.key === 'M') {
        if (Y.Hand.mode === 'camera') {
          Y.Hand.stopCamera(); Y.Hand.usePointer(W, H);
          camVisible = false;
          el['cam-wrap'].classList.add('is-hidden');
          el['btn-cam'].textContent = '显示画面';
          setStatus('已切换到鼠标模式', 'info');
        } else { setStatus('刷新页面可重新启用摄像头', 'info'); }
      }
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    cacheDom();
    engine = Y.Bloom.create(el.canvas);
    gestures = Y.Gestures.create();
    Y.Hand.init({
      onStatus: function (kind, detail) {
        var map = {
          model: '正在加载手势模型…（首次约 22 MB，请稍候）',
          ready: '摄像头已就绪 · 握拳收拢，张手绽放',
          denied: '摄像头权限被拒绝',
          nocamera: '没有找到摄像头',
          insecure: '当前环境不支持摄像头',
          modelfailed: '手势模型未能加载',
          pointer: '鼠标模式'
        };
        /* 失败时把真实原因放进状态栏，方便一眼看到卡在哪一步 */
        var text = (kind === 'modelfailed' && detail) ? detail : (map[kind] || detail || '');
        if (text.length > 76) text = text.slice(0, 76) + '…';
        setStatus(text, kind === 'ready' ? 'ok' : 'info');
        if (kind === 'denied') {
          showNotice('浏览器拒绝了摄像头访问。视频只在本机处理，不会上传或录制。你可以继续用鼠标完整体验，也可以在地址栏左侧把摄像头权限改为「允许」后刷新。', '用鼠标继续', function () {
            Y.Hand.usePointer(W, H);
          });
        } else if (kind === 'modelfailed') {
          var why = String(detail || '').replace(/^手势模型加载失败：/, '');
          showNotice(
            '手势识别模型没有加载成功' + (why ? '：' + why : '') +
            '。首次需下载约 22 MB 模型，可点「重试」再试一次；视频只在本机运算，也可以先用鼠标完整体验。',
            '用鼠标继续',
            function () { Y.Hand.usePointer(W, H); },
            '重试摄像头',
            function () {
              setStatus('正在重新加载手势模型…', 'info');
              Y.Hand.startCamera(el.video, W, H).then(function (ok) {
                if (ok) {
                  camVisible = true;
                  el['cam-wrap'].classList.remove('is-hidden');
                  el['btn-cam'].textContent = '隐藏画面';
                  setStatus('摄像头已就绪 · 握拳收拢，张手绽放', 'ok');
                } else {
                  setStatus('重试未成功，已保持鼠标模式', 'warn');
                  Y.Hand.usePointer(W, H);
                }
              });
            }
          );
        } else if (kind === 'nocamera' || kind === 'insecure') {
          showNotice('没有可用的摄像头（或当前不是 https / localhost）。已切换到鼠标模式。', '用鼠标继续', function () {
            Y.Hand.usePointer(W, H);
          });
        }
      }
    });
    bind();
    resize();

    /* 停留在开始页时后台预热三大件（bundle / 模型 / wasm），
     * 用户读说明的这几秒里就把约 22 MB 拉进 HTTP 缓存，
     * 进入体验页时 HandLandmarker 能直接命中，不必干等。 */
    if (global.fetch) {
      [V.modelPath,
       V.wasmPath + '/vision_wasm_internal.js',
       V.wasmPath + '/vision_wasm_internal.wasm',
       V.bundleUrl].forEach(function (u) {
        fetch(u).then(function (r) { return r.arrayBuffer(); }).catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})(window);
