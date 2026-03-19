'use strict';

/*
 * ROCKETPULT — Multiplayer System
 *
 * HOST: click MULTI → HOST → share the 4-letter code
 * JOIN: click MULTI → type code → JOIN
 * Host clicks ▶ START RACE to begin the countdown
 * After 5 seconds, rockets that get close enough bump each other
 */

(function () {

  /* ═══════════════════════════════════════════
     CONFIG
  ═══════════════════════════════════════════ */
  var PEER_PREFIX        = 'rktplt-';
  var BROADCAST_HZ       = 20;
  var COLLISION_DELAY_MS = 5000;
  var COLLISION_RADIUS   = 100;   // world units before bump triggers
  var MAX_PLAYERS        = 6;
  var STALE_MS           = 4000;  // drop player if no update for this long

  /* ═══════════════════════════════════════════
     PLAYER COLORS  (host = index 0)
  ═══════════════════════════════════════════ */
  var COLORS = ['#44aaff','#ff4444','#44ff88','#ffaa00','#ff44ff','#00ffff'];

  /* ═══════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════ */
  var peer              = null;
  var isHost            = false;
  var myCode            = null;
  var myId              = null;
  var myColorIdx        = 0;
  var myName            = 'P1';
  var connections       = {};   // peerId → PeerJS connection
  var players           = {};   // peerId → { x, y, angle, color, name, lastSeen }
  var connected         = false;
  var collisionActive   = false;
  var panelOpen         = false;
  var broadcastInterval = null;
  var overlayCanvas     = null;
  var overlayCtx        = null;

  /* ═══════════════════════════════════════════
     RUNTIME ACCESS  (Construct 2)
     We grab the runtime object so we can read
     the rocket's world position each frame.
  ═══════════════════════════════════════════ */
  var _runtimeCache = null;

  function findRuntime() {
    if (_runtimeCache) return _runtimeCache;
    // Check saved reference from start.js first
    if (window._rpRuntime) { _runtimeCache = window._rpRuntime; return _runtimeCache; }
    // Fallback: scan window for the Construct 2 runtime object
    try {
      var keys = Object.getOwnPropertyNames(window);
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = window[keys[i]];
          if (v && typeof v === 'object' &&
              v.types && v.running_layout && typeof v.tickcount === 'number') {
            _runtimeCache = v; return v;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  function getRocketData() {
    var rt = findRuntime();
    if (!rt) return null;
    try {
      var t = rt.types && rt.types['RocketSprite'];
      if (!t || !t.instances || !t.instances.length) return null;
      var inst = t.instances[0];
      return {
        x:     inst.x     || 0,
        y:     inst.y     || 0,
        angle: inst.angle || 0
      };
    } catch (e) { return null; }
  }

  // Convert world coordinates → screen pixels using Construct 2 camera
  function worldToScreen(wx, wy) {
    var rt = findRuntime();
    if (!rt || !rt.running_layout) return null;
    try {
      var layout = rt.running_layout;
      var layer  = null;
      if (layout.layers) {
        for (var i = 0; i < layout.layers.length; i++) {
          if (layout.layers[i].name === 'Gameplay') { layer = layout.layers[i]; break; }
        }
        if (!layer) layer = layout.layers[1] || layout.layers[0];
      }
      if (!layer) return null;
      var sx = (layer.scroll_x !== undefined ? layer.scroll_x : layer.scrollX) || 0;
      var sy = (layer.scroll_y !== undefined ? layer.scroll_y : layer.scrollY) || 0;
      var sc = layer.scale || 1;
      var cw = overlayCanvas ? overlayCanvas.width  : window.innerWidth;
      var ch = overlayCanvas ? overlayCanvas.height : window.innerHeight;
      return { x: (wx - sx) * sc + cw / 2, y: (wy - sy) * sc + ch / 2 };
    } catch (e) { return null; }
  }

  /* ═══════════════════════════════════════════
     COLLISION  (simulated via keyboard events)
  ═══════════════════════════════════════════ */
  var _lastBump = 0;

  function fireKey(keyName, keyCode, durationMs) {
    var opts = { key: keyName, code: keyName, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    var canvas = document.querySelector('canvas');
    if (canvas) canvas.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(function () {
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (canvas) canvas.dispatchEvent(new KeyboardEvent('keyup', opts));
    }, durationMs);
  }

  function bumpRocket() {
    var now = Date.now();
    if (now - _lastBump < 800) return; // debounce
    _lastBump = now;

    // Random combination of thrust + random rotation to feel like a real hit
    var picks = [
      function () { fireKey('ArrowUp', 38, 180); },
      function () { fireKey('ArrowLeft', 37, 200); },
      function () { fireKey('ArrowRight', 39, 200); }
    ];
    picks[Math.floor(Math.random() * picks.length)]();

    // Flash the screen red
    var fl = document.getElementById('rp-mp-flash');
    if (fl) {
      fl.style.opacity = '0.55';
      setTimeout(function () { if (fl) fl.style.opacity = '0'; }, 180);
    }
    showToast('💥 HIT!');
  }

  function checkCollisions() {
    if (!collisionActive) return;
    var me = getRocketData();
    if (!me) return;
    var now = Date.now();
    var ids = Object.keys(players);
    for (var i = 0; i < ids.length; i++) {
      var p = players[ids[i]];
      if (!p || now - p.lastSeen > STALE_MS) continue;
      var dx = me.x - p.x, dy = me.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < COLLISION_RADIUS) {
        bumpRocket();
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════
     COUNTDOWN / START
  ═══════════════════════════════════════════ */
  function startCollisionCountdown() {
    collisionActive = false;
    var cd = document.getElementById('rp-mp-countdown');
    var secs = Math.ceil(COLLISION_DELAY_MS / 1000);
    if (cd) { cd.style.display = 'block'; cd.textContent = 'COLLISION IN ' + secs + 's'; }

    var iv = setInterval(function () {
      secs--;
      if (cd) {
        if (secs > 0) { cd.textContent = 'COLLISION IN ' + secs + 's'; }
        else          { cd.style.display = 'none'; clearInterval(iv); }
      }
    }, 1000);

    setTimeout(function () {
      collisionActive = true;
      showToast('💥 COLLISION ACTIVE!');
    }, COLLISION_DELAY_MS);
  }

  /* ═══════════════════════════════════════════
     NETWORKING  (PeerJS)
  ═══════════════════════════════════════════ */
  function genCode() {
    var ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid confusion
    var s  = '';
    for (var i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
  }

  function sendToAll(obj) {
    var s = JSON.stringify(obj);
    Object.keys(connections).forEach(function (id) {
      try { connections[id].send(s); } catch (e) {}
    });
  }

  // Processes an incoming message.  senderId = the PeerJS peer ID of the sender.
  function handleMessage(senderId, raw) {
    var d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }

    if (d.type === 'pos') {
      // Actual position update (from host direct broadcast or relayed by host)
      var pid = d.playerId || senderId;
      if (!players[pid]) players[pid] = { color: d.color || '#fff', name: d.name || '?' };
      Object.assign(players[pid], { x: d.x, y: d.y, angle: d.angle, color: d.color, name: d.name, lastSeen: Date.now() });
      updateHUD();

    } else if (d.type === 'pos_relay' && isHost) {
      // A client is relaying its own position through us → forward to everyone else
      sendToAll({ type: 'pos', playerId: senderId, x: d.x, y: d.y, angle: d.angle, color: d.color, name: d.name });

    } else if (d.type === 'welcome') {
      myColorIdx = d.colorIdx;
      myName     = d.name;
      updateHUD();

    } else if (d.type === 'start') {
      startCollisionCountdown();
      showToast('RACE STARTED!');
      refreshPanel();

    } else if (d.type === 'snapshot') {
      // Host sends existing player list to a new joiner
      Object.keys(d.players).forEach(function (id) {
        if (id !== myId) players[id] = d.players[id];
      });
    }
  }

  function wireConn(conn) {
    var rid = conn.peer;
    connections[rid] = conn;
    conn.on('data',  function (r) { handleMessage(rid, r); });
    conn.on('close', function ()  { delete connections[rid]; delete players[rid]; updateHUD(); });
    conn.on('error', function (e) { console.warn('[MP]', e); });
  }

  /* ─── HOST ─────────────────────────────── */
  function hostLobby() {
    myCode = genCode();
    myId   = PEER_PREFIX + myCode.toLowerCase();
    isHost = true;
    myColorIdx = 0;
    myName = 'P1';

    peer = new Peer(myId, { debug: 0 });

    peer.on('open', function () {
      connected = true;
      showToast('LOBBY READY!');
      updateHUD();
      refreshPanel();
      startBroadcast();
    });

    peer.on('connection', function (conn) {
      if (Object.keys(connections).length >= MAX_PLAYERS - 1) { conn.close(); return; }
      conn.on('open', function () {
        var idx  = Object.keys(connections).length + 1;
        var name = 'P' + (idx + 1);
        wireConn(conn);

        // Tell the joiner their color + name
        conn.send(JSON.stringify({ type: 'welcome', colorIdx: idx % COLORS.length, name: name }));

        // Send them a snapshot of existing players
        conn.send(JSON.stringify({ type: 'snapshot', players: players }));

        players[conn.peer] = { color: COLORS[idx % COLORS.length], name: name, lastSeen: Date.now() };
        showToast(name + ' JOINED!');
        updateHUD();
        refreshPanel();
      });
    });

    peer.on('error', function (e) {
      if (e.type === 'unavailable-id') { peer.destroy(); hostLobby(); }
      else showToast('ERR: ' + e.type);
    });
  }

  /* ─── JOIN ─────────────────────────────── */
  function joinLobby(code) {
    isHost = false;
    peer   = new Peer({ debug: 0 });

    peer.on('open', function (id) {
      myId = id;
      var hostId = PEER_PREFIX + code.toLowerCase();
      var conn   = peer.connect(hostId, { reliable: false, serialization: 'raw' });

      conn.on('open', function () {
        wireConn(conn);
        connected = true;
        showToast('CONNECTED!');
        updateHUD();
        refreshPanel();
        startBroadcast();
      });
      conn.on('error', function () { showToast('JOIN FAILED — CHECK CODE'); });
    });

    peer.on('error', function (e) { showToast('ERR: ' + e.type); });
  }

  /* ─── DISCONNECT ───────────────────────── */
  function disconnect() {
    if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
    if (peer) { peer.destroy(); peer = null; }
    connections = {}; players = {};
    connected = false; isHost = false; myCode = null; collisionActive = false;
    updateHUD();
    refreshPanel();
  }

  /* ═══════════════════════════════════════════
     POSITION BROADCAST  (every 1/BROADCAST_HZ s)
  ═══════════════════════════════════════════ */
  function startBroadcast() {
    if (broadcastInterval) clearInterval(broadcastInterval);
    broadcastInterval = setInterval(function () {
      var r = getRocketData();
      if (!r) return;
      var msg = { type: isHost ? 'pos' : 'pos_relay',
                  playerId: myId,
                  x: r.x, y: r.y, angle: r.angle,
                  color: COLORS[myColorIdx], name: myName };
      sendToAll(msg);

      // Host also needs to broadcast its OWN position to all clients
      if (isHost) sendToAll(Object.assign({}, msg, { type: 'pos' }));

      checkCollisions();
      drawOverlay();
    }, 1000 / BROADCAST_HZ);
  }

  /* ═══════════════════════════════════════════
     OVERLAY CANVAS
  ═══════════════════════════════════════════ */
  function initOverlay() {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'rp-mp-overlay';
    overlayCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:9990;';
    document.body.appendChild(overlayCanvas);
    overlayCtx = overlayCanvas.getContext('2d');
    function resize() { overlayCanvas.width = window.innerWidth; overlayCanvas.height = window.innerHeight; }
    window.addEventListener('resize', resize);
    resize();
  }

  // Draw a simple pixelated rocket silhouette
  function drawGhost(ctx, sx, sy, angle, color) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle + Math.PI / 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(-5, 4);
    ctx.lineTo(-2, 2);
    ctx.lineTo(-2, 8);
    ctx.lineTo(2, 8);
    ctx.lineTo(2, 2);
    ctx.lineTo(5, 4);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawMinimap() {
    if (!overlayCtx) return;
    var ctx = overlayCtx;
    var cw  = overlayCanvas.width, ch = overlayCanvas.height;
    var pad = 8;
    var mw  = 90, mh = 80;
    var mx  = cw - mw - pad, my = ch - mh - pad - 40; // 40 = MULTI button height

    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.strokeStyle = '#225588';
    ctx.lineWidth   = 1;
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeRect(mx, my, mw, mh);

    ctx.fillStyle = '#225588';
    ctx.font      = '7px monospace';
    ctx.fillText('RADAR', mx + 3, my + 9);

    var me = getRocketData();
    var ox = me ? me.x : 0, oy = me ? me.y : 0;
    var sc = 0.025;
    var cx = mx + mw / 2, cy = my + mh / 2;

    // Me
    ctx.fillStyle   = COLORS[myColorIdx] || '#fff';
    ctx.shadowColor = COLORS[myColorIdx] || '#fff';
    ctx.shadowBlur  = 6;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = COLORS[myColorIdx] || '#fff';
    ctx.font        = 'bold 7px monospace';
    ctx.fillText(myName, cx + 5, cy + 3);

    // Others
    var now = Date.now();
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (!p || now - p.lastSeen > STALE_MS) return;
      var rx = Math.max(mx + 6, Math.min(mx + mw - 6, cx + (p.x - ox) * sc));
      var ry = Math.max(my + 12, Math.min(my + mh - 6, cy + (p.y - oy) * sc));
      ctx.fillStyle   = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur  = 5;
      ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur  = 0;
      ctx.fillStyle   = p.color;
      ctx.font        = 'bold 7px monospace';
      ctx.fillText(p.name || '?', rx + 4, ry + 3);
    });
  }

  function drawOverlay() {
    if (!overlayCtx || !overlayCanvas) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!connected || !Object.keys(players).length) return;

    var now = Date.now();

    // Ghost rockets at screen positions
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (!p || now - p.lastSeen > STALE_MS) return;
      var sp = worldToScreen(p.x, p.y);
      if (!sp) return;
      // Only draw if within ±200px of screen
      if (sp.x < -200 || sp.x > overlayCanvas.width + 200 || sp.y < -200 || sp.y > overlayCanvas.height + 200) return;

      drawGhost(overlayCtx, sp.x, sp.y, p.angle, p.color);

      // Name tag
      overlayCtx.fillStyle   = p.color;
      overlayCtx.font        = 'bold 9px monospace';
      overlayCtx.textAlign   = 'center';
      overlayCtx.shadowColor = p.color;
      overlayCtx.shadowBlur  = 6;
      overlayCtx.fillText(p.name || '?', sp.x, sp.y - 15);
      overlayCtx.shadowBlur  = 0;
      overlayCtx.textAlign   = 'left';

      // Collision warning ring
      if (collisionActive) {
        var me = getRocketData();
        if (me) {
          var dx = me.x - p.x, dy = me.y - p.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < COLLISION_RADIUS * 2) {
            var alpha = 1 - dist / (COLLISION_RADIUS * 2);
            overlayCtx.strokeStyle = 'rgba(255,68,68,' + alpha + ')';
            overlayCtx.lineWidth   = 1.5;
            overlayCtx.setLineDash([4, 4]);
            overlayCtx.beginPath();
            overlayCtx.arc(sp.x, sp.y, 30 + (1 - alpha) * 20, 0, Math.PI * 2);
            overlayCtx.stroke();
            overlayCtx.setLineDash([]);
          }
        }
      }
    });

    drawMinimap();
  }

  /* ═══════════════════════════════════════════
     UI  (CSS + panel)
  ═══════════════════════════════════════════ */
  var CSS = [
    /* MULTI button */
    '#rp-mp-btn{position:fixed;bottom:10px;right:10px;z-index:9999;',
      'background:#0d0d0d;color:#333;font:bold 10px/1 monospace;',
      'letter-spacing:2px;padding:9px 13px;border:3px solid #333;',
      'cursor:pointer;user-select:none;',
      'transition:color .15s,border-color .15s,box-shadow .15s;}',
    '#rp-mp-btn.on{color:#44aaff;border-color:#44aaff;',
      'box-shadow:0 0 12px #44aaff55;}',

    /* small HUD line above button */
    '#rp-mp-hud{position:fixed;bottom:48px;right:10px;z-index:9999;',
      'background:#080808;border:2px solid #44aaff;color:#44aaff;',
      'font:bold 8px monospace;letter-spacing:1px;padding:4px 8px;',
      'display:none;}',

    /* countdown overlay */
    '#rp-mp-countdown{position:fixed;top:44%;left:50%;',
      'transform:translate(-50%,-50%);z-index:9998;',
      'font:bold 22px monospace;color:#ff4444;letter-spacing:5px;',
      'text-shadow:0 0 24px #ff4444;pointer-events:none;display:none;}',

    /* red hit flash */
    '#rp-mp-flash{position:fixed;inset:0;background:#ff2200;',
      'opacity:0;pointer-events:none;z-index:9997;transition:opacity .12s;}',

    /* panel */
    '#rp-mp-panel{position:fixed;bottom:50px;right:10px;z-index:10000;',
      'background:#080808;border:3px solid #44aaff;padding:18px 16px;',
      'font-family:monospace;color:#ccc;width:255px;',
      'box-shadow:0 0 40px #44aaff22;}',
    '#rp-mp-panel h1{margin:0 0 10px;font-size:11px;color:#44aaff;',
      'letter-spacing:5px;text-align:center;}',
    '#rp-mp-panel .sub{font-size:8px;color:#445;',
      'letter-spacing:2px;text-align:center;margin-bottom:12px;}',
    '#rp-mp-panel .codebox{font-size:30px;font-weight:bold;',
      'color:#44aaff;letter-spacing:10px;text-align:center;',
      'border:2px solid #44aaff;padding:10px 4px;margin:8px 0;',
      'text-shadow:0 0 14px #44aaff;}',
    '#rp-mp-panel .hint{font-size:8px;color:#446;',
      'letter-spacing:1px;text-align:center;margin-bottom:10px;}',
    '#rp-mp-panel input{width:100%;box-sizing:border-box;',
      'background:#111;border:2px solid #44aaff;color:#44aaff;',
      'font:bold 24px monospace;letter-spacing:8px;',
      'text-align:center;padding:8px;margin-bottom:8px;',
      'text-transform:uppercase;outline:none;}',
    '#rp-mp-panel .row{display:flex;gap:6px;margin-top:6px;}',
    '#rp-mp-panel button{flex:1;padding:9px 4px;cursor:pointer;',
      'font:bold 9px monospace;letter-spacing:2px;border:2px solid;}',
    '.mp-b-host{background:#44aaff;color:#000;border-color:#44aaff !important;}',
    '.mp-b-join{background:#0a0a0a;color:#44aaff;border-color:#44aaff !important;}',
    '.mp-b-dim {background:#0d0d0d;color:#444;border-color:#222 !important;}',
    '.mp-b-go  {background:#27ae60;color:#000;border-color:#27ae60 !important;',
      'width:100%;padding:11px;margin-top:8px;letter-spacing:3px;}',

    /* player list */
    '.mp-plist{margin-top:10px;border-top:1px solid #111;padding-top:8px;}',
    '.mp-plist .title{font-size:8px;color:#334;letter-spacing:2px;margin-bottom:5px;}',
    '.mp-prow{display:flex;align-items:center;gap:7px;',
      'font-size:9px;letter-spacing:1px;padding:2px 0;}',
    '.mp-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}',

    /* toast */
    '.rp-toast{position:fixed;bottom:100px;right:12px;z-index:10002;',
      'background:#44aaff;color:#000;font:bold 10px monospace;',
      'letter-spacing:2px;padding:6px 12px;pointer-events:none;',
      'animation:rpt 2.2s forwards;}',
    '@keyframes rpt{0%{opacity:1;transform:translateY(0)}',
      '75%{opacity:1}100%{opacity:0;transform:translateY(-20px)}}',
  ].join('');

  /* ── UI Helpers ─────────────────────────── */
  function showToast(msg) {
    var t = document.createElement('div');
    t.className   = 'rp-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2300);
  }

  function updateHUD() {
    var btn = document.getElementById('rp-mp-btn');
    var hud = document.getElementById('rp-mp-hud');
    if (btn) btn.className = connected ? 'on' : '';
    if (hud) {
      hud.style.display = connected ? 'block' : 'none';
      hud.textContent   = myName + ' ▸ ' + (Object.keys(players).length + 1) + ' ONLINE';
    }
  }

  /* ── Panel HTML ─────────────────────────── */
  function playerListHTML() {
    var h = '<div class="mp-plist"><div class="title">IN LOBBY</div>'
          + '<div class="mp-prow">'
          +   '<div class="mp-dot" style="background:' + (COLORS[myColorIdx] || '#fff') + '"></div>'
          +   '<span>' + myName + ' (YOU)</span></div>';
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (!p) return;
      h += '<div class="mp-prow">'
         + '<div class="mp-dot" style="background:' + (p.color || '#aaa') + '"></div>'
         + '<span>' + (p.name || '?') + '</span></div>';
    });
    return h + '</div>';
  }

  function buildPanel() {
    if (!connected) {
      return '<h1>MULTIPLAYER</h1>'
        + '<div class="sub">HOST OR JOIN A LOBBY</div>'
        + '<div class="row">'
        +   '<button class="mp-b-host" onclick="window.__rpMpHost()">HOST</button>'
        +   '<button class="mp-b-dim"  onclick="window.__rpMpClose()">CLOSE ✕</button>'
        + '</div>'
        + '<div style="border-top:1px solid #111;margin:14px 0 10px">'
        +   '<div class="hint" style="margin-bottom:6px">JOIN A LOBBY</div>'
        +   '<input id="rp-join-inp" maxlength="4" placeholder="CODE" />'
        +   '<div class="row"><button class="mp-b-join" onclick="window.__rpMpJoin()">JOIN ▶</button></div>'
        + '</div>';
    }

    return '<h1>MULTIPLAYER</h1>'
      + (myCode
        ? '<div class="hint">SHARE THIS CODE</div><div class="codebox">' + myCode + '</div>'
        : '<div class="hint">CONNECTED TO HOST</div>')
      + playerListHTML()
      + (isHost
        ? '<button class="mp-b-go" onclick="window.__rpMpStart()">▶ START RACE</button>'
        : '')
      + '<div class="row" style="margin-top:10px">'
      +   '<button class="mp-b-dim" onclick="window.__rpMpClose()">CLOSE ✕</button>'
      +   '<button class="mp-b-dim" onclick="window.__rpMpLeave()">LEAVE</button>'
      + '</div>';
  }

  function refreshPanel() {
    var el = document.getElementById('rp-mp-panel');
    if (!el || !panelOpen) return;
    el.innerHTML = buildPanel();
    bindInputHandler();
  }

  function bindInputHandler() {
    var inp = document.getElementById('rp-join-inp');
    if (inp) inp.addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z]/g, '');
    });
  }

  /* ── Global callbacks (called from onclick) ─ */
  window.__rpMpHost  = function () {
    if (typeof Peer === 'undefined') { showToast('PEERJS NOT LOADED'); return; }
    hostLobby();
  };
  window.__rpMpJoin  = function () {
    if (typeof Peer === 'undefined') { showToast('PEERJS NOT LOADED'); return; }
    var inp  = document.getElementById('rp-join-inp');
    var code = inp ? inp.value.trim() : '';
    if (code.length !== 4) { showToast('NEED 4-LETTER CODE'); return; }
    joinLobby(code);
  };
  window.__rpMpStart = function () {
    if (!isHost) return;
    sendToAll({ type: 'start' });
    startCollisionCountdown();
    showToast('RACE STARTED!');
    refreshPanel();
  };
  window.__rpMpLeave = function () { disconnect(); window.__rpMpClose(); };
  window.__rpMpClose = function () {
    panelOpen = false;
    var el = document.getElementById('rp-mp-panel');
    if (el) el.remove();
  };

  /* ═══════════════════════════════════════════
     DOM INIT
  ═══════════════════════════════════════════ */
  function init() {
    // Inject CSS
    var sty = document.createElement('style');
    sty.textContent = CSS;
    document.head.appendChild(sty);

    // MULTI button
    var btn = document.createElement('div');
    btn.id        = 'rp-mp-btn';
    btn.textContent = 'MULTI';
    btn.addEventListener('click', function () {
      panelOpen = !panelOpen;
      var el = document.getElementById('rp-mp-panel');
      if (panelOpen) {
        if (!el) { el = document.createElement('div'); el.id = 'rp-mp-panel'; document.body.appendChild(el); }
        el.innerHTML = buildPanel();
        bindInputHandler();
      } else {
        if (el) el.remove();
      }
    });
    document.body.appendChild(btn);

    // HUD line
    var hud = document.createElement('div'); hud.id = 'rp-mp-hud'; document.body.appendChild(hud);

    // Countdown
    var cd = document.createElement('div'); cd.id = 'rp-mp-countdown'; document.body.appendChild(cd);

    // Flash
    var fl = document.createElement('div'); fl.id = 'rp-mp-flash'; document.body.appendChild(fl);

    initOverlay();

    // Refresh panel player list every second while open
    setInterval(function () {
      if (panelOpen && connected) refreshPanel();
      // Also purge stale players
      var now = Date.now();
      Object.keys(players).forEach(function (id) {
        if (players[id] && now - players[id].lastSeen > STALE_MS + 1000) delete players[id];
      });
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

}());
