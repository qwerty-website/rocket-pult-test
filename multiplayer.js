'use strict';

/*
 * ROCKETPULT — Multiplayer v2
 *
 * HOST: MULTI → HOST → pick mode/settings → share 4-letter code
 * JOIN: MULTI → type code → JOIN
 * Host presses ▶ START when everyone is ready
 *
 * SANDBOX: No timer, see each other, collision optional
 * RACE:    Host sets time limit, farthest distance wins, collision optional
 *
 * Collision only activates 5s after YOU personally launch.
 * If you die/reset, collision pauses until you launch again.
 */

(function () {

  /* ═══════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════ */
  var PEER_PREFIX        = 'rktplt2-';
  var BROADCAST_HZ       = 15;
  var COLLISION_DELAY_MS = 5000;
  var COLLISION_RADIUS   = 80;
  var MAX_PLAYERS        = 8;
  var STALE_MS           = 3000;
  var START_X            = 320;
  var START_Y            = 630;
  var LAUNCH_MOVE_THRESH = 8;
  var RESET_SNAP_THRESH  = 200;

  var COLORS = ['#44aaff','#ff4444','#44ff88','#ffaa00','#cc66ff','#ff88cc','#00ffee','#ffee00'];

  /* ═══════════════════════════════════════
     STATE
  ═══════════════════════════════════════ */
  var peer          = null;
  var isHost        = false;
  var myCode        = null;
  var myId          = null;
  var myColorIdx    = 0;
  var myName        = 'P1';

  var connections   = {};
  var players       = {};   // never includes self

  var settings      = { mode: 'sandbox', collision: true, timeLimit: 60 };

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

  var overlayEl     = null;
  var overlayCtx    = null;

  /* ═══════════════════════════════════════
     RUNTIME ACCESS
  ═══════════════════════════════════════ */
  var _rt = null;

  function findRuntime() {
    if (_rt) return _rt;
    if (window._rpRuntime) return (_rt = window._rpRuntime);
    try {
      var keys = Object.getOwnPropertyNames(window);
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = window[keys[i]];
          if (v && typeof v === 'object' && v.types &&
              v.running_layout && typeof v.tickcount === 'number') {
            return (_rt = v);
          }
        } catch(e){}
      }
    } catch(e){}
    return null;
  }

  function getRocketPos() {
    var rt = findRuntime();
    if (!rt) return null;
    try {
      var t = rt.types['RocketSprite'];
      if (!t || !t.instances || !t.instances.length) return null;
      var i = t.instances[0];
      return { x: i.x||0, y: i.y||0, angle: i.angle||0 };
    } catch(e){ return null; }
  }

  /* ─────────────────────────────────────────────────────────────────
     worldToScreen  —  converts world coords to canvas pixel coords.

     Strategy: the C2 camera ALWAYS follows the local rocket.
     So:  screenCenter = myRocket in world space.
     We only need the DIFFERENCE between target and my rocket,
     scaled by the game's internal zoom and the CSS display scale.
     ───────────────────────────────────────────────────────────────── */

  // C2 game resolution (from data.js layout size)
  var GAME_W = 1920, GAME_H = 1080;

  // Read C2's internal zoom level — tries all known property paths
  function getInternalZoom() {
    var rt = findRuntime();
    if (!rt) return 1;
    try {
      // layout-level scale (set when camera zooms in/out)
      var layout = rt.running_layout;
      if (layout) {
        if (typeof layout.scale === 'number' && layout.scale > 0) return layout.scale;
        if (typeof layout.zoom === 'number' && layout.zoom > 0) return layout.zoom;
      }
      // Gameplay layer scale
      if (layout && layout.layers) {
        for (var i = 0; i < layout.layers.length; i++) {
          var l = layout.layers[i];
          if (l.name === 'Gameplay' && typeof l.scale === 'number' && l.scale > 0) return l.scale;
        }
      }
    } catch(e){}
    return 1;
  }

  function worldToScreen(wx, wy) {
    // My rocket's world position = what the camera is centred on
    var me = getRocketPos();
    if (!me) return null;

    var cw  = overlayEl ? overlayEl.width  : window.innerWidth;
    var ch  = overlayEl ? overlayEl.height : window.innerHeight;

    // CSS scale: how much the game canvas is shrunk/stretched to fill the window
    var cssScaleX = cw / GAME_W;
    var cssScaleY = ch / GAME_H;
    var cssScale  = Math.min(cssScaleX, cssScaleY);   // C2 uses letterbox scaling

    // Combined pixel-per-world-unit
    var ppu = getInternalZoom() * cssScale;

    // Offset from my rocket in world units → pixel offset from screen centre
    return {
      x: cw/2 + (wx - me.x) * ppu,
      y: ch/2 + (wy - me.y) * ppu
    };
  }

  /* ═══════════════════════════════════════
     LAUNCH / DEATH DETECTION
  ═══════════════════════════════════════ */
  function checkMyState(pos) {
    if (!pos) return;
    var distToStart = Math.sqrt(Math.pow(pos.x-START_X,2)+Math.pow(pos.y-START_Y,2));

    // Reset detected — snapped back near catapult
    if (myLaunched && distToStart < RESET_SNAP_THRESH) { onMyDeath(); return; }

    // Launch detected — moved significantly AND far from start
    if (!myLaunched && myLastPos) {
      var moved = Math.sqrt(Math.pow(pos.x-myLastPos.x,2)+Math.pow(pos.y-myLastPos.y,2));
      if (moved > LAUNCH_MOVE_THRESH && distToStart > RESET_SNAP_THRESH) onMyLaunch();
    }

    if (myLaunched) {
      var dist = Math.abs(pos.x - START_X);
      if (dist > myBestDist) myBestDist = dist;
    }
    myLastPos = { x:pos.x, y:pos.y };
  }

  function onMyLaunch() {
    if (myLaunched) return;
    myLaunched = true; myDead = false; myCollisionActive = false;
    if (myCollisionTimer) clearTimeout(myCollisionTimer);
    if (raceStarted && settings.collision) {
      myCollisionTimer = setTimeout(function(){
        if (myLaunched && !myDead) { myCollisionActive = true; showToast('💥 COLLISION ON!'); }
      }, COLLISION_DELAY_MS);
    }
    broadcast({ type:'launch' });
    updateHUD();
  }

  function onMyDeath() {
    myLaunched=false; myDead=true; myCollisionActive=false;
    if (myCollisionTimer){ clearTimeout(myCollisionTimer); myCollisionTimer=null; }
    myLastPos=null;
    broadcast({ type:'death' });
    updateHUD();
  }

  /* ═══════════════════════════════════════
     COLLISION
  ═══════════════════════════════════════ */
  function checkCollisions() {
    if (!myCollisionActive || !settings.collision) return;
    var me = getRocketPos();
    if (!me) return;
    var now = Date.now();
    var ids = Object.keys(players);
    for (var i=0; i<ids.length; i++) {
      var p = players[ids[i]];
      if (!p || !p.launched || p.dead || now-(p.lastSeen||0)>STALE_MS) continue;
      var dx=me.x-p.x, dy=me.y-p.y;
      if (Math.sqrt(dx*dx+dy*dy) < COLLISION_RADIUS) {
        if (now-lastBumpTime > 900) { lastBumpTime=now; doBump(); }
        return;
      }
    }
  }

  function doBump() {
    var keys=[['ArrowUp',38],['ArrowLeft',37],['ArrowRight',39]];
    var k=keys[Math.floor(Math.random()*keys.length)];
    var opts={key:k[0],code:k[0],keyCode:k[1],which:k[1],bubbles:true,cancelable:true};
    var canvas=document.querySelector('canvas');
    [document,canvas].forEach(function(el){
      if(!el) return;
      el.dispatchEvent(new KeyboardEvent('keydown',opts));
      setTimeout(function(){ el.dispatchEvent(new KeyboardEvent('keyup',opts)); },200);
    });
    var fl=document.getElementById('rp-flash');
    if(fl){ fl.style.opacity='0.5'; setTimeout(function(){ fl.style.opacity='0'; },160); }
    showToast('💥 HIT!');
  }

  /* ═══════════════════════════════════════
     RACE TIMER
  ═══════════════════════════════════════ */
  function startRaceTimer() {
    if (raceTimerIv) clearInterval(raceTimerIv);
    raceEndTime = Date.now() + settings.timeLimit*1000;
    raceTimerIv = setInterval(function(){
      var rem = Math.max(0, raceEndTime-Date.now());
      var el  = document.getElementById('rp-timer');
      if (el) { el.textContent=formatTime(rem); el.style.color=rem<10000?'#ff4444':'#44aaff'; }
      if (rem<=0){ clearInterval(raceTimerIv); endRace(); }
    }, 250);
  }

  function formatTime(ms) {
    var s=Math.ceil(ms/1000), m=Math.floor(s/60); s=s%60;
    return (m>0?m+':':'')+(s<10?'0':'')+s;
  }

  function endRace() {
    raceEnded=true;
    var results=[{ name:myName, dist:Math.round(myBestDist), color:COLORS[myColorIdx] }];
    Object.keys(players).forEach(function(id){
      var p=players[id];
      if(p) results.push({ name:p.name, dist:Math.round(p.bestDist||0), color:p.color });
    });
    results.sort(function(a,b){ return b.dist-a.dist; });
    showResults(results);
  }

  function showResults(results) {
    var ex=document.getElementById('rp-results'); if(ex) ex.remove();
    var d=document.createElement('div'); d.id='rp-results';
    var rows=results.map(function(r,i){
      return '<div class="rp-res-row">'
           + '<span style="color:'+r.color+'">#'+(i+1)+' '+r.name+'</span>'
           + '<span>'+r.dist+'u</span></div>';
    }).join('');
    d.innerHTML='<div class="rp-res-title">RACE OVER</div>'+rows
               +'<button onclick="this.parentNode.remove()" class="rp-res-close">CLOSE ✕</button>';
    document.body.appendChild(d);
  }

  /* ═══════════════════════════════════════
     NETWORKING
  ═══════════════════════════════════════ */
  function genCode(){
    var ch='ABCDEFGHJKLMNPQRSTUVWXYZ', s='';
    for(var i=0;i<4;i++) s+=ch[Math.floor(Math.random()*ch.length)];
    return s;
  }

  function sendToAll(obj, excludeId) {
    var s=JSON.stringify(obj);
    Object.keys(connections).forEach(function(id){
      if(id===excludeId) return;
      try{ connections[id].send(s); }catch(e){}
    });
  }

  function broadcast(obj) {
    obj.playerId=myId;
    sendToAll(obj);
  }

  function handleMessage(senderId, raw) {
    var d;
    try{ d=typeof raw==='string'?JSON.parse(raw):raw; }catch(e){ return; }

    // Always ignore anything that claims to be from me
    if (d.playerId===myId) return;

    var pid=d.playerId||senderId;

    if (d.type==='pos') {
      if (pid===myId) return;
      if (!players[pid]) players[pid]={ color:d.color||'#fff', name:d.name||'?', launched:false, dead:false, bestDist:0 };
      var p=players[pid];
      p.x=d.x; p.y=d.y; p.angle=d.angle; p.color=d.color; p.name=d.name;
      p.bestDist=Math.max(p.bestDist||0,d.bestDist||0);
      p.launched=d.launched; p.dead=d.dead; p.lastSeen=Date.now();
      // Host relays to everyone EXCEPT the sender
      if (isHost) sendToAll(d, senderId);

    } else if (d.type==='launch') {
      if (players[pid]){ players[pid].launched=true; players[pid].dead=false; }

    } else if (d.type==='death') {
      if (players[pid]){ players[pid].dead=true; players[pid].launched=false; }

    } else if (d.type==='welcome') {
      myColorIdx=d.colorIdx; myName=d.name;
      settings=Object.assign(settings, d.settings||{});
      if (d.players) {
        Object.keys(d.players).forEach(function(id){
          if (id!==myId) players[id]=d.players[id];
        });
      }
      updateHUD(); refreshPanel();

    } else if (d.type==='start') {
      settings=Object.assign(settings, d.settings||{});
      raceStarted=true; onRaceStart();

    } else if (d.type==='settings_update') {
      settings=Object.assign(settings, d.settings||{});
      refreshPanel();
    } else if (d.type==='end_session') {
      raceEnded=true; raceStarted=false;
      endRace();
      refreshPanel();
      showToast('HOST ENDED THE SESSION');
    }
  }

  function wireConn(conn) {
    var rid=conn.peer;
    connections[rid]=conn;
    conn.on('data',  function(r){ handleMessage(rid,r); });
    conn.on('close', function(){  delete connections[rid]; delete players[rid]; updateHUD(); refreshPanel(); });
    conn.on('error', function(e){ console.warn('[MP]',e); });
  }

  function hostLobby() {
    myCode=genCode(); myId=PEER_PREFIX+myCode.toLowerCase();
    isHost=true; myColorIdx=0; myName='P1';
    peer=new Peer(myId,{debug:0});
    peer.on('open', function(){
      connected=true; showToast('LOBBY READY!'); updateHUD(); refreshPanel(); startBroadcast();
    });
    peer.on('connection', function(conn){
      if (Object.keys(connections).length>=MAX_PLAYERS-1){ conn.close(); return; }
      conn.on('open', function(){
        var idx=Object.keys(connections).length+1;
        var name='P'+(idx+1);
        wireConn(conn);
        conn.send(JSON.stringify({
          type:'welcome', colorIdx:idx%COLORS.length, name:name,
          settings:settings,
          players:players  // existing players (excludes me — my pos arrives via broadcast)
        }));
        players[conn.peer]={ color:COLORS[idx%COLORS.length], name:name, launched:false, dead:false, bestDist:0, lastSeen:Date.now() };
        showToast(name+' JOINED!'); updateHUD(); refreshPanel();
      });
    });
    peer.on('error', function(e){
      if(e.type==='unavailable-id'){ peer.destroy(); peer=null; hostLobby(); }
      else showToast('NET ERR: '+e.type);
    });
  }

  function joinLobby(code) {
    isHost=false; peer=new Peer({debug:0});
    peer.on('open', function(id){
      myId=id;
      var conn=peer.connect(PEER_PREFIX+code.toLowerCase(),{reliable:false,serialization:'raw'});
      conn.on('open', function(){
        wireConn(conn); connected=true;
        showToast('JOINED!'); updateHUD(); refreshPanel(); startBroadcast();
      });
      conn.on('error', function(){ showToast('FAILED — CHECK CODE'); });
    });
    peer.on('error', function(e){ showToast('NET ERR: '+e.type); });
  }

  function disconnect() {
    if(broadcastIv){clearInterval(broadcastIv);broadcastIv=null;}
    if(raceTimerIv){clearInterval(raceTimerIv);raceTimerIv=null;}
    if(myCollisionTimer){clearTimeout(myCollisionTimer);myCollisionTimer=null;}
    if(peer){peer.destroy();peer=null;}
    connections={}; players={};
    connected=false; isHost=false; myCode=null;
    raceStarted=false; raceEnded=false;
    myLaunched=false; myDead=false; myCollisionActive=false;
    myBestDist=0; myLastPos=null;
    var el=document.getElementById('rp-timer'); if(el) el.style.display='none';
    updateHUD(); refreshPanel();
  }

  /* ═══════════════════════════════════════
     BROADCAST LOOP
  ═══════════════════════════════════════ */
  function startBroadcast() {
    if(broadcastIv) clearInterval(broadcastIv);
    broadcastIv=setInterval(function(){
      var pos=getRocketPos();
      checkMyState(pos);
      if(pos) broadcast({ type:'pos', x:pos.x, y:pos.y, angle:pos.angle,
                          color:COLORS[myColorIdx], name:myName,
                          launched:myLaunched, dead:myDead, bestDist:myBestDist });
      checkCollisions();
      drawOverlay();
    }, 1000/BROADCAST_HZ);
  }

  function onRaceStart() {
    raceStarted=true; raceEnded=false; myBestDist=0;
    if(settings.mode==='race'){
      var el=document.getElementById('rp-timer');
      if(el){ el.style.display='block'; el.style.color='#44aaff'; }
      startRaceTimer();
    }
    refreshPanel();
    showToast(settings.mode==='race'?'🏁 RACE STARTED!':'▶ SANDBOX STARTED!');
  }

  /* ═══════════════════════════════════════
     OVERLAY
  ═══════════════════════════════════════ */
  function initOverlay(){
    overlayEl=document.createElement('canvas');
    overlayEl.id='rp-overlay';
    overlayEl.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9990;';
    document.body.appendChild(overlayEl);
    overlayCtx=overlayEl.getContext('2d');
    function resize(){ overlayEl.width=window.innerWidth; overlayEl.height=window.innerHeight; }
    window.addEventListener('resize',resize); resize();
  }

  function drawGhost(ctx, sx, sy, angle, color, label){
    ctx.save();
    ctx.translate(sx,sy); ctx.rotate(angle+Math.PI/2);
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.shadowColor=color; ctx.shadowBlur=10;
    ctx.beginPath();
    ctx.moveTo(0,-10); ctx.lineTo(-5,4); ctx.lineTo(-2,2);
    ctx.lineTo(-2,8); ctx.lineTo(2,8); ctx.lineTo(2,2); ctx.lineTo(5,4);
    ctx.closePath(); ctx.stroke(); ctx.restore();
    ctx.fillStyle=color; ctx.font='bold 9px monospace'; ctx.textAlign='center';
    ctx.shadowColor=color; ctx.shadowBlur=6;
    ctx.fillText(label,sx,sy-17);
    ctx.shadowBlur=0; ctx.textAlign='left';
  }

  function drawMinimap(){
    if(!overlayCtx) return;
    var ctx=overlayCtx, cw=overlayEl.width, ch=overlayEl.height;
    var mw=90, mh=76, pad=10;
    var mx=cw-mw-pad, my=ch-mh-pad-44;
    ctx.fillStyle='rgba(0,0,0,0.78)'; ctx.strokeStyle='#225588'; ctx.lineWidth=1;
    ctx.fillRect(mx,my,mw,mh); ctx.strokeRect(mx,my,mw,mh);
    ctx.fillStyle='#225588'; ctx.font='7px monospace'; ctx.fillText('RADAR',mx+3,my+9);
    var me=getRocketPos()||{x:0,y:0};
    var sc=0.025, cx=mx+mw/2, cy=my+mh/2;
    var myCol=COLORS[myColorIdx]||'#fff';
    ctx.fillStyle=myCol; ctx.shadowColor=myCol; ctx.shadowBlur=5;
    ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0; ctx.fillStyle=myCol; ctx.font='bold 7px monospace'; ctx.fillText(myName,cx+5,cy+3);
    var now=Date.now();
    Object.keys(players).forEach(function(id){
      var p=players[id];
      if(!p||now-(p.lastSeen||0)>STALE_MS) return;
      var rx=Math.max(mx+5,Math.min(mx+mw-5,cx+(p.x-me.x)*sc));
      var ry=Math.max(my+12,Math.min(my+mh-5,cy+(p.y-me.y)*sc));
      ctx.fillStyle=p.color; ctx.shadowColor=p.color; ctx.shadowBlur=4;
      ctx.beginPath(); ctx.arc(rx,ry,3,0,Math.PI*2); ctx.fill();
      ctx.shadowBlur=0; ctx.fillStyle=p.color; ctx.font='bold 7px monospace';
      ctx.fillText(p.name||'?',rx+4,ry+3);
    });
  }

  function drawOverlay(){
    if(!overlayCtx) return;
    overlayCtx.clearRect(0,0,overlayEl.width,overlayEl.height);
    if(!connected) return;
    var now=Date.now();
    Object.keys(players).forEach(function(id){
      var p=players[id];
      if(!p||now-(p.lastSeen||0)>STALE_MS) return;
      var sp=worldToScreen(p.x,p.y);
      if(!sp) return;
      if(sp.x<-250||sp.x>overlayEl.width+250||sp.y<-250||sp.y>overlayEl.height+250) return;
      drawGhost(overlayCtx,sp.x,sp.y,p.angle||0,p.color,p.name||'?');
      if(myCollisionActive&&p.launched&&!p.dead){
        var me=getRocketPos();
        if(me){
          var dx=me.x-p.x, dy=me.y-p.y;
          var dist=Math.sqrt(dx*dx+dy*dy);
          if(dist<COLLISION_RADIUS*2.5){
            var alpha=Math.max(0,1-dist/(COLLISION_RADIUS*2.5));
            overlayCtx.strokeStyle='rgba(255,68,68,'+alpha+')';
            overlayCtx.lineWidth=1.5; overlayCtx.setLineDash([4,4]);
            overlayCtx.beginPath(); overlayCtx.arc(sp.x,sp.y,28,0,Math.PI*2); overlayCtx.stroke();
            overlayCtx.setLineDash([]);
          }
        }
      }
    });
    drawMinimap();
  }

  /* ═══════════════════════════════════════
     UI
  ═══════════════════════════════════════ */
  function updateHUD(){
    var btn=document.getElementById('rp-mp-btn');
    var hud=document.getElementById('rp-hud');
    if(btn) btn.className=connected?'on':'';
    if(hud){
      hud.style.display=connected?'block':'none';
      var status=myLaunched?'▶ FLYING':(myDead?'✕ DEAD':'· READY');
      hud.textContent=myName+'  '+status+'  ('+(Object.keys(players).length+1)+' online)';
    }
  }

  function playerListHTML(){
    var html='<div class="rp-plist">';
    html+='<div class="rp-prow"><span class="rp-dot" style="background:'+COLORS[myColorIdx]+'"></span>'
         +'<span>'+myName+' (YOU)'+(myLaunched?' ▶':myDead?' ✕':'')+'</span></div>';
    var now=Date.now();
    Object.keys(players).forEach(function(id){
      var p=players[id]; if(!p) return;
      var stale=now-(p.lastSeen||0)>STALE_MS;
      html+='<div class="rp-prow">'
           +'<span class="rp-dot" style="background:'+(stale?'#333':p.color)+'"></span>'
           +'<span style="color:'+(stale?'#333':'#ccc')+'">'+(p.name||'?')+(p.launched?' ▶':p.dead?' ✕':'')+'</span></div>';
    });
    return html+'</div>';
  }

  function hostSettingsHTML(){
    var modesH=['sandbox','race'].map(function(m){
      return '<button class="rp-mode-btn'+(settings.mode===m?' active':'')+'" onclick="window.__rpSetMode(\''+m+'\')">'+m.toUpperCase()+'</button>';
    }).join('');
    var tlH=settings.mode==='race'
      ?'<div class="rp-set-row"><span>TIME LIMIT</span><div class="rp-tl-group">'
        +[30,60,90,120].map(function(t){
          return '<button class="rp-tl-btn'+(settings.timeLimit===t?' active':'')+'" onclick="window.__rpSetTL('+t+')">'+t+'s</button>';
        }).join('')+'</div></div>'
      :'';
    var colH='<div class="rp-set-row"><span>COLLISION</span>'
             +'<button class="rp-col-btn'+(settings.collision?' active':'')+'" onclick="window.__rpToggleCol()">'
             +(settings.collision?'ON ✓':'OFF')+'</button></div>';
    return '<div class="rp-settings"><div class="rp-set-row"><span>MODE</span>'
           +'<div class="rp-mode-group">'+modesH+'</div></div>'+tlH+colH+'</div>';
  }

  function buildPanel(){
    if(!connected){
      return '<h1>MULTIPLAYER</h1>'
            +'<div class="rp-sub">HOST OR JOIN A LOBBY</div>'
            +'<button class="rp-btn-main" onclick="window.__rpHost()">HOST LOBBY</button>'
            +'<div class="rp-divider">— OR JOIN —</div>'
            +'<input id="rp-join-inp" maxlength="4" placeholder="CODE" autocomplete="off"/>'
            +'<button class="rp-btn-sec" onclick="window.__rpJoin()">JOIN ▶</button>'
            +'<button class="rp-btn-dim" onclick="window.__rpClose()">CLOSE ✕</button>';
    }
    var startBtn='';
    if(isHost&&!raceStarted) startBtn='<button class="rp-btn-go" onclick="window.__rpStart()">▶ START</button>';
    else if(raceStarted&&settings.mode==='sandbox') startBtn=(isHost?'<button class="rp-btn-end" onclick="window.__rpEndSession()">■ END SANDBOX</button>':'<div class="rp-tag-active">■ SANDBOX ACTIVE</div>');
    else if(raceStarted&&settings.mode==='race')    startBtn='<div class="rp-tag-active">🏁 RACE ACTIVE</div>';
    return '<h1>MULTIPLAYER</h1>'
          +(myCode?'<div class="rp-codebox">'+myCode+'</div><div class="rp-sub">SHARE THIS CODE</div>':'')
          +(isHost&&!raceStarted?hostSettingsHTML():'')
          +playerListHTML()
          +startBtn
          +'<div class="rp-btm-row">'
          +'<button class="rp-btn-dim" onclick="window.__rpClose()">CLOSE ✕</button>'
          +'<button class="rp-btn-dim" onclick="window.__rpLeave()">LEAVE</button>'
          +'</div>';
  }

  function refreshPanel(){
    var el=document.getElementById('rp-panel');
    if(el&&panelOpen){ el.innerHTML=buildPanel(); bindInput(); }
  }

  function bindInput(){
    var inp=document.getElementById('rp-join-inp'); if(!inp) return;
    inp.addEventListener('input',function(){ this.value=this.value.toUpperCase().replace(/[^A-Z]/g,''); });
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter') window.__rpJoin(); });
  }

  function showToast(msg){
    var t=document.createElement('div'); t.className='rp-toast'; t.textContent=msg;
    document.body.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },2400);
  }

  /* ═══════════════════════════════════════
     GLOBALS
  ═══════════════════════════════════════ */
  window.__rpHost      = function(){ if(typeof Peer==='undefined'){showToast('PEERJS NOT LOADED');return;} hostLobby(); };
  window.__rpJoin      = function(){
    if(typeof Peer==='undefined'){showToast('PEERJS NOT LOADED');return;}
    var inp=document.getElementById('rp-join-inp');
    var code=inp?inp.value.trim():'';
    if(code.length!==4){showToast('NEED 4-LETTER CODE');return;}
    joinLobby(code);
  };
  window.__rpStart     = function(){ if(!isHost) return; sendToAll({type:'start',settings:settings}); onRaceStart(); };
  window.__rpLeave     = function(){ disconnect(); window.__rpClose(); };
  window.__rpClose     = function(){ panelOpen=false; var el=document.getElementById('rp-panel'); if(el) el.remove(); };
  window.__rpSetMode   = function(m){ if(!isHost) return; settings.mode=m; sendToAll({type:'settings_update',settings:settings}); refreshPanel(); };
  window.__rpSetTL     = function(t){ if(!isHost) return; settings.timeLimit=t; sendToAll({type:'settings_update',settings:settings}); refreshPanel(); };
  window.__rpToggleCol = function(){ if(!isHost) return; settings.collision=!settings.collision; sendToAll({type:'settings_update',settings:settings}); refreshPanel(); };
  window.__rpEndSession = function(){
    if(!isHost) return;
    sendToAll({type:'end_session'});
    // Host ends locally
    raceEnded=true; raceStarted=false;
    endRace();
    refreshPanel();
  };

  /* ═══════════════════════════════════════
     CSS
  ═══════════════════════════════════════ */
  var CSS=[
    '#rp-mp-btn{position:fixed;bottom:10px;right:10px;z-index:9999;background:#0d0d0d;color:#334;font:bold 10px/1 monospace;letter-spacing:2px;padding:9px 13px;border:3px solid #334;cursor:pointer;user-select:none;}',
    '#rp-mp-btn.on{color:#44aaff;border-color:#44aaff;box-shadow:0 0 10px #44aaff44;}',
    '#rp-hud{position:fixed;bottom:50px;right:10px;z-index:9999;background:#080808;border:2px solid #44aaff;color:#44aaff;font:bold 8px monospace;letter-spacing:1px;padding:3px 7px;display:none;}',
    '#rp-timer{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;font:bold 22px monospace;color:#44aaff;text-shadow:0 0 18px #44aaff;letter-spacing:4px;display:none;}',
    '#rp-flash{position:fixed;inset:0;background:#ff2200;opacity:0;pointer-events:none;z-index:9997;transition:opacity .1s;}',
    '#rp-results{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;background:#080808;border:3px solid #ffaa00;padding:20px;font-family:monospace;min-width:220px;}',
    '.rp-res-title{font-size:12px;color:#ffaa00;letter-spacing:5px;text-align:center;margin-bottom:12px;}',
    '.rp-res-row{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #111;}',
    '.rp-res-close{width:100%;margin-top:12px;padding:8px;cursor:pointer;background:#ffaa00;color:#000;font:bold 9px monospace;letter-spacing:2px;border:none;}',
    '#rp-panel{position:fixed;bottom:50px;right:10px;z-index:10000;background:#080808;border:3px solid #44aaff;padding:16px;font-family:monospace;color:#ccc;width:240px;box-shadow:0 0 40px #44aaff22;}',
    '#rp-panel h1{margin:0 0 6px;font-size:11px;color:#44aaff;letter-spacing:5px;text-align:center;}',
    '.rp-sub{font-size:8px;color:#335;letter-spacing:2px;text-align:center;margin-bottom:10px;}',
    '.rp-divider{font-size:8px;color:#224;letter-spacing:2px;text-align:center;margin:10px 0 8px;border-top:1px solid #111;padding-top:10px;}',
    '.rp-codebox{font-size:28px;font-weight:bold;color:#44aaff;letter-spacing:10px;text-align:center;border:2px solid #44aaff;padding:8px 4px;margin-bottom:6px;text-shadow:0 0 12px #44aaff;}',
    '#rp-panel input{width:100%;box-sizing:border-box;background:#111;border:2px solid #44aaff;color:#44aaff;font:bold 22px monospace;letter-spacing:8px;text-align:center;padding:7px;text-transform:uppercase;outline:none;display:block;margin-bottom:6px;}',
    '.rp-btn-main,.rp-btn-sec,.rp-btn-dim,.rp-btn-go{width:100%;padding:9px;cursor:pointer;font:bold 9px monospace;letter-spacing:2px;border:2px solid;display:block;margin-bottom:6px;text-align:center;}',
    '.rp-btn-end{width:100%;padding:9px;cursor:pointer;font:bold 9px monospace;letter-spacing:2px;border:2px solid #ff4444;display:block;margin-bottom:6px;text-align:center;background:#ff4444;color:#fff;}',
    '.rp-btn-main{background:#44aaff;color:#000;border-color:#44aaff;}',
    '.rp-btn-sec{background:#0a0a0a;color:#44aaff;border-color:#44aaff;}',
    '.rp-btn-dim{background:#0d0d0d;color:#334;border-color:#222;}',
    '.rp-btn-go{background:#27ae60;color:#000;border-color:#27ae60;font-size:11px;padding:11px;letter-spacing:4px;margin-top:8px;}',
    '.rp-tag-active{font-size:9px;color:#27ae60;letter-spacing:2px;text-align:center;padding:8px;border:1px solid #27ae60;margin-top:8px;}',
    '.rp-btm-row{display:flex;gap:6px;margin-top:8px;}',
    '.rp-btm-row button{flex:1;}',
    '.rp-settings{margin-bottom:8px;border:1px solid #111;padding:8px;}',
    '.rp-set-row{display:flex;align-items:center;justify-content:space-between;font-size:8px;color:#446;letter-spacing:1px;margin-bottom:5px;}',
    '.rp-mode-group,.rp-tl-group{display:flex;gap:3px;}',
    '.rp-mode-btn,.rp-tl-btn,.rp-col-btn{padding:4px 7px;cursor:pointer;font:bold 8px monospace;letter-spacing:1px;background:#0d0d0d;color:#334;border:1px solid #222;}',
    '.rp-mode-btn.active,.rp-tl-btn.active{background:#44aaff;color:#000;border-color:#44aaff;}',
    '.rp-col-btn.active{background:#ff4444;color:#fff;border-color:#ff4444;}',
    '.rp-plist{border-top:1px solid #111;padding-top:8px;margin-bottom:6px;}',
    '.rp-prow{display:flex;align-items:center;gap:7px;font-size:9px;letter-spacing:1px;padding:2px 0;}',
    '.rp-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;display:inline-block;}',
    '.rp-toast{position:fixed;bottom:100px;right:12px;z-index:10002;background:#44aaff;color:#000;font:bold 9px monospace;letter-spacing:2px;padding:5px 12px;pointer-events:none;animation:rpt 2.2s forwards;}',
    '@keyframes rpt{0%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(-16px)}}',
  ].join('');

  /* ═══════════════════════════════════════
     INIT
  ═══════════════════════════════════════ */
  function init(){
    var sty=document.createElement('style'); sty.textContent=CSS; document.head.appendChild(sty);

    var btn=document.createElement('div'); btn.id='rp-mp-btn'; btn.textContent='MULTI';
    btn.addEventListener('click',function(){
      panelOpen=!panelOpen;
      var el=document.getElementById('rp-panel');
      if(panelOpen){
        if(!el){ el=document.createElement('div'); el.id='rp-panel'; document.body.appendChild(el); }
        el.innerHTML=buildPanel(); bindInput();
      } else if(el){ el.remove(); }
    });
    document.body.appendChild(btn);

    var hud=document.createElement('div'); hud.id='rp-hud'; document.body.appendChild(hud);
    var tmr=document.createElement('div'); tmr.id='rp-timer'; document.body.appendChild(tmr);
    var fl=document.createElement('div');  fl.id='rp-flash';  document.body.appendChild(fl);

    initOverlay();

    setInterval(function(){
      updateHUD();
      if(panelOpen&&connected) refreshPanel();
      var now=Date.now();
      Object.keys(players).forEach(function(id){
        if(players[id]&&now-(players[id].lastSeen||0)>STALE_MS+2000) delete players[id];
      });
    },1000);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();

}());
