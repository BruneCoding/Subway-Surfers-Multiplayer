/* mp-social.js - Poki13 social layer: friends, friend requests, lobby invites,
 * presence and profile extras (bio). Works on the same backend as the multiplayer
 * layer:
 *   firebase -> mp-friends/<key>/{list,in,out}, mp-presence/<key>, mp-invites/<key>/<id>
 *   local    -> localStorage (same browser) + BroadcastChannel between tabs
 * Exposes window.MPSocial. Every call is safe to make while logged out (resolves empty). */
(function (W) {
  'use strict';
  var S = W.MPSocial = {};
  var LS = 'mp_social_local';
  var subs = [];
  function emit() { subs.forEach(function (f) { try { f(); } catch (e) {} }); }
  S.onChange = function (f) { subs.push(f); return function () { subs = subs.filter(function (x) { return x !== f; }); }; };
  function kind() { return W.MPNet ? W.MPNet.kind() : 'local'; }
  S.kind = kind;
  function myKey() { var u = W.MPAcc && W.MPAcc.user(); return u ? u.key : null; }
  function myName() { var u = W.MPAcc && W.MPAcc.user(); return u ? u.name : null; }
  function db() { return W.MPNet.fb(); }
  function T(p, ms) { return W.MPNet.withTimeout(Promise.resolve(p), ms || 10000, 'Timed out'); }
  function fail(e) { throw new Error(W.MPNet.explain(e)); }

  // ----------------------------------------------------------- local store ---
  function ldb() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } }
  function ldbSave(d) { try { localStorage.setItem(LS, JSON.stringify(d)); } catch (e) {} }
  function ldbBucket(k) { var d = ldb(); d[k] = d[k] || {}; return d[k]; }
  var CH = null;
  function chan() {
    if (CH) return CH;
    try { CH = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ssmp-social') : null; } catch (e) { CH = null; }
    if (CH) {
      CH.onmessage = function (ev) {
        var m = ev.data || {}; if (!m.k) return;
        if (m.k === 'ping') { presenceRx(m.who); }
        else if (m.k === 'req' || m.k === 'acc' || m.k === 'unfriend' || m.k === 'inv') { setTimeout(function () { startListen(); emit(); }, 60); }
      };
    }
    return CH;
  }
  function post(m) { try { var c = chan(); c && c.postMessage(m); } catch (e) {} }

  // ------------------------------------------------------------- presence ---
  var presenceMap = {};              // local-mode live peers (BroadcastChannel)
  var presenceTimer = null, presenceState = { lobby: '' };
  function presenceRx(who) { if (who && who.key) { presenceMap[who.key] = { n: who.n, ts: Date.now(), lobby: who.lobby || '' }; } }
  function presenceBeat() {
    var k = myKey(); if (!k) return;
    var n = myName();
    if (kind() === 'firebase') {
      T(db().then(function (d) {
        var r = d.ref('mp-presence/' + k);
        try { r.onDisconnect().remove(); } catch (e) {}
        return r.set({ n: n, ts: W.MP_SERVER_OFF ? Date.now() + W.MP_SERVER_OFF : Date.now(), lobby: presenceState.lobby || '' });
      })).catch(function () {});
    } else {
      post({ k: 'ping', who: { key: k, n: n, lobby: presenceState.lobby || '' } });
    }
  }
  S.setLobby = function (code) { presenceState.lobby = code || ''; presenceBeat(); };
  S.start = function () {
    if (presenceTimer) return; chan();
    presenceBeat();
    presenceTimer = setInterval(presenceBeat, 25000);
    startListen();
  };
  S.stop = function () { clearInterval(presenceTimer); presenceTimer = null; stopListen(); };
  S.online = function (cb) {
    var k = myKey(); if (!k) { cb([]); return function () {}; }
    if (kind() === 'firebase') {
      var off = null, stop = false;
      T(db().then(function (d) {
        if (stop) return;
        var ref = d.ref('mp-presence');
        var fn = ref.on('value', function (s) {
          var v = s.val() || {}, now = Date.now() + (W.MP_SERVER_OFF || 0), out = [];
          Object.keys(v).forEach(function (x) { if (v[x] && v[x].n && now - (v[x].ts || 0) < 75000) out.push(Object.assign({ key: x }, v[x])); });
          cb(out, null);
        }, function (e) { cb([], e); });
        off = function () { try { ref.off('value', fn); } catch (e) {} };
      })).catch(function (e) { cb([], e); });
      return function () { stop = true; off && off(); };
    }
    // local: active BroadcastChannel peers + myself
    var iv = setInterval(function () {
      var now = Date.now(), out = [{ key: k, n: myName(), ts: now, lobby: presenceState.lobby || '' }];
      Object.keys(presenceMap).forEach(function (x) { if (now - presenceMap[x].ts < 8000) out.push(Object.assign({ key: x }, presenceMap[x])); });
      cb(out, null);
    }, 1500);
    presenceBeat();
    return function () { clearInterval(iv); };
  };

  function accsLocal() { try { return (JSON.parse(localStorage.getItem('mp_local_db') || '{}').a) || { }; } catch (e) { return { }; } }

  function accsLocal() { try { return (JSON.parse(localStorage.getItem('mp_local_db') || '{}').a) || { }; } catch (e) { return { }; } }

  // -------------------------------------------------------------- friends ---
  // shape: {list:{key:{n,ts}}, in:{...}, out:{...}}
  var cache = { list: {}, in: {}, out: {}, ready: false };
  function readLocal() {
    var k = myKey(); if (!k) return;
    var d = ldb(); var me = d[k] = d[k] || { list: {}, in: {}, out: {} };
    cache.list = me.list || {}; cache.in = me.in || {}; cache.out = me.out || {}; cache.ready = true;
  }
  function saveLocalBucket(bucket, val) {
    var k = myKey(); if (!k) return;
    var d = ldb(); var me = d[k] = d[k] || { list: {}, in: {}, out: {} };
    me[bucket] = me[bucket] || {};
    if (val) me[bucket][val.key] = { n: val.n, ts: Date.now() };
    else if (val === null && arguments[2]) delete me[bucket][arguments[2]];
    ldbSave(d); readLocal();
  }

  var listeners = [];
  function startListen() {
    stopListen();
    var k = myKey();
    if (!k) { cache = { list: {}, in: {}, out: {}, ready: true }; emit(); return; }
    if (kind() === 'firebase') {
      var base = null;
      T(db().then(function (d) {
        base = d.ref('mp-friends/' + k);
        ['list', 'in', 'out'].forEach(function (bk) {
          var fn = base.child(bk).on('value', function (s) { cache[bk] = s.val() || {}; cache.ready = true; emit(); }, function () {});
          listeners.push({ ref: base.child(bk), fn: fn });
        });
      })).catch(function () { cache.ready = true; emit(); });
    } else {
      readLocal(); cache.ready = true; emit();
    }
  }
  function stopListen() {
    listeners.forEach(function (l) { try { l.ref.off('value', l.fn); } catch (e) {} });
    listeners = [];
  }
  S.friends = function () { return Object.keys(cache.list || {}).map(function (x) { return Object.assign({ key: x }, cache.list[x]); }); };
  S.requestsIn = function () { return Object.keys(cache.in || {}).map(function (x) { return Object.assign({ key: x }, cache.in[x]); }); };
  S.requestsOut = function () { return Object.keys(cache.out || {}).map(function (x) { return Object.assign({ key: x }, cache.out[x]); }); };
  S.isFriend = function (key) { return !!(cache.list || {})[key]; };

  S.addFriend = function (name) {
    var k = myKey(); if (!k) return Promise.reject(new Error('Log in to add friends'));
    var to = String(name || '').trim().toLowerCase();
    if (!to) return Promise.reject(new Error('Type a username'));
    if (to === k) return Promise.reject(new Error('That is you'));
    if (S.isFriend(to)) return Promise.reject(new Error('Already friends'));
    var myN = myName();
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return d.ref('mp-profiles/' + to).once('value');
      })).then(function (s) {
        if (!s.exists()) throw new Error('No player named "' + name + '"');
        var theirN = (s.val() || {}).n || name;
        return T(db().then(function (d) {
          return Promise.all([
            d.ref('mp-friends/' + to + '/in/' + k).set({ n: myN, ts: Date.now() }),
            d.ref('mp-friends/' + k + '/out/' + to).set({ n: theirN, ts: Date.now() })
          ]);
        }));
      }).then(function () { emit(); return true; }, fail);
    }
    var accs = accsLocal();
    if (!accs[to]) return Promise.reject(new Error('No player named "' + name + '" in this browser'));
    var theirN = (accs[to] && accs[to].u) || name;
    saveLocalBucket('out', { key: to, n: theirN });
    var td = ldb(); var them = td[to] = td[to] || { list: {}, in: {}, out: {} };
    them.in = them.in || {}; them.in[k] = { n: myN, ts: Date.now() }; ldbSave(td);
    post({ k: 'req' }); emit(); return Promise.resolve(true);
  };

  S.acceptRequest = function (key) {
    var k = myKey(); if (!k) return Promise.reject(new Error('Not logged in'));
    var me = cache.in[key] || {};
    var myN = myName(), theirN = me.n || key;
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return Promise.all([
          d.ref('mp-friends/' + k + '/list/' + key).set({ n: theirN, ts: Date.now() }),
          d.ref('mp-friends/' + key + '/list/' + k).set({ n: myN, ts: Date.now() }),
          d.ref('mp-friends/' + k + '/in/' + key).remove(),
          d.ref('mp-friends/' + key + '/out/' + k).remove()
        ]);
      })).then(function () { emit(); }, fail);
    }
    saveLocalBucket('list', { key: key, n: theirN }); saveLocalBucket('in', null, key);
    var d = ldb(); var them = d[key] = d[key] || { list: {}, in: {}, out: {} };
    them.list = them.list || {}; them.list[k] = { n: myN, ts: Date.now() };
    them.out = them.out || {}; delete them.out[k]; ldbSave(d);
    post({ k: 'acc' }); emit(); return Promise.resolve(true);
  };

  S.declineRequest = function (key) {
    var k = myKey(); if (!k) return Promise.resolve();
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return Promise.all([d.ref('mp-friends/' + k + '/in/' + key).remove(), d.ref('mp-friends/' + key + '/out/' + k).remove()]);
      })).then(function () { emit(); }, fail);
    }
    saveLocalBucket('in', null, key);
    post({ k: 'acc' }); emit(); return Promise.resolve();
  };

  S.removeFriend = function (key) {
    var k = myKey(); if (!k) return Promise.resolve();
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return Promise.all([d.ref('mp-friends/' + k + '/list/' + key).remove(), d.ref('mp-friends/' + key + '/list/' + k).remove()]);
      })).then(function () { emit(); }, fail);
    }
    saveLocalBucket('list', null, key);
    var d = ldb(); if (d[key] && d[key].list) { delete d[key].list[k]; ldbSave(d); }
    post({ k: 'unfriend' }); emit(); return Promise.resolve();
  };

  // -------------------------------------------------------------- invites ---
  var inviteOff = null;
  // cb(banner) is called with {id, code, from, lobby} when someone invites me; banner auto-expires
  S.listenInvites = function (cb) {
    var k = myKey(); if (!k) return function () {};
    if (kind() === 'firebase') {
      var ref = null, added = null;
      T(db().then(function (d) {
        ref = d.ref('mp-invites/' + k);
        added = ref.on('child_added', function (s) {
          var v = s.val() || {};
          if (Date.now() + (W.MP_SERVER_OFF || 0) - (v.ts || 0) < 90000) cb({ id: s.key, code: v.code, from: v.from, lobby: v.lobby || '', key: v.fromKey, ranked: v.ranked || 0, mode: v.mode || 'coin' });
        }, function () {});
        inviteOff = function () { try { ref.off('child_added', added); } catch (e) {} };
      })).catch(function () {});
      return function () { inviteOff && inviteOff(); inviteOff = null; };
    }
    // local: poll my invites bucket (written by another tab)
    var iv = setInterval(function () {
      var d = ldb(); var inv = (d[k] && d[k].inv) || {}; var now = Date.now();
      Object.keys(inv).forEach(function (id) {
        if (inv[id] && !inv[id]._seen && now - (inv[id].ts || 0) < 90000) {
          inv[id]._seen = 1;
          cb({ id: id, code: inv[id].code, from: inv[id].from, lobby: inv[id].lobby || '', ranked: inv[id].ranked || 0, mode: inv[id].mode || 'coin' });
        }
      });
      var stale = Object.keys(inv).filter(function (id) { return now - (inv[id].ts || 0) > 120000; });
      stale.forEach(function (id) { delete inv[id]; });
      if (stale.length) { d[k].inv = inv; ldbSave(d); }
    }, 1200);
    return function () { clearInterval(iv); };
  };
  // POKI18: meta carries ranked-duel flags through the existing invite channel
  S.sendInvite = function (code, toKey, lobbyName, meta) {
    var k = myKey(); if (!k) return Promise.reject(new Error('Log in to invite players'));
    var myN = myName();
    meta = meta || {};
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return d.ref('mp-invites/' + toKey).push({ code: code, from: myN, fromKey: k, lobby: lobbyName || '', ts: Date.now(), ranked: meta.ranked || 0, mode: meta.mode || 'coin' });
      })).then(function () { return true; }, fail);
    }
    var d = ldb(); var them = d[toKey] = d[toKey] || { list: {}, in: {}, out: {} };
    them.inv = them.inv || {};
    them.inv['i' + Date.now()] = { code: code, from: myN, ts: Date.now(), ranked: meta.ranked || 0, mode: meta.mode || 'coin' };
    ldbSave(d); post({ k: 'inv' }); return Promise.resolve(true);
  };
  S.declineInvite = function (id) {
    var k = myKey(); if (!k) return Promise.resolve();
    if (kind() === 'firebase') {
      return T(db().then(function (d) { return d.ref('mp-invites/' + k + '/' + id).remove(); })).catch(function () {});
    }
    var d = ldb(); if (d[k] && d[k].inv) { delete d[k].inv[id]; ldbSave(d); }
    return Promise.resolve();
  };

  // ------------------------------------------------------------- profiles ---
  S.setBio = function (text) {
    var k = myKey(); if (!k) return Promise.reject(new Error('Log in first'));
    var b = String(text || '').slice(0, 160);
    if (kind() === 'firebase') {
      return T(db().then(function (d) { return d.ref('mp-profiles/' + k + '/b').set(b); })).then(function () { if (W.MPAcc.refresh) W.MPAcc.refresh(); return true; }, fail);
    }
    var d = ldb(); d['prof_' + k] = d['prof_' + k] || {}; d['prof_' + k].b = b; ldbSave(d);
    if (W.MPAcc.refresh) W.MPAcc.refresh();
    emit(); return Promise.resolve(true);
  };

  // full social profile of any account: friends, requests, presence, created time
  S.profileOf = function (key) {
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return Promise.all([
          d.ref('mp-profiles/' + key).once('value'),
          d.ref('mp-friends/' + key + '/list').once('value'),
          d.ref('mp-accounts/' + key + '/c').once('value'),
          d.ref('mp-presence/' + key).once('value')
        ]);
      })).then(function (r) {
        var prof = r[0].val() || {}, fl = r[1].val() || {}, created = r[2].val() || prof.c0 || 0, pres = r[3].val() || null;
        var now = Date.now() + (W.MP_SERVER_OFF || 0);
        return {
          key: key, profile: prof, created: created,
          friends: Object.keys(fl).map(function (x) { return Object.assign({ key: x }, fl[x]); }),
          friendsCount: Object.keys(fl).length,
          online: pres && now - (pres.ts || 0) < 75000
        };
      }, fail);
    }
    var d = ldb(); var me = d[key] || {};
    var fl = me.list || {};
    // Poki14: merge the REAL stats profile (mp-accounts store) with the social extras (bio)
    var profP = (W.MPAcc && W.MPAcc.fetchProfile) ? Promise.resolve(W.MPAcc.fetchProfile(key)).catch(function () { return null; }) : Promise.resolve(null);
    var profC = (W.MPAcc && W.MPAcc.created) ? W.MPAcc.created(key) : Promise.resolve(0);
    return Promise.all([profP, profC]).then(function (r) {
      var stats = r[0] || {};
      return {
        key: key, profile: Object.assign({}, stats, d['prof_' + key] || {}), created: r[1] || stats.c0 || 0,
        friends: Object.keys(fl).map(function (x) { return Object.assign({ key: x }, fl[x]); }),
        friendsCount: Object.keys(fl).length,
        online: key === myKey() || (Date.now() - ((presenceMap[key] || {}).ts || 0) < 8000)
      };
    });
  };

  // every known player (for the host INVITE list): profiles + live presence
  S.allPlayers = function (cb) {
    if (kind() === 'firebase') {
      return T(db().then(function (d) {
        return Promise.all([d.ref('mp-profiles').limitToFirst(300).once('value'), d.ref('mp-presence').once('value')]);
      })).then(function (r) {
        var profs = r[0].val() || {}, pres = r[1].val() || {}, now = Date.now() + (W.MP_SERVER_OFF || 0), out = [];
        Object.keys(profs).forEach(function (k) {
          var p = profs[k]; if (!p || typeof p !== 'object') return;
          out.push({ key: k, n: p.n || k, pts: p.pts | 0, ch: p.ch || 'jake', online: pres[k] && now - (pres[k].ts || 0) < 75000, lobby: (pres[k] || {}).lobby || '' });
        });
        Object.keys(pres).forEach(function (k) {
          if (profs[k] || now - (pres[k].ts || 0) >= 75000 || !(pres[k] && pres[k].n)) return;
          out.push({ key: k, n: pres[k].n, pts: 0, ch: 'jake', online: true, lobby: pres[k].lobby || '' });
        });
        out.sort(function (a, b) { return (b.online - a.online) || (b.pts - a.pts) || a.n.localeCompare(b.n); });
        cb(out, null);
      }, function (e) { cb([], e); }).catch(function (e) { cb([], e); });
    }
    var d = ldb(), now = Date.now(), out = [];
    var accs = accsLocal();
    Object.keys(accs).forEach(function (k) {
      var a = accs[k], p = d['prof_' + k] || {};
      out.push({ key: k, n: (a && a.u) || k, pts: p.pts | 0, ch: p.ch || 'jake', online: k === myKey() || now - ((presenceMap[k] || {}).ts || 0) < 8000, lobby: (presenceMap[k] || {}).lobby || '' });
    });
    out.sort(function (a, b) { return (b.online - a.online) || a.n.localeCompare(b.n); });
    cb(out, null);
  };

  // ------------------------------------------------- server time offset -----
  if (kind() === 'firebase') {
    try {
      W.MPNet.fb().then(function (d) {
        d.ref('.info/serverTimeOffset').on('value', function (s) { W.MP_SERVER_OFF = s.val() || 0; });
      }).catch(function () {});
    } catch (e) {}
  }
  if (W.MPAcc && W.MPAcc.onChange) W.MPAcc.onChange(function (u) { if (u) S.start(); else { S.stop(); cache = { list: {}, in: {}, out: {}, ready: true }; emit(); } });
  if (W.MPAcc && W.MPAcc.user()) setTimeout(function () { S.start(); }, 0);
})(window);
