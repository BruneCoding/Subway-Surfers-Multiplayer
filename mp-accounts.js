/* mp-accounts.js - accounts (username + password), rank points, ranks and global leaderboards.
 *
 * Storage follows the multiplayer backend:
 *   firebase -> Realtime Database paths  mp-accounts/<name>  (salt + password hash)   and   mp-profiles/<name>  (public stats)
 *   local    -> localStorage of this browser (good for testing; accounts are not shared between computers)
 *
 * NOTE: there is no game server, so this is client-side logic on top of an open database. Passwords are
 * salted + hashed (never stored in clear), but anyone who can write to the database can also edit stats.
 * See MULTIPLAYER_README.md for the hardening path (Firebase Auth + rules / Cloud Functions).
 */
(function (W) {
  'use strict';
  var A = W.MPAcc = {};
  var LS_DB = 'mp_local_db', LS_SESSION = 'mp_session';

  // ------------------------------------------------------------------ ranks ---
  // Poki14: every rank is a designed vector emblem (no emoji). Ranks are split into
  // three divisions (I/II/III); rankOf() returns the full progression state.
  var RANKS = [
    { id: 'rookie',   name: 'Rookie',   min: 0,     color: '#9fb3c8', dark: '#425065' },
    { id: 'bronze',   name: 'Bronze',   min: 100,   color: '#cd7f32', dark: '#6e3f18' },
    { id: 'silver',   name: 'Silver',   min: 300,   color: '#d0d8e2', dark: '#6b7684' },
    { id: 'gold',     name: 'Gold',     min: 700,   color: '#ffd23f', dark: '#8a6a00' },
    { id: 'platinum', name: 'Platinum', min: 1500,  color: '#7fe3ff', dark: '#1f6e86' },
    { id: 'diamond',  name: 'Diamond',  min: 3000,  color: '#6fa8ff', dark: '#254a8f' },
    { id: 'master',   name: 'Master',   min: 6000,  color: '#d98bff', dark: '#5f2f8f' },
    { id: 'legend',   name: 'Legend',   min: 12000, color: '#ff6a3d', dark: '#8f2c10' }
  ];
  A.RANKS = RANKS;

  // ---------------------------------------------------------------- badges ---
  // One emblem shape per rank, a metallic gradient from the rank palette and a
  // division pips row (I / II / III) so divisions are readable at a glance.
  var EMBLEM = {
    rookie:   { o: '<circle cx="12" cy="10.4" r="7.4"/>',
                i: '<path d="M8.8 10.6L12 7.4l3.2 3.2M8.8 13.8L12 10.6l3.2 3.2"/>' },
    bronze:   { o: '<path d="M12 2.6l8.2 3v7.2c0 5-3.5 8.4-8.2 10.4C7.3 21.2 3.8 17.8 3.8 12.8V5.6z"/>',
                i: '<path d="M12 6.4v8.8M12 15.2l-3-3M12 15.2l3-3"/>' },
    silver:   { o: '<path d="M12 2.2l8 5.4-8 14.2L4 7.6z"/>',
                i: '<path d="M12 6v4.6M9.6 8.3h4.8"/>' },
    gold:     { o: '<path d="M12 2.4l9 4v6.4c0 5.2-3.8 8.6-9 10.6-5.2-2-9-5.4-9-10.6V6.4z"/>',
                i: '<path d="M12 14.8c-2.7 0-4.6-1.9-4.6-4.4h2.3c0 1.3.9 2.1 2.3 2.1s2.3-.8 2.3-2.1h2.3c0 2.5-1.9 4.4-4.6 4.4z"/><path d="M9.4 6.5h5.2"/>' },
    platinum: { o: '<path d="M12 2l3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.6l-6.1 3.2 1.2-6.8L2.2 9.2 9 8.2z"/>',
                i: '' },
    diamond:  { o: '<path d="M7 3h10l4.4 5.4L12 21.8 2.6 8.4z"/>',
                i: '<path d="M2.6 8.4h18.8M12 21.8L7 8.4l5-5.4 5 5.4z"/>' },
    master:   { o: '<path d="M12 2.6l8.6 3.2v7c0 5.4-3.6 8.8-8.6 10.8-5-2-8.6-5.4-8.6-10.8v-7z"/>',
                i: '<path d="M8.4 12.4l2.5 2.5 4.7-5.2"/>' },
    legend:   { o: '<path d="M12 2.4c1.4 3.6-.4 5.6-1.9 7.7-1.4 2-2.1 3.7-2.1 5.7a6 6 0 0 0 12 0c0-1.9-.6-3.6-1.6-5.2-.6 1.1-1.4 1.9-2.4 2.4.7-3.8-.9-7.8-4-10.6z"/>',
                i: '' }
  };
  function rankSvg(r, div, size) {
    var gid = 'rg' + r.id, sid = 'rs' + r.id, pips = '';
    for (var i = 0; i < 3; i++) {
      var on = i < div;
      pips += '<rect x="' + (7.4 + i * 3.4) + '" y="20.8" width="2.4" height="2.1" rx="0.7" fill="' + (on ? r.color : 'rgba(255,255,255,.16)') + '"/>';
    }
    return '<svg class="rk-svg"' + (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '') + ' viewBox="0 0 24 24" role="img" aria-label="' + r.name + '">' +
      '<defs>' +
      '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + r.color + '"/><stop offset="1" stop-color="' + r.dark + '"/></linearGradient>' +
      '<linearGradient id="' + sid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.5)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient>' +
      '</defs>' +
      '<g fill="url(#' + gid + ')" stroke="rgba(0,0,0,.5)" stroke-width="1">' + EMBLEM[r.id].o + '</g>' +
      '<path d="M12 3.2l7 2.6v6.5c0 4.3-2.9 7.2-7 9-4.1-1.8-7-4.7-7-9V5.8z" fill="url(#' + sid + ')"/>' +
      '<g fill="none" stroke="rgba(10,14,22,.55)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + EMBLEM[r.id].i + '</g>' +
      pips + '</svg>';
  }
  A.rankSvg = rankSvg;

  A.rankOf = function (pts) {
    pts = Math.max(0, pts | 0);
    var i = 0; for (var k = 0; k < RANKS.length; k++) if (pts >= RANKS[k].min) i = k;
    var r = RANKS[i], nx = RANKS[i + 1] || null;
    var span = nx ? nx.min - r.min : 1, into = nx ? pts - r.min : span;
    var DIVS = 3, dspan = span / DIVS;
    var div = Math.min(DIVS, 1 + Math.floor(into / dspan));
    var divInto = into - (div - 1) * dspan;
    return { index: i, id: r.id, name: r.name, color: r.color, min: r.min,
      div: nx ? div : DIVS, divPct: nx ? Math.min(100, Math.round(divInto / dspan * 100)) : 100,
      pct: nx ? Math.round(into / span * 100) : 100, toNext: nx ? nx.min - pts : 0, next: nx,
      svg: rankSvg(r, nx ? div : DIVS), sigil: rankSvg(r, nx ? div : DIVS, 18) };
  };
  // Points for winning a lobby race: more opponents -> bigger prize. Solo races give nothing (no farming).
  A.winPoints = function (players) { return players < 2 ? 0 : 100 + 20 * (players - 1); };

  // ---------------------------------------------------------- XP & levels ----
  // XP is earned from real match results only (never from idling). Level curve:
  // level N->N+1 needs 1000 + 250*(N-1) XP, capped at 4000 per level.
  A.xpNeed = function (lvl) { return Math.min(4000, 1000 + (Math.max(1, lvl) - 1) * 250); };
  A.levelOf = function (xp) {
    xp = Math.max(0, xp | 0);
    var lvl = 1, rest = xp;
    while (rest >= A.xpNeed(lvl) && lvl < 999) { rest -= A.xpNeed(lvl); lvl++; }
    return { lvl: lvl, cur: rest, need: A.xpNeed(lvl), pct: Math.min(100, Math.round(rest / A.xpNeed(lvl) * 100)) };
  };
  // Real XP for a finished race: opponents + win bonus + distance + coins.
  A.xpAward = function (r) {
    var xp = 150 + 40 * Math.max(0, (r.players | 0) - 1);
    if (r.won) xp += 120;
    xp += Math.min(200, Math.floor(Math.max(0, r.dist | 0) / 100));
    xp += Math.min(80, Math.floor(Math.max(0, r.coins | 0) / 2));
    return Math.min(800, xp);
  };

  // -------------------------------------------------------- achievements ----
  // Computed from real profile fields only - nothing here is invented or stored.
  A.achievementsOf = function (p, friendsCount) {
    p = p || {}; var lvl = A.levelOf(p.xp | 0).lvl;
    function a(id, name, desc, val, goal, unit) {
      var v = Math.max(0, val | 0), g = Math.max(1, goal | 0);
      return { id: id, name: name, desc: desc, prog: Math.min(v, g), goal: g, done: v >= g, unit: unit || '' };
    }
    return [
      a('firstwin', 'First Victory', 'Win your first lobby race', p.w, 1),
      a('winner10', 'Contender', 'Win 10 lobby races', p.w, 10),
      a('winner50', 'Dominator', 'Win 50 lobby races', p.w, 50),
      a('streak3', 'On Fire', 'Reach a 3-win streak', p.bst, 3),
      a('races10', 'Regular', 'Finish 10 races', p.r, 10),
      a('races100', 'Veteran', 'Finish 100 races', p.r, 100),
      a('dist10k', 'Marathoner', 'Run 10,000 m in total', p.td, 10000, ' m'),
      a('dist100k', 'Ultra Runner', 'Run 100,000 m in total', p.td, 100000, ' m'),
      a('coins1k', 'Coin Collector', 'Collect 1,000 coins', p.cc, 1000),
      a('score50k', 'High Roller', 'Score 50,000 in one run', p.bs, 50000),
      a('dist1k', 'Long Haul', 'Run 1,000 m in a single race', p.bd, 1000, ' m'),
      a('lvl10', 'Rising Star', 'Reach level 10', lvl, 10),
      a('rankgold', 'Golden', 'Reach the Gold rank', (p.pts | 0) >= 700 ? 1 : 0, 1),
      a('social3', 'Squad Leader', 'Have 3 friends', friendsCount | 0, 3)
    ];
  };

  // --------------------------------------------------------------- crypto -----
  function sha256(str) {                         // small pure-JS SHA-256 (works on http:// too, unlike crypto.subtle)
    function rr(n, x) { return (x >>> n) | (x << (32 - n)); }
    var K = [], H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], p = 2, c = 0;
    for (; c < 64; p++) { var pr = true; for (var d = 2; d * d <= p; d++) if (p % d === 0) { pr = false; break; } if (pr) K[c++] = (Math.pow(p, 1 / 3) * 4294967296) | 0; }
    var bytes = [], i, j;
    for (i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      if (ch < 128) bytes.push(ch);
      else if (ch < 2048) bytes.push(192 | ch >> 6, 128 | ch & 63);
      else bytes.push(224 | ch >> 12, 128 | ch >> 6 & 63, 128 | ch & 63);
    }
    var bl = bytes.length * 8; bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bl >>> (i * 8)) & 255);
    for (i = 0; i < bytes.length; i += 64) {
      var w = [];
      for (j = 0; j < 16; j++) w[j] = bytes[i + j * 4] << 24 | bytes[i + j * 4 + 1] << 16 | bytes[i + j * 4 + 2] << 8 | bytes[i + j * 4 + 3];
      for (j = 16; j < 64; j++) { var s0 = rr(7, w[j - 15]) ^ rr(18, w[j - 15]) ^ (w[j - 15] >>> 3), s1 = rr(17, w[j - 2]) ^ rr(19, w[j - 2]) ^ (w[j - 2] >>> 10); w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0; }
      var a = H[0], b = H[1], cc = H[2], dd = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = rr(6, e) ^ rr(11, e) ^ rr(25, e), ch2 = (e & f) ^ (~e & g), t1 = (h + S1 + ch2 + K[j] + w[j]) | 0;
        var S0 = rr(2, a) ^ rr(13, a) ^ rr(22, a), mj = (a & b) ^ (a & cc) ^ (b & cc), t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (dd + t1) | 0; dd = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + dd) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  function hashPw(pw, salt) { var h = salt + ':' + pw; for (var i = 0; i < 4000; i++) h = sha256(h + salt); return h; }
  function newSalt() { var a = ''; for (var i = 0; i < 4; i++) a += Math.random().toString(36).slice(2, 8); return a; }

  // --------------------------------------------------------------- storage ----
  function kind() { return W.MPNet ? W.MPNet.kind() : 'local'; }
  function localDb() { try { var d = JSON.parse(localStorage.getItem(LS_DB) || '{}'); d.a = d.a || {}; d.p = d.p || {}; return d; } catch (e) { return { a: {}, p: {} }; } }
  function saveLocal(d) { try { localStorage.setItem(LS_DB, JSON.stringify(d)); } catch (e) {} }
  function db() { return W.MPNet.fb(); }
  function T(p) { return W.MPNet.withTimeout(Promise.resolve(p), 12000, 'Timed out talking to the database'); }
  function fail(e) { throw new Error(W.MPNet.explain(e)); }
  function lc(u) { return String(u || '').trim().toLowerCase(); }
  function weekKey() { var d = new Date(), y = d.getUTCFullYear(), j = new Date(Date.UTC(y, 0, 1)), w = Math.floor(((d - j) / 86400000 + j.getUTCDay()) / 7); return y + 'w' + w; }
  function blank(name) { return { n: name, pts: 0, xp: 0, w: 0, r: 0, bs: 0, bd: 0, cc: 0, st: 0, bst: 0, ch: 'jake', wk: '', wp: 0, ts: 0, td: 0, hist: [], seen: [], md: {}, rw: 0, rl: 0, em: '' }; }

  // ------------------------------------------------------- mode statistics ----
  // POKI18: every finished race also lands in a per-mode bucket so the
  // leaderboards can split Unranked/Ranked x Coin/No Coin. Buckets live in
  // profile.md = { coin:{r,w,bs,bd,cc}, nocoin:{...}, rcoin:{...}, rnocoin:{...} }.
  function modeKey(mode, ranked) { return (ranked ? 'r' : '') + (mode === 'nocoin' ? 'nocoin' : 'coin'); }
  function modeBucket(p, mode, ranked) {
    p.md = p.md || {};
    var k = modeKey(mode, ranked);
    if (!p.md[k] || typeof p.md[k] !== 'object') p.md[k] = { r: 0, w: 0, bs: 0, bd: 0, cc: 0 };
    return p.md[k];
  }
  A.modeKey = modeKey;
  // ranked points: win +30..+46 (scaled by lobby size), loss -14 (never below 0)
  A.rankedPoints = function (players, won) { return won ? 30 + 4 * Math.max(0, (players | 0) - 1) : -14; };

  // --------------------------------------------------------------- session ----
  var sess = null, profile = null, subs = [];
  try { sess = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { sess = null; }
  function emit() { subs.forEach(function (f) { try { f(A.user(), profile); } catch (e) { console.error(e); } }); }
  A.onChange = function (f) { subs.push(f); return function () { subs = subs.filter(function (x) { return x !== f; }); }; };
  A.user = function () { return sess ? { name: sess.name, key: sess.key } : null; };
  A.profile = function () { return profile; };
  A.points = function () { return profile ? profile.pts | 0 : 0; };

  function setSession(name) {
    sess = { name: name, key: lc(name) };
    try { localStorage.setItem(LS_SESSION, JSON.stringify(sess)); } catch (e) {}
  }
  A.validName = function (n) { return /^[A-Za-z0-9_]{3,14}$/.test(String(n || '')); };

  A.refresh = function () {
    if (!sess) { profile = null; emit(); return Promise.resolve(null); }
    return A.fetchProfile(sess.key).then(function (p) { profile = p || blank(sess.name); emit(); return profile; }).catch(function () { return profile; });
  };

  A.fetchProfile = function (key) {
    key = lc(key);
    if (kind() === 'local') return Promise.resolve(localDb().p[key] || null);
    return T(db().then(function (d) { return d.ref('mp-profiles/' + key).once('value'); })).then(function (s) { return s.val(); });
  };

  // v13: when the account was created (epoch ms), 0 if unknown
  A.created = function (key) {
    key = lc(key || (sess && sess.key) || '');
    if (!key) return Promise.resolve(0);
    if (kind() === 'local') { var d = localDb(); return Promise.resolve((d.a[key] || {}).c || 0); }
    return T(db().then(function (d2) { return d2.ref('mp-accounts/' + key + '/c').once('value'); })).then(function (s) { return s.val() || 0; }, function () { return 0; });
  };

  A.signup = function (name, pw, recov) {
    name = String(name || '').trim();
    if (!A.validName(name)) return Promise.reject(new Error('Username must be 3-14 letters, numbers or _'));
    if (String(pw || '').length < 4) return Promise.reject(new Error('Password must be at least 4 characters'));
    var key = lc(name), salt = newSalt(), h = hashPw(pw, salt);
    var acc = { u: name, s: salt, h: h, c: Date.now() };
    if (recov && String(recov).trim()) acc.em = String(recov).trim().slice(0, 80);   // recovery email for password resets
    function done() { setSession(name); return A.refresh().then(function () { return A.user(); }); }
    if (kind() === 'local') {
      var d = localDb(); if (d.a[key]) return Promise.reject(new Error('That username is taken'));
      d.a[key] = acc; d.p[key] = d.p[key] || blank(name); saveLocal(d); return done();
    }
    return T(db().then(function (fb) {
      return fb.ref('mp-accounts/' + key).transaction(function (cur) { return cur ? undefined : acc; });   // atomic: only if free
    })).then(function (res) {
      if (!res.committed) throw new Error('That username is taken');
      return T(db().then(function (fb) { return fb.ref('mp-profiles/' + key).transaction(function (cur) { return cur || blank(name); }); }));
    }).then(done, function (e) { if (/taken/.test(e && e.message)) throw e; fail(e); });
  };

  A.login = function (name, pw) {
    var key = lc(name);
    if (!key) return Promise.reject(new Error('Enter your username'));
    function check(acc) {
      if (!acc || hashPw(pw || '', acc.s) !== acc.h) throw new Error('Wrong username or password');
      setSession(acc.u || name);
      return A.refresh().then(function () { return A.user(); });
    }
    if (kind() === 'local') return Promise.resolve().then(function () { return check(localDb().a[key]); });
    return T(db().then(function (fb) { return fb.ref('mp-accounts/' + key).once('value'); })).then(function (s) { return check(s.val()); }, fail);
  };

  A.logout = function () { sess = null; profile = null; try { localStorage.removeItem(LS_SESSION); } catch (e) {} emit(); };

  // --------------------------------------------------- password recovery ----
  // Uses the existing authentication backend: the account record stores the
  // (optional) recovery email; matching it unlocks a password change. The old
  // password is never displayed or returned - only a fresh salt + hash is written.
  A.setRecovery = function (email) {
    if (!sess) return Promise.reject(new Error('Log in first'));
    var em = String(email || '').trim().slice(0, 80);
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return Promise.reject(new Error('Enter a valid email address'));
    var key = sess.key;
    if (kind() === 'local') { var d = localDb(); if (d.a[key]) { d.a[key].em = em; saveLocal(d); return Promise.resolve(); } return Promise.reject(new Error('Account not found')); }
    return T(db().then(function (fb) { return fb.ref('mp-accounts/' + key + '/em').set(em); })).then(null, fail);
  };
  A.recoveryOf = function (key) {
    key = lc(key);
    if (!key) return Promise.resolve('');
    if (kind() === 'local') { var d = localDb(); return Promise.resolve((d.a[key] || {}).em || ''); }
    return T(db().then(function (fb) { return fb.ref('mp-accounts/' + key + '/em').once('value'); })).then(function (s) { return s.val() || ''; }, function () { return ''; });
  };
  A.checkRecovery = function (name, email) {
    var key = lc(name);
    if (!key) return Promise.reject(new Error('Enter your username'));
    return A.recoveryOf(key).then(function (em) {
      if (!em) throw new Error('This account has no recovery email. Ask the account owner to add one from the profile screen.');
      if (String(email || '').trim().toLowerCase() !== em.toLowerCase()) throw new Error('Recovery email does not match our records');
      return true;
    });
  };
  A.resetPassword = function (name, email, newPw) {
    if (String(newPw || '').length < 4) return Promise.reject(new Error('Password must be at least 4 characters'));
    return A.checkRecovery(name, email).then(function () {
      var key = lc(name), salt = newSalt(), h = hashPw(newPw, salt);
      if (kind() === 'local') {
        var d = localDb(); if (!d.a[key]) throw new Error('Account not found');
        d.a[key].s = salt; d.a[key].h = h; saveLocal(d); return true;
      }
      return T(db().then(function (fb) {
        return fb.ref('mp-accounts/' + key).transaction(function (cur) {
          if (!cur) return;                                  // account vanished meanwhile
          cur.s = salt; cur.h = h;
          return cur;
        });
      })).then(function (res) { if (res && res.committed === false) throw new Error('Account not found'); return true; }, fail);
    });
  };

  // ------------------------------------------------------------- race result --
  // r = {key, players, won, place, score, dist, coins, ch, mode, ranked}.
  // Idempotent per r.key so a result is never counted twice. mode = 'coin'|
  // 'nocoin'; ranked races additionally move ranked RP (win +, loss -).
  A.record = function (r) {
    if (!sess) return Promise.resolve(null);
    var key = sess.key, name = sess.name;
    var ranked = !!r.ranked && (r.players | 0) >= 2;
    var mode = r.mode === 'nocoin' ? 'nocoin' : 'coin';
    var gained = (r.won && !ranked) ? A.winPoints(r.players) : 0;
    var rpDelta = ranked ? A.rankedPoints(r.players, !!r.won) : 0;
    var before = A.points(), xpGain = A.xpAward(r), lvBefore = A.levelOf(((profile && profile.xp) || 0)).lvl;
    function apply(p) {
      p = p || blank(name); p.n = name; p.seen = p.seen || []; p.hist = p.hist || []; p.md = p.md || {};
      if (p.seen.indexOf(r.key) >= 0) return p;
      p.seen.push(r.key); if (p.seen.length > 12) p.seen.shift();
      var wkk = weekKey(); if (p.wk !== wkk) { p.wk = wkk; p.wp = 0; }
      p.r = (p.r | 0) + 1;
      p.cc = (p.cc | 0) + (r.coins | 0);
      p.bs = Math.max(p.bs | 0, r.score | 0);
      p.bd = Math.max(p.bd | 0, r.dist | 0);
      p.td = (p.td | 0) + Math.max(0, r.dist | 0);
      p.ch = r.ch || p.ch || 'jake';
      if (r.won && r.players >= 2) { p.w = (p.w | 0) + 1; if (!ranked) { p.pts = (p.pts | 0) + gained; p.wp = (p.wp | 0) + gained; } p.st = (p.st | 0) + 1; p.bst = Math.max(p.bst | 0, p.st); }
      else if (r.players >= 2) p.st = 0;
      if (ranked) { p.pts = Math.max(0, (p.pts | 0) + rpDelta); if (r.won) p.rw = (p.rw | 0) + 1; else p.rl = (p.rl | 0) + 1; }
      // per-mode bucket (unranked + ranked, coin + no coin)
      var b = modeBucket(p, mode, ranked);
      b.r = (b.r | 0) + 1; b.cc = (b.cc | 0) + (r.coins | 0);
      b.bs = Math.max(b.bs | 0, r.score | 0); b.bd = Math.max(b.bd | 0, r.dist | 0);
      if (r.won && r.players >= 2) b.w = (b.w | 0) + 1;
      p.xp = (p.xp | 0) + xpGain;                                   // XP for every finished race
      p.hist = (p.hist || []).slice(-11);                           // real match history (last 12)
      p.hist.push({ ts: Date.now(), pl: r.place | 0, n: r.players | 0, sc: r.score | 0, d: Math.max(0, r.dist | 0), c: r.coins | 0, rp: rpDelta || gained, xp: xpGain, won: r.won ? 1 : 0, md: mode + (ranked ? '+r' : '') });
      p.ts = Date.now();
      return p;
    }
    var out;
    if (kind() === 'local') { var d = localDb(); d.p[key] = apply(d.p[key]); saveLocal(d); out = Promise.resolve(d.p[key]); }
    else out = T(db().then(function (fb) { return fb.ref('mp-profiles/' + key).transaction(function (cur) { return apply(cur); }); })).then(function (res) { return res.snapshot.val(); });
    return out.then(function (p) {
      profile = p; emit();
      var ra = A.rankOf(before), rb = A.rankOf(p.pts | 0);
      var lv = A.levelOf(p.xp | 0), lvUp = lv.lvl > lvBefore ? { from: lvBefore, to: lv.lvl } : null;
      return { gained: rpDelta || gained, xp: xpGain, total: p.pts | 0, rank: rb, rankedUp: rb.index > ra.index, level: lv, levelUp: lvUp, profile: p, ranked: ranked, rpDelta: rpDelta };
    }).catch(function (e) { console.warn('[MP] could not save result', e); return null; });
  };

  // ----------------------------------------------------------- leaderboards ---
  A.BOARDS = [
    { id: 'pts', name: 'Rank Points', unit: 'RP', field: 'pts' },
    { id: 'wk',  name: 'This Week',   unit: 'RP', field: 'wp' },
    { id: 'w',   name: 'Most Wins',   unit: 'wins', field: 'w' },
    { id: 'bs',  name: 'High Score',  unit: 'pts', field: 'bs' },
    { id: 'bd',  name: 'Best Distance', unit: 'm', field: 'bd' },
    { id: 'cc',  name: 'Coins',       unit: '', field: 'cc' }
  ];
  A.board = function (cat, limit) {
    limit = limit || 50;
    var def = A.BOARDS.filter(function (b) { return b.id === cat; })[0] || A.BOARDS[0];
    var wkk = weekKey();
    function build(all) {
      var rows = Object.keys(all || {}).map(function (k) { var p = all[k]; if (!p || typeof p !== 'object') return null; var v = def.id === 'wk' ? (p.wk === wkk ? p.wp | 0 : 0) : (p[def.field] | 0); return { key: k, name: p.n || k, ch: p.ch || 'jake', value: v, pts: p.pts | 0, wins: p.w | 0, races: p.r | 0, p: p }; })
        .filter(function (r) { return r && r.value > 0; });
      rows.sort(function (a, b) { return b.value - a.value || b.pts - a.pts || (a.name < b.name ? -1 : 1); });
      rows.forEach(function (r, i) { r.pos = i + 1; });
      return { def: def, rows: rows.slice(0, limit), all: rows };
    }
    if (kind() === 'local') return Promise.resolve(build(localDb().p));
    return T(db().then(function (fb) { return fb.ref('mp-profiles').once('value'); })).then(function (s) { return build(s.val()); }, fail);
  };

  // ------------------------------------------------- POKI18 mode boards -------
  // Per-mode leaderboards: board18('bs'|'bd'|'w'|'cc'|'r', 'coin'|'nocoin', ranked?)
  A.MODE_META = {
    coin:   { name: 'Coin Mode',    icon: 'coin' },
    nocoin: { name: 'No Coin Mode', icon: 'nocoin' }
  };
  A.board18 = function (field, mode, ranked, limit) {
    limit = limit || 50;
    var mk = modeKey(mode, ranked);
    var defs = { bs: { name: 'High Score', unit: 'pts', f: 'bs' }, bd: { name: 'Best Distance', unit: 'm', f: 'bd' }, w: { name: 'Most Wins', unit: 'wins', f: 'w' }, cc: { name: 'Coins', unit: '', f: 'cc' }, r: { name: 'Races', unit: 'races', f: 'r' } };
    var def = defs[field] || defs.bs;
    function build(all) {
      var rows = Object.keys(all || {}).map(function (k) {
        var p = all[k]; if (!p || typeof p !== 'object') return null;
        var b = (p.md || {})[mk]; if (!b || typeof b !== 'object') return null;
        return { key: k, name: p.n || k, ch: p.ch || 'jake', value: b[def.f] | 0, pts: p.pts | 0, wins: p.w | 0, races: p.r | 0, rw: p.rw | 0, rl: p.rl | 0, b: b, p: p };
      }).filter(function (r) { return r && r.value > 0; });
      rows.sort(function (a, b2) { return b2.value - a.value || b2.pts - a.pts || (a.name < b2.name ? -1 : 1); });
      rows.forEach(function (r, i) { r.pos = i + 1; });
      return { def: def, mode: mode, ranked: !!ranked, rows: rows.slice(0, limit), all: rows };
    }
    if (kind() === 'local') return Promise.resolve(build(localDb().p));
    return T(db().then(function (fb) { return fb.ref('mp-profiles').once('value'); })).then(function (s) { return build(s.val()); }, fail);
  };

  if (sess) setTimeout(function () { A.refresh(); }, 0);
})(window);



