"use strict";

(function () {

  /* =============================================
     CONSTANTS
  ============================================= */
  var PEER_PREFIX        = "rktplt2-";
  var BROADCAST_HZ       = 15;
  var COLLISION_DELAY_MS = 5000;
  var COLLISION_RADIUS   = 80;
  var MAX_PLAYERS        = 8;
  var STALE_MS           = 3000;
  var START_X            = 320;
  var START_Y            = 630;
  var LAUNCH_THRESH      = 8;
  var RESET_THRESH       = 200;
  var GAME_W             = 1920;
  var GAME_H             = 1080;

  var COLORS = ["#44aaff","#ff4444","#44ff88","#ffaa00","#cc66ff","#ff88cc","#00ffee","#ffee00"];

  /* =============================================
     STATE
  ============================================= */
  var peer          = null;
  var isHost        = false;
  var myCode        = null;
  var myId          = null;
  var myColorIdx    = 0;
  var myName        = "P1";
  var connections   = {};
  var players       = {};

  var settings = { mode: "sandbox", collision: "simple", timeLimit: 60 };

  var connected         = false;
  var raceStarted       = false;
  var raceEndTime       = 0;
  var raceEnded         = false;
  var panelOpen         = false;
  var broadcastIv       = null;
  var raceTimerIv       = null;

  var myLaunched        = false;
  var myDead            = false;
  var myCollisionActive = false;
  var myCollisionTimer  = null;
  var myLastPos         = null;
  var myBestDist        = 0;
  var lastBumpTime      = 0;

  var overlayEl  = null;
  var overlayCtx = null;

  /* =============================================
     RUNTIME ACCESS
  ============================================= */
  var _rt = null;

  function findRuntime() {
    if (_rt) return _rt;
    if (window._rpRuntime) return (_rt = window._rpRuntime);
    try {
      var keys = Object.getOwnPropertyNames(window);
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = window[keys[i]];
          if (v && typeof v === "object" && v.types &&
              v.running_layout && typeof v.tickcount === "number") {
            return (_rt = v);
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  function getRocketPos() {
    var rt = findRuntime();
    if (!rt) return null;
    try {
      var t = rt.types["RocketSprite"];
      if (!t || !t.instances || !t.instances.length) return null;
      var inst = t.instances[0];
      return { x: inst.x || 0, y: inst.y || 0, angle: inst.angle || 0 };
    } catch (e) { return null; }
  }

  /* =============================================
     WORLD TO SCREEN
     C2 camera always follows my rocket, so my
     rocket = screen centre. Only need the offset
     between other players and me, scaled by ppu.
  ============================================= */
  var _gameCanvas = null;

  function getGameCanvas() {
    if (_gameCanvas && _gameCanvas.id !== "rp-overlay") return _gameCanvas;
    var all = document.querySelectorAll("canvas");
    for (var i = 0; i < all.length; i++) {
      if (all[i].id !== "rp-overlay") { _gameCanvas = all[i]; return _gameCanvas; }
    }
    return null;
  }

  // World-to-screen using C2's actual internal camera properties.
  // From C2 source: running_layout.scrollX/Y = world coord of screen centre,
  // running_layout.scale = C2 zoom, runtime.aspect_scale = window resize scale.
  // These are set directly by the ScrollTo behavior every tick.
  function getC2Camera() {
    var rt = findRuntime();
    if (!rt || !rt.running_layout) return null;
    var layout = rt.running_layout;
    try {
      var cx   = typeof layout.scrollX === "number" ? layout.scrollX : null;
      var cy   = typeof layout.scrollY === "number" ? layout.scrollY : null;
      var zoom = typeof layout.scale   === "number" ? layout.scale   : 1;
      var aspect = (rt.aspect_scale && rt.aspect_scale > 0) ? rt.aspect_scale : 1;
      if (cx === null) return null;
      return { cx: cx, cy: cy, zoom: zoom, aspect: aspect,
               drawW: rt.draw_width || GAME_W, drawH: rt.draw_height || GAME_H };
    } catch (e) {}
    return null;
  }

  function worldToScreen(wx, wy) {
    var cam = getC2Camera();
    if (!cam) return null;

    // ppu (canvas pixels per world unit) = zoom * aspect_scale
    var ppuCanvas = cam.zoom * cam.aspect;

    // CSS pixels per canvas pixel (canvas may be stretched to fill window)
    var canvas = getGameCanvas();
    var cssPerCanvas = canvas ? (canvas.getBoundingClientRect().width / cam.drawW) : 1;

    var ppu = ppuCanvas * cssPerCanvas;

    // Screen-space centre of the game canvas
    var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var screenCX = rect.left + rect.width  / 2;
    var screenCY = rect.top  + rect.height / 2;

    return {
      x: screenCX + (wx - cam.cx) * ppu,
      y: screenCY + (wy - cam.cy) * ppu
    };
  }

  /* =============================================
     LAUNCH / DEATH DETECTION
  ============================================= */
  function checkMyState(pos) {
    if (!pos) return;
    var ds = Math.sqrt(Math.pow(pos.x - START_X, 2) + Math.pow(pos.y - START_Y, 2));
    if (myLaunched && ds < RESET_THRESH) { onMyDeath(); return; }
    if (!myLaunched && myLastPos) {
      var mv = Math.sqrt(Math.pow(pos.x - myLastPos.x, 2) + Math.pow(pos.y - myLastPos.y, 2));
      if (mv > LAUNCH_THRESH && ds > RESET_THRESH) onMyLaunch();
    }
    if (myLaunched) {
      var d = Math.abs(pos.x - START_X);
      if (d > myBestDist) myBestDist = d;
    }
    myLastPos = { x: pos.x, y: pos.y };
  }

  function onMyLaunch() {
    if (myLaunched) return;
    myLaunched = true; myDead = false; myCollisionActive = false;
    if (myCollisionTimer) clearTimeout(myCollisionTimer);
    if (raceStarted && settings.collision !== "off") {
      myCollisionTimer = setTimeout(function () {
        if (myLaunched && !myDead) { myCollisionActive = true; showToast("COLLISION ON!"); }
      }, COLLISION_DELAY_MS);
    }
    broadcast({ type: "launch" });
    updateHUD();
  }

  function onMyDeath() {
    myLaunched = false; myDead = true; myCollisionActive = false;
    if (myCollisionTimer) { clearTimeout(myCollisionTimer); myCollisionTimer = null; }
    myLastPos = null;
    broadcast({ type: "death" });
    updateHUD();
  }

  /* =============================================
     COLLISION
  ============================================= */
  // Get the Box2D physics body from the rocket's Physics behavior instance.
  // C2 stores behavior instances on inst.behavior_insts[].body
  function getRocketPhysicsBody() {
    var rt = findRuntime();
    if (!rt) return null;
    try {
      var t = rt.types["RocketSprite"];
      if (!t || !t.instances || !t.instances.length) return null;
      var inst = t.instances[0];
      if (!inst.behavior_insts) return null;
      for (var i = 0; i < inst.behavior_insts.length; i++) {
        var b = inst.behavior_insts[i];
        if (b && b.body) return b.body;
      }
    } catch (e) {}
    return null;
  }

  function checkCollisions() {
    if (!myCollisionActive || settings.collision === "off") return;
    var me = getRocketPos();
    if (!me) return;
    var now = Date.now();
    var ids = Object.keys(players);
    for (var i = 0; i < ids.length; i++) {
      var p = players[ids[i]];
      if (!p || !p.launched || p.dead || now - (p.lastSeen || 0) > STALE_MS) continue;
      var dx = me.x - p.x, dy = me.y - p.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < COLLISION_RADIUS) {
        resolveCollision(dx, dy, dist);
        return;
      }
    }
  }

  // C2 Box2D worldScale = 0.02 (pixels to meters)
  var BOX2D_SCALE = 0.02;

  function resolveCollision(dx, dy, dist) {
    // Collision normal: unit vector pointing FROM other rocket TO me
    var len = dist < 0.001 ? 1 : dist;
    var nx = dx / len, ny = dy / len;

    if (settings.collision === "simple") {
      // Simple: fixed-strength impulse along the normal
      doPhysicsImpulse(nx * 8, ny * 8);
      hitFlash(); showToast("HIT!");

    } else {
      // Full: apply an impulse directly to the Box2D body in the
      // direction away from the other rocket. Strength based on overlap.
      var overlap = Math.max(4, COLLISION_RADIUS - dist);
      var strength = 0.5 + overlap * 0.04;  // impulse in Box2D units (1 unit ~= 50px/s)
      var body = getRocketPhysicsBody();
      if (body) {
        try {
          // ApplyLinearImpulse(force_vec, point_vec, wake)
          // Box2D world scale = 0.02 (worldScale in c2runtime.js)
          // Impulse vec in Box2D units = direction * strength
          var tmpA = new b2Vec2(nx * strength, ny * strength);
          // Apply at body centre
          var pos = body.GetWorldCenter();
          body.ApplyLinearImpulse(tmpA, pos, true);
        } catch (e) {
          doPhysicsImpulse(nx * 8, ny * 8);
        }
      } else {
        doPhysicsImpulse(nx * 8, ny * 8);
      }
      hitFlash();
      showToast("COLLISION!");
    }
  }

  // Apply impulse via keyboard shortcuts (fallback / simple mode)
  function doPhysicsImpulse(ix, iy) {
    // Convert impulse direction to the closest key press
    var absX = Math.abs(ix), absY = Math.abs(iy);
    if (absY > absX && iy < 0) {
      pressKey("ArrowUp", 38, 220);
    } else if (ix > 0) {
      pressKey("ArrowRight", 39, 220);
    } else {
      pressKey("ArrowLeft", 37, 220);
    }
  }

  function pressKey(name, code, ms) {
    var opts = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true };
    var canvas = getGameCanvas();
    [document, canvas].forEach(function (el) {
      if (!el) return;
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      setTimeout(function () { el.dispatchEvent(new KeyboardEvent("keyup", opts)); }, ms);
    });
  }

  function hitFlash() {
    var fl = document.getElementById("rp-flash");
    if (fl) { fl.style.opacity = "0.5"; setTimeout(function () { fl.style.opacity = "0"; }, 160); }
  }

  /* =============================================
     RACE TIMER
  ============================================= */
  function startRaceTimer() {
    if (raceTimerIv) clearInterval(raceTimerIv);
    raceEndTime = Date.now() + settings.timeLimit * 1000;
    raceTimerIv = setInterval(function () {
      var rem = Math.max(0, raceEndTime - Date.now());
      var el = document.getElementById("rp-timer");
      if (el) { el.textContent = fmtTime(rem); el.style.color = rem < 10000 ? "#ff4444" : "#44aaff"; }
      if (rem <= 0) { clearInterval(raceTimerIv); endRace(); }
    }, 250);
  }

  function fmtTime(ms) {
    var s = Math.ceil(ms / 1000), m = Math.floor(s / 60); s = s % 60;
    return (m > 0 ? m + ":" : "") + (s < 10 ? "0" : "") + s;
  }

  function endRace() {
    raceEnded = true;
    var results = [{ name: myName, dist: Math.round(myBestDist), color: COLORS[myColorIdx] }];
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (p) results.push({ name: p.name, dist: Math.round(p.bestDist || 0), color: p.color });
    });
    results.sort(function (a, b) { return b.dist - a.dist; });
    showResults(results);
  }

  function showResults(results) {
    var ex = document.getElementById("rp-results");
    if (ex) ex.remove();
    var d = document.createElement("div");
    d.id = "rp-results";
    var rows = results.map(function (r, i) {
      return "<div class='rp-res-row'><span style='color:" + r.color + "'>#" + (i + 1) + " " + r.name + "</span><span>" + r.dist + "u</span></div>";
    }).join("");
    d.innerHTML = "<div class='rp-res-title'>RESULTS</div>" + rows + "<button class='rp-res-close' onclick='document.getElementById(\"rp-results\").remove()'>CLOSE</button>";
    document.body.appendChild(d);
  }

  /* =============================================
     NETWORKING
  ============================================= */
  function genCode() {
    var ch = "ABCDEFGHJKLMNPQRSTUVWXY", s = ""; // no Z (slows game), no I/O (look alike)
    for (var i = 0; i < 4; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
  }

  function sendToAll(obj, excludeId) {
    var s = JSON.stringify(obj);
    Object.keys(connections).forEach(function (id) {
      if (id === excludeId) return;
      try { connections[id].send(s); } catch (e) {}
    });
  }

  function broadcast(obj) {
    obj.playerId = myId;
    sendToAll(obj);
  }

  function handleMessage(senderId, raw) {
    var d;
    try { d = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (d.playerId === myId) return;
    var pid = d.playerId || senderId;

    if (d.type === "pos") {
      if (pid === myId) return;
      if (!players[pid]) players[pid] = { color: d.color || "#fff", name: d.name || "?", launched: false, dead: false, bestDist: 0 };
      var p = players[pid];
      p.x = d.x; p.y = d.y; p.angle = d.angle;
      p.color = d.color; p.name = d.name;
      p.bestDist = Math.max(p.bestDist || 0, d.bestDist || 0);
      p.launched = d.launched; p.dead = d.dead;
      p.lastSeen = Date.now();
      if (isHost) sendToAll(d, senderId);

    } else if (d.type === "launch") {
      if (players[pid]) { players[pid].launched = true; players[pid].dead = false; }
    } else if (d.type === "death") {
      if (players[pid]) {
        // Spawn explosion at last known position before marking dead
        if (players[pid].x !== undefined) spawnExplosion(players[pid].x, players[pid].y, players[pid].color || "#ff4444");
        players[pid].dead = true; players[pid].launched = false;
      }
    } else if (d.type === "welcome") {
      myColorIdx = d.colorIdx; myName = d.name;
      settings = Object.assign(settings, d.settings || {});
      if (d.players) {
        Object.keys(d.players).forEach(function (id) {
          if (id !== myId) players[id] = d.players[id];
        });
      }
      updateHUD(); refreshPanel();
    } else if (d.type === "start") {
      settings = Object.assign(settings, d.settings || {});
      raceStarted = true; onRaceStart();
    } else if (d.type === "settings_update") {
      settings = Object.assign(settings, d.settings || {});
      refreshPanel();
    } else if (d.type === "end_session") {
      raceEnded = true; raceStarted = false;
      endRace(); refreshPanel();
      showToast("HOST ENDED SESSION");
    }
  }

  function wireConn(conn) {
    var rid = conn.peer;
    connections[rid] = conn;
    conn.on("data",  function (r) { handleMessage(rid, r); });
    conn.on("close", function ()  { delete connections[rid]; delete players[rid]; updateHUD(); refreshPanel(); });
    conn.on("error", function (e) { console.warn("[MP]", e); });
  }

  function hostLobby() {
    myCode = genCode(); myId = PEER_PREFIX + myCode.toLowerCase();
    isHost = true; myColorIdx = 0; myName = "P1";
    peer = new Peer(myId, { debug: 0 });
    peer.on("open", function () {
      connected = true; showToast("LOBBY READY!"); updateHUD(); refreshPanel(); startBroadcast();
    });
    peer.on("connection", function (conn) {
      if (Object.keys(connections).length >= MAX_PLAYERS - 1) { conn.close(); return; }
      conn.on("open", function () {
        var idx = Object.keys(connections).length + 1;
        var name = "P" + (idx + 1);
        wireConn(conn);
        conn.send(JSON.stringify({ type: "welcome", colorIdx: idx % COLORS.length, name: name, settings: settings, players: players }));
        players[conn.peer] = { color: COLORS[idx % COLORS.length], name: name, launched: false, dead: false, bestDist: 0, lastSeen: Date.now() };
        showToast(name + " JOINED!"); updateHUD(); refreshPanel();
      });
    });
    peer.on("error", function (e) {
      if (e.type === "unavailable-id") { peer.destroy(); peer = null; hostLobby(); }
      else showToast("ERR: " + e.type);
    });
  }

  function joinLobby(code) {
    isHost = false; peer = new Peer({ debug: 0 });
    peer.on("open", function (id) {
      myId = id;
      var conn = peer.connect(PEER_PREFIX + code.toLowerCase(), { reliable: false, serialization: "raw" });
      conn.on("open", function () { wireConn(conn); connected = true; showToast("JOINED!"); updateHUD(); refreshPanel(); startBroadcast(); });
      conn.on("error", function () { showToast("FAILED — CHECK CODE"); });
    });
    peer.on("error", function (e) { showToast("ERR: " + e.type); });
  }

  function disconnect() {
    if (broadcastIv)      { clearInterval(broadcastIv);     broadcastIv = null; }
    if (raceTimerIv)      { clearInterval(raceTimerIv);     raceTimerIv = null; }
    if (myCollisionTimer) { clearTimeout(myCollisionTimer); myCollisionTimer = null; }
    if (peer)             { peer.destroy(); peer = null; }
    connections = {}; players = {};
    connected = false; isHost = false; myCode = null;
    raceStarted = false; raceEnded = false;
    myLaunched = false; myDead = false; myCollisionActive = false;
    myBestDist = 0; myLastPos = null;
    var el = document.getElementById("rp-timer");
    if (el) el.style.display = "none";
    updateHUD(); refreshPanel();
  }

  /* =============================================
     BROADCAST LOOP
  ============================================= */
  function startBroadcast() {
    if (broadcastIv) clearInterval(broadcastIv);
    broadcastIv = setInterval(function () {
      var pos = getRocketPos();
      checkMyState(pos);
      if (pos) {
        broadcast({ type: "pos", x: pos.x, y: pos.y, angle: pos.angle,
                    color: COLORS[myColorIdx], name: myName,
                    launched: myLaunched, dead: myDead, bestDist: myBestDist });
      }
      checkCollisions();
      drawOverlay();
    }, 1000 / BROADCAST_HZ);
  }

  function onRaceStart() {
    raceStarted = true; raceEnded = false; myBestDist = 0;
    if (settings.mode === "race") {
      var el = document.getElementById("rp-timer");
      if (el) { el.style.display = "block"; el.style.color = "#44aaff"; }
      startRaceTimer();
    }
    refreshPanel();
    showToast(settings.mode === "race" ? "RACE STARTED!" : "SANDBOX STARTED!");
  }

  /* =============================================
     OVERLAY CANVAS
  ============================================= */
  function initOverlay() {
    overlayEl = document.createElement("canvas");
    overlayEl.id = "rp-overlay";
    overlayEl.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9990;";
    document.body.appendChild(overlayEl);
    overlayCtx = overlayEl.getContext("2d");
    function resize() { overlayEl.width = window.innerWidth; overlayEl.height = window.innerHeight; }
    window.addEventListener("resize", resize); resize();
  }

  // Draws a fixed-screen-size rocket ghost (always 24px tall regardless of zoom)
  function drawGhost(ctx, sx, sy, angleDeg, color, label) {
    // glow dot — always visible even if off-screen-edge
    ctx.save();
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.restore();

    // rocket body — FIXED pixel size, independent of world scale
    ctx.save();
    ctx.translate(sx, sy);
    // C2 angle 0=right, 90=down, clockwise, degrees.
    // Shape points UP (-Y). Subtract 90° to align.
    ctx.rotate((angleDeg - 90) * Math.PI / 180);

    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.fillStyle = color;
    // Fixed 22px tall rocket shape
    ctx.fillRect(-5, -14, 10, 22);          // fuselage
    ctx.beginPath();                         // nose cone
    ctx.moveTo(0, -22); ctx.lineTo(-5, -14); ctx.lineTo(5, -14);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();                         // left fin
    ctx.moveTo(-5, 4); ctx.lineTo(-10, 12); ctx.lineTo(-5, 8);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();                         // right fin
    ctx.moveTo(5, 4); ctx.lineTo(10, 12); ctx.lineTo(5, 8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(-3, 8, 6, 5);              // nozzle
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(-2, -10, 4, 10);           // stripe
    ctx.shadowBlur = 0; ctx.restore();

    // name label above
    ctx.save();
    ctx.font = "bold 11px monospace"; ctx.textAlign = "center";
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.fillText(label, sx, sy - 30);
    ctx.shadowBlur = 0; ctx.restore();
  }

  // Explosion particle system for remote player deaths
  var explosions = []; // { x, y, color, t, maxT }

  function spawnExplosion(wx, wy, color) {
    var sp = worldToScreen(wx, wy);
    if (!sp) return;
    explosions.push({ wx: wx, wy: wy, color: color, t: 0, maxT: 45 });
  }

  function drawExplosions() {
    if (!overlayCtx || explosions.length === 0) return;
    var ctx = overlayCtx;
    var alive = [];
    for (var i = 0; i < explosions.length; i++) {
      var e = explosions[i];
      e.t++;
      var sp = worldToScreen(e.wx, e.wy);
      if (!sp) { alive.push(e); continue; }
      var progress = e.t / e.maxT;           // 0→1
      if (progress >= 1) continue;           // expired, drop it
      alive.push(e);

      var alpha  = 1 - progress;
      var radius = 10 + progress * 60;

      // outer ring
      ctx.save();
      ctx.strokeStyle = "rgba(255,180,0," + alpha + ")";
      ctx.lineWidth   = 3 * (1 - progress);
      ctx.shadowColor = "rgba(255,100,0," + alpha + ")";
      ctx.shadowBlur  = 20;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2); ctx.stroke();

      // inner flash
      if (progress < 0.3) {
        ctx.fillStyle = "rgba(255,255,200," + (1 - progress / 0.3) * 0.8 + ")";
        ctx.beginPath(); ctx.arc(sp.x, sp.y, radius * 0.4, 0, Math.PI * 2); ctx.fill();
      }

      // 8 spark lines
      ctx.strokeStyle = e.color;
      ctx.lineWidth   = 2;
      ctx.shadowBlur  = 8;
      for (var s = 0; s < 8; s++) {
        var ang  = (s / 8) * Math.PI * 2;
        var len  = progress * 50;
        ctx.beginPath();
        ctx.moveTo(sp.x + Math.cos(ang) * radius * 0.3,
                   sp.y + Math.sin(ang) * radius * 0.3);
        ctx.lineTo(sp.x + Math.cos(ang) * (radius * 0.3 + len),
                   sp.y + Math.sin(ang) * (radius * 0.3 + len));
        ctx.stroke();
      }
      ctx.shadowBlur = 0; ctx.restore();
    }
    explosions = alive;
  }

  function drawMinimap() {
    if (!overlayCtx) return;
    var ctx = overlayCtx;
    var cw = overlayEl.width, ch = overlayEl.height;
    var mw = 90, mh = 76, pad = 10;
    var mx = cw - mw - pad, my = ch - mh - pad - 44;
    ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.strokeStyle = "#225588"; ctx.lineWidth = 1;
    ctx.fillRect(mx, my, mw, mh); ctx.strokeRect(mx, my, mw, mh);
    ctx.fillStyle = "#225588"; ctx.font = "7px monospace"; ctx.fillText("RADAR", mx + 3, my + 9);
    var me = getRocketPos() || { x: 0, y: 0 };
    var sc = 0.025, cx = mx + mw / 2, cy = my + mh / 2;
    var myCol = COLORS[myColorIdx] || "#fff";
    ctx.fillStyle = myCol; ctx.shadowColor = myCol; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = myCol; ctx.font = "bold 7px monospace";
    ctx.fillText(myName, cx + 5, cy + 3);
    var now = Date.now();
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (!p || now - (p.lastSeen || 0) > STALE_MS) return;
      var rx = Math.max(mx + 5, Math.min(mx + mw - 5, cx + (p.x - me.x) * sc));
      var ry = Math.max(my + 12, Math.min(my + mh - 5, cy + (p.y - me.y) * sc));
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = p.color; ctx.font = "bold 7px monospace";
      ctx.fillText(p.name || "?", rx + 4, ry + 3);
    });
  }

  function drawOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
    if (!connected) return;
    var now = Date.now();
    Object.keys(players).forEach(function (id) {
      var p = players[id];
      if (!p || now - (p.lastSeen || 0) > STALE_MS) return;

      // Dead players: show explosion, then nothing
      if (p.dead) return; // explosion already spawned on death message

      var sp = worldToScreen(p.x, p.y);
      if (!sp) return;
      if (sp.x < -260 || sp.x > overlayEl.width + 260 || sp.y < -260 || sp.y > overlayEl.height + 260) return;

      drawGhost(overlayCtx, sp.x, sp.y, p.angle || 0, p.color, p.name || "?");

      // Collision proximity ring (only when collision active and not off)
      if (myCollisionActive && p.launched && settings.collision !== "off") {
        var me = getRocketPos();
        if (me) {
          var dx = me.x - p.x, dy = me.y - p.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < COLLISION_RADIUS * 2.5) {
            var alpha = Math.max(0, 1 - dist / (COLLISION_RADIUS * 2.5));
            overlayCtx.strokeStyle = "rgba(255,68,68," + alpha + ")";
            overlayCtx.lineWidth = 1.5; overlayCtx.setLineDash([4, 4]);
            overlayCtx.beginPath(); overlayCtx.arc(sp.x, sp.y, 28, 0, Math.PI * 2); overlayCtx.stroke();
            overlayCtx.setLineDash([]);
          }
        }
      }
    });
    drawExplosions();
    drawMinimap();
  }

  /* =============================================
     HUD
  ============================================= */
  function updateHUD() {
    var btn = document.getElementById("rp-mp-btn");
    var hud = document.getElementById("rp-hud");
    if (btn) btn.className = connected ? "on" : "";
    if (hud) {
      hud.style.display = connected ? "block" : "none";
      var status = myLaunched ? "FLYING" : myDead ? "DEAD" : "READY";
      hud.textContent = myName + "  " + status + "  (" + (Object.keys(players).length + 1) + " online)";
    }
  }

  /* =============================================
     PANEL HTML
     All onclick values use double-quotes inside
     single-quoted JS strings — no escaping needed.
  ============================================= */
  function playerListHTML() {
    var h = "<div class='rp-plist'>";
    h += "<div class='rp-prow'><span class='rp-dot' style='background:" + COLORS[myColorIdx] + "'></span>"
       + "<span>" + myName + " (YOU)" + (myLaunched ? " >" : myDead ? " X" : "") + "</span></div>";
    var now = Date.now();
    Object.keys(players).forEach(function (id) {
      var p = players[id]; if (!p) return;
      var stale = now - (p.lastSeen || 0) > STALE_MS;
      h += "<div class='rp-prow'>"
         + "<span class='rp-dot' style='background:" + (stale ? "#333" : p.color) + "'></span>"
         + "<span style='color:" + (stale ? "#333" : "#ccc") + "'>" + (p.name || "?")
         + (p.launched ? " >" : p.dead ? " X" : "") + "</span></div>";
    });
    return h + "</div>";
  }

  function modeBtn(val, label, current) {
    var active = current === val ? " active" : "";
    return "<button class='rp-mode-btn" + active + "' onclick='window.__rpSetMode(\"" + val + "\")'>" + label + "</button>";
  }
  function tlBtn(val, current) {
    var active = current === val ? " active" : "";
    return "<button class='rp-tl-btn" + active + "' onclick='window.__rpSetTL(" + val + ")'>" + val + "s</button>";
  }
  function colBtn(val, label, current) {
    var active = current === val ? " active" : "";
    return "<button class='rp-col-btn" + active + "' onclick='window.__rpSetCol(\"" + val + "\")'>" + label + "</button>";
  }

  function hostSettingsHTML() {
    var s = settings;
    var modesRow = "<div class='rp-set-row'><span>MODE</span><div class='rp-btn-group'>"
                 + modeBtn("sandbox", "SANDBOX", s.mode)
                 + modeBtn("race", "RACE", s.mode)
                 + "</div></div>";
    var tlRow = s.mode === "race"
      ? "<div class='rp-set-row'><span>TIME</span><div class='rp-btn-group'>"
        + tlBtn(30, s.timeLimit) + tlBtn(60, s.timeLimit) + tlBtn(90, s.timeLimit) + tlBtn(120, s.timeLimit)
        + "</div></div>"
      : "";
    var colRow = "<div class='rp-set-row'><span>COLLISION</span><div class='rp-btn-group'>"
               + colBtn("off",    "OFF",    s.collision)
               + colBtn("simple", "SIMPLE", s.collision)
               + colBtn("full",   "FULL",   s.collision)
               + "</div></div>";
    return "<div class='rp-settings'>" + modesRow + tlRow + colRow + "</div>";
  }

  function buildPanel() {
    if (!connected) {
      return "<h1>MULTIPLAYER</h1>"
           + "<div class='rp-sub'>HOST OR JOIN A LOBBY</div>"
           + "<button class='rp-btn-main' onclick='window.__rpHost()'>HOST LOBBY</button>"
           + "<div class='rp-divider'>OR JOIN</div>"
           + "<input id='rp-join-inp' maxlength='4' placeholder='CODE' autocomplete='off'/>"
           + "<button class='rp-btn-sec' onclick='window.__rpJoin()'>JOIN</button>"
           + "<button class='rp-btn-dim' onclick='window.__rpClose()'>CLOSE</button>";
    }
    var startBtn = "";
    if (isHost && !raceStarted)            startBtn = "<button class='rp-btn-go' onclick='window.__rpStart()'>START</button>";
    else if (raceStarted && isHost)        startBtn = "<button class='rp-btn-end' onclick='window.__rpEndSession()'>END SESSION</button>";
    else if (raceStarted)                  startBtn = "<div class='rp-tag-active'>ACTIVE</div>";

    return "<h1>MULTIPLAYER</h1>"
         + (myCode ? "<div class='rp-codebox'>" + myCode + "</div><div class='rp-sub'>SHARE CODE</div>" : "")
         + (isHost && !raceStarted ? hostSettingsHTML() : "")
         + playerListHTML()
         + startBtn
         + "<div class='rp-btm-row'>"
         + "<button class='rp-btn-dim' onclick='window.__rpClose()'>CLOSE</button>"
         + "<button class='rp-btn-dim' onclick='window.__rpLeave()'>LEAVE</button>"
         + "</div>";
  }

  function refreshPanel() {
    var el = document.getElementById("rp-panel");
    if (el && panelOpen) { el.innerHTML = buildPanel(); bindInput(); }
  }

  function bindInput() {
    var inp = document.getElementById("rp-join-inp"); if (!inp) return;
    inp.addEventListener("input", function () { this.value = this.value.toUpperCase().replace(/[^A-Z]/g, ""); });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") window.__rpJoin(); });
  }

  function showToast(msg) {
    var t = document.createElement("div"); t.className = "rp-toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
  }

  /* =============================================
     GLOBAL CALLBACKS
  ============================================= */
  window.__rpHost       = function () { if (typeof Peer === "undefined") { showToast("PEERJS NOT LOADED"); return; } hostLobby(); };
  window.__rpJoin       = function () {
    if (typeof Peer === "undefined") { showToast("PEERJS NOT LOADED"); return; }
    var inp = document.getElementById("rp-join-inp");
    var code = inp ? inp.value.trim() : "";
    if (code.length !== 4) { showToast("NEED 4-LETTER CODE"); return; }
    joinLobby(code);
  };
  window.__rpStart      = function () { if (!isHost) return; sendToAll({ type: "start", settings: settings }); onRaceStart(); };
  window.__rpEndSession = function () {
    if (!isHost) return;
    raceEnded = true; raceStarted = false;
    sendToAll({ type: "end_session" });
    endRace(); refreshPanel();
  };
  window.__rpLeave      = function () { disconnect(); window.__rpClose(); };
  window.__rpClose      = function () { panelOpen = false; var el = document.getElementById("rp-panel"); if (el) el.remove(); };
  window.__rpSetMode    = function (m) { if (!isHost) return; settings.mode = m;      sendToAll({ type: "settings_update", settings: settings }); refreshPanel(); };
  window.__rpSetTL      = function (t) { if (!isHost) return; settings.timeLimit = t; sendToAll({ type: "settings_update", settings: settings }); refreshPanel(); };
  window.__rpSetCol     = function (m) { if (!isHost) return; settings.collision = m; sendToAll({ type: "settings_update", settings: settings }); refreshPanel(); };

  /* =============================================
     CSS
  ============================================= */
  var CSS = [
    "#rp-mp-btn{position:fixed;bottom:10px;right:10px;z-index:9999;background:#0d0d0d;color:#334;font:bold 10px/1 monospace;letter-spacing:2px;padding:9px 13px;border:3px solid #334;cursor:pointer;user-select:none;}",
    "#rp-mp-btn.on{color:#44aaff;border-color:#44aaff;box-shadow:0 0 10px #44aaff44;}",
    "#rp-hud{position:fixed;bottom:50px;right:10px;z-index:9999;background:#080808;border:2px solid #44aaff;color:#44aaff;font:bold 8px monospace;letter-spacing:1px;padding:3px 7px;display:none;}",
    "#rp-timer{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;font:bold 22px monospace;color:#44aaff;text-shadow:0 0 18px #44aaff;letter-spacing:4px;display:none;}",
    "#rp-flash{position:fixed;inset:0;background:#ff2200;opacity:0;pointer-events:none;z-index:9997;transition:opacity .1s;}",
    "#rp-results{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;background:#080808;border:3px solid #ffaa00;padding:20px;font-family:monospace;min-width:220px;}",
    ".rp-res-title{font-size:12px;color:#ffaa00;letter-spacing:5px;text-align:center;margin-bottom:12px;}",
    ".rp-res-row{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #111;}",
    ".rp-res-close{width:100%;margin-top:12px;padding:8px;cursor:pointer;background:#ffaa00;color:#000;font:bold 9px monospace;letter-spacing:2px;border:none;}",
    "#rp-panel{position:fixed;bottom:50px;right:10px;z-index:10000;background:#080808;border:3px solid #44aaff;padding:16px;font-family:monospace;color:#ccc;width:240px;box-shadow:0 0 40px #44aaff22;}",
    "#rp-panel h1{margin:0 0 6px;font-size:11px;color:#44aaff;letter-spacing:5px;text-align:center;}",
    ".rp-sub{font-size:8px;color:#335;letter-spacing:2px;text-align:center;margin-bottom:10px;}",
    ".rp-divider{font-size:8px;color:#224;letter-spacing:2px;text-align:center;margin:10px 0 8px;border-top:1px solid #111;padding-top:10px;}",
    ".rp-codebox{font-size:28px;font-weight:bold;color:#44aaff;letter-spacing:10px;text-align:center;border:2px solid #44aaff;padding:8px 4px;margin-bottom:6px;text-shadow:0 0 12px #44aaff;}",
    "#rp-panel input{width:100%;box-sizing:border-box;background:#111;border:2px solid #44aaff;color:#44aaff;font:bold 22px monospace;letter-spacing:8px;text-align:center;padding:7px;text-transform:uppercase;outline:none;display:block;margin-bottom:6px;}",
    ".rp-btn-main,.rp-btn-sec,.rp-btn-dim,.rp-btn-go,.rp-btn-end{width:100%;padding:9px;cursor:pointer;font:bold 9px monospace;letter-spacing:2px;border:2px solid;display:block;margin-bottom:6px;text-align:center;}",
    ".rp-btn-main{background:#44aaff;color:#000;border-color:#44aaff;}",
    ".rp-btn-sec{background:#0a0a0a;color:#44aaff;border-color:#44aaff;}",
    ".rp-btn-dim{background:#0d0d0d;color:#334;border-color:#222;}",
    ".rp-btn-go{background:#27ae60;color:#000;border-color:#27ae60;font-size:11px;padding:11px;letter-spacing:4px;margin-top:8px;}",
    ".rp-btn-end{background:#ff4444;color:#fff;border-color:#ff4444;margin-top:8px;}",
    ".rp-tag-active{font-size:9px;color:#27ae60;letter-spacing:2px;text-align:center;padding:8px;border:1px solid #27ae60;margin-top:8px;}",
    ".rp-btm-row{display:flex;gap:6px;margin-top:8px;}",
    ".rp-btm-row button{flex:1;}",
    ".rp-settings{margin-bottom:8px;border:1px solid #111;padding:8px;}",
    ".rp-set-row{display:flex;align-items:center;justify-content:space-between;font-size:8px;color:#446;letter-spacing:1px;margin-bottom:5px;}",
    ".rp-btn-group{display:flex;gap:3px;}",
    ".rp-mode-btn,.rp-tl-btn,.rp-col-btn{padding:4px 7px;cursor:pointer;font:bold 8px monospace;letter-spacing:1px;background:#0d0d0d;color:#334;border:1px solid #222;}",
    ".rp-mode-btn.active,.rp-tl-btn.active{background:#44aaff;color:#000;border-color:#44aaff;}",
    ".rp-col-btn.active{background:#ff4444;color:#fff;border-color:#ff4444;}",
    ".rp-plist{border-top:1px solid #111;padding-top:8px;margin-bottom:6px;}",
    ".rp-prow{display:flex;align-items:center;gap:7px;font-size:9px;letter-spacing:1px;padding:2px 0;}",
    ".rp-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;display:inline-block;}",
    ".rp-toast{position:fixed;bottom:100px;right:12px;z-index:10002;background:#44aaff;color:#000;font:bold 9px monospace;letter-spacing:2px;padding:5px 12px;pointer-events:none;animation:rpt 2.2s forwards;}",
    "@keyframes rpt{0%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(-16px)}}"
  ].join("");

  /* =============================================
     INIT
  ============================================= */
  function init() {
    var sty = document.createElement("style"); sty.textContent = CSS; document.head.appendChild(sty);

    var btn = document.createElement("div"); btn.id = "rp-mp-btn"; btn.textContent = "MULTI";
    btn.addEventListener("click", function () {
      panelOpen = !panelOpen;
      var el = document.getElementById("rp-panel");
      if (panelOpen) {
        if (!el) { el = document.createElement("div"); el.id = "rp-panel"; document.body.appendChild(el); }
        el.innerHTML = buildPanel(); bindInput();
      } else if (el) { el.remove(); }
    });
    document.body.appendChild(btn);

    var hud = document.createElement("div"); hud.id = "rp-hud"; document.body.appendChild(hud);
    var tmr = document.createElement("div"); tmr.id = "rp-timer"; document.body.appendChild(tmr);
    var fl  = document.createElement("div"); fl.id  = "rp-flash"; document.body.appendChild(fl);

    initOverlay();

    setInterval(function () {
      updateHUD();
      if (panelOpen && connected) refreshPanel();
      var now = Date.now();
      Object.keys(players).forEach(function (id) {
        if (players[id] && now - (players[id].lastSeen || 0) > STALE_MS + 2000) delete players[id];
      });
    }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

}());
