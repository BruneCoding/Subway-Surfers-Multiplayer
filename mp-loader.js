/* mp-loader.js - Poki14 minimal loading screen.
 * ONLY two elements, per the design brief: the game logo (centred, slightly
 * above the midpoint) and ONE thin progress bar underneath. The bar follows the
 * game's real boot progress: the inline LoadingBar in index.html forwards every
 * progress callback here (window.MPLoader.set), readiness is confirmed with
 * MP.ready(), and the screen fades out smoothly once the game is playable.
 * Nothing is faked to 100%. Exposes window.MPLoader {done, progress, finish()}. */
(function (W) {
  'use strict';
  if (W.MPLoader) return;
  var LD = W.MPLoader = { done: false, progress: 0, finish: function () { complete(true); }, set: setProgress };
  var prog = 0, progTarget = 0, readyAt = 0, finished = false, fading = false;
  var root = null, fill = null;
  var REDUCED = false;
  try { REDUCED = W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var CSS =
    '#mp-load{position:fixed;inset:0;z-index:200000;background:#0a0d14;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding-bottom:9vh;transition:opacity .55s ease}' +
    '#mp-load.out{opacity:0;pointer-events:none}' +
    '.mpl-logo{max-width:min(380px,78vw);max-height:180px;width:auto;height:auto;object-fit:contain;filter:drop-shadow(0 12px 32px rgba(0,0,0,.55))}' +
    '.mpl-bar{width:min(280px,70vw);height:4px;border-radius:3px;background:#1a2231;overflow:hidden}' +
    '.mpl-bar i{display:block;height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,#3e7bfa,#6fa0ff)}' +
    '@media (prefers-reduced-motion: reduce){#mp-load{transition:none}.mpl-bar i{transition:none}}';

  function mount() {
    if (!document.body) { setTimeout(mount, 30); return; }
    root = document.createElement('div');
    root.id = 'mp-load';
    var logo = (W.MP_CONFIG && W.MP_CONFIG.logo) || 'assets/preload/splash.webp';
    root.innerHTML = '<img class="mpl-logo" src="' + logo + '" alt="Subway Surfers Multiplayer">' +
      '<div class="mpl-bar"><i></i></div>';
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    document.body.appendChild(root);
    fill = root.querySelector('.mpl-bar i');
    // catch up with progress reported before we mounted
    var last = W.__MPL_LAST || null;
    if (last) progTarget = Math.max(progTarget, Math.min(1, last.ratio || 0));
    loop();
    pollReady();
    setTimeout(function () { complete(true); }, 90000);   // safety net (same as before)
  }

  // called by the game's LoadingBar with REAL ratios (pre-init ramp + asset loading)
  function setProgress(ratio, loadedRatio, total) {
    if (finished) return;
    if (!(ratio >= 0)) return;
    progTarget = Math.max(progTarget, Math.min(1, ratio));
  }

  function pollReady() {
    if (finished) return;
    try {
      if (!readyAt && W.MP && typeof W.MP.ready === 'function' && W.MP.ready()) readyAt = performance.now();
    } catch (e) {}
    if (readyAt && performance.now() - readyAt > 250) { complete(false); return; }
    setTimeout(pollReady, 200);
  }

  function complete(force) {
    if (finished || fading) return;
    progTarget = 1;
    fading = true;
    setTimeout(function () {
      if (!root) { finishNow(); return; }
      if (REDUCED) { finishNow(); return; }
      root.classList.add('out');
      setTimeout(finishNow, 600);
    }, 240);
  }
  function finishNow() {
    finished = true; LD.done = true;
    if (root && root.parentNode) { try { root.parentNode.removeChild(root); } catch (e) {} }
    try { W.dispatchEvent(new CustomEvent('mp-loader-done')); } catch (e) {}
  }

  function loop() {
    if (finished) return;
    requestAnimationFrame(loop);
    prog += (progTarget - prog) * (progTarget > prog ? 0.055 : 0.3);
    if (prog > 0.9985) prog = 1;
    LD.progress = prog;
    if (fill) fill.style.width = (prog * 100).toFixed(1) + '%';
  }

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})(window);
