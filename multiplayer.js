"use strict";

// ROCKETPULT MULTIPLAYER — v14
var MP_VERSION = "v14";

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
  var myStillSince      = 0;   // timestamp when rocket last had significant movement
  var myExploding       = false; // true while C2 explosion particles are active

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

    // Death: rocket snapped back near catapult (player pressed reset)
    if (myLaunched && ds < RESET_THRESH) { onMyDeath(); return; }

    // Launch: moved significantly away from catapult
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
    myLaunched = true; myDead = false; myCollisionActive = false; myStillSince = 0;
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

  // Watch RocketFlightStatusText — C2 sets it to "Too Fast" or "Tipped Over"
  // ONLY when the real explosion fires (OnRocketTooFast / OnRocketTippedOver events).
  // Water splash, landing, out-of-fuel etc all use different status strings.
  var myLastStatus = "";
  function checkMyExplosion() {
    var rt = findRuntime();
    if (!rt) return;
    try {
      var t = rt.types["RocketFlightStatusText"];
      if (!t || !t.instances || !t.instances.length) return;
      var statusText = t.instances[0].text || "";
      var isExploding = (statusText === "Too Fast" || statusText === "Tipped Over");
      if (isExploding && !myExploding) {
        myExploding = true;
        var pos = getRocketPos();
        if (pos) broadcast({ type: "explode", x: pos.x, y: pos.y });
      }
      if (!isExploding) myExploding = false;
      myLastStatus = statusText;
    } catch(e) {}
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
      if (d.launched) p.exploding = false;  // clear on relaunch
      if (isHost) sendToAll(d, senderId);

    } else if (d.type === "launch") {
      if (players[pid]) { players[pid].launched = true; players[pid].dead = false; }
    } else if (d.type === "death") {
      if (players[pid]) {
        players[pid].dead = true; players[pid].launched = false;
      }
    } else if (d.type === "explode") {
      spawnExplosion(d.x, d.y);
      if (players[pid]) { players[pid].exploding = true; players[pid].dead = true; players[pid].launched = false; }
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

  // PeerJS config with multiple STUN servers so at least one works through
  // most school/work firewalls. Falls back gracefully if WebRTC is blocked.
  // Explicit PeerJS server config — MUST be the same for host and joiner
  // regardless of which site they load the game from (Netlify vs GitHub).
  // Using PeerJS's own cloud server with explicit host/port/path.
  var PEER_CFG = {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    debug: 0,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
        { urls: "stun:stun.cloudflare.com:3478" }
      ]
    }
  };

  function makePeer(id) {
    var opts = JSON.parse(JSON.stringify(PEER_CFG));
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  function hostLobby() {
    myCode = genCode(); myId = PEER_PREFIX + myCode.toLowerCase();
    isHost = true; myColorIdx = 0; myName = "P1";

    peer = makePeer(myId);
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
      else if (e.type === "network") {
        showToast("NETWORK BLOCKED — TRY DIFFERENT WIFI");
        peer.destroy(); peer = null; connected = false; updateHUD(); refreshPanel();
      }
      else showToast("ERR: " + e.type);
    });
    peer.on("disconnected", function () {
      if (connected) { showToast("RECONNECTING..."); try { peer.reconnect(); } catch(e) {} }
    });
  }

  function joinLobby(code) {
    isHost = false;
    var targetId = PEER_PREFIX + code.toLowerCase();

    showToast("CONNECTING...");
    peer = makePeer(null);

    // If PeerJS signaling server unreachable after 12s
    var openTimer = setTimeout(function () {
      if (!connected) {
        showToast("CANT REACH SERVER — CHECK INTERNET");
        if (peer) { peer.destroy(); peer = null; }
        refreshPanel();
      }
    }, 12000);

    peer.on("open", function (id) {
      clearTimeout(openTimer);
      myId = id;
      showToast("SERVER OK — FINDING HOST...");
      var conn = peer.connect(targetId, { reliable: true });

      // ICE negotiation can take up to 20s on restricted networks
      var connTimer = setTimeout(function () {
        if (!connected) {
          showToast("HOST UNREACHABLE — HOST MAY HAVE LEFT");
          if (peer) { peer.destroy(); peer = null; }
          refreshPanel();
        }
      }, 20000);

      conn.on("open", function () {
        clearTimeout(connTimer);
        wireConn(conn); connected = true;
        showToast("JOINED!"); updateHUD(); refreshPanel(); startBroadcast();
      });
      conn.on("error", function (e) {
        clearTimeout(connTimer);
        showToast("CONN ERR — " + (e && e.type ? e.type : "UNKNOWN"));
      });
    });

    peer.on("error", function (e) {
      clearTimeout(openTimer);
      if (e.type === "network" || e.type === "server-error") {
        showToast("NETWORK BLOCKED — TRY DIFFERENT NETWORK");
      } else if (e.type === "peer-unavailable") {
        // Host ID not on server — they may be on a different session
        showToast("HOST NOT FOUND — MAKE SURE HOST CLICKED START");
      } else if (e.type === "unavailable-id") {
        showToast("ID TAKEN — RETRYING");
      } else {
        showToast("ERR: " + e.type);
      }
      if (peer) { peer.destroy(); peer = null; }
      refreshPanel();
    });

    peer.on("disconnected", function () {
      if (connected) { try { peer.reconnect(); } catch(e) {} }
    });
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
      checkMyExplosion();
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

  // Ghost rocket matching actual single-player sprite.
  // Body: gray #424242, stripe: pink #E91E63, nose: dark #212121
  // Outer fins are drawn in the player's color (different from the inner body).
  function drawGhost(ctx, sx, sy, angleRad, color, label) {
    // Glow dot — always visible position indicator
    ctx.save();
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.restore();

    // Rocket body
    ctx.save();
    ctx.translate(sx, sy);
    // angleRad is radians from Box2D (0=right). Shape points UP. +PI/2 aligns.
    ctx.rotate(angleRad + Math.PI / 2);

    var L = 30;  // half-length px
    var W = 10;  // half-width px

    // Gray fuselage
    ctx.fillStyle = "#424242";
    ctx.fillRect(-W, -L * 0.4, W * 2, L * 0.95);

    // Dark nose tip
    ctx.fillStyle = "#212121";
    ctx.beginPath();
    ctx.moveTo(-W, L * 0.55); ctx.lineTo(0, L); ctx.lineTo(W, L * 0.55);
    ctx.closePath(); ctx.fill();

    // Pink stripe — matches the actual sprite color
    ctx.fillStyle = "#E91E63";
    ctx.fillRect(-W, -L * 0.45, W * 2, L * 0.35);

    // Inner fins (gray — part of body)
    ctx.fillStyle = "#424242";
    ctx.beginPath();
    ctx.moveTo(-W, -L * 0.1); ctx.lineTo(-W * 1.6, -L * 0.55); ctx.lineTo(-W, -L * 0.38);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W, -L * 0.1); ctx.lineTo(W * 1.6, -L * 0.55); ctx.lineTo(W, -L * 0.38);
    ctx.closePath(); ctx.fill();

    // Outer fins — player color (the different-color fins the user requested)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-W, -L * 0.22); ctx.lineTo(-W * 2.4, -L * 0.7); ctx.lineTo(-W, -L * 0.52);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W, -L * 0.22); ctx.lineTo(W * 2.4, -L * 0.7); ctx.lineTo(W, -L * 0.52);
    ctx.closePath(); ctx.fill();

    // Nozzle
    ctx.fillStyle = "#111";
    ctx.fillRect(-W * 0.6, -L * 0.42, W * 1.2, L * 0.14);

    ctx.restore();

    // Name label
    ctx.save();
    ctx.font = "bold 12px monospace"; ctx.textAlign = "center";
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.fillText(label, sx, sy - L - 14);
    ctx.shadowBlur = 0; ctx.restore();
  }


  // Canvas explosion with additive blending — replicates C2's particle look.
  // C2 uses red sprites (#F44336) with additive blend → orange/yellow on dark bg.
  // Params from data.js: speed=256px, size=64px, ~20 particles total.
  var explosions = [];

  function spawnExplosion(wx, wy) {
    var particles = [];
    for (var i = 0; i < 22; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 55 + Math.random() * 130;
      var size  = 9  + Math.random() * 18;
      particles.push({
        wx: wx, wy: wy,          // world origin (for camera-relative drawing)
        ox: 0,  oy: 0,           // accumulated pixel offset from origin
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 45,
        size: size,
        life: 1.0,
        decay: 0.022 + Math.random() * 0.018
      });
    }
    explosions.push(particles);
  }

  function drawExplosions() {
    if (!overlayCtx || explosions.length === 0) return;
    var ctx = overlayCtx;
    var alive = [];

    for (var e = 0; e < explosions.length; e++) {
      var group = explosions[e];
      var anyAlive = false;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";  // additive = red→orange/yellow

      for (var i = 0; i < group.length; i++) {
        var p = group[i];
        p.life -= p.decay;
        if (p.life <= 0) continue;
        anyAlive = true;

        // Move in screen space (velocity in px/s at 60fps ≈ /60 per tick)
        p.oy += p.vy / 60;
        p.ox += p.vx / 60;
        p.vy += 2;  // slight gravity

        // Get current screen position of world origin + particle offset
        var sp = worldToScreen(p.wx, p.wy);
        if (!sp) continue;
        var px = sp.x + p.ox;
        var py = sp.y + p.oy;

        var a = p.life;
        var r = p.size * p.life;

        // Three concentric circles: white core → orange → red outer
        ctx.fillStyle = "rgba(255,240,120," + (a * 0.95) + ")";
        ctx.beginPath(); ctx.arc(px, py, r * 0.35, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "rgba(255,130,0," + (a * 0.75) + ")";
        ctx.beginPath(); ctx.arc(px, py, r * 0.65, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = "rgba(244,67,54," + (a * 0.55) + ")";
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      }

      ctx.restore();
      if (anyAlive) alive.push(group);
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

      // Dead/exploding players: hide ghost (explosion draws via canvas)
      if (p.dead || p.exploding) return;

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
    "@keyframes rpt{0%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(-16px)}}",
    ".rp-ver{font-size:7px;color:#223;letter-spacing:2px;text-align:center;margin-bottom:4px;}"
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
