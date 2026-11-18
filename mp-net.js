/* mp-net.js - transport backends for the multiplayer layer (local BroadcastChannel + Firebase). */
(function (W) {
  'use strict';
  var STALE = 14000;

  function LocalNet() {
    var ch, lch, room = null, players = {}, states = {}, seen = {}, me, h = {}, timer, myPlayer, lobbyTimer, lobbyInfo = null, code0 = '';
    function post(m) { try { ch.postMessage(m); } catch (e) {} }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function emitPlayers() { h.onPlayers && h.onPlayers(clone(players)); }
    function emitRoom() { h.onRoom && h.onRoom(room ? clone(room) : null); }
    function emitStates() { h.onStates && h.onStates(clone(states)); }
    function announce() { myPlayer.ts = Date.now(); players[me.uid] = myPlayer; post({ k: 'player', uid: me.uid, p: myPlayer }); }

    function onMsg(ev) {
      var m = ev.data; if (!m || m.uid === me.uid) return;
      if (m.k === 'hello') {
        announce();
        if (room) post({ k: 'room', uid: me.uid, r: room });
      } else if (m.k === 'player') {
        players[m.uid] = m.p; seen[m.uid] = Date.now(); emitPlayers();
      } else if (m.k === 'room') {
        if (!room || (m.r.v || 0) > (room.v || 0)) { room = m.r; emitRoom(); }
      } else if (m.k === 'state') {
        if (m.s) states[m.uid] = m.s; else delete states[m.uid];
        emitStates();
      } else if (m.k === 'bye') {
        delete players[m.uid]; delete states[m.uid]; delete seen[m.uid]; emitPlayers(); emitStates();
        if (room && m.uid === room.host) { room = null; emitRoom(); }
      }
    }

    this.list = function (cb) {
      if (typeof BroadcastChannel === 'undefined') { cb([]); return function () {}; }
      var c = new BroadcastChannel('ssmp-lobbies'), map = {}, iv;
      function push() {
        var now = Date.now(), out = [];
        Object.keys(map).forEach(function (k) { if (now - map[k].seenAt > 5000) delete map[k]; else out.push(map[k]); });
        cb(out);
      }
      c.onmessage = function (ev) {
        var m = ev.data; if (!m) return;
        if (m.k === 'lobby') { m.l.seenAt = Date.now(); map[m.l.code] = m.l; push(); }
        else if (m.k === 'gone') { delete map[m.code]; push(); }
      };
      c.postMessage({ k: 'who' });
      iv = setInterval(function () { c.postMessage({ k: 'who' }); push(); }, 2000); push();
      return function () { clearInterval(iv); try { c.close(); } catch (e) {} };
    };

    this.name = 'local';
    this.connect = function (code, meInfo, handlers, asHost, hostInfo) {
      me = meInfo; h = handlers || {}; code0 = code;
      myPlayer = { name: me.name, ready: false, char: me.char, board: me.board, ts: Date.now() };
      return new Promise(function (resolve, reject) {
        if (typeof BroadcastChannel === 'undefined') { reject(new Error('BroadcastChannel not supported in this browser')); return; }
        ch = new BroadcastChannel('ssmp-' + code);
        ch.onmessage = onMsg;
        announce();
        timer = setInterval(function () {
          var now = Date.now(), changed = false;
          announce();
          Object.keys(seen).forEach(function (u) { if (now - seen[u] > 7000) { delete players[u]; delete states[u]; delete seen[u]; changed = true; } });
          if (changed) { emitPlayers(); emitStates(); }
        }, 2000);
        emitPlayers();
        if (asHost) {
          hostInfo = hostInfo || {};
          room = { host: me.uid, status: 'lobby', v: Date.now(), created: Date.now(), name: hostInfo.name || 'Lobby', max: hostInfo.max || 8, opts: hostInfo.opts || {} };
          lobbyInfo = { code: code, name: room.name, host: me.name, count: 1, max: room.max, status: 'lobby', created: room.created };
          lch = new BroadcastChannel('ssmp-lobbies');
          lch.onmessage = function (ev) { if (ev.data && ev.data.k === 'who') pingLobby(); };
          pingLobby(); lobbyTimer = setInterval(pingLobby, 1500);
          post({ k: 'room', uid: me.uid, r: room }); emitRoom(); resolve();
        } else {
          post({ k: 'hello', uid: me.uid });
          var tries = 0, iv = setInterval(function () {
            if (room) { clearInterval(iv); resolve(); }
            else if (++tries > 8) { clearInterval(iv); reject(new Error('Lobby "' + code + '" not found')); }
            else post({ k: 'hello', uid: me.uid });
          }, 250);
        }
      });
    };
    function pingLobby() { if (lch && lobbyInfo) lch.postMessage({ k: 'lobby', l: lobbyInfo }); }
    this.setRoom = function (patch) {
      room = Object.assign({}, room, patch, { v: Math.max((room && room.v || 0) + 1, Date.now()) });
      post({ k: 'room', uid: me.uid, r: room }); emitRoom();
    };
    this.setLobby = function (patch) { if (lobbyInfo) { Object.assign(lobbyInfo, patch); pingLobby(); } };
    this.setPlayer = function (patch) { Object.assign(myPlayer, patch); announce(); emitPlayers(); };
    this.sendState = function (s) { states[me.uid] = s; post({ k: 'state', uid: me.uid, s: s }); };
    this.clearState = function () { delete states[me.uid]; post({ k: 'state', uid: me.uid, s: null }); };
    this.now = function () { return Date.now(); };
    this.leave = function () {
      clearInterval(timer); clearInterval(lobbyTimer);
      if (lch) { lch.postMessage({ k: 'gone', code: code0 }); try { lch.close(); } catch (e) {} }
      post({ k: 'bye', uid: me.uid }); try { ch.close(); } catch (e) {}
    };
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load ' + src + ' (offline?)')); };
      document.head.appendChild(s);
    });
  }
  function withTimeout(p, ms, msg) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error(msg || 'Timed out')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  // Turn a Firebase / network error into something a human can act on.
  function explain(e) {
    var m = String((e && (e.message || e.code)) || e || 'Unknown error');
    if (/permission[_ ]denied/i.test(m)) return 'The database refused the request (permission denied). In the Firebase console open Realtime Database \u2192 Rules, paste database.rules.json from this build and press Publish.';
    if (/timed? ?out|network|offline|Could not load/i.test(m)) return 'Could not reach the database. Check your internet connection (and that databaseURL in mp-config.js is right).';
    return m;
  }
  var fbReady = null;
  function loadFirebase(cfg) {
    if (fbReady) return fbReady;
    var V = '10.12.2';
    fbReady = withTimeout(loadScript('https://www.gstatic.com/firebasejs/' + V + '/firebase-app-compat.js')
      .then(function () { return loadScript('https://www.gstatic.com/firebasejs/' + V + '/firebase-database-compat.js'); })
      .then(function () { if (!firebase.apps.length) firebase.initializeApp(cfg); return firebase.database(); }), 15000, 'Could not load Firebase (are you online?)');
    fbReady.catch(function () { fbReady = null; });
    return fbReady;
  }

  function FirebaseNet(cfg) {
    var db, base, me, h = {}, off = 0, myPlayer, stateRef, lobbyRef, lobbyTimer, lobbyData = null, handles = [], pingFn = null;
    this.name = 'firebase';

    this.list = function (cb) {
      var ref = null, fn = null, stopped = false, iv = null, last = {}, offRef = null;
      loadFirebase(cfg).then(function (d) {
        if (stopped) return;
        offRef = d.ref('.info/serverTimeOffset');
        offRef.on('value', function (s) { off = s.val() || 0; });
        ref = d.ref('mp-lobbies');
        fn = ref.on('value', function (s) { last = s.val() || {}; push(); }, function (e) { cb([], e); });
        iv = setInterval(push, 3000);
      }).catch(function (e) { cb([], e); });
      function push() {
        var now = Date.now() + off, out = [];
        Object.keys(last).forEach(function (k) {
          var l = last[k]; if (!l || typeof l !== 'object') return;
          if (now - (l.ts || 0) > STALE) return;
          l.code = k; out.push(l);
        });
        cb(out);
      }
      return function () { stopped = true; clearInterval(iv); try { ref && fn && ref.off('value', fn); } catch (e) {} };
    };

    this.connect = function (code, meInfo, handlers, asHost, hostInfo) {
      me = meInfo; h = handlers || {};
      myPlayer = { name: me.name, ready: false, char: me.char || 'jake', board: me.board || 'hoverboard' };
      return loadFirebase(cfg).then(function (d) {
        db = d;
        db.ref('.info/serverTimeOffset').on('value', function (s) { off = s.val() || 0; });
        base = db.ref('mp-rooms/' + code);
        if (asHost) {
          hostInfo = hostInfo || {};
          var room = { host: me.uid, status: 'lobby', v: 1, created: firebase.database.ServerValue.TIMESTAMP, name: hostInfo.name || 'Lobby', max: hostInfo.max || 8, opts: hostInfo.opts || {} };
          return base.set({ room: room }).then(function () {
            lobbyRef = db.ref('mp-lobbies/' + code);
            lobbyData = { name: room.name, host: me.name, count: 1, max: room.max, status: 'lobby' };
            lobbyRef.onDisconnect().remove();
            base.onDisconnect().remove();
            pingFn = function () { lobbyRef.set(Object.assign({}, lobbyData, { ts: firebase.database.ServerValue.TIMESTAMP })); };
            pingFn(); lobbyTimer = setInterval(pingFn, 5000);
          });
        }
        return base.child('room').once('value').then(function (s) {
          if (!s.exists()) throw new Error('Lobby "' + code + '" not found (it may have closed)');
        });
      }).then(function () {
        var pRef = base.child('players/' + me.uid);
        stateRef = base.child('states/' + me.uid);
        pRef.onDisconnect().remove(); stateRef.onDisconnect().remove();
        return pRef.set(myPlayer);
      }).then(function () {
        var r = base.child('room'), p = base.child('players'), s = base.child('states');
        r.on('value', function (x) { h.onRoom && h.onRoom(x.val()); });
        p.on('value', function (x) { h.onPlayers && h.onPlayers(x.val() || {}); });
        s.on('value', function (x) { h.onStates && h.onStates(x.val() || {}); });
        handles = [r, p, s];
      });
    };
    this.setRoom = function (patch) { var upd = Object.assign({}, patch); upd.v = Date.now(); base.child('room').update(upd); };
    this.setLobby = function (patch) { if (lobbyData) { Object.assign(lobbyData, patch); pingFn && pingFn(); } };
    this.setPlayer = function (patch) { Object.assign(myPlayer, patch); base.child('players/' + me.uid).update(patch); };
    this.sendState = function (s) { stateRef.set(s); };
    this.clearState = function () { try { stateRef.remove(); } catch (e) {} };
    this.now = function () { return Date.now() + off; };
    this.leave = function () {
      clearInterval(lobbyTimer);
      try { handles.forEach(function (r) { r.off(); }); } catch (e) {}
      try {
        base.child('players/' + me.uid).remove(); stateRef.remove();
        if (lobbyRef) { lobbyRef.remove(); base.remove(); }
      } catch (e) {}
    };
  }


  // ---- chat channel: scope 'global' (home screen) or 'lobby' (one room). Keeps at most 30 messages (oldest dropped).
  function openChat(scope, code, cb) {
    var MAXM = 30, list = [], closed = false, send, close;
    var cfg = (W.MP_CONFIG || {}).firebase || {};
    if (W.MPNet.kind() === 'firebase') {
      var ref = null, q = null, rp = loadFirebase(cfg).then(function (db) {
        if (closed) return null;
        ref = db.ref(scope === 'global' ? 'mp-chat/global' : 'mp-rooms/' + code + '/chat');
        q = ref.limitToLast(MAXM);
        q.on('value', function (s) { var a = []; s.forEach(function (c) { a.push(c.val()); }); cb(a, null); }, function (e) { cb([], new Error(explain(e))); });
        return ref;
      }).catch(function (e) { cb([], new Error(explain(e))); return null; });
      send = function (m) {
        return rp.then(function (r) {
          if (!r) throw new Error('Chat is offline');
          return r.push(m).then(function () { return r.once('value'); }).then(function (s) {
            var ks = Object.keys(s.val() || {}); ks.slice(0, Math.max(0, ks.length - MAXM)).forEach(function (k) { r.child(k).remove(); });
          });
        }).catch(function (e) { throw new Error(explain(e)); });
      };
      close = function () { closed = true; try { q && q.off(); } catch (e) {} };
    } else {
      var ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ssmp-chat-' + scope + (code || '')) : null;
      if (ch) ch.onmessage = function (ev) { if (ev.data && ev.data.t) { list.push(ev.data); while (list.length > MAXM) list.shift(); cb(list.slice()); } };
      send = function (m) { list.push(m); while (list.length > MAXM) list.shift(); try { ch && ch.postMessage(m); } catch (e) {} cb(list.slice()); return Promise.resolve(); };
      close = function () { closed = true; try { ch && ch.close(); } catch (e) {} };
      setTimeout(function () { if (!closed) cb(list.slice()); }, 0);
    }
    return { send: function (m) { return send(m); }, close: close };
  }

  W.MPNet = {
    explain: explain,
    withTimeout: withTimeout,
    fb: function () { return loadFirebase((W.MP_CONFIG || {}).firebase || {}); },
    chat: function (scope, code, cb) { return openChat(scope, code, cb); },
    kind: function () {
      var c = W.MP_CONFIG || {}, fb = c.firebase || {}, kind = c.backend || 'auto';
      if (kind === 'auto') kind = fb.databaseURL ? 'firebase' : 'local';
      return kind;
    },
    create: function () {
      var c = W.MP_CONFIG || {}, fb = c.firebase || {};
      return this.kind() === 'firebase' ? new FirebaseNet(fb) : new LocalNet();
    }
  };
})(window);
