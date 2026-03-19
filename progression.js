'use strict';

/*
 * ROCKETPULT — Progression Mode
 * ─────────────────────────────
 * Click the PROG button (top-right) to open the shop.
 * ACTIVATE to start progression mode, which boots the rocket with
 * weaker fuel & boost. Earn coins by scoring — spend them on upgrades.
 *
 * Coin formula:  coins per flight = floor( score_gain / 50 )
 * Platform multipliers work automatically because better landings
 * produce higher in-game scores → more coins.
 *
 * Upgrades take effect on the NEXT page reload (because the game
 * data is patched at load time via fetch intercept).
 */

(function () {

  /* ══════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════ */
  var STORE_KEY = 'rocketpult_prog_v1';

  function defaultState() {
    return { enabled: false, coins: 0, fuelLvl: 0, boostLvl: 0, lastBest: 0 };
  }

  function loadState() {
    try { return Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORE_KEY))); }
    catch (e) { return defaultState(); }
  }

  function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }

  var S = loadState();

  /* ══════════════════════════════════════════════
     UPGRADE TABLES
     Index 0 = progression base  |  Index 5 = normal / max
  ══════════════════════════════════════════════ */
  var FUEL  = { vals: [12, 15, 18, 22, 26, 30], costs: [0,  50, 150,  300,  600, 1000] };
  var BOOST = { vals: [16, 19, 22, 26, 29, 32], costs: [0,  75, 200,  400,  800, 1500] };
  var ROTAT = { vals: [64, 78, 92,105,118, 128] }; // rotation force, tracks boost level

  /* ══════════════════════════════════════════════
     DATA.JS PATCH  (fetch intercept)
     Runs BEFORE the game engine loads so the rocket
     starts with the correct stats for the current
     upgrade level.
  ══════════════════════════════════════════════ */
  if (S.enabled) {
    var _fetch = window.fetch;
    window.fetch = function (req, opts) {
      var url = typeof req === 'string' ? req : (req && req.url) || '';
      if (url.indexOf('data.js') !== -1) {
        return _fetch(req, opts)
          .then(function (r) { return r.text(); })
          .then(function (text) {
            var fv = FUEL.vals[S.fuelLvl];
            var bv = BOOST.vals[S.boostLvl];
            var rv = ROTAT.vals[S.boostLvl];
            // Replace the rocket's initial instance-variable block:
            //   [[maxFuel], [curFuel=0], [thrust], [rotation], [512], [64] …
            // Original values (normal mode): [[30],[0],[32],[128],[512],[64]
            text = text.replace(
              '[[30],[0],[32],[128],[512],[64]',
              '[[' + fv + '],[0],[' + bv + '],[' + rv + '],[512],[64]'
            );
            return new Response(text, { headers: { 'Content-Type': 'application/json' } });
          });
      }
      return _fetch(req, opts);
    };
  }

  /* ══════════════════════════════════════════════
     COIN TRACKING  (localStorage intercept)
     Fires when the game saves a new best score.
  ══════════════════════════════════════════════ */
  var _setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _setItem.call(this, key, value);
    if (S.enabled && key === 'BestScore') {
      var score = parseInt(value, 10) || 0;
      if (score > S.lastBest) {
        var gained = Math.max(1, Math.floor((score - S.lastBest) / 50));
        S.coins   += gained;
        S.lastBest = score;
        saveState();
        refreshHUD();
        showToast('+' + gained + ' COINS!');
      }
    }
  };

  /* ══════════════════════════════════════════════
     CSS
  ══════════════════════════════════════════════ */
  var CSS = [
    /* toggle button */
    '#rp-btn{position:fixed;top:10px;right:10px;z-index:9999;',
      'background:#0d0d0d;color:#555;font:bold 10px/1 monospace;',
      'letter-spacing:2px;text-transform:uppercase;padding:7px 11px;',
      'border:3px solid #3a3a3a;cursor:pointer;user-select:none;',
      'transition:color .15s,border-color .15s,box-shadow .15s;}',
    '#rp-btn.on{color:#f5a623;border-color:#f5a623;',
      'box-shadow:0 0 10px #f5a62366;}',

    /* coin HUD */
    '#rp-hud{position:fixed;top:44px;right:10px;z-index:9999;',
      'background:#0a0a0a;color:#f5a623;font:bold 9px/1 monospace;',
      'letter-spacing:1px;padding:5px 9px;border:2px solid #f5a623;}',

    /* shop overlay */
    '#rp-shop{position:fixed;top:50%;left:50%;',
      'transform:translate(-50%,-50%);z-index:10001;',
      'background:#0a0a0a;border:4px solid #f5a623;padding:22px;',
      'font-family:monospace;color:#ccc;min-width:300px;max-width:360px;',
      'box-shadow:0 0 60px #f5a62322;}',

    '#rp-shop h1{margin:0 0 4px;font-size:13px;color:#f5a623;',
      'letter-spacing:4px;text-align:center;}',
    '#rp-shop .sub{font-size:9px;text-align:center;',
      'letter-spacing:2px;margin-bottom:14px;}',
    '#rp-shop .card{border:2px solid #1e1e1e;padding:10px;margin-bottom:10px;}',
    '#rp-shop .card h2{margin:0 0 7px;font-size:10px;',
      'color:#888;letter-spacing:3px;}',
    '#rp-shop .pips{display:flex;gap:3px;margin-bottom:5px;}',
    '#rp-shop .pip{width:22px;height:10px;border:1px solid #2a2a2a;}',
    '#rp-shop .pip.f{background:#f5a623;}',
    '#rp-shop .pip.b{background:#44aaff;}',
    '#rp-shop .hint{font-size:8px;color:#555;margin-bottom:6px;}',
    '#rp-shop .upg{width:100%;padding:7px;font:bold 10px monospace;',
      'letter-spacing:2px;border:none;cursor:pointer;margin-top:4px;}',
    '#rp-shop .upg.af{background:#f5a623;color:#000;}',
    '#rp-shop .upg.ab{background:#44aaff;color:#000;}',
    '#rp-shop .upg.no{background:#141414;color:#3a3a3a;cursor:not-allowed;}',
    '#rp-shop .upg.mx{background:#141414;color:#f5a623;cursor:default;}',
    '#rp-shop .upg.mxb{background:#141414;color:#44aaff;cursor:default;}',
    '#rp-shop .platrow{display:flex;justify-content:space-between;',
      'font-size:9px;padding:2px 0;}',
    '#rp-shop .rrow{display:flex;gap:8px;}',
    '#rp-shop .rrow button{flex:1;padding:8px;font:bold 10px monospace;',
      'letter-spacing:2px;border:2px solid #333;cursor:pointer;}',

    /* toast */
    '.rp-toast{position:fixed;bottom:70px;right:14px;z-index:10002;',
      'background:#f5a623;color:#000;font:bold 11px monospace;',
      'letter-spacing:2px;padding:7px 14px;border:2px solid #000;',
      'pointer-events:none;animation:rpf 1.8s forwards;}',
    '@keyframes rpf{0%{opacity:1;transform:translateY(0)}',
      '100%{opacity:0;transform:translateY(-28px)}}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* ══════════════════════════════════════════════
     HUD HELPERS
  ══════════════════════════════════════════════ */
  function refreshHUD() {
    var btn = document.getElementById('rp-btn');
    var hud = document.getElementById('rp-hud');
    if (btn) {
      btn.textContent = S.enabled ? 'PROG ●' : 'PROG ○';
      btn.className   = S.enabled ? 'on' : '';
    }
    if (hud) {
      hud.textContent = '⬡ ' + S.coins;
      hud.style.display = S.enabled ? 'block' : 'none';
    }
    refreshShop();
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.className   = 'rp-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 1900);
  }

  /* ══════════════════════════════════════════════
     SHOP RENDER
  ══════════════════════════════════════════════ */
  function makePips(lvl, cls) {
    var out = '';
    for (var i = 0; i <= 5; i++) {
      out += '<div class="pip' + (i <= lvl ? ' ' + cls : '') + '"></div>';
    }
    return out;
  }

  function shopHTML() {
    var fl = S.fuelLvl, bl = S.boostLvl;
    var fc = fl < 5 ? FUEL.costs[fl + 1]  : null;
    var bc = bl < 5 ? BOOST.costs[bl + 1] : null;

    var fBtn = fc === null
      ? '<button class="upg mx" disabled>MAX LEVEL ✓</button>'
      : '<button class="upg ' + (S.coins >= fc ? 'af' : 'no') + '" onclick="window.__rpUpg(\'fuel\')">'
          + 'UPGRADE — ⬡' + fc + '</button>';

    var bBtn = bc === null
      ? '<button class="upg mxb" disabled>MAX LEVEL ✓</button>'
      : '<button class="upg ' + (S.coins >= bc ? 'ab' : 'no') + '" onclick="window.__rpUpg(\'boost\')">'
          + 'UPGRADE — ⬡' + bc + '</button>';

    var statusCol   = S.enabled ? '#27ae60' : '#555';
    var statusText  = S.enabled ? '● ACTIVE' : '○ INACTIVE';
    var toggleLabel = S.enabled ? 'DEACTIVATE' : 'ACTIVATE';
    var toggleStyle = S.enabled
      ? 'background:#922;color:#fff;border-color:#922'
      : 'background:#27ae60;color:#000;border-color:#27ae60';

    return ''
      + '<h1>PROGRESSION</h1>'
      + '<div class="sub" style="color:' + statusCol + '">'
          + statusText + ' &nbsp;|&nbsp; ⬡ ' + S.coins + ' COINS'
      + '</div>'

      /* platform info */
      + '<div class="card">'
        + '<h2>⬡ PLATFORM COIN MULTIPLIERS</h2>'
        + '<div class="platrow">'
            + '<span style="color:#cd7f32">▪ BRONZE &nbsp;(big platform)</span>'
            + '<span>×1.5 score bonus</span>'
        + '</div>'
        + '<div class="platrow">'
            + '<span style="color:#c0c0c0">▪ SILVER &nbsp;(gray platform)</span>'
            + '<span>×2.0 score bonus</span>'
        + '</div>'
        + '<div class="platrow">'
            + '<span style="color:#f5a623">▪ GOLD &nbsp;&nbsp;(gold platform)</span>'
            + '<span>×3.0 score bonus</span>'
        + '</div>'
        + '<div class="hint" style="margin-top:5px">'
            + 'Better landing = higher score = more coins (score ÷ 50)'
        + '</div>'
      + '</div>'

      /* fuel upgrade */
      + '<div class="card">'
        + '<h2>⛽ FUEL TANK — LVL ' + fl + '/5</h2>'
        + '<div class="pips">' + makePips(fl, 'f') + '</div>'
        + '<div class="hint">'
            + FUEL.vals[fl] + ' units'
            + (fl < 5 ? ' → ' + FUEL.vals[fl + 1] + ' units' : ' (full)')
        + '</div>'
        + fBtn
      + '</div>'

      /* boost upgrade */
      + '<div class="card">'
        + '<h2>🚀 BOOST POWER — LVL ' + bl + '/5</h2>'
        + '<div class="pips">' + makePips(bl, 'b') + '</div>'
        + '<div class="hint">'
            + 'Thrust ' + BOOST.vals[bl]
            + (bl < 5 ? ' → ' + BOOST.vals[bl + 1] : ' (full)')
        + '</div>'
        + bBtn
      + '</div>'

      /* action row */
      + '<div class="rrow">'
        + '<button onclick="window.__rpToggle()" style="' + toggleStyle + '">'
            + toggleLabel
        + '</button>'
        + '<button onclick="document.getElementById(\'rp-shop\').remove()" '
            + 'style="background:#0d0d0d;color:#555">CLOSE ✕</button>'
      + '</div>'

      + (S.enabled
          ? '<div style="font-size:8px;color:#444;margin-top:9px;'
              + 'text-align:center;letter-spacing:1px">'
              + 'CHANGES APPLY ON NEXT PAGE RELOAD'
            + '</div>'
          : '');
  }

  function openShop() {
    var ex = document.getElementById('rp-shop');
    if (ex) { ex.parentNode.removeChild(ex); return; }
    var el = document.createElement('div');
    el.id = 'rp-shop';
    el.innerHTML = shopHTML();
    document.body.appendChild(el);
  }

  function refreshShop() {
    var el = document.getElementById('rp-shop');
    if (el) el.innerHTML = shopHTML();
  }

  /* ══════════════════════════════════════════════
     GLOBAL CALLBACKS  (called from inline onclick)
  ══════════════════════════════════════════════ */
  window.__rpUpg = function (type) {
    if (type === 'fuel') {
      var next = S.fuelLvl + 1;
      if (next > 5 || S.coins < FUEL.costs[next]) return;
      S.coins -= FUEL.costs[next];
      S.fuelLvl = next;
    } else {
      var next = S.boostLvl + 1;
      if (next > 5 || S.coins < BOOST.costs[next]) return;
      S.coins -= BOOST.costs[next];
      S.boostLvl = next;
    }
    saveState();
    refreshHUD();
  };

  window.__rpToggle = function () {
    S.enabled = !S.enabled;
    saveState();
    location.reload();
  };

  /* ══════════════════════════════════════════════
     DOM INIT
  ══════════════════════════════════════════════ */
  function init() {
    var btn = document.createElement('div');
    btn.id          = 'rp-btn';
    btn.textContent = S.enabled ? 'PROG ●' : 'PROG ○';
    btn.className   = S.enabled ? 'on' : '';
    btn.addEventListener('click', openShop);

    var hud = document.createElement('div');
    hud.id            = 'rp-hud';
    hud.textContent   = '⬡ ' + S.coins;
    hud.style.display = S.enabled ? 'block' : 'none';

    document.body.appendChild(btn);
    document.body.appendChild(hud);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
