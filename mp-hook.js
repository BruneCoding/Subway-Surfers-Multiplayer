/* mp-hook.js - race multiplayer layer (v2).  Open index.html?mp=1
 *   lobby browser · character/board picker · shared seeded track · live ghosts (real models)
 *   no-coin mode · spectate after crash · full leaderboard                                     */
(function (W) {
  'use strict';
  var MP = W.MP = {};
  var params = new URLSearchParams(location.search);
  var UI_ON = params.has('mp');

  // ---------------------------------------------------------------- utils ---
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(str) { var h = 2166136261; str = String(str); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function withRng(seedStr, fn) { var old = Math.random; Math.random = mulberry32(hash(seedStr)); try { return fn(); } finally { Math.random = old; } }
  function rnd1(v) { return Math.round(v * 10) / 10; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ------------------------------------------------ deterministic world ------
  var theirSh = {}; function flagDesync(u, at) { if (MP.desync) return; MP.desync = u; console.warn('[MP] WORLD DESYNC vs', u, 'at chunk', at); try { toast('\u26A0 Track out of sync with ' + ((players[u] && players[u].name) || 'a player'), 4000); } catch (e) {} }
  var seed = '0', seq = 0, mnt = 0, cd = 0, landings = [], installed = false, BLOCK = 45, inSeq = 0, sub = 0, xcnt = {}, sh = 0, shAt = {};

  MP.ready = function () {
    return !!(W.game && W.game.hero && W.game.level && W.__MP_APP && W.__MP_APP.library && W.__MP_APP.library.hasResourcesForFullGameplay());
  };

  function resetCounters() {
    seq = 0; mnt = 0; cd = 0; landings = []; inSeq = 0; sub = 0; xcnt = {}; sh = 0; shAt = {};
    try { W.game.pickup.timedPickups.length = 0; } catch (e) {}
  }
  MP.resetCounters = resetCounters;

  MP.installWorld = function (s) {
    seed = String(s);
    var g = W.game, L = g.level;
    if (!installed) {
      installed = true;
      var oNIS = L.nextInSequence, oPNC = L.placeNextChunk, oSSL = L.setSafeLanding;
      L.nextInSequence = function () {
        seq++;
        var st = g.stats.data, svT = st.time, svD = st.distance, node;
        st.time = cd / 150; st.distance = cd;
        inSeq++; sub = 0;
        try { node = withRng(seed + '|s|' + seq, function () { return oNIS.call(L); }); }
        finally { inSeq--; st.time = svT; st.distance = svD; }
        var rc = node && node.components && node.components.RouteChunk;
        cd += ((rc && rc._blockCount) || 0) * BLOCK;
        sh = hash(sh + '|' + (node && node.name || '?') + '|' + cd); shAt[seq] = sh; delete shAt[seq - 40];
        Object.keys(theirSh).forEach(function (u) { var t = theirSh[u]; if (t[seq] != null && t[seq] !== sh) flagDesync(u, seq); delete t[seq - 60]; });
        return node;
      };
      L.placeNextChunk = function (name) {
        // Key by WHERE the chunk is in the shared sequence, never by a per-client call counter: a chunk placed on
        // one client only (jetpack landing, revive, ...) used to shift the counter and desync every later chunk.
        var key;
        if (name === 'intro') key = 'intro';
        else if (inSeq) key = 'n' + seq + '|' + (++sub);
        else { var xk = 'x|' + String(name || '') + '|' + cd; xcnt[xk] = (xcnt[xk] || 0) + 1; key = xk + '|' + xcnt[xk]; }
        return withRng(seed + '|' + key, function () { return oPNC.call(L, name); });
      };
      L.setSafeLanding = function (t) {
        var r = oSSL.call(L, t), c = L.chunks[L.chunks.length - 1];
        if (c) landings.push({ at: c.start, len: c.length });
        return r;
      };
      g.revive = function () {};
      // Spectating: place the hero/camera rig BEFORE the engine's own update so the camera never lags a frame behind.
      try {
        var oUpd = g.update, lastSp = performance.now();
        g.update = function () {
          if (phase === 'spectate') { var n = performance.now(); try { followSpectated(Math.min(0.1, (n - lastSp) / 1000)); } catch (e) {} lastSp = n; }
          return oUpd.apply(this, arguments);
        };
      } catch (e) { console.warn('[MP] update hook', e); }
      // A crash must NOT end the game engine: level generation only runs while RUNNING, and a crashed
      // player needs the track to keep coming so they can spectate runners that are further ahead.
      g.gameover = function () { try { onCrash(); } catch (e) { console.error(e); } };
      g.onReset.add({ reset: resetCounters });
    }
    resetCounters();
  };

  MP.begin = function (s) {
    var g = W.game;
    MP.installWorld(s);
    g.tutorial.enabled = false;
    try { W.__MP_APP.user.tutorial = true; } catch (e) {}
    W.__MP_APP.nav.toGame();
  };

  function toCanon(w) {
    var sub = 0;
    for (var i = 0; i < landings.length; i++) { var l = landings[i]; if (w >= l.at + l.len) sub += l.len; else if (w > l.at) return l.at - sub; }
    return w - sub;
  }
  function toWorld(c) {
    var add = 0, P = 0;
    for (var i = 0; i < landings.length; i++) { var l = landings[i]; if (c >= l.at - P) add += l.len; P += l.len; }
    return c + add;
  }

  MP.getWorldSignature = function (minAbsZ, maxAbsZ) {
    var g = W.game, ents = g.level.entities, rows = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], z = e.position.z, az = Math.abs(z);
      if (az < (minAbsZ || 0) || az > (maxAbsZ || 1e9)) continue;
      rows.push(e.constructor.name + '|' + (e.name || '') + '|' + rnd1(e.position.x) + '|' + rnd1(e.position.y) + '|' + rnd1(z));
    }
    rows.sort();
    return { hash: hash(rows.join(';')), entities: rows.length, chunks: g.level.chunks.map(function (c) { return c.name.replace('routeChunk_', '') + '@' + c.start; }) };
  };

  // ----------------------------------------------------------------- data ---
  var CHARS = [['jake', 'Jake'], ['tricky', 'Tricky'], ['yutani', 'Yutani'], ['lucy', 'Lucy'], ['tagbot', 'Tagbot'], ['ninja', 'Ninja'], ['tasha', 'Tasha'], ['king', 'King'], ['brody', 'Brody']];
  var BOARDS = ['hoverboard', 'starboard', 'lumberjack', 'superhero', 'sunset', 'greatwhite', 'monster', 'scoot', 'bigkahuna', 'skullfire', 'daredevil', 'teleporter', 'bouncer', 'hotrod', 'lowrider', 'windglider'];
  var BNAME = { hoverboard: 'Classic', bigkahuna: 'Big Kahuna', greatwhite: 'Great White', hotrod: 'Hot Rod', lowrider: 'Low Rider', windglider: 'Wind Glider', skullfire: 'Skull Fire', daredevil: 'Daredevil', superhero: 'Superhero' };
  function bname(id) { return BNAME[id] || cap(id); }
  function cname(id) { for (var i = 0; i < CHARS.length; i++) if (CHARS[i][0] === id) return CHARS[i][1]; return cap(id || '?'); }
  var NAMECOLS = ['#ffffff', '#ffd740', '#69f0ae', '#40c4ff', '#ff5252', '#e040fb', '#ff9100', '#b2ff59', '#ff80ab', '#18ffff', '#8c9eff', '#ffab40', '#00e676', '#f4ff81', '#ff6e40', '#b388ff'];
  // ---- badges: real vector icons (no emoji)
  var BADGE_ICONS = [
    { id: '', name: 'None', svg: '' },
    { id: 'star', name: 'Star', svg: '<path d="M12 2.2l2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.1l-5.8 3.1 1.1-6.5L2.6 9.1l6.5-.9z" fill="#ffd740" stroke="rgba(0,0,0,.45)" stroke-width="1"/>' },
    { id: 'flame', name: 'Flame', svg: '<path d="M12 2c1 3.4-1.4 5.1-2.7 7C7.6 11.4 7 13 7 15a5 5 0 0 0 10 0c0-1.7-.5-3.2-1.4-4.6-.5 1-1.2 1.7-2.1 2.2.6-3.4-.2-7-1.5-10.6z" fill="#ff7a2f" stroke="rgba(0,0,0,.45)" stroke-width="1"/>' },
    { id: 'crown', name: 'Crown', svg: '<path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z" fill="#ffd23f" stroke="rgba(0,0,0,.45)" stroke-width="1"/><circle cx="12" cy="15" r="1.6" fill="#e23b4e"/>' },
    { id: 'bolt', name: 'Bolt', svg: '<path d="M13.5 2L5 13.5h5L9 22l9-12h-5.4l.9-8z" fill="#ffe14d" stroke="rgba(0,0,0,.45)" stroke-width="1"/>' },
    { id: 'skull', name: 'Skull', svg: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.6 5 3.5 6.1V20a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2v-3.9C18.4 15 20 13 20 10a8 8 0 0 0-8-8z" fill="#e8edf2" stroke="rgba(0,0,0,.45)" stroke-width="1"/><circle cx="9" cy="10.5" r="1.9" fill="#1b2430"/><circle cx="15" cy="10.5" r="1.9" fill="#1b2430"/><path d="M11 14.5h2l-1 2.4z" fill="#1b2430"/>' },
    { id: 'clover', name: 'Clover', svg: '<path d="M12 11c-1-3-4-4.5-6-3s-1.6 5 1.5 5.7c-2.6 1.5-1.4 5 1 5.3 1.9.2 3-1.4 3.5-3 .5 1.6 1.6 3.2 3.5 3 2.4-.3 3.6-3.8 1-5.3 3.1-.7 3.5-4.2 1.5-5.7s-5 0-6 3z" fill="#5fe07a" stroke="rgba(0,0,0,.4)" stroke-width="1"/><path d="M11 18l-2 4h4l-2-4z" fill="#5fe07a"/>' },
    { id: 'rocket', name: 'Rocket', svg: '<path d="M12 2c3.5 2 5 6 4.4 10.4l2.1 3.1-3.3.3A9.6 9.6 0 0 1 12 22a9.6 9.6 0 0 1-3.2-6.2l-3.3-.3 2.1-3.1C7 8 8.5 4 12 2z" fill="#cfd8e2" stroke="rgba(0,0,0,.45)" stroke-width="1"/><circle cx="12" cy="10" r="2.2" fill="#37b6ff" stroke="rgba(0,0,0,.4)"/><path d="M12 22c-1 0-1.8-1.2-2.2-2.8.7.4 1.4.6 2.2.6s1.5-.2 2.2-.6C13.8 20.8 13 22 12 22z" fill="#ff7a2f"/>' },
    { id: 'gem', name: 'Gem', svg: '<path d="M12 2l8 7-8 13L4 9z" fill="#5fe3d0" stroke="rgba(0,0,0,.45)" stroke-width="1"/><path d="M12 2l3 7h-6zM4 9h16l-8 13z" fill="rgba(255,255,255,.25)"/>' },
    { id: 'game', name: 'Gamer', svg: '<path d="M7 8h10a5 5 0 0 1 0 10c-1.7 0-2.6-.8-3.5-1.7h-3C9.6 17.2 8.7 18 7 18a5 5 0 0 1 0-10z" fill="#4f8cff" stroke="rgba(0,0,0,.45)" stroke-width="1"/><path d="M8 12h2M9 11v2" stroke="#fff" stroke-width="1.4"/><circle cx="15.5" cy="11.5" r="1.1" fill="#ffd740"/><circle cx="17.5" cy="13.5" r="1.1" fill="#ff5252"/>' },
    { id: 'trophy', name: 'Trophy', svg: '<path d="M7 3h10v2h4a5 5 0 0 1-5 5.6A5.5 5.5 0 0 1 13 13v3h3v3H8v-3h3v-3a5.5 5.5 0 0 1-3-2.4A5 5 0 0 1 3 5h4V3z" fill="#ffc82f" stroke="rgba(0,0,0,.45)" stroke-width="1"/>' },
    { id: 'diamond', name: 'Diamond', svg: '<path d="M12 3l7 5-7 13L5 8l7-5z" fill="#6fa8ff" stroke="rgba(0,0,0,.45)" stroke-width="1"/><path d="M5 8h14l-7 13z" fill="rgba(255,255,255,.3)"/>' },
    { id: 'skate', name: 'Skater', svg: '<rect x="3" y="10" width="18" height="4" rx="2" fill="#ff8a2f" stroke="rgba(0,0,0,.45)" stroke-width="1"/><circle cx="8" cy="17" r="2" fill="#2b3444"/><circle cx="16" cy="17" r="2" fill="#2b3444"/><path d="M6 8l3-3M18 8l-3-3" stroke="#ffd740" stroke-width="1.6"/>' },
    { id: 'train', name: 'Conductor', svg: '<rect x="5" y="4" width="14" height="12" rx="3" fill="#e23b4e" stroke="rgba(0,0,0,.45)" stroke-width="1"/><rect x="7" y="6.5" width="10" height="4" rx="1.4" fill="#bfe6ff"/><circle cx="8.5" cy="14" r="1.6" fill="#2b3444"/><circle cx="15.5" cy="14" r="1.6" fill="#2b3444"/><path d="M7 20l2-2h6l2 2" stroke="#8fa3d0" stroke-width="1.6"/>' },
    { id: 'rainbow', name: 'Rainbow', svg: '<path d="M3 17a9 9 0 0 1 18 0" fill="none" stroke="#ff5252" stroke-width="2"/><path d="M5.5 17a6.5 6.5 0 0 1 13 0" fill="none" stroke="#ffd740" stroke-width="2"/><path d="M8 17a4 4 0 0 1 8 0" fill="none" stroke="#5fe07a" stroke-width="2"/><path d="M10.5 17a1.5 1.5 0 0 1 3 0" fill="none" stroke="#4f8cff" stroke-width="2"/>' },
    { id: 'ghost', name: 'Ghost', svg: '<path d="M12 3a7 7 0 0 0-7 7v10l2.4-2 2.3 2 2.3-2 2.3 2 2.3-2 2.4 2V10a7 7 0 0 0-7-7z" fill="#dfe8f2" stroke="rgba(0,0,0,.4)" stroke-width="1"/><circle cx="9.5" cy="10" r="1.5" fill="#1b2430"/><circle cx="14.5" cy="10" r="1.5" fill="#1b2430"/>' },
    { id: 'target', name: 'Target', svg: '<circle cx="12" cy="12" r="9" fill="#f4f7fa" stroke="rgba(0,0,0,.4)"/><circle cx="12" cy="12" r="6" fill="#ff5252"/><circle cx="12" cy="12" r="3" fill="#fff"/><circle cx="12" cy="12" r="1.4" fill="#e23b4e"/>' },
    { id: 'bomb', name: 'Bomb', svg: '<circle cx="11" cy="14" r="7" fill="#3a4658" stroke="rgba(0,0,0,.5)"/><path d="M14 8l2-3 3 1" fill="none" stroke="#ffd740" stroke-width="1.8"/><path d="M19 4.5l1.8 1.2M19.5 6.8l1.6-.8" stroke="#ff9a2f" stroke-width="1.5"/><circle cx="9" cy="12" r="1.6" fill="#5a6a82"/>' },
    { id: 'snow', name: 'Frost', svg: '<path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1" stroke="#8fdcff" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.4" fill="#dff4ff" stroke="#8fdcff"/>' }
  ];
  function badgeSvg(id) {
    for (var i = 0; i < BADGE_ICONS.length; i++) if (BADGE_ICONS[i].id === id) return BADGE_ICONS[i].svg ? '<svg class="bdg" viewBox="0 0 24 24" aria-label="' + esc(BADGE_ICONS[i].name) + '">' + BADGE_ICONS[i].svg + '</svg>' : '';
    return ''; // unknown / legacy emoji badges are dropped
  }
  function badgeKnown(id) { for (var i = 0; i < BADGE_ICONS.length; i++) if (BADGE_ICONS[i].id === id) return true; return false; }
  // ---- POKI18: account badge helpers (crown for the owner account, custom admin badges)
  function MP18_badgeCrown() {
    return '<svg viewBox="0 0 24 24" style="width:1.1em;height:1.1em;vertical-align:-0.14em;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))"><path d="M3 7.4l4.2 3 4.8-6 4.8 6 4.2-3-2.1 11H5.1L3 7.4z" fill="#ffd23f" stroke="rgba(0,0,0,.5)" stroke-width="1"/><circle cx="12" cy="14.6" r="1.7" fill="rgba(0,0,0,.4)"/></svg>';
  }
  var MP18_custom = [];
  function MP18_customBadgeById(id) { for (var i = 0; i < MP18_custom.length; i++) if (MP18_custom[i].id === id) return MP18_custom[i]; return null; }
  function MP18_customBadgeSvg(b) {
    var col = b.col || '#ffd23f';
    var inner = W.MPAcc && W.MP18 ? W.MP18.badges.icoSvg(b.ico, col) : '';
    return inner;
  }
  function bn(p) {
    var c = p.tc != null && NAMECOLS[p.tc] ? NAMECOLS[p.tc] : '#ffffff', rk = '';
    if (p.tr && p.rk != null && W.MPAcc) { var r = W.MPAcc.rankOf(p.rk); rk = '<i class="nrk" title="' + esc(r.name) + '">' + r.sigil + '</i>'; }
    var op = p.to == null ? 1 : Math.max(0.3, Math.min(1, (p.to | 0) / 10));
    var und = (p.tu != null && p.tu >= 0 && NAMECOLS[p.tu]) ? ';--nu:' + NAMECOLS[p.tu] : '';
    var ab18 = '';
    if (p.ow) ab18 += '<i class="nab" title="Developer / platform owner">' + MP18_badgeCrown() + '</i>';
    if (p.ab) { var cb18 = MP18_customBadgeById(p.ab); if (cb18) ab18 += '<i class="nab" title="' + esc(cb18.n) + '">' + MP18_customBadgeSvg(cb18) + '</i>'; }
    return '<span class="nt np' + (p.tp | 0) + ' nf' + (p.tf | 0) + ' ns' + (p.tq | 0) + '" style="--nc:' + c + ';--no:' + op + und + '">' + rk + ab18 + (p.tt ? '<i class="nbd">' + badgeSvg(p.tt) + '</i>' : '') + '<span class="nn">' + esc(p.name) + '</span></span>';
  }
  var OPTDEFS = [
    { k: 'noCoin', t: 'bool', i: '🪙', n: 'No coin', d: 'touching a coin ends the round for everyone', def: false },
    { k: 'coinKeep', t: 'bool', i: '🚫', n: 'No coin: others keep playing', d: 'with No coin on, only the player who grabs a coin is out', def: false },
    { k: 'stopwatch', t: 'bool', i: '⏱', n: 'Stopwatch', d: "show a live race timer - in No Coin Mode it also tracks each player's time until their first coin", def: false },
    { k: 'boards', t: 'bool', i: '🛹', n: 'Hoverboards', d: 'double-tap / space to ride your chosen board', def: true },
    { k: 'boardCount', t: 'sel', i: '\u23F9', n: 'Hoverboards per run', d: 'how many boards each player starts with', def: 3, ch: [[1, '1'], [3, '3'], [5, '5'], [9, '9'], [15, '15'], [25, '25']] },
    { k: 'boardInf', t: 'bool', i: '\u221E', n: 'Infinite hoverboards', d: 'boards never run out this round', def: false },
    { k: 'goalType', t: 'sel', i: '🎯', n: 'Race objective', d: 'first player to reach the target wins the round', def: 'none', ch: [['none', 'Last runner standing'], ['dist', 'Distance'], ['coins', 'Coins'], ['score', 'Score']] },
    { k: 'goalValue', t: 'num', i: '🏁', n: 'Objective target', d: 'distance (m), coins or score to reach (e.g. 10000 / 5000)', def: 10000 },
    { k: 'timeLimit', t: 'sel', i: '⏱', n: 'Time limit', d: 'round ends when time is up; best score wins', def: 0, ch: [[0, 'Off'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']] },
    { k: 'seed', t: 'txt', i: '🌱', n: 'Fixed track seed', d: 'same text = same track every round (blank = random)', def: '' },
    { k: 'countdown', t: 'sel', i: '⏳', n: 'Start countdown', d: 'seconds before GO', def: 5, ch: [[3, '3 s'], [5, '5 s'], [10, '10 s']] },
    { k: 'noGhosts', t: 'bool', i: '👻', n: 'Blind race', d: 'hide opponents while running (you only see yourself)', def: false },
    { k: 'noNames', t: 'bool', i: '🏷', n: 'Hide nametags', d: 'no names above opponents', def: false },
    { k: 'noSpectate', t: 'bool', i: '👁', n: 'No spectating', d: 'crashed players cannot watch the others', def: false },
    { k: 'noPause', t: 'bool', i: '⏸', n: 'Disable pause', d: 'blocks Esc / P pausing for everyone while racing', def: false },
    { k: 'hudMode', t: 'sel', i: '📊', n: 'Standings display', d: 'top-left scoreboard, top position bar, or both', def: 'board', ch: [['board', 'Scoreboard (top-left)'], ['bar', 'Position bar (top)'], ['both', 'Both']] }
  ];
  function optVal(o, d) { var v = o && o[d.k]; return v === undefined || v === null ? d.def : v; }
  function cleanOpts(o) {
    var r = {}; OPTDEFS.forEach(function (d) {
      var v = optVal(o, d);
      if (d.t === 'bool') v = !!v; else if (d.t === 'num') v = Math.max(100, Math.min(1000000, parseInt(v, 10) || d.def));
      else if (d.t === 'txt') v = String(v || '').trim().slice(0, 20);
      else if (typeof d.def === 'number') v = parseInt(v, 10) || 0; else v = String(v);
      r[d.k] = v;
    }); return r;
  }
  var COLORS = ['#ff5252', '#40c4ff', '#ffd740', '#69f0ae', '#e040fb', '#ff9100', '#18ffff', '#b2ff59'];
  function colorOf(uid) { return COLORS[hash(uid) % COLORS.length]; }
  function preview(ch) { return 'assets/character-previews/preview-' + esc(ch || 'jake') + '.webp'; }
  var DEATH_CLIP = { train: 'death_movingTrain', upper: 'death_upper', lower: 'death_lower', bounce: 'death_bounce', out: 'death_bounce' };

  function icoTrophy(sz) { return '<svg viewBox="0 0 24 24"' + (sz ? ' style="width:' + sz + 'px;height:' + sz + 'px"' : ' class="ico"') + '><path d="M7 3h10v2h4a5 5 0 0 1-5 5.6A5.5 5.5 0 0 1 13 13v3h3v3H8v-3h3v-3a5.5 5.5 0 0 1-3-2.4A5 5 0 0 1 3 5h4V3z" fill="#ffd23f"/></svg>'; }
  function icoGear() { return '<svg viewBox="0 0 24 24" class="ico"><path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm8.6 3.5c0-.6-.1-1.2-.2-1.7l2-1.6-2-3.4-2.4 1a8 8 0 0 0-3-1.7L14.6 2h-4l-.4 2.6a8 8 0 0 0-3 1.7l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 3.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 3 1.7l.4 2.6h4l.4-2.6a8 8 0 0 0 3-1.7l2.4 1 2-3.4-2-1.6c.1-.5.2-1.1.2-1.7z" fill="none" stroke="#cfe0ff" stroke-width="1.5"/></svg>'; }
  function icoUser() { return '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="8" r="4" fill="none" stroke="#cfe0ff" stroke-width="1.8"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="none" stroke="#cfe0ff" stroke-width="1.8"/></svg>'; }
  function icoGlobe() { return '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="12" r="9" fill="none" stroke="#59c2ff" stroke-width="1.6"/><path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z" fill="none" stroke="#59c2ff" stroke-width="1.6"/></svg>'; }
  function icoShirt() { return '<svg viewBox="0 0 24 24" class="ico"><path d="M8 3l4 2 4-2 5 4-2.5 3L17 8.8V21H7V8.8L5.5 10 3 7z" fill="rgba(255,255,255,.9)"/></svg>'; }
  function icoChat() { return '<svg viewBox="0 0 24 24" class="ico"><path d="M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z" fill="none" stroke="#59c2ff" stroke-width="1.8" stroke-linejoin="round"/></svg>'; }

  function logoImg(small) {
    var c = W.MP_CONFIG || {}, a = c.logo || 'Logo.png', b = c.logoFallback || '';
    return '<img class="mp-logo-img' + (small ? ' sm' : '') + '" src="' + esc(a) + '" alt="Logo" ' +
      (b ? 'onerror="this.onerror=null;this.src=\'' + esc(b) + '\'"' : '') + '>';
  }

  // --------------------------------------------------------------- state ----
  var net = null, listNet = null, stopListFn = null, lobbies = [], listErr = null;
  var me = { uid: '', name: '', char: 'jake', board: 'hoverboard', tp: 0, tf: 0, tr: 0 }, code = '', isHost = false;
  var room = null, players = {}, states = {}, lastState = {}, lastName = {}, lastChar = {}, mine = null;
  var phase = 'boot';
  var round = 0, opts = {}, scheduledFor = 0, raceStart = 0, running = false, finished = false, hostGone = false;
  var dead = false, frozen = null, coinT = 0, deathAt = 0, deathWz = 0, deathCause = '';
  var spec = { uid: null, since: 0, exit: false };
  var ghosts = {}, loadingChars = {};
  var cdTimer = null, pubTimer = null, hudTimer = null, readyTimer = null;
  var draft = cleanOpts({});
  var gchat = null, lchat = null, gmsgs = [], lmsgs = [], gtMine = 0, gerr = '', lerr = '';
  MP.dbg = { ghosts: ghosts, get states() { return states; }, get players() { return players; }, get room() { return room; }, get phase() { return phase; }, get spec() { return spec; }, get dead() { return dead; } };
  MP.dbgCam = { get SPEC() { return SPEC; }, get ORB() { return SPEC_ORB; }, get FREE() { return FREE; }, get mode() { return specMode; }, get ghosts() { return ghosts; }, get meUid() { return me.uid; }, get running() { return running; } };

  // ------------------------------------------------- characters & loadout ---
  function charLoaded(id) { var A = W.__MP_APP; return !!(A && A.library && A.library.hasScene('avatar_' + id)); }
  function loadChar(id) {
    var A = W.__MP_APP;
    if (!id || !A || !A.library || !A.loader) return Promise.resolve(false);
    if (charLoaded(id)) return Promise.resolve(true);
    if (loadingChars[id]) return loadingChars[id];
    loadingChars[id] = Promise.resolve().then(function () { return A.loader.loadCharacter(id, true); })
      .catch(function (e) { console.warn('[MP] could not load character', id, e); })
      .then(function () { delete loadingChars[id]; return charLoaded(id); });
    return loadingChars[id];
  }
  function applyLoadout() {
    var A = W.__MP_APP, u = A.user, hb = W.game.hero.hoverboard;
    try { if (u.character !== me.char) u.character = me.char; } catch (e) { console.warn(e); }
    try { u.board = me.board; } catch (e) { }
    try { u.boardPowers = [0]; } catch (e) { }
    try { u.boosts.consumables.hoverboard = opts.boards === false ? 0 : (opts.boardInf ? 99 : ((opts.boardCount | 0) || 3)); } catch (e) { }
    if (opts.boards === false) hb.turnOn = function () { }; else delete hb.turnOn;
  }

  // ---------------------------------------------------------- live state ----
  function myLive() {
    var g = W.game, h = g.hero, an = h.anim;
    return {
      rd: round,
      d: +toCanon(-h.position.z).toFixed(1), x: +h.position.x.toFixed(2), y: +h.position.y.toFixed(2),
      bh: +(h.body.height || 11).toFixed(1),
      a: String(an.currentAnimationClipName || 'run3'), l: an.currentAnimationLoop ? 1 : 0, sp: +(an.speed || 1).toFixed(2),
      b: (h.hoverboard && h.hoverboard.isOn && h.hoverboard.isOn()) ? String(h.hoverboard.boardId || 'hoverboard') : '',
      gy: +((h.body && h.body.ground) || 0).toFixed(1), cy: +((h.player && h.player.cameraY) || 0).toFixed(2), cr: +((h.player && h.player.cameraRotX) || 0).toFixed(3), cl: (h.player && h.player.cameraLow) ? 1 : 0,
      sc: Math.round(g.stats.score) || 0, c: (g.stats.coins | 0) || 0, ct: coinT || 0, gt: gtMine || 0, dead: 0, dc: '', sq: seq, sh: sh
    };
  }
  function hideGuard() { try { var gd = W.game.guard; if (gd) { gd.visible = false; gd.position.z = 5000; } } catch (e) {} }
  function showGuard() { try { var gd = W.game.guard; if (gd) gd.visible = true; } catch (e) {} }
  function onCrash() {
    if (!running || dead) return;
    var g = W.game, h = g.hero, snap = myLive();
    deathCause = (h.player && h.player.deathCause) || 'lower';
    deathWz = -h.position.z; deathAt = performance.now();
    snap.dead = 1; snap.dc = deathCause; snap.l = 0; snap.a = DEATH_CLIP[deathCause] || 'death_lower';
    frozen = snap; mine = snap; dead = true;
    try { h.body.ghost = true; h.body.velocity.z = 0; } catch (e) {}
    try { h.anim.play(snap.a, { sudden: true, loop: false }); } catch (e) {}
    hideGuard();
    pushState();
    toast('You crashed! ' + snap.sc + ' pts', 2200);
  }
  var lastSendSig = '';
  function pushState() {
    if (!net) return;
    var s = dead && frozen ? frozen : myLive();
    var sig = JSON.stringify(s);
    if (sig === lastSendSig && !s.dead) return;              // heartbeat with no change: skip the write
    lastSendSig = sig;
    mine = s; lastState[me.uid] = s;
    try { net.sendState(s); } catch (e) { console.warn('[MP] sendState', e); }
  }
  function tick() {
    if (!running || !net) return;
    var g = W.game;
    if (opts.boardInf) { try { W.__MP_APP.user.boosts.consumables.hoverboard = 99; } catch (e) { } }
    if (!dead && !coinT && ((g.stats.coins | 0) > 0)) { coinT = net.now(); if (opts.noCoin && opts.coinKeep) { toast('\uD83E\uDE99 Coin! You are out', 2000); onCrash(); } }
    if (!dead && !gtMine && opts.goalType && opts.goalType !== 'none') {
      var gv = opts.goalType === 'dist' ? toCanon(-g.hero.position.z) : opts.goalType === 'coins' ? (g.stats.coins | 0) : (g.stats.score || 0);
      if (gv >= (opts.goalValue || 10000)) gtMine = net.now();
    }
    pushState();
  }

  // --------------------------------------------------------------- ghosts ---
  function cam3() { var v = W.game && W.game.view3d, c = v && v.camera; return c && (c.threeCamera || (c.camera && c.camera.threeCamera)); }
  var PC = { t: 0, e: null, p: null };
  function projBase() {
    var c = cam3(); if (!c || !c.matrixWorldInverse) return null;
    var n = performance.now();
    if (phase === 'spectate' && SPEC.INV && !spec.exit) { PC.e = SPEC.INV; PC.p = c.projectionMatrix.elements; PC.t = n; return PC; }
    if (PC.e && n - PC.t < 4) return PC;                    // reuse the view-projection matrices within a frame budget
    try { c.updateMatrixWorld(); var mi = c.matrixWorldInverse.copy(c.matrixWorld); if (mi.invert) mi.invert(); else if (mi.getInverse) mi.getInverse(c.matrixWorld); } catch (e) { }
    PC.e = c.matrixWorldInverse.elements; PC.p = c.projectionMatrix.elements; PC.t = n;
    return PC;
  }
  function project(x, y, z) {
    var B = projBase(); if (!B) return null;
    var e = B.e, p = B.p;
    var vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14], vw = e[3] * x + e[7] * y + e[11] * z + e[15];
    var cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw, cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw, cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
    if (cw <= 0) return null;
    return { x: cx / cw * 0.5 + 0.5, y: 1 - (cy / cw * 0.5 + 0.5), w: cw };
  }

  function setGhostAlpha(gh, a) {
    if (gh.alpha === a) return; gh.alpha = a;
    gh.ent.traverse(function (o) {
      var v = o.view3d; if (!v || !v.material || o.name === 'shadow') return;
      var m = v.material;
      m.transparent = a < 1; m.opacity = a; m.depthWrite = a >= 1;
    });
  }
  function setGhostBoard(gh, id) {
    if (gh.board === id) return; gh.board = id;
    if (gh.boardView) { try { gh.boardView.parent && gh.boardView.parent.removeChild(gh.boardView); } catch (e) {} gh.boardView = null; }
    var A = W.__MP_APP;
    if (!id || !A.library.hasScene('board-' + id)) return;
    var view = A.library.getScene('board-' + id, { map: 'board-' + id + '-tex' }), ap = null;
    gh.ent.traverse(function (o) { if (!ap && o.name === 'attachPoint1') ap = o; });
    if (!ap) return;
    view.rx = -Math.PI / 2; view.ry = 0; view.rz = 0; view.x = 0; view.y = 0; view.z = 0;
    ap.addChild(view);
    try {
      var data = A.data.getBoardData(id), feat = (data && data.features) || [], nodes = [], shown = 0;
      view.traverse(function (o) { if (o.view3d && o.name) nodes.push(o); });
      if (feat.length) {
        nodes.forEach(function (o) { var on = feat.indexOf(o.name) >= 0; o.view3d.renderable = on; if (on) shown++; });
        if (!shown) nodes.forEach(function (o) { o.view3d.renderable = true; });
      }
    } catch (e) {}
    gh.boardView = view; gh.alpha = -1;
  }
  function playClip(gh, clip, loop) {
    if (!clip || gh.clip === clip) return;
    gh.clip = clip;
    try { gh.ent.anim.play(clip, { loop: !!loop, sudden: true }); } catch (e) {}
  }
  function createGhost(uid, ch) {
    var g = W.game, h = g.hero;
    var Is = h.anim.constructor, G = Object.getPrototypeOf(h.constructor), M = h.model.constructor;
    var ent = new G(); ent.model = new M(); ent.addChild(ent.model); ent.add(Is);
    ent.anim.character = ch;
    ent.anim.addSharedAvatar({ character: ch, modelFile: 'avatar_' + ch, texture: ch + '-tex', sources: h.anim.sharedAvatarData.sources });
    g.addChild(ent);
    ent.model.position.y = -4.5; ent.model.rotation.y = Math.PI;
    try { ent.anim.play('run3', { loop: true, sudden: true }); } catch (e) {}
    var col = colorOf(uid), label = document.createElement('div');
    label.className = 'mp-lbl'; label.style.borderColor = col;
    document.getElementById('mp-hud').appendChild(label);
    var gh = { uid: uid, ch: ch, ent: ent, label: label, cur: null, tgt: null, vel: 0, rx: 0, clip: 'run3', board: '', boardView: null, alpha: -1, deadSince: 0 };
    setGhostAlpha(gh, 0.5);
    skinLater(ent, ch, ((players[uid] || {}).ot) | 0);
    return (ghosts[uid] = gh);
  }
  function removeGhost(uid) {
    var gh = ghosts[uid]; if (!gh) return;
    try { gh.ent.parent && gh.ent.parent.removeChild(gh.ent); } catch (e) {}
    try { gh.ent.destroy && gh.ent.destroy(); } catch (e) {}
    try { gh.label.remove(); } catch (e) {}
    delete ghosts[uid];
  }
  function clearGhosts() { Object.keys(ghosts).forEach(removeGhost); }

  function ghostOf(uid) {
    if (ghosts[uid]) return ghosts[uid];
    var ch = (players[uid] && players[uid].char) || lastChar[uid] || 'jake';
    if (!charLoaded(ch)) { loadChar(ch); return null; }
    try { return createGhost(uid, ch); } catch (e) { console.error('[MP] ghost', e); return null; }
  }
  function applyStates() {
    if (!running) return;
    var part = (room && room.participants) || Object.keys(players);
    part.forEach(function (uid) {
      if (uid === me.uid) return;
      var s = states[uid]; if (!s || s.rd !== round) return;
      var gh = ghostOf(uid); if (!gh) return;
      var prev = gh.tgt;
      if (!prev || prev.d !== s.d || prev.x !== s.x) {
        if (prev && gh.rx) { var dt = (performance.now() - gh.rx) / 1000; if (dt > 0.02) gh.vel = Math.max(0, (s.d - prev.d) / dt); }
        gh.rx = performance.now();
      }
      gh.tgt = s;
      if (!gh.cur) gh.cur = { d: s.d, x: s.x, y: s.y, bh: s.bh || 11 };
    });
    Object.keys(ghosts).forEach(function (uid) { if (!players[uid] || (room && room.participants && room.participants.indexOf(uid) < 0)) removeGhost(uid); });
  }

  var lastF = performance.now(), myLbl = null;
  var lastF = performance.now(), myLbl = null, cvRect = null, cvRectAt = 0;
  function canvasRect() {
    var n = performance.now();
    if (cvRect && n - cvRectAt < 400) return cvRect;         // avoid a layout read every frame
    var cv = document.querySelector('canvas'), r = null;
    try { r = cv ? cv.getBoundingClientRect() : null; } catch (e) { r = null; }
    cvRect = (r && r.width) ? r : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    cvRectAt = n;
    return cvRect;
  }
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.1, (ts - lastF) / 1000); lastF = ts;
    if (!running) { if (myLbl) myLbl.style.display = 'none'; return; }
    // project onto the CANVAS rect (not the window): fixes nametags drifting when the game
    // canvas is letterboxed / offset inside the page
    var rect = canvasRect();
    var now = performance.now();
    Object.keys(ghosts).forEach(function (uid) {
      var gh = ghosts[uid], s = gh.tgt; if (!s || !gh.cur) return;
      var isDead = !!s.dead, ext = isDead ? 0 : gh.vel * Math.min(0.25, (now - gh.rx) / 1000), k = Math.min(1, dt * (phase === 'spectate' && spec.uid === uid ? 17 : 12));
      gh.cur.d += (s.d + ext - gh.cur.d) * k; gh.cur.x += (s.x - gh.cur.x) * k; gh.cur.y += (s.y - gh.cur.y) * k; gh.cur.bh += ((s.bh || 11) - gh.cur.bh) * k;
      var wd = toWorld(gh.cur.d);
      gh.ent.x = gh.cur.x; gh.ent.y = gh.cur.y; gh.ent.z = -wd;
      gh.ent.model.position.y = -gh.cur.bh * 0.5 + 1;
      try { gh.ent.anim.speed = s.sp || 1; } catch (e) { }
      if (isDead) { if (!gh.deadSince) gh.deadSince = now; playClip(gh, s.a || DEATH_CLIP[s.dc] || 'death_lower', false); }
      else { gh.deadSince = 0; playClip(gh, s.a, s.l); }
      setGhostBoard(gh, isDead ? '' : (s.b || ''));
      var spectated = phase === 'spectate' && spec.uid === uid;
      var a = isDead ? (now - gh.deadSince > 2500 ? 0 : 0.3) : (spectated ? 1 : 0.5);
      setGhostAlpha(gh, a); gh.ent.visible = a > 0 && (!opts.noGhosts || phase === 'spectate') && !(spectated && specMode === 'first');
      var p = a > 0 && !opts.noNames && (!opts.noGhosts || phase === 'spectate') && !spectated && project(gh.cur.x, gh.cur.y + 9, -wd), nm = (players[uid] && players[uid].name) || lastName[uid] || '?';
      if (p && p.w > 4 && p.w < 700) {
        gh.label.style.display = 'flex'; var pq = players[uid] || {}, lk = (isDead ? 'x' : '') + nm + '|' + pq.tc + '|' + pq.tt + '|' + pq.tp + '|' + pq.tf + '|' + pq.tr + '|' + pq.rk + '|' + pq.tq + '|' + pq.to + '|' + pq.tu;
        if (gh.lk !== lk) { gh.lk = lk; gh.label.innerHTML = (isDead ? '\u2620 ' : '') + bn({ name: nm, tc: pq.tc, tt: pq.tt, tp: pq.tp, tf: pq.tf, tr: pq.tr, rk: pq.rk, tq: pq.tq, to: pq.to, tu: pq.tu }); }
        var nx = rect.left + p.x * rect.width, ny = rect.top + p.y * rect.height, sc = Math.max(0.62, Math.min(1, 1.2 - p.w / 220));
        if (gh.lx === undefined || Math.abs(nx - gh.lx) > 0.5 || Math.abs(ny - gh.ly) > 0.5 || gh.lsc !== sc.toFixed(2)) { gh.lx = nx; gh.ly = ny; gh.lsc = sc.toFixed(2); gh.label.style.transform = 'translate(' + nx.toFixed(1) + 'px,' + ny.toFixed(1) + 'px) translate(-50%,-100%) scale(' + gh.lsc + ')'; }
      } else { gh.label.style.display = 'none'; gh.lx = undefined; }
    });
    try {
      var h0 = W.game && W.game.hero;
      if (h0 && phase !== 'spectate' && !opts.noNames) {
        var p0 = project(h0.position.x, (h0.position.y || 0) + 9.4, h0.position.z || 0);
        if (!myLbl) { myLbl = document.createElement('div'); myLbl.className = 'mp-lbl mp-mine'; if (hud) hud.appendChild(myLbl); }
        if (p0 && p0.w > 4 && p0.w < 900) {
          myLbl.style.display = 'flex';
          var lk0 = me.name + '|' + me.tc + '|' + me.tt + '|' + me.tp + '|' + me.tf + '|' + me.tr + '|' + myPts() + '|' + me.tq + '|' + me.to + '|' + me.tu;
          if (myLbl.__k !== lk0) { myLbl.__k = lk0; myLbl.innerHTML = bn(myTag()); }
          var mx = rect.left + p0.x * rect.width, my = rect.top + p0.y * rect.height;
          if (myLbl.__x === undefined || Math.abs(mx - myLbl.__x) > 0.5 || Math.abs(my - myLbl.__y) > 0.5) { myLbl.__x = mx; myLbl.__y = my; myLbl.style.transform = 'translate(' + mx.toFixed(1) + 'px,' + my.toFixed(1) + 'px) translate(-50%,-100%)'; }
        } else myLbl.style.display = 'none';
      } else if (myLbl) myLbl.style.display = 'none';
    } catch (e0) { }
    if (phase === 'spectate') followSpectated(dt);
  }

  // ------------------------------------------------------------ spectate ----
  // Poki14 spectator rig - THREE camera modes driven ONLY through the render hook:
  //   third  - genuine third-person chase camera positioned BEHIND the runner,
  //            slightly above, with drag-to-orbit and wheel zoom
  //   aerial - high overhead orbit looking down at the runner (genuine 3D view)
  //   free   - independent free camera (WASD + mouse look + Space/Ctrl), no target
  // All modes smooth with frame-rate independent exponents so nothing ever snaps,
  // and the spectated player's physics are never modified.
  var SPEC = { pos: null, tgt: null, M: null, INV: null };
  var specMode = 'third';
  try { var sm0 = sessionStorage.getItem('mp_speccam'); if (sm0 === 'third' || sm0 === 'first' || sm0 === 'aerial' || sm0 === 'free') specMode = sm0; } catch (e0b) {}
  var SPEC_ORB = { az: 0, el: 0.46, azT: 0, elT: 0.46, dist: 12.5, distT: 12.5 };   // orbit state (third / aerial) - el 0.46 keeps the camera above train roofs
  var FREE = { x: 0, y: 30, z: -80, yaw: Math.PI, pitch: -0.38, spd: 1, init: false };
  var specKeys = {};
  syncOrbToMode();
  // keep the orbit parameters inside the current mode's sensible envelope
  // (also applied on boot when the mode was remembered from a previous session)
  function syncOrbToMode() {
    if (specMode === 'third') { SPEC_ORB.elT = Math.min(1.2, Math.max(0.2, SPEC_ORB.elT)); SPEC_ORB.distT = Math.min(22, Math.max(7, SPEC_ORB.distT)); }
    else if (specMode === 'aerial') { SPEC_ORB.elT = Math.min(1.45, Math.max(0.9, SPEC_ORB.elT)); SPEC_ORB.distT = Math.min(70, Math.max(16, SPEC_ORB.distT)); }
    else if (specMode === 'first') { SPEC_ORB.elT = Math.min(0.7, Math.max(-0.6, SPEC_ORB.elT)); SPEC_ORB.azT = Math.min(1.3, Math.max(-1.3, SPEC_ORB.azT)); }
  }
  function setSpecMode(m) {
    if (m !== 'third' && m !== 'first' && m !== 'aerial' && m !== 'free') return;
    if (m === specMode) return;
    if (specMode !== 'free' && m === 'free') { freeFromOrbit(); }
    specMode = m; specKeys = {};
    // each mode opens on its own default viewpoint (drag/wheel adjustments persist
    // while you stay in a mode; switching modes resets to that mode's default)
    if (specMode === 'third') { SPEC_ORB.azT = 0; SPEC_ORB.elT = 0.46; SPEC_ORB.distT = 12.5; }
    else if (specMode === 'first') { SPEC_ORB.azT = 0; SPEC_ORB.elT = 0; }
    else if (specMode === 'aerial') { SPEC_ORB.azT = 0; SPEC_ORB.elT = 1.15; SPEC_ORB.distT = 34; }
    else { SPEC_ORB.az = 0; SPEC_ORB.el = 0.46; SPEC_ORB.dist = 12.5; }
    try { sessionStorage.setItem('mp_speccam', m); } catch (e0c) {}
    updateSpecBar();
  }
  function freeFromOrbit() {
    if (SPEC.pos && SPEC.tgt) {
      var dx = SPEC.tgt[0] - SPEC.pos[0], dy = SPEC.tgt[1] - SPEC.pos[1], dz = SPEC.tgt[2] - SPEC.pos[2], dl = Math.hypot(dx, dy, dz) || 1;
      FREE.x = SPEC.pos[0]; FREE.y = SPEC.pos[1]; FREE.z = SPEC.pos[2]; FREE.yaw = Math.atan2(dx, dz); FREE.pitch = Math.asin(Math.max(-1, Math.min(1, dy / dl))); FREE.init = true; return;
    }
    if (FREE.init) return;
    var gh = ghosts[spec.uid];
    if (gh && gh.cur) { FREE.x = gh.cur.x; FREE.y = gh.cur.y + 14; FREE.z = -toWorld(gh.cur.d) + 26; FREE.yaw = Math.PI; FREE.pitch = -0.4; }
    else { FREE.x = 0; FREE.y = 30; FREE.z = -60; FREE.yaw = Math.PI; FREE.pitch = -0.4; }
    FREE.init = true;
  }
  function specReset() { SPEC.pos = null; SPEC.tgt = null; SPEC.M = null; SPEC.INV = null; }
  function buildSpecMatrix(P, Tt) {
    var z = [P[0] - Tt[0], P[1] - Tt[1], P[2] - Tt[2]], zl = Math.hypot(z[0], z[1], z[2]) || 1; z = [z[0] / zl, z[1] / zl, z[2] / zl];
    var x = [z[2], 0, -z[0]], xl = Math.hypot(x[0], x[1], x[2]) || 1; x = [x[0] / xl, 0, x[2] / xl];
    var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    var tx = -(x[0] * P[0] + x[1] * P[1] + x[2] * P[2]), ty = -(y[0] * P[0] + y[1] * P[1] + y[2] * P[2]), tz = -(z[0] * P[0] + z[1] * P[1] + z[2] * P[2]);
    SPEC.M = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, P[0], P[1], P[2], 1];
    SPEC.INV = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, tx, ty, tz, 1];
  }
  function specFreeCam(dt) {
    var sprint = specKeys['shift'] ? 2.6 : 1;
    var sp = 26 * FREE.spd * sprint * Math.min(0.1, dt);
    var cp = Math.cos(FREE.pitch);
    var f = [Math.sin(FREE.yaw) * cp, Math.sin(FREE.pitch), Math.cos(FREE.yaw) * cp];
    var r = [Math.sin(FREE.yaw - Math.PI / 2), 0, Math.cos(FREE.yaw - Math.PI / 2)];
    var mv = [0, 0, 0];
    if (specKeys['w']) { mv[0] += f[0]; mv[1] += f[1]; mv[2] += f[2]; }
    if (specKeys['s']) { mv[0] -= f[0]; mv[1] -= f[1]; mv[2] -= f[2]; }
    if (specKeys['a']) { mv[0] -= r[0]; mv[2] -= r[2]; }
    if (specKeys['d']) { mv[0] += r[0]; mv[2] += r[2]; }
    if (specKeys[' ']) mv[1] += 1;
    if (specKeys['control'] || specKeys['c']) mv[1] -= 1;
    var ml = Math.hypot(mv[0], mv[1], mv[2]);
    if (ml > 0) {
      mv[0] /= ml; mv[1] /= ml; mv[2] /= ml;
      FREE.x = Math.max(-60, Math.min(60, FREE.x + mv[0] * sp));
      FREE.y = Math.max(2, Math.min(180, FREE.y + mv[1] * sp));
      FREE.z = Math.max(-4200, Math.min(60, FREE.z + mv[2] * sp));
    }
    var look = [FREE.x + f[0] * 12, FREE.y + f[1] * 12, FREE.z + f[2] * 12];
    if (!SPEC.pos) SPEC.pos = [FREE.x, FREE.y, FREE.z];
    if (!SPEC.tgt) SPEC.tgt = look.slice();
    var k = 1 - Math.exp(-dt * 14);
    SPEC.pos[0] += (FREE.x - SPEC.pos[0]) * k; SPEC.pos[1] += (FREE.y - SPEC.pos[1]) * k; SPEC.pos[2] += (FREE.z - SPEC.pos[2]) * k;
    SPEC.tgt[0] += (look[0] - SPEC.tgt[0]) * k; SPEC.tgt[1] += (look[1] - SPEC.tgt[1]) * k; SPEC.tgt[2] += (look[2] - SPEC.tgt[2]) * k;
    buildSpecMatrix(SPEC.pos, SPEC.tgt);
  }
  function followSpectated(dt) {
    if (spec.exit) return;
    if (specMode === 'free') { try { hideGuard(); } catch (eH) {} specFreeCam(dt); return; }
    var g = W.game, h = g.hero, gh = ghosts[spec.uid];
    if (!gh || !gh.cur || !gh.tgt) return;
    var P = gh.tgt, z = -toWorld(gh.cur.d), pl = h.player;
    // keep the local hero glued to the spectated runner (guards/world stay consistent)
    try { h.position.x = gh.cur.x; h.position.y = gh.cur.y; h.position.z = z; } catch (e) { }
    try { h.body.x = gh.cur.x; h.body.y = gh.cur.y; h.body.z = z; h.body.bottom = 0; h.body.ground = P.gy || 0; h.body.groundBefore = P.gy || 0; h.body.velocity.x = 0; h.body.velocity.y = 0; h.body.velocity.z = 0; } catch (e) { }
    try { pl.cameraTargetY = P.cy || 0; pl.cameraLow = P.cl ? 1 : 0; } catch (e) { }
    hideGuard();
    // orbit parameters glide towards the mode's targets (mode switches blend smoothly)
    var k2 = Math.min(1, dt * 7);
    SPEC_ORB.az += (SPEC_ORB.azT - SPEC_ORB.az) * k2;
    SPEC_ORB.el += (SPEC_ORB.elT - SPEC_ORB.el) * k2;
    SPEC_ORB.dist += (SPEC_ORB.distT - SPEC_ORB.dist) * k2;
    try { gh.ent.visible = !(specMode === 'first'); } catch (eV) {}
    var ty = gh.cur.y;
    var dir = [Math.sin(SPEC_ORB.az) * Math.cos(SPEC_ORB.el), Math.sin(SPEC_ORB.el), Math.cos(SPEC_ORB.az) * Math.cos(SPEC_ORB.el)];
    var aerial = specMode === 'aerial', first = specMode === 'first';
    // third person: BEHIND the runner (az 0 => +z offset, the way they came from),
    // slightly above, looking a little down-track so their body and the rails stay in frame
    var fpE = [gh.cur.x, ty + 7.2, z - 1.2], pt = -SPEC_ORB.el;
    var fpF = [-Math.sin(SPEC_ORB.az) * Math.cos(pt), Math.sin(pt), -Math.cos(SPEC_ORB.az) * Math.cos(pt)];
    var des = first ? fpE : [gh.cur.x + dir[0] * SPEC_ORB.dist, ty + dir[1] * SPEC_ORB.dist + (aerial ? 0 : 1.4), z + dir[2] * SPEC_ORB.dist];
    if (!aerial && !first && des[1] < ty + 6.2) des[1] = ty + 6.2;   // never dip below the runner's chest: keeps trains out of the lens
    var look = first ? [fpE[0] + fpF[0] * 14, fpE[1] + fpF[1] * 14, fpE[2] + fpF[2] * 14] : aerial ? [gh.cur.x, ty + 1.2, z - 4] : [gh.cur.x, ty + 5.0 + (P.cy || 0) * 0.35, z - 3.5];
    if (!SPEC.pos) SPEC.pos = des.slice();
    if (!SPEC.tgt) SPEC.tgt = look.slice();
    var axz = 1 - Math.exp(-dt * (first ? 20 : 9.5));
    var ay = 1 - Math.exp(-dt * (first ? 20 : 7.5));
    var al = 1 - Math.exp(-dt * (first ? 22 : 13));
    SPEC.pos[0] += (des[0] - SPEC.pos[0]) * axz;
    SPEC.pos[1] += (des[1] - SPEC.pos[1]) * ay;
    SPEC.pos[2] += (des[2] - SPEC.pos[2]) * axz;
    SPEC.tgt[0] += (look[0] - SPEC.tgt[0]) * al;
    SPEC.tgt[1] += (look[1] - SPEC.tgt[1]) * al;
    SPEC.tgt[2] += (look[2] - SPEC.tgt[2]) * al;
    buildSpecMatrix(SPEC.pos, SPEC.tgt);
  }
  function aliveOthers(list) { return (list || standings()).filter(function (p) { return p.uid !== me.uid && !p.dead && !p.gone; }); }
  function startSpectate(list) {
    if (opts.noSpectate) { return; }
    var o = aliveOthers(list); if (!o.length) return;
    phase = 'spectate';
    var g = W.game;
    try { g.hero.visible = false; } catch (e) {}
    hideGuard();
    try { g.hud && g.hud.close && g.hud.close(); } catch (e) {}
    spec.exit = false; FREE.init = false;
    syncOrbToMode();
    specReset();
    spec.uid = o[0].uid; spec.since = performance.now();
    updateSpecBar();
  }
  function specCycle(dir) {
    var o = aliveOthers(); if (!o.length) return;
    var i = 0; o.forEach(function (p, ix) { if (p.uid === spec.uid) i = ix; });
    spec.uid = o[(i + dir + o.length) % o.length].uid;
    // keep the camera position, just glide to the new target (smooth transition)
    updateSpecBar();
  }
  function specExit() {
    if (phase !== 'spectate' || spec.exit) return;
    spec.exit = true; spec.uid = null; specReset();
    updateSpecBar();
    setOv('<div class="mq-screen"><div class="mq-panel" style="width:min(400px,92vw);text-align:center;padding:24px">' +
      '<h2 style="margin:0 0 8px;font-family:\'torus\',\'titan-one\',sans-serif;font-weight:normal;letter-spacing:2px;text-transform:uppercase;font-size:18px;color:#cdd8ee">Spectator ended</h2>' +
      '<p class="mq-note" style="margin:0 0 6px">The race is still running for everyone else. You can jump back in at any time.</p>' +
      '<div class="mq-live" style="margin-bottom:14px"><i></i>LIVE</div>' +
      '<div class="btns"><button class="mq-btn pri" data-act="back">Back to lobby</button><button class="mq-btn danger" data-act="leave">Leave game</button></div></div></div>', 'dim');
  }
  var SPICO = {
    third: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6.4" r="2.8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.2 20c.6-4 2.9-6 5.8-6s5.2 2 5.8 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M19.5 9.5a8 8 0 0 1 1.6 4.5M4.5 9.5a8 8 0 0 0-1.6 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    aerial: '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    first: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/></svg>',
    free: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-2.4 2.4M12 3l2.4 2.4M12 21l-2.4-2.4M12 21l2.4-2.4M3 12l2.4-2.4M3 12l2.4 2.4M21 12l-2.4-2.4M21 12l-2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
  };
  var specBarKey = '';
  function updateSpecBar() {
    var el = document.getElementById('mp-spec'); if (!el) return;
    if (phase !== 'spectate' || spec.exit) { el.style.display = 'none'; specBarKey = ''; return; }
    var list = standings(), t = null;
    list.forEach(function (p) { if (p.uid === spec.uid) t = p; });
    var pq = (spec.uid && players[spec.uid]) || {};
    var rk = W.MPAcc ? MPAcc.rankOf(pq.rk | 0) : null;
    var lv = pq.lv | 0;
    var modes = [['third', 'Third person'], ['first', 'First person'], ['aerial', 'Aerial'], ['free', 'Freecam']].map(function (m) {
      return '<button class="sp14-mb' + (specMode === m[0] ? ' on' : '') + '" data-act="specmode" data-m="' + m[0] + '" title="' + m[1] + ' (' + (m[0] === 'third' ? '1' : m[0] === 'first' ? '2' : m[0] === 'aerial' ? '3' : '4') + ')">' + SPICO[m[0]] + '</button>';
    }).join('');
    // POKI21 anti-flicker: the shell (buttons, avatar, hint) is rebuilt only when
    // the watched target / camera mode / board toggle changes; the live score,
    // distance and name are updated as text every tick, so nothing is re-created.
    var key = (spec.uid || '') + '|' + specMode + '|' + (specBoardOn ? 1 : 0) + '|' + (t ? t.ch : '');
    el.style.display = 'flex';
    if (key !== specBarKey) {
      specBarKey = key;
      el.innerHTML = '<div class="sp14">' +
        '<div class="sp14-g">' + modes + '</div>' +
        '<div class="sp14-t">' + (t ? '<img src="' + preview(t.ch) + '" alt="">' : '') +
          '<div class="i"><b></b><small></small></div></div>' +
        '<div class="sp14-g"><button class="sp14-nb" data-act="specprev" title="Previous player (A / \u2190)"><svg viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
        '<button class="sp14-nb" data-act="specnext" title="Next player (D / \u2192)"><svg viewBox="0 0 24 24"><path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>' +
        '<button class="sp14-nb' + (specBoardOn ? ' on' : '') + '" data-act="sbopen" title="Toggle live standings (B)"><svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 15l3-4 2.5 2.5L17 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '<button class="sp14-x" data-act="specexit" title="Exit spectator">EXIT</button>' +
        '</div>' +
        '<div class="sp14-hint">' + (specMode === 'free'
          ? 'WASD move \u00B7 mouse look \u00B7 SPACE up \u00B7 CTRL / C down \u00B7 SHIFT sprint \u00B7 wheel speed \u00B7 [ ] players \u00B7 1-4 camera'
          : 'drag orbit \u00B7 wheel zoom \u00B7 A / D or \u2190 \u2192 players \u00B7 1-4 camera modes') + '</div>';
    }
    var nm = el.querySelector('.sp14-t .i b'), sm = el.querySelector('.sp14-t .i small');
    if (nm) nm.textContent = t ? t.name : 'No runner';
    if (sm) sm.innerHTML =
      (lv ? 'LEVEL ' + lv : '') + (lv && rk ? ' \u00B7 ' : '') + (rk ? '<span class="rk-svg-w">' + rk.svg + '</span> ' + esc(rk.name) : '') +
      (t ? (lv || rk ? ' \u00B7 ' : '') + num(t.sc) + ' pts \u00B7 ' + Math.round(t.d) + ' m' : '');
  }
  // pointer + keyboard input for the spectator cameras (local spectator only)
  function specPtr() {
    if (specPtr.on) return; specPtr.on = true;
    function isBg(t) { return t && (t.tagName === 'CANVAS' || t === document.body || t === document.documentElement); }
    var drag = null;
    W.addEventListener('pointerdown', function (e) {
      if (phase !== 'spectate' || spec.exit) return;
      if (!isBg(e.target)) return;
      drag = { x: e.clientX, y: e.clientY, az: SPEC_ORB.azT, el: SPEC_ORB.elT, yaw: FREE.yaw, pitch: FREE.pitch };
    });
    W.addEventListener('pointermove', function (e) {
      if (phase !== 'spectate' || spec.exit) return;
      if (drag && specMode === 'free') { FREE.yaw = drag.yaw - (e.clientX - drag.x) * 0.006; FREE.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch - (e.clientY - drag.y) * 0.005)); }
      else if (drag && specMode === 'first') { SPEC_ORB.azT = Math.max(-1.3, Math.min(1.3, drag.az - (e.clientX - drag.x) * 0.0075)); SPEC_ORB.elT = Math.max(-0.6, Math.min(0.7, drag.el + (e.clientY - drag.y) * 0.006)); }
      else if (drag) {
        SPEC_ORB.azT = drag.az - (e.clientX - drag.x) * 0.0075;
        var lim = specMode === 'aerial' ? [0.9, 1.45] : [0.08, 1.2];
        SPEC_ORB.elT = Math.max(lim[0], Math.min(lim[1], drag.el + (e.clientY - drag.y) * 0.006));
      }
    });
    ['pointerup', 'pointercancel'].forEach(function (n) { W.addEventListener(n, function () { drag = null; }); });
    W.addEventListener('wheel', function (e) {
      if (phase !== 'spectate' || spec.exit) return;
      if (!isBg(e.target)) return;
      if (specMode === 'free') { FREE.spd = Math.max(0.25, Math.min(4, FREE.spd * (e.deltaY > 0 ? 0.9 : 1.1))); return; }
      if (specMode === 'first') return;
      var lim = specMode === 'aerial' ? [16, 70] : [8, 22];
      SPEC_ORB.distT = Math.max(lim[0], Math.min(lim[1], SPEC_ORB.distT * (e.deltaY > 0 ? 1.08 : 0.93)));
    }, { passive: true });
    // free-camera movement keys + quick mode switching
    var MVK = { w: 1, a: 1, s: 1, d: 1, ' ': 1, c: 1, shift: 1, control: 1 };
    W.addEventListener('keydown', function (e) {
      if (phase !== 'spectate' || spec.exit) return;
      var k = e.key.toLowerCase();
      if (specMode === 'free') {
        if (k === '[' || k === ',') { specCycle(-1); return; }
        if (k === ']' || k === '.') { specCycle(1); return; }
        if (MVK[k]) { specKeys[k] = 1; e.preventDefault(); }
      }
    });
    W.addEventListener('keyup', function (e) { var k = e.key.toLowerCase(); if (specKeys[k]) specKeys[k] = 0; });
  }

  // ----------------------------------------------------------- standings ----
  function cur(u) {
    if (u === me.uid) return mine;
    if (states[u] && states[u].rd === round) return states[u];
    return lastState[u] && lastState[u].rd === round ? lastState[u] : null;
  }
  function standings() {
    var part = (room && room.participants) || Object.keys(players), now = net ? net.now() : Date.now();
    var rows = part.map(function (u) {
      var s = cur(u), pl = players[u];
      var gone = !pl || (!s && raceStart && now - raceStart > 30000);
      return { uid: u, tc: pl && pl.tc, tt: pl && pl.tt, tp: pl && pl.tp, tf: pl && pl.tf, tr: pl && pl.tr, rk: pl && pl.rk, tq: pl && pl.tq, to: pl && pl.to, tu: pl && pl.tu, name: (pl && pl.name) || lastName[u] || '(left)', ch: (pl && pl.char) || lastChar[u] || 'jake', sc: s ? s.sc || 0 : 0, d: s ? s.d || 0 : 0, c: s ? s.c || 0 : 0, dead: !!(s && s.dead), gone: gone, coinT: s ? s.ct || 0 : 0, gt: s ? s.gt || 0 : 0 };
    });
    rows.sort(function (a, b) {
      if (a.gt || b.gt) { if (!!a.gt !== !!b.gt) return a.gt ? -1 : 1; if (a.gt !== b.gt) return a.gt - b.gt; }
      if (opts.noCoin && !!a.coinT !== !!b.coinT) return a.coinT ? 1 : -1;
      var g = opts.goalType, ka = g === 'dist' ? a.d : g === 'coins' ? a.c : a.sc, kb = g === 'dist' ? b.d : g === 'coins' ? b.c : b.sc;
      return (kb - ka) || (b.sc - a.sc) || (b.d - a.d);
    });
    return rows;
  }

  // ------------------------------------------------------------------ UI ----
  var css = `

/* ===================== Poki14 design system (LABY.net inspired) ===================== */
body{--b0:#0a0d14;--b1:#10141d;--b2:#151b27;--b3:#1a2231;--b4:#0d1119;
--ln:#232b3a;--ln2:#313d52;--tx:#e8edf6;--sub:#9aa5bd;--dim:#626e88;
--acc:#3e7bfa;--acc-h:#5c92ff;--vio:#8b6bff;--ok:#3fbf7f;--bad:#e05656;--warn:#e6a23c;--gold:#f6c453;
--rad:12px;--rad2:9px;--sh:0 14px 34px rgba(0,0,0,.4)}
#mp-ov{position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;font-family:'proxima',Verdana,sans-serif;color:var(--tx);overflow:auto;padding:14px;box-sizing:border-box;
 background:radial-gradient(1200px 700px at 50% -20%,var(--ovglow,rgba(62,123,250,.10)) 0%,transparent 60%),linear-gradient(180deg,rgba(6,9,16,.50),rgba(6,9,16,.18) 30%,rgba(6,9,16,.18) 70%,rgba(6,9,16,.55))}
#mp-ov.dim{background:rgba(5,8,15,.78)}
#mp-ov.none{display:none}
#mp-ov *{box-sizing:border-box}
.ico{width:18px;height:18px;flex:none;vertical-align:-3px}
.gem{width:16px;height:16px;flex:none;vertical-align:-3px}
.mq-btn .ico{width:16px;height:16px}
.mp-shell{width:min(1040px,100%);margin:auto;display:flex;flex-direction:column;align-items:center;gap:14px}
.mp-shell.narrow{width:min(520px,100%)}
.mp-logo-img{display:block;max-width:min(400px,86vw);max-height:190px;width:auto;height:auto;object-fit:contain;filter:drop-shadow(0 8px 22px rgba(0,0,0,.6))}
.mp-logo-img.sm{max-height:40px;max-width:min(210px,50vw);filter:drop-shadow(0 3px 8px rgba(0,0,0,.55))}
.mp-sub{margin-top:8px;font-size:12px;letter-spacing:3px;color:var(--sub);text-transform:uppercase}

/* ---------- panels (one container system everywhere) ---------- */
.mq-panel,.p14-panel,.sm-panel,.mp-card,.mq-lb,.mq-auth,.m13,.fnk-right,.p14-lob,.p14-chat,.p14-side,.f14-season,.f14-mode,.f14-party,.f14-go,.pf14-grid .p14-panel,.p14-acc{
 background:linear-gradient(180deg,#12161f,#0f131b);border:1px solid var(--ln);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.04);color:var(--tx)}
.p14-panel{min-width:0}
.mq-head{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--ln);padding-bottom:10px;margin-bottom:12px}
.mq-head h2,.m13-h h3{margin:0;font-family:'torus','titan-one',Verdana,sans-serif;font-weight:normal;font-size:16px;letter-spacing:2.5px;text-transform:uppercase;color:#cdd8ee}
.mq-sec{font-family:'torus','titan-one',Verdana,sans-serif;font-weight:normal;font-size:11px;letter-spacing:2.2px;text-transform:uppercase;color:#8296c4;margin:14px 2px 8px;display:flex;align-items:center;gap:8px}
.mq-sec:first-child{margin-top:0}
.mq-lab{display:block;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10.5px;letter-spacing:1.8px;text-transform:uppercase;color:var(--sub);margin:12px 2px 6px}
.mq-note{color:var(--dim);font-size:11.5px;line-height:1.5}
.mq-err{color:#ff9ba3;font-size:12.5px;min-height:16px;margin-top:6px}
.mq-empty{border:1px dashed #313d52;border-radius:10px;color:var(--sub);text-align:center;padding:18px 14px;font-size:12.5px;line-height:1.6}
.mq-empty small{color:var(--dim)}
.mq-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(120,150,220,.09);border:1px solid #313d52;border-radius:20px;color:#c3d0ea;font-size:10.5px;padding:3px 10px;line-height:1.5}
.mq-chip.ok{color:#7ce0ac;border-color:rgba(63,191,127,.45)}
.mq-chip.gold{color:#ffdf8a;border-color:rgba(246,196,83,.4)}
.mq-chip.hot{color:#ff9ba3;border-color:rgba(224,86,86,.45)}
.mq-chip.on{color:#8ecaff;border-color:rgba(62,123,250,.5)}
.mq-live{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:2px;color:#8ecaff;text-transform:uppercase}
.mq-live i{width:8px;height:8px;border-radius:50%;background:#3fbf7f;box-shadow:0 0 8px #3fbf7f;animation:p14pl 1.4s infinite}
@keyframes p14pl{50%{opacity:.25}}
.mq-bar{height:7px;border-radius:5px;background:#0d1119;border:1px solid #232b3a;overflow:hidden}
.mq-bar i{display:block;height:100%;background:linear-gradient(90deg,#3e7bfa,#6fa0ff);transition:width .45s ease}
.mq-scroll{scrollbar-width:thin;scrollbar-color:rgba(130,150,200,.35) transparent}
#mp-ov ::-webkit-scrollbar,#mp-lchat ::-webkit-scrollbar,.m13-list::-webkit-scrollbar{width:8px;height:8px}
#mp-ov ::-webkit-scrollbar-thumb,#mp-lchat ::-webkit-scrollbar-thumb,.m13-list::-webkit-scrollbar-thumb{background:rgba(130,150,200,.32);border-radius:6px}
#mp-ov ::-webkit-scrollbar-track,#mp-lchat ::-webkit-scrollbar-track,.m13-list::-webkit-scrollbar-track{background:rgba(0,0,0,.25)}

/* ---------- inputs ---------- */
#mp-ov input[type=text],#mp-ov input[type=password],#mp-ov input[type=number],#mp-ov select,#mp-ov textarea,
.m13 input[type=text],.fr-add input,.p14-share input{
 background:#0d1119;border:1px solid #232b3a;border-radius:8px;color:#e8edf6;font-family:'proxima',Verdana,sans-serif;font-size:13px;padding:9px 12px;outline:0;transition:border-color .15s,box-shadow .15s}
#mp-ov input:focus,#mp-ov select:focus,#mp-ov textarea:focus,.m13 input:focus,.fr-add input:focus{border-color:#3e7bfa;box-shadow:0 0 0 3px rgba(62,123,250,.18)}
#mp-ov input::placeholder,#mp-ov textarea::placeholder{color:#5b6680}
#mp-ov select{cursor:pointer}

/* ---------- buttons ---------- */
#mp-ov .mq-btn,.m13 button,.bn-go,.c13-go,.sp14 button,.p14-navb,.p14-mini,.f14-navb,.pf14-mini,.p13-mini,.f13-mini{
 font-family:'proxima','titan-one',Verdana,sans-serif;font-weight:bold;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;
 border-radius:9px;border:1px solid #313d52;background:#1a2231;color:#dbe3f2;padding:10px 16px;cursor:pointer;
 transition:transform .14s ease,background .14s ease,border-color .14s ease,filter .14s ease,box-shadow .14s ease}
#mp-ov .mq-btn:hover,.m13 button:hover,.p14-navb:hover,.p14-mini:hover,.p13-mini:hover,.f13-mini:hover{background:#222b3c;border-color:#3d4c68;filter:brightness(1.06)}
#mp-ov .mq-btn:active,.m13 button:active,.p14-navb:active,.p13-mini:active{transform:translateY(1px)}
#mp-ov .mq-btn.pri,#mp-ov .mq-btn.blue{background:linear-gradient(180deg,#4d86ff,#2f66e8);border-color:rgba(150,185,255,.55);color:#fff;text-shadow:0 1px 1px rgba(10,30,90,.4)}
#mp-ov .mq-btn.pri:hover,#mp-ov .mq-btn.blue:hover{filter:brightness(1.1);box-shadow:0 6px 18px rgba(47,102,232,.35)}
#mp-ov .mq-btn.green{background:linear-gradient(180deg,#3fbf7f,#27995f);border-color:rgba(120,220,170,.45);color:#fff}
#mp-ov .mq-btn.danger{background:rgba(224,86,86,.12);border-color:rgba(224,86,86,.5);color:#ff9ba3}
#mp-ov .mq-btn.danger:hover{background:rgba(224,86,86,.22)}
#mp-ov .mq-btn.gold{background:linear-gradient(180deg,#ffd95e,#eda22c);border-color:rgba(255,225,150,.6);color:#3a2708;text-shadow:none}
#mp-ov .mq-btn.sm,#mp-ov .mq-btn.sm2{padding:7px 12px;font-size:11px}
#mp-ov .mq-btn.ctr{display:block;margin-left:auto;margin-right:auto}
#mp-ov .mq-btn:disabled,#mp-ov .mq-btn[disabled]{opacity:.45;cursor:not-allowed;filter:grayscale(.5)}
#mp-ov .mq-btn:disabled:hover{transform:none;filter:grayscale(.5)}
.mq-x{background:#1a2231;border:1px solid #313d52;border-radius:8px;color:#c3d0ea;padding:8px 13px;cursor:pointer;font-size:13px}
.mq-x:hover{border-color:#3d4c68;color:#fff}
.mq-seg{display:flex;background:#0d1119;border:1px solid #232b3a;border-radius:10px;padding:3px;gap:3px}
.mq-seg button{flex:1;border:0;background:transparent;color:#9aa5bd;border-radius:8px;padding:8px 10px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:12px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;transition:background .15s,color .15s}
.mq-seg button:hover{color:#fff}
.mq-seg button.on{background:#3e7bfa;color:#fff}
.mq-pill{background:#1a2231;border:1px solid #313d52;color:#c3d0ea;border-radius:20px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:11px;letter-spacing:1px;padding:6px 14px;cursor:pointer;transition:all .15s}
.mq-pill:hover{border-color:#3d4c68;color:#fff}
.mq-pill.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}
.mq-tab{font-family:'proxima',Verdana,sans-serif;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;font-size:12px;background:#1a2231;border:1px solid #313d52;color:#c3d0ea;border-radius:8px;padding:8px 16px;cursor:pointer;transition:all .15s}
.mq-tab:hover{color:#fff;border-color:#3d4c68}
.mq-tab.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}
.mq-tabs{display:flex;gap:7px;flex-wrap:wrap}
.mq-tagplate{font-size:clamp(18px,2.6vh,26px);text-shadow:0 3px 8px rgba(0,0,0,.6)}

/* ---------- TOP NAV (shared: home + lobby) ---------- */
.p14-nav{position:relative;z-index:5;display:flex;align-items:center;gap:14px;width:100%;pointer-events:auto}
.p14-logo{flex:0 0 auto;display:flex;align-items:center}
.p14-tabs{display:flex;gap:6px;flex-wrap:wrap}
.p14-navb{padding:8px 15px;font-size:11.5px}
.p14-navb.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}
.p14-navr{margin-left:auto;display:flex;align-items:center;gap:8px}
.p14-pill{display:flex;align-items:center;gap:7px;background:rgba(16,20,29,.85);border:1px solid #313d52;border-radius:10px;padding:7px 12px;color:#fff;font-size:13px}
.p14-pill b{font-family:'proxima',Verdana,sans-serif}
.p14-pill .ico{width:16px;height:16px}
.p14-pill .gem{width:16px;height:16px}
.p14-accchip{display:flex;align-items:center;gap:9px;background:rgba(16,20,29,.85);border:1px solid #313d52;border-radius:10px;padding:5px 12px 5px 6px;cursor:pointer;transition:border-color .15s}
.p14-accchip:hover{border-color:#3e7bfa}
.p14-accchip img{width:30px;height:30px;border-radius:8px;background:#0a0d14}
.p14-accchip .i{display:flex;flex-direction:column;align-items:flex-start;line-height:1.25}
.p14-accchip .i b{font-size:12.5px}
.p14-accchip .i small{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;display:flex;align-items:center;gap:4px}
.p14-accchip .rk-svg{width:14px;height:14px}

/* ---------- HOME ---------- */
.p14-home{width:min(1280px,100%);margin:auto;display:flex;flex-direction:column;gap:14px;pointer-events:none}
.p14-home>*{pointer-events:auto}
.p14-body{display:grid;grid-template-columns:minmax(280px,1.05fr) minmax(240px,.9fr) minmax(280px,1.05fr);gap:14px;align-items:start;min-height:0}
.p14-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.p14-ph{display:flex;align-items:center;gap:8px;font-family:'torus','titan-one',Verdana,sans-serif;font-weight:normal;font-size:11px;letter-spacing:2.2px;text-transform:uppercase;color:#8296c4;border-bottom:1px solid #232b3a;padding:11px 13px}
.p14-ph .ico{width:15px;height:15px}
.p14-ph .cnt{margin-left:auto;font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;letter-spacing:1px}
.p14-ph button{background:none;border:0;color:#9aa5bd;cursor:pointer;font-size:14px;padding:2px 5px;border-radius:6px}
.p14-ph button:hover{color:#fff;background:rgba(255,255,255,.08)}
.p14-lob,.p14-chat,.p14-side{padding:0 0 8px;min-width:0}
.p14-lobs{padding:9px;display:flex;flex-direction:column;gap:6px;max-height:236px;overflow:auto}
.p14-lobrow{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.12);border-radius:9px;padding:7px 9px;transition:border-color .15s,background .15s;animation:p14in .3s ease both}
.p14-lobrow:hover{border-color:rgba(62,123,250,.5);background:rgba(62,123,250,.06)}
.p14-lobrow img{width:34px;height:34px;border-radius:8px;background:#0a0d14;flex:0 0 auto}
.p14-lobrow .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start}
.p14-lobrow .i b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.p14-lobrow .i small{font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#9aa5bd}
.p14-lobrow .i small b{color:#8ecaff;font-size:10.5px}
@keyframes p14in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.p14-create{margin:2px 9px 4px;display:flex;align-items:center;justify-content:center;gap:8px}
.p14-center{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:12px;min-height:min(430px,56vh);padding-bottom:4.5vh}
.p14-namebox{background:rgba(16,20,29,.85);border:1px solid #313d52;border-radius:10px;overflow:hidden;display:flex;transition:border-color .15s}
.p14-namebox:focus-within{border-color:#3e7bfa}
.p14-namebox input{border:0!important;background:transparent!important;box-shadow:none!important;text-align:center;font-size:15px;padding:9px 14px;width:min(220px,60vw)}
.p14-playwrap{display:flex;flex-direction:column;align-items:center;gap:10px}
.p14-play{font-family:'torus','titan-one',Verdana,sans-serif;display:flex;flex-direction:column;align-items:center;gap:1px;background:linear-gradient(180deg,#ffd95e,#eda22c);border:1px solid rgba(255,230,160,.65);border-radius:14px;color:#3a2708;padding:13px 58px;cursor:pointer;letter-spacing:3px;font-size:26px;line-height:1.15;transition:transform .14s,box-shadow .14s,filter .14s;box-shadow:0 8px 26px rgba(237,162,44,.3)}
.p14-play small{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:2.5px;opacity:.75}
.p14-play:hover{filter:brightness(1.06);transform:translateY(-2px);box-shadow:0 12px 30px rgba(237,162,44,.42)}
.p14-play:active{transform:translateY(1px)}
.p14-err{text-align:center;min-height:16px;color:#ff9ba3;font-size:12.5px}
.p14-side{display:flex;flex-direction:column}
.p14-acc{padding:12px 13px}
.p14-acc .top{display:flex;align-items:center;gap:10px}
.p14-acc .top img{width:40px;height:40px;border-radius:10px;background:#0a0d14}
.p14-acc .top .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start}
.p14-acc .top .i b{font-size:14px}
.p14-acc .top .i small{font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#9aa5bd;display:flex;align-items:center;gap:5px}
.p14-acc .top .i small .rk-svg{width:14px;height:14px}
.p14-xpmini{margin-top:9px}
.p14-xpmini .lab{display:flex;justify-content:space-between;font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;letter-spacing:1px;margin-bottom:4px}
.p14-minibar{height:7px;border-radius:5px;background:#0d1119;border:1px solid #232b3a;overflow:hidden}
.p14-minibar i{display:block;height:100%;background:linear-gradient(90deg,#3e7bfa,#6fa0ff);transition:width .5s ease}
.p14-acc .row{display:flex;gap:7px;margin-top:10px}
.p14-acc .row .mq-btn{flex:1;padding:8px 6px;font-size:10.5px}
.p14-guest{padding:13px}
.p14-guest p{margin:6px 0 10px;font-size:12px;color:#9aa5bd;line-height:1.5}
.p14-lbrows{padding:8px 9px;display:flex;flex-direction:column;gap:5px}
.p14-lbr{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px;border:1px solid transparent;animation:p14in .3s ease both}
.p14-lbr.me{background:rgba(62,123,250,.1);border-color:rgba(62,123,250,.4)}
.p14-lbr>span{width:20px;text-align:center;font-family:'torus','titan-one',Verdana,sans-serif;color:#9aa5bd;font-size:13px}
.p14-lbr img{width:28px;height:28px;border-radius:7px;background:#0a0d14}
.p14-lbr b{flex:1;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.p14-lbr em{font-style:normal;font-family:'proxima',Verdana,sans-serif;font-weight:bold;color:#8ecaff;font-size:12px}
.p14-lbtabs{display:flex;gap:5px;padding:9px 9px 0}
.p14-lbtabs button{flex:1;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;background:#1a2231;border:1px solid #313d52;color:#9aa5bd;border-radius:7px;padding:5px;cursor:pointer}
.p14-lbtabs button.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}

`;

  var ov, hud, board, big, toastEl, toastT = null;
  var css2 = `

/* ---------- LOBBY BROWSER + CREATE ---------- */
.mq-screen{width:min(1180px,100%);max-height:100%;margin:auto;display:flex;align-items:stretch;justify-content:center}
.mq-screen>.mq-panel,.mq-screen>.mq-auth{display:flex;flex-direction:column;padding:16px 18px;min-height:0;max-height:100%}
.mq-browse{width:min(760px,100%);gap:0}
.mq-tools{display:flex;gap:9px;align-items:center;margin:10px 0 12px;flex-wrap:wrap}
.mq-tools input{flex:1;min-width:180px}
.mq-pills{display:flex;gap:6px}
.mq-lobs{flex:1;min-height:140px;overflow:auto;display:flex;flex-direction:column;gap:7px;padding-right:3px}
.mq-lob{display:flex;align-items:center;gap:11px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.12);border-radius:10px;padding:9px 11px;transition:border-color .15s}
.mq-lob:hover{border-color:rgba(62,123,250,.5)}
.mq-lob img{width:38px;height:38px;border-radius:9px;background:#0a0d14}
.mq-lob .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.mq-lob .i b{font-size:14px}
.mq-lob .i small{font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#9aa5bd;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.mq-lob .cnt{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.mq-lob .mq-bar{width:86px}
.mq-lob .mq-note{font-size:10.5px;color:#9aa5bd;display:flex;align-items:center;gap:3px}
.mq-foot2{display:flex;gap:8px;margin-top:12px}
.mq-foot2 .mq-btn{flex:1}
.mq-opt{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.12);border-radius:9px;padding:8px 11px;margin:6px 0}
.mq-opt>span{flex:1;min-width:0}
.mq-opt b{display:block;font-size:12.5px}
.mq-opt small{display:block;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#626e88;margin-top:1px}
.mq-opt input[type=checkbox]{appearance:none;-webkit-appearance:none;width:42px;height:22px;border-radius:12px;background:#232b3a;border:1px solid #313d52;position:relative;cursor:pointer;flex:0 0 auto;margin:0;transition:background .15s}
.mq-opt input[type=checkbox]:checked{background:rgba(63,191,127,.5);border-color:rgba(120,220,170,.6)}
.mq-opt input[type=checkbox]::after{content:'';position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#c3d0ea;transition:left .15s}
.mq-opt input[type=checkbox]:checked::after{left:22px;background:#fff}
.mq-opt select,.mq-opt input[type=number],.mq-opt input[type=text]{max-width:190px}

/* ---------- AUTH ---------- */
.mq-auth{width:min(420px,100%);gap:0}
.mq-auth .art{background:rgba(255,255,255,.025);border:1px solid #232b3a;border-radius:10px;padding:14px;margin-bottom:14px}
.mq-auth .art ul{margin:0;padding:0 0 0 4px;list-style:none;font-size:12px;color:#9aa5bd;line-height:1.9}
.mq-auth .art ul li:before{content:'\\25B8';color:#3e7bfa;margin-right:8px}
.mq-auth .art img.c{display:block;height:min(190px,26vh);margin:0 auto 10px;filter:drop-shadow(0 14px 18px rgba(0,0,0,.55))}
.mq-pw{display:flex;gap:7px}
.mq-pw input{flex:1}
.mq-pw button{flex:0 0 auto}

/* ---------- LOCKER ---------- */
.fnk-locker{display:grid;grid-template-columns:1fr minmax(400px,44%);gap:16px;width:min(1460px,100%);height:min(860px,100%)}
.fnk-left{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;padding:14px;min-height:0}
.fnk-hint{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;letter-spacing:2px;color:rgba(210,224,255,.75);background:rgba(10,14,22,.7);border:1px solid #313d52;border-radius:20px;padding:6px 14px}
.fnk-hint svg{width:15px;height:15px}
.fnk-desc{background:linear-gradient(180deg,rgba(10,13,20,0),rgba(10,13,20,.92) 40%);border-radius:12px;padding:14px 16px;max-width:430px}
.fnk-desc .fnk-rar{display:block;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10.5px;letter-spacing:2.5px;color:#8ecaff;margin-bottom:3px}
.fnk-desc b{display:block;font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:clamp(24px,3vw,38px);text-transform:uppercase;letter-spacing:1px;text-shadow:0 3px 8px rgba(0,0,0,.5)}
.fnk-desc span{display:block;font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#9aa5bd;margin-top:3px}
.fnk-desc p{font-family:'proxima',Verdana,sans-serif;font-size:12.5px;color:#b9c4d8;margin:8px 0 0;max-width:380px}
.fnk-right{display:flex;flex-direction:column;min-height:0;padding:14px 16px}
.fnk-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.fnk-head h2{margin:0;font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:clamp(20px,2.4vw,30px);letter-spacing:2px;text-transform:uppercase;color:#cdd8ee}
.fnk-tabs{margin-bottom:10px}
.fnk-tools{display:flex;gap:8px;align-items:center;margin:0 0 10px}
.fnk-tools input{flex:1}
.fnk-tools .fltr{width:24px;height:24px;color:#9aa5bd;flex:none}
.fnk-scr{flex:1;min-height:0;overflow:auto;padding:2px 6px 2px 2px}
.fnk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(102px,1fr));gap:9px}
.fnk-grid.tags{grid-template-columns:repeat(auto-fill,minmax(88px,1fr))}
.fnk-tile{position:relative;cursor:pointer;border-radius:10px;padding:6px;border:1px solid rgba(120,150,220,.16);text-align:center;transition:transform .12s,border-color .15s,box-shadow .15s}
.fnk-tile:hover{transform:translateY(-2px);border-color:#3d4c68}
.fnk-tile.ch{background:linear-gradient(180deg,rgba(46,66,120,.5),rgba(20,30,60,.6))}
.fnk-tile.bd{background:linear-gradient(180deg,rgba(90,70,30,.35),rgba(40,30,14,.55))}
.fnk-tile b{display:block;margin-top:5px;font-family:'proxima',Verdana,sans-serif;font-size:12px;font-weight:bold;color:#e8edf6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fnk-tile.sel{border-color:#3e7bfa;box-shadow:0 0 0 2px rgba(62,123,250,.35)}
.fnk-tile.sel::after{content:'\\2714';position:absolute;right:5px;top:5px;width:18px;height:18px;border-radius:50%;background:#3e7bfa;color:#fff;font-size:11px;line-height:18px;font-family:Verdana,sans-serif}
.fnk-imgw{aspect-ratio:1;border-radius:8px;overflow:hidden;background:rgba(6,9,16,.5);display:block}
.fnk-imgw img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.fnk-tile.bd .fnk-imgw{background:radial-gradient(ellipse at 50% 42%,rgba(70,110,220,.22),rgba(6,9,16,.6) 72%)}
.fnk-imgw img.bd3d{object-fit:contain;padding:9%}
.fnk-sub{grid-column:1/-1;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8296c4;margin:10px 0 5px}
.fnk-swatch{width:34px;height:34px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.25);display:inline-flex;justify-content:center;align-items:center;justify-self:center;transition:transform .12s}
.fnk-swatch.sel{border-color:#fff;box-shadow:0 0 0 2px rgba(62,123,250,.7);transform:scale(1.1)}
.fnk-swatch.sm{width:26px;height:26px}
.fnk-badge{width:48px;height:48px;border-radius:10px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;background:#1a2231;border:1px solid #313d52;justify-self:center;position:relative;transition:border-color .15s}
.fnk-badge svg{width:28px;height:28px}
.fnk-badge.sel{border-color:#3e7bfa;box-shadow:0 0 0 2px rgba(62,123,250,.4)}
.fnk-pick{min-width:86px;height:36px;padding:0 12px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:'proxima',Verdana,sans-serif;font-size:12px;font-weight:bold;color:#dbe3f2;background:#1a2231;border:1px solid #313d52;justify-self:center;transition:border-color .15s}
.fnk-pick:hover{border-color:#3d4c68}
.fnk-pick.sel{border-color:#3e7bfa;background:rgba(62,123,250,.14);color:#fff}
.fnk-urow{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.fnk-range,#mp-to{-webkit-appearance:none;appearance:none;width:100%;height:8px;border-radius:6px;background:#0d1119;border:1px solid #232b3a;outline:0;margin:9px 0;cursor:pointer}
.fnk-range::-webkit-slider-thumb,#mp-to::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#3e7bfa;border:2px solid #0a0d14;cursor:pointer}
.fnk-range::-moz-range-thumb,#mp-to::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#3e7bfa;border:2px solid #0a0d14}
.fnk-btns{display:flex;gap:9px;margin-top:12px}
.fnk-btns .mq-btn{flex:1;height:46px;font-size:14px}
.mq-sw{display:flex;flex-wrap:wrap;gap:8px}
.mq-sw i{font-style:normal;width:auto;min-width:88px;padding:0 12px;height:36px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-family:'proxima',Verdana,sans-serif;font-size:12px;font-weight:bold;color:#dbe3f2;background:#1a2231;border:1px solid #313d52;cursor:pointer;transition:border-color .15s}
.mq-sw i:hover{border-color:#3d4c68}
.mq-sw i.sel{border-color:#3e7bfa;background:rgba(62,123,250,.14);color:#fff}

/* ---------- COUNTDOWN ---------- */
.mp-cd{display:flex;flex-direction:column;align-items:center;gap:12px;pointer-events:none}
.mp-cd-t{font-family:'torus','titan-one',sans-serif;font-size:clamp(20px,3.4vw,34px);letter-spacing:6px;text-shadow:0 3px 10px rgba(0,0,0,.7)}
.mp-cd-n{font-family:'torus','titan-one',sans-serif;font-size:clamp(64px,11vw,120px);color:#ffd95e;text-shadow:0 8px 0 rgba(140,80,0,.35),0 0 46px rgba(0,0,0,.6);line-height:1}
.mp-cd-p{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:80vw}
.mp-cd-p span{background:rgba(10,14,22,.8);border:1px solid #313d52;border-radius:20px;font-family:'proxima',Verdana,sans-serif;font-size:12px;padding:5px 14px}
.mp-cd-h{font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#9aa5bd;letter-spacing:1px}

`;
  var css4 = `

/* ---------- RESULTS / LEADERBOARD ---------- */
.mq-lb{width:min(860px,100%);gap:0;display:flex;flex-direction:column}
.mq-auth{display:flex;flex-direction:column}
#mp-ov .mq-screen>.mq-lb.wide,#mp-ov .mq-lb.wide{flex-direction:row;width:min(1080px,100%);gap:16px;align-items:stretch}
.mq-lb .hd{display:flex;align-items:center;gap:10px;border-bottom:1px solid #232b3a;padding-bottom:10px}
.mq-lb .hd h2{margin:0;font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:20px;letter-spacing:2.5px;text-transform:uppercase;color:#cdd8ee}
.mq-lb .hd .ring{width:12px;height:12px;border-radius:50%;border:3px solid #f6c453;box-shadow:0 0 10px rgba(246,196,83,.6)}
.mq-lb .hd .menu{margin-left:auto;display:flex;gap:4px}
.mq-lb .hd .menu i{width:5px;height:5px;border-radius:50%;background:#626e88}
.mq-lbtabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
.mq-lbtabs button{background:#1a2231;border:1px solid #313d52;color:#c3d0ea;border-radius:20px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:11px;letter-spacing:.8px;padding:6px 14px;cursor:pointer;transition:all .15s}
.mq-lbtabs button:hover{color:#fff;border-color:#3d4c68}
.mq-lbtabs button.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}
.mq-lbscroll{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1}
.mq-lb.wide>div:last-child{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.lrw{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.12);border-radius:10px;padding:8px 12px}
.lrw:hover{border-color:rgba(62,123,250,.4)}
.lrw.me{background:rgba(62,123,250,.1);border-color:rgba(62,123,250,.5)}
.lrw .no{font-family:'torus','titan-one',sans-serif;color:#f6c453;font-size:15px;width:26px;text-align:center;flex:0 0 auto}
.lrw img{width:34px;height:34px;border-radius:9px;background:#0a0d14;border:1px solid #313d52;flex:0 0 auto}
.lrw .n{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:13.5px}
.lrw .n small{font-family:'proxima',Verdana,sans-serif;font-weight:normal;font-size:10.5px;color:#626e88;margin-top:1px}
.lrw .v{font-family:'proxima',Verdana,sans-serif;font-weight:bold;color:#7ce0ac;font-size:14px;display:flex;align-items:center;gap:6px}
.lrw .v .gem{width:14px;height:14px}
.pod{display:flex;gap:10px;align-items:flex-end;margin:6px 0 12px}
.pod .pc{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;background:rgba(255,255,255,.035);border:1px solid rgba(120,150,220,.14);border-radius:12px;padding:14px 8px 12px;position:relative}
.pod .pc.p1{background:linear-gradient(180deg,rgba(246,196,83,.13),rgba(246,196,83,.03));border-color:rgba(246,196,83,.45);box-shadow:0 0 30px rgba(246,196,83,.1);padding-top:20px}
.pod .pc.empty{visibility:hidden}
.pod .pc .lw{display:flex;align-items:center;gap:6px;font-family:'torus','titan-one',sans-serif;font-size:13px;color:#9aa5bd}
.pod .pc .lw svg{width:17px;height:17px}
.pod .pc .crw{position:absolute;top:-13px}
.pod .pc .crw svg{width:26px;height:26px;filter:drop-shadow(0 3px 3px rgba(0,0,0,.5))}
.pod .pc .av img{width:52px;height:52px;border-radius:12px;background:#0a0d14;border:1px solid #313d52;object-fit:cover;object-position:top}
.pod .pc .pn{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:14px;display:flex;align-items:center;gap:4px;max-width:100%;overflow:hidden}
.pod .pc .ps{font-family:'proxima',Verdana,sans-serif;font-weight:bold;color:#7ce0ac;display:flex;align-items:center;gap:5px}
.pod .pc .ps .gem{width:13px;height:13px}
.mq-win{position:relative;overflow:visible;flex:0 0 300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(246,196,83,.05);border:1px solid rgba(246,196,83,.3);border-radius:12px;padding:18px 16px}
.mq-win .crown svg{width:38px;height:38px;filter:drop-shadow(0 4px 4px rgba(0,0,0,.5))}
.mq-win h3{margin:6px 0 0;font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:19px;letter-spacing:1.5px;color:#ffdf8a;text-transform:uppercase;text-align:center}
.mq-win .av img{width:74px;height:74px;border-radius:16px;background:#0a0d14;border:1px solid rgba(246,196,83,.4);object-fit:cover;object-position:top}
.mq-win .nm{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:16px}
.mq-win .lw{display:flex;align-items:center;gap:6px;color:#9aa5bd;font-family:'torus','titan-one',sans-serif;font-size:14px}
.mq-win .lw svg{width:18px;height:18px}
.mq-win .sc{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:24px;color:#7ce0ac;display:flex;align-items:center;gap:8px}
.mq-win .sc .gem{width:18px;height:18px}
.mq-rp{margin-top:10px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.mq-rp .xpline{width:100%;max-width:240px}
.mq-rp .xpline .lab{display:flex;justify-content:space-between;font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;letter-spacing:1px;margin-bottom:4px}
.mq-rp .lvup{font-family:'torus','titan-one',sans-serif;color:#ffdf8a;letter-spacing:2px;font-size:15px;animation:p14pop .5s ease}
@keyframes p14pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
.mp-rk{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:12px;display:inline-flex;align-items:center;gap:5px}
.mp-rk .rk-svg{width:15px;height:15px}
.btns{display:flex;gap:8px;margin-top:12px}
.btns .mq-btn{flex:1}

/* ---------- race HUD ---------- */
#mp-hud{position:fixed;inset:0;z-index:99980;pointer-events:none}
#mp-hud>*{pointer-events:auto}
#mp-hud #mp-big,#mp-hud #mp-toast{pointer-events:none}
#mp-board{position:absolute;left:12px;top:64px;display:none;background:rgba(10,14,22,.78);border:1px solid #232b3a;border-radius:10px;padding:8px 11px;font-family:'proxima',Verdana,sans-serif;font-size:12px;line-height:1.75;color:#dbe3f2;pointer-events:auto;max-width:230px}
#mp-board div{display:flex;align-items:center;gap:6px}
#mp-board i{width:8px;height:8px;border-radius:2px;flex:0 0 auto}
#mp-hudopen{position:absolute;left:10px;top:10px;display:none;pointer-events:auto;border:1px solid #313d52;border-radius:9px;background:rgba(10,14,22,.85);color:#dbe3f2;padding:6px 9px;cursor:pointer}
#mp-hudopen svg{width:18px;height:18px;display:block}
#mp-posbar{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:none;flex-direction:column;gap:6px;background:rgba(10,14,22,.82);border:1px solid #232b3a;border-radius:12px;padding:8px 44px 8px 12px;min-width:340px;max-width:min(760px,92vw);pointer-events:auto}
#mp-posbar .hdr{display:flex;gap:8px;flex-wrap:wrap}
#mp-posbar .hdr span{background:rgba(6,9,16,.8);border:1px solid #313d52;border-radius:7px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10.5px;letter-spacing:1.2px;color:#c3d0ea;padding:4px 10px;text-transform:uppercase}
#mp-posbar .hdr span.g{color:#ffdf8a;border-color:rgba(246,196,83,.4)}
#mp-posbar .mqb{position:relative;height:96px}
#mp-posbar .mqb .area{position:absolute;inset:0;display:flex;align-items:flex-end;gap:10px;padding:0 6px}
#mp-posbar .col{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0}
#mp-posbar .col .cr{font-size:14px;line-height:1;height:16px}
#mp-posbar .col .val{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;color:#c3d0ea}
#mp-posbar .col .bar{width:60%;max-width:34px;border-radius:4px 4px 0 0;min-height:4px}
#mp-posbar .col img{position:absolute;bottom:-2px;width:24px;height:24px;border-radius:7px;background:#0a0d14;border:2px solid;object-fit:cover;object-position:top;left:50%;transform:translateX(-50%)}
#mp-posbar .col.out{opacity:.4;filter:grayscale(.7)}
#mp-posbar .mqt{position:relative;height:40px;margin-top:2px}
#mp-posbar .mqt .rail{position:absolute;left:0;right:0;top:19px;height:2px;background:#313d52}
#mp-posbar .mqt .tk{position:absolute;top:0;font-family:'proxima',Verdana,sans-serif;font-size:9px;color:#626e88;transform:translateX(-50%)}
#mp-posbar .pin{position:absolute;top:8px;width:24px;height:24px;transform:translateX(-50%);transition:left .3s linear}
#mp-posbar .pin img{width:24px;height:24px;border-radius:7px;background:#0a0d14;border:2px solid;object-fit:cover;object-position:top}
#mp-posbar .pin b{position:absolute;right:-4px;top:-7px;background:#1a2231;border:1px solid #313d52;color:#c3d0ea;font-size:8.5px;border-radius:6px;padding:0 4px;font-family:'proxima',Verdana,sans-serif}
#mp-posbar .pin.me img{border-color:#3e7bfa;box-shadow:0 0 8px rgba(62,123,250,.5)}
#mp-posbar .pin.out{opacity:.4;filter:grayscale(.7)}
#mp-posbar.cmp .mqb,#mp-posbar.cmp .mqt{display:none}
#mp-posbar .hc{position:absolute;right:6px;top:6px;display:flex;gap:4px;pointer-events:auto;z-index:3}
#mp-posbar .hc button{border:1px solid #313d52;border-radius:7px;background:#1a2231;color:#c3d0ea;font-size:11px;width:22px;height:20px;line-height:1;cursor:pointer;padding:0}
#mp-posbar .hc button:hover{color:#fff;border-color:#3d4c68}
#mp-big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:'torus','titan-one',sans-serif;font-size:clamp(46px,8vw,92px);color:#fff;text-shadow:0 6px 0 rgba(140,60,0,.4),0 0 50px rgba(0,0,0,.6);letter-spacing:4px;z-index:40}
#mp-toast{position:absolute;left:50%;bottom:9vh;transform:translateX(-50%);background:rgba(10,14,22,.9);border:1px solid #313d52;border-radius:12px;padding:9px 18px;font-family:'proxima',Verdana,sans-serif;font-size:13px;color:#dbe3f2;opacity:0;transition:opacity .3s;pointer-events:none;max-width:80vw;text-align:center}
#mp-toast a{color:#8ecaff}

`;
  var css3 = `

/* ---------- LOBBY CHAT (floating) ---------- */
#mp-lchat{position:fixed;left:14px;bottom:14px;z-index:99994;width:min(360px,92vw);display:none;flex-direction:column;background:linear-gradient(180deg,#12161f,#0f131b);border:1px solid #232b3a;border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.4);overflow:hidden;pointer-events:auto}
#mp-lchat .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #232b3a;font-family:'torus','titan-one',Verdana,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8296c4;cursor:grab}
#mp-lchat .hd .ico{width:15px;height:15px}
#mp-lchat .hd small{margin-left:auto;font-family:'proxima',Verdana,sans-serif;font-size:9px;letter-spacing:.6px;color:#626e88;text-transform:none}
#mp-lchat .hd .cb{border:1px solid #313d52;background:#1a2231;border-radius:6px;color:#c3d0ea;font-size:10px;width:22px;height:20px;cursor:pointer;padding:0;line-height:1}
#mp-lchat .hd .cb:hover{color:#fff;border-color:#3d4c68}
#mp-lchat .cbox{height:var(--ch,150px);max-height:none;padding:10px 12px;overflow-y:auto;display:flex;flex-direction:column}
#mp-lchat.cmin .cbox,#mp-lchat.cmin .cf{display:none}
#mp-lchat.sz1{width:min(430px,94vw);--ch:210px}
#mp-lchat.sz2{width:min(540px,94vw);--ch:320px}
#mp-lchat .cf{display:flex;gap:7px;padding:9px 10px;border-top:1px solid #232b3a}
#mp-lchat .cf input{flex:1;min-width:0}
#mp-lchat .cf button{flex:0 0 auto;width:38px;height:36px;display:flex;align-items:center;justify-content:center;background:#3e7bfa;border:1px solid rgba(150,185,255,.5);border-radius:8px;color:#fff;cursor:pointer}
#mp-lchat .cf button:hover{filter:brightness(1.1)}
#mp-lchat .cf button svg{width:16px;height:16px}
#mp-lchat.ing{opacity:.92;transition:opacity .5s}
#mp-lchat.ing:not(.act):hover{opacity:1}
#mp-lchat.ing:not(.act) .cbox{height:110px}

/* ---------- visual-novel chat (universal + lobby, per reference) ---------- */
.c13box{flex:1;min-height:120px;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;scrollbar-width:thin}
.c13{position:relative;display:flex;align-items:flex-start;gap:8px;margin:12px 0 10px;padding-right:58px;animation:c13in .25s ease}
@keyframes c13in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.c13 .c13-port{position:absolute;right:-4px;top:0;width:60px;height:60px;object-fit:cover;object-position:top;border-radius:14px;opacity:.5;filter:saturate(.85);pointer-events:none}
.c13.mine{flex-direction:row-reverse;padding-right:0;padding-left:58px;justify-content:flex-start}
.c13.mine .c13-port{left:-4px;right:auto}
.c13-wrap{max-width:76%;display:flex;flex-direction:column;gap:3px;min-width:0}
.c13.mine .c13-wrap{align-items:flex-end}
.c13-nm{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#8a97b4;letter-spacing:.6px;padding:0 9px}
.c13-bd{position:relative;background:#2b3542;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:9px 34px 14px 13px;color:#eef3f8;font-family:'proxima',Verdana,sans-serif;font-size:12.5px;line-height:1.5;word-break:break-word}
.c13.mine .c13-bd{background:linear-gradient(180deg,#2c4a7a,#24406b);border-color:rgba(120,160,255,.25);border-top-right-radius:5px}
.c13:not(.mine) .c13-bd{border-top-left-radius:5px}
.c13-ts{position:absolute;right:9px;bottom:4px;font-size:9px;color:rgba(255,255,255,.5);font-family:'proxima',Verdana,sans-serif}
.c13-go{align-self:center;flex:0 0 auto;background:linear-gradient(180deg,#9be15d,#5faf2e);border:0;border-radius:20px;color:#17350a;font-family:'torus','titan-one',Verdana,sans-serif;font-size:13px;letter-spacing:1px;padding:8px 18px;cursor:pointer;transition:transform .14s,filter .14s}
.c13-go:hover{filter:brightness(1.08);transform:translateY(-1px)}
.c13-sys{display:flex;align-items:center;justify-content:center;gap:8px;margin:9px 0;color:#8a97b4;font-family:'proxima',Verdana,sans-serif;font-size:11px}
.c13-sys.err{color:#ff9ba3}
.c13-sys .sav{width:24px;height:24px;border-radius:50%;background:#0a0d14;border:1px solid #313d52;object-fit:cover;object-position:top}
.c13.old{opacity:.55}
.c13form{display:flex;gap:7px;padding:9px 10px;border-top:1px solid #232b3a}
.c13form input{flex:1;min-width:0;border:0!important;box-shadow:none!important}
.c13form button{flex:0 0 auto;width:38px;height:36px;display:flex;align-items:center;justify-content:center;background:#3e7bfa;border:1px solid rgba(150,185,255,.5);border-radius:8px;color:#fff;cursor:pointer}
.c13form button:hover{filter:brightness(1.1)}
.c13form button svg{width:16px;height:16px}

/* ---------- FORTNITE-INSPIRED LOBBY ---------- */
.f14{position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;padding:12px 16px 14px;gap:12px}
.f14-nav{pointer-events:auto!important}
.f14-mid{flex:1;min-height:0;position:relative}
.f14-left{position:absolute;left:0;top:0;bottom:0;width:min(300px,30vw);display:flex;flex-direction:column;gap:10px;pointer-events:auto!important;min-height:0;padding-bottom:240px}
.f14-season{padding:13px}
.f14-season .stag{display:inline-block;background:linear-gradient(180deg,#3e7bfa,#2653c8);color:#fff;border-radius:7px;padding:3px 11px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:2px}
.f14-lv{display:flex;align-items:center;gap:11px;margin-top:11px}
.f14-shield{width:52px;height:52px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.f14-shield svg{width:50px;height:50px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5))}
.f14-lvmid{flex:1;min-width:0}
.f14-lvnum{font-family:'torus','titan-one',sans-serif;font-size:20px;letter-spacing:1px;text-shadow:0 2px 4px rgba(0,0,0,.5)}
.f14-xptxt{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;margin:3px 0 5px;letter-spacing:.5px}
.f14-xp{height:8px;border-radius:6px;background:#0d1119;border:1px solid #232b3a;overflow:hidden}
.f14-xp i{display:block;height:100%;background:linear-gradient(90deg,#3e7bfa,#6fa0ff);transition:width .5s ease}
.f14-rkrow{display:flex;align-items:center;gap:9px;margin-top:11px;padding-top:10px;border-top:1px solid #232b3a}
.f14-rkrow .rk-svg{width:34px;height:34px;flex:0 0 auto}
.f14-rkrow .i{display:flex;flex-direction:column;align-items:flex-start;line-height:1.3}
.f14-rkrow .i b{font-family:'proxima',Verdana,sans-serif;font-size:13px}
.f14-rkrow .i small{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd}
.f14-mode{padding:12px 13px}
.f14-mode .mh{font-family:'torus','titan-one',Verdana,sans-serif;font-size:10px;letter-spacing:2.2px;color:#8296c4;text-transform:uppercase}
.f14-mode .mn{font-family:'torus','titan-one',sans-serif;font-size:22px;letter-spacing:1.5px;margin:3px 0 9px;text-transform:uppercase}
.f14-fillrow{display:flex;align-items:center;gap:9px;font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#c3d0ea;margin-top:9px}
.f14-fillrow span{flex:1}
.f14-fillop{font-size:9.5px;letter-spacing:1px;color:#626e88;width:58px;text-align:right}
.f14-switch{width:46px;height:22px;border-radius:12px;background:#232b3a;border:1px solid #313d52;position:relative;cursor:pointer;transition:background .2s;flex:0 0 auto}
.f14-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#8a97b4;transition:all .2s ease}
.f14-switch.on{background:rgba(63,191,127,.4);border-color:rgba(120,220,170,.5)}
.f14-switch.on i{left:26px;background:#3fbf7f}
.f14-lobinfo{padding:11px 13px;font-family:'proxima',Verdana,sans-serif}
.f14-lobinfo small{color:#9aa5bd;display:block;margin-bottom:7px;font-size:11px}
.f14-lobinfo small b{color:#ffdf8a;letter-spacing:3px;font-size:13px}
.f14-lobinfo .tags{display:flex;flex-wrap:wrap;gap:5px}
.f14-lobinfo .rf{margin-top:7px}
.f14-lobinfo .rf a{color:#8ecaff;font-size:11px;cursor:pointer;text-decoration:none}
.f14-lobinfo .rf a:hover{text-decoration:underline}
.f14-party{position:absolute;right:0;top:0;width:min(300px,30vw);max-height:100%;overflow:auto;padding:0 0 8px;pointer-events:auto!important}
.f14-party .rh{display:flex;align-items:center;gap:8px;font-family:'torus','titan-one',Verdana,sans-serif;font-size:11px;letter-spacing:2.2px;text-transform:uppercase;color:#8296c4;border-bottom:1px solid #232b3a;padding:11px 13px}
.f14-party .rh .cnt{margin-left:auto;font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd}
.f14-ros{display:flex;align-items:center;gap:9px;padding:6px 9px;margin:4px 6px;border-radius:9px;border:1px solid transparent;transition:border-color .15s,background .15s}
.f14-ros:hover{background:rgba(120,150,220,.07);border-color:rgba(120,150,220,.18)}
.f14-ros img{width:34px;height:34px;border-radius:8px;background:#0a0d14;flex:0 0 auto}
.f14-ros .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.f14-ros .i small{font-family:'proxima',Verdana,sans-serif;font-size:9.5px;letter-spacing:1px;display:inline-flex;align-items:center;gap:4px}
.f14-ros .i small .rk-svg{width:12px;height:12px}
.f14-ros .i small.ok{color:#7ce0ac}
.f14-ros .i small.no{color:#ff9ba3}
.f14-ros .i small.host{color:#ffdf8a}
.f14-ros .lvchip{font-family:'proxima',Verdana,sans-serif;font-size:9px;color:#8ecaff;background:rgba(62,123,250,.12);border:1px solid rgba(62,123,250,.35);padding:0 6px;border-radius:8px}
.f14-kick{background:rgba(224,86,86,.12);border:1px solid rgba(224,86,86,.4);color:#ff9ba3;border-radius:7px;width:24px;height:24px;cursor:pointer;font-size:11px;flex:0 0 auto}
.f14-kick:hover{background:rgba(224,86,86,.28)}
.f14-cam{position:absolute;left:16px;bottom:16px;width:46px;height:46px;border-radius:50%;background:rgba(10,14,22,.85);border:1px solid #313d52;color:#c3d0ea;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:auto!important;transition:transform .15s,border-color .15s}
.f14-cam svg{width:20px;height:20px}
.f14-cam:hover{border-color:#3e7bfa;color:#fff;transform:scale(1.06)}
.f14-go{position:absolute;right:0;bottom:0;width:min(300px,30vw);padding:13px;display:flex;flex-direction:column;gap:9px;pointer-events:auto!important}
.f14-readyline{text-align:center;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#9aa5bd;letter-spacing:.5px}
.f14-ready{font-family:'torus','titan-one',Verdana,sans-serif;width:100%;background:linear-gradient(180deg,#ffd95e,#eda22c);border:1px solid rgba(255,230,160,.6);border-radius:11px;color:#3a2708;font-size:19px;letter-spacing:3px;padding:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;transition:filter .14s,transform .14s;box-shadow:0 6px 20px rgba(237,162,44,.28)}
.f14-ready .ric{width:19px;height:19px}
.f14-ready:hover{filter:brightness(1.07)}
.f14-ready:active{transform:translateY(1px)}
.f14-ready:disabled{filter:grayscale(.75) brightness(.7);cursor:not-allowed}
.f14-ready.un{background:linear-gradient(180deg,#3fbf7f,#27995f);color:#fff;border-color:rgba(120,220,170,.5);text-shadow:0 1px 1px rgba(0,40,20,.4)}
.f14-gorow{display:flex;gap:8px}
.f14-gorow .mq-btn{flex:1}
.f14-inv{background:#3e7bfa!important;border-color:rgba(150,185,255,.55)!important;color:#fff!important}

`;

  // ======================================================= v8 UI LAYER =======
  var PLATES = ['None', 'Pill', 'Neon', 'Glass', 'Flag', 'Gold', 'Hex', 'Bracket', 'Banner'];
  var EFFECTS = ['None', 'Glow', 'Shadow', 'Rainbow', 'Pulse', 'Stroke', 'Flicker', 'Bounce'];
  var lsys = [], chatFadeT = null, custOpen = false, custBack = 'home', custTab = 'outfit', brQ = '', brF = 'all', authMode = 'login', lastMetaSig = '';
  var panoCv = null, panoCtx = null, panoRaf = 0, panoLayers = null, panoImg = null, panoOn = false, panoT0 = 0, panoKey = '';

  function myPts() { return (W.MPAcc && MPAcc.user()) ? MPAcc.points() : null; }
  function myLevel() { var pr = W.MPAcc && MPAcc.profile && MPAcc.profile(); return (W.MPAcc && pr) ? MPAcc.levelOf(pr.xp | 0).lvl : 0; }
  function myTag(nm) { return { name: nm || me.name || 'Player', tc: me.tc, tt: me.tt, tp: me.tp, tf: me.tf, tr: me.tr, rk: myPts(), tq: me.tq, to: me.to, tu: me.tu }; }
  function saveCust() {
    try {
      localStorage.setItem('mp_tc', me.tc == null ? '' : me.tc); localStorage.setItem('mp_tt', me.tt || '');
      localStorage.setItem('mp_tp', me.tp | 0); localStorage.setItem('mp_tf', me.tf | 0); localStorage.setItem('mp_tr', me.tr ? 1 : 0);
      localStorage.setItem('mp_tq', me.tq | 0); localStorage.setItem('mp_to', String(me.to == null ? 10 : me.to)); localStorage.setItem('mp_tu', me.tu == null ? '' : String(me.tu));
    } catch (e) { }
    if (net) { try { net.setPlayer({ tc: me.tc, tt: me.tt || '', tp: me.tp | 0, tf: me.tf | 0, tr: me.tr ? 1 : 0, rk: myPts(), tq: me.tq | 0, to: me.to == null ? 10 : me.to, tu: me.tu == null ? -1 : me.tu }); } catch (e) { } }
  }
  function refreshCust() { if (custOpen || phase === 'custom') showCustom(); else if (phase === 'lobby') showLobby(); }

  // ---- inline icons
  function gemSvg() { return '<svg class="gem" viewBox="0 0 24 24"><defs><linearGradient id="gmg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7dffd8"/><stop offset="1" stop-color="#14b887"/></linearGradient></defs><path d="M12 2l8 7-8 13L4 9z" fill="url(#gmg)"/><path d="M12 2l3 7h-6zM4 9h16l-8 13z" fill="rgba(255,255,255,.22)"/></svg>'; }
  function laurel(col) {
    var s = '<svg viewBox="0 0 64 64" aria-hidden="true">';
    for (var side = 0; side < 2; side++) for (var i = 0; i < 7; i++) {
      var deg = 250 - i * 15, th = deg * Math.PI / 180, x = 32 + 25 * Math.cos(th), y = 34 - 25 * Math.sin(th), rot = -(deg + 90) + 25;
      if (side) { x = 64 - x; rot = 180 - rot; }
      s += '<ellipse cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" rx="6" ry="2.7" transform="rotate(' + rot.toFixed(0) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" fill="' + col + '"/>';
    }
    return s + '</svg>';
  }

  // ---- panorama background (procedural; set MP_CONFIG.panorama to use a real screenshot instead)
  function panoBuild(w, h) {
    var R = mulberry32(7), TW = Math.max(1800, Math.round(w * 1.7)), L = [];
    function mk(a, b) { var c = document.createElement('canvas'); c.width = a; c.height = b; return c; }
    function skyline(color, minH, maxH, minW, maxW, base, wc, wcol, speed) {
      var c = mk(TW, h), g = c.getContext('2d'), x = 0;
      while (x < TW) {
        var bw = Math.min(TW - x, minW + R() * (maxW - minW)), bh = minH + R() * (maxH - minH);
        g.fillStyle = color; g.fillRect(x, base - bh, bw, bh + h);
        if (R() < 0.3) g.fillRect(x + bw * 0.45, base - bh - 16, 3, 16);
        if (wc) { g.fillStyle = wcol; for (var wy = base - bh + 12; wy < base - 10; wy += 16) for (var wx = x + 7; wx < x + bw - 9; wx += 13) if (R() < wc) g.fillRect(wx, wy, 5, 8); }
        x += bw + R() * 5;
      }
      L.push({ cv: c, sp: speed });
    }
    skyline('#2b2a78', h * 0.10, h * 0.30, 34, 84, h * 0.66, 0.06, '#ffd98a', 5);
    skyline('#1b1856', h * 0.14, h * 0.40, 44, 110, h * 0.74, 0.2, '#ffcf6a', 12);
    var br = mk(TW, h), bg = br.getContext('2d');
    bg.fillStyle = '#0d0b30'; bg.fillRect(0, h * 0.2, TW, 14); bg.fillRect(0, h * 0.2 + 14, TW, 5);
    for (var px = 80; px < TW; px += 440) {
      bg.fillStyle = '#0d0b30'; bg.fillRect(px, h * 0.2, 26, h);
      bg.fillStyle = '#17143f'; bg.fillRect(px + 20, h * 0.2, 6, h);
      for (var lx = px + 160; lx < px + 420 && lx < TW; lx += 140) {
        bg.fillStyle = '#0d0b30'; bg.fillRect(lx, h * 0.2 + 19, 2, 26);
        var rg = bg.createRadialGradient(lx, h * 0.2 + 56, 2, lx, h * 0.2 + 56, 70); rg.addColorStop(0, 'rgba(255,214,120,.75)'); rg.addColorStop(1, 'rgba(255,214,120,0)');
        bg.fillStyle = rg; bg.fillRect(lx - 70, h * 0.2 + 0, 140, 140);
        bg.fillStyle = '#ffe9a8'; bg.beginPath(); bg.arc(lx, h * 0.2 + 52, 6, 0, 7); bg.fill();
      }
    }
    L.push({ cv: br, sp: 26 });
    var tr = mk(TW, h), tg = tr.getContext('2d'), cols = ['#e63946', '#2a9d8f', '#f4a261', '#3a86ff', '#8338ec', '#ffb703'], cw = 330, ch = h * 0.17, ty = h * 0.8 - ch, tx = 20, ci = 0;
    while (tx < TW) {
      var col = cols[ci++ % cols.length], wcar = Math.min(cw, TW - tx - 6); if (wcar < 120) break;
      tg.fillStyle = '#0b0a26'; tg.fillRect(tx + 8, ty + ch, wcar - 16, 10);
      tg.fillStyle = col; tg.fillRect(tx, ty, wcar, ch);
      tg.fillStyle = 'rgba(0,0,0,.28)'; tg.fillRect(tx, ty + ch * 0.62, wcar, ch * 0.38);
      tg.fillStyle = 'rgba(255,255,255,.22)'; tg.fillRect(tx, ty, wcar, 5);
      tg.fillStyle = '#12113a';
      for (var wx2 = tx + 18; wx2 < tx + wcar - 50; wx2 += 66) tg.fillRect(wx2, ty + ch * 0.14, 48, ch * 0.34);
      tg.fillStyle = 'rgba(255,255,255,.35)'; for (var wx3 = tx + 18; wx3 < tx + wcar - 50; wx3 += 66) tg.fillRect(wx3, ty + ch * 0.14, 48, 4);
      tg.strokeStyle = 'rgba(255,255,255,.55)'; tg.lineWidth = 4; tg.lineCap = 'round'; tg.beginPath();
      tg.moveTo(tx + 30, ty + ch * 0.8); tg.bezierCurveTo(tx + 80, ty + ch * 0.55, tx + 120, ty + ch * 0.95, tx + 190, ty + ch * 0.72); tg.stroke();
      tg.fillStyle = '#05041a'; tg.beginPath(); tg.arc(tx + 46, ty + ch + 10, 9, 0, 7); tg.arc(tx + wcar - 46, ty + ch + 10, 9, 0, 7); tg.fill();
      tx += wcar + 10;
    }
    L.push({ cv: tr, sp: 58 });
    var rl = mk(TW, h), rg2 = rl.getContext('2d'), gy = h * 0.8 + 16;
    var gg = rg2.createLinearGradient(0, gy, 0, h); gg.addColorStop(0, '#171447'); gg.addColorStop(1, '#05041a'); rg2.fillStyle = gg; rg2.fillRect(0, gy, TW, h - gy);
    rg2.fillStyle = '#3a3680'; for (var sx = 0; sx < TW; sx += 38) rg2.fillRect(sx, gy + (h - gy) * 0.18, 20, (h - gy) * 0.5);
    rg2.fillStyle = '#9aa0d8'; rg2.fillRect(0, gy + (h - gy) * 0.25, TW, 4); rg2.fillRect(0, gy + (h - gy) * 0.55, TW, 4);
    L.push({ cv: rl, sp: 130 });
    return { layers: L, TW: TW, w: w, h: h };
  }
  function panoDraw(ts) {
    if (!panoOn || !panoCv) { panoRaf = 0; return; }
    panoRaf = requestAnimationFrame(panoDraw);
    var dpr = Math.min(1.5, W.devicePixelRatio || 1), w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (panoCv.width !== w || panoCv.height !== h) { panoCv.width = w; panoCv.height = h; panoLayers = null; }
    var g = panoCtx, t = (ts - panoT0) / 1000;
    if (panoImg && panoImg.naturalWidth) {
      var sc = Math.max(h / panoImg.naturalHeight, (w * 1.2) / panoImg.naturalWidth), iw = panoImg.naturalWidth * sc, ih = panoImg.naturalHeight * sc;
      g.drawImage(panoImg, -(Math.sin(t * 0.045) * 0.5 + 0.5) * (iw - w), (h - ih) / 2, iw, ih);
    } else {
      if (!panoLayers || panoLayers.h !== h || panoLayers.w !== w) panoLayers = panoBuild(w, h);
      var sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#0b1240'); sky.addColorStop(0.42, '#3a2a8a'); sky.addColorStop(0.7, '#d9588f'); sky.addColorStop(1, '#ffb15c');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      var sg = g.createRadialGradient(w * 0.72, h * 0.52, 4, w * 0.72, h * 0.52, h * 0.42); sg.addColorStop(0, 'rgba(255,236,170,.95)'); sg.addColorStop(0.18, 'rgba(255,180,100,.55)'); sg.addColorStop(1, 'rgba(255,140,80,0)');
      g.fillStyle = sg; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; for (var i = 0; i < 60; i++) { var sx = (i * 977) % w, sy = (i * 331) % (h * 0.4); g.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(t * 0.8 + i)); g.fillRect(sx, sy, 2, 2); } g.globalAlpha = 1;
      var P = panoLayers, k = dpr;
      P.layers.forEach(function (l) { var off = (t * l.sp * k) % P.TW; g.drawImage(l.cv, -off, 0); g.drawImage(l.cv, P.TW - off, 0); });
    }
    var vg = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(3,6,20,.62)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
  }
  function panoShow(on) {
    if (!panoCv) return;
    on = !!on && !STG.on; if (on === panoOn) return;
    panoOn = on; panoCv.classList.toggle('on', on);
    if (!on) { panoLayers = null; try { panoCv.width = 1; panoCv.height = 1; } catch (e) {} }
    if (on && !panoRaf) { panoT0 = performance.now(); panoRaf = requestAnimationFrame(panoDraw); }
  }

  var P15CSS = `
#mp-ov.sm{padding:0!important;overflow:hidden!important;align-items:stretch;justify-content:stretch}
.p14-home{--s:1;flex:none!important;position:relative;width:calc(100% / var(--s))!important;height:calc(100% / var(--s))!important;margin:0!important;transform:scale(var(--s));transform-origin:0 0;display:flex;flex-direction:column;gap:0;padding:18px 26px 22px;box-sizing:border-box}
.p14-home .p14-nav{flex:0 0 auto;margin-bottom:16px;height:48px}
.p14-home .p14-logo img{height:44px;width:auto;max-height:44px}
.p14-home .p14-navb{padding:10px 18px;font-size:12px}
.p14-home .p14-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(330px,420px) minmax(0,1fr) minmax(310px,380px);gap:22px;align-items:stretch}
.p14-home .p14-col{min-height:0;gap:14px}
.p14-home .p14-l{display:flex;flex-direction:column}
.p14-home .p14-lob{flex:0 1 auto;max-height:42%;display:flex;flex-direction:column;min-height:150px}
.p14-home .p14-lobs{flex:1;min-height:56px;max-height:none}
.p14-home .p14-chat{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.p14-home .p14-r{display:flex;flex-direction:column;overflow:auto;scrollbar-width:none}
.p14-home .p14-r::-webkit-scrollbar{display:none}
.p14-home .p14-r>*{flex:0 0 auto}
.p14-home .p14-center{justify-content:flex-end;align-items:center;min-height:0;padding:0 0 4px;gap:12px}
.p14-home .p14-playwrap{gap:10px;align-items:center}
.p14-home .p14-play{min-width:280px;padding:13px 36px;font-size:30px;border-radius:16px}
.p14-home .p14-namebox input{font-size:16px;padding:11px 16px;width:260px}
.p14-home .p14-playwrap .mq-btn{padding:11px 22px;font-size:12.5px}
.p14-home .p14-err{position:absolute;left:0;right:0;bottom:4px}
#mp-ov.stg .p14-home>.p14-body,#mp-ov.stg .p14-home .p14-center,#mp-ov.stg .p14-home .p14-playwrap{pointer-events:none!important}
#mp-ov.stg .p14-home .p14-col>*,#mp-ov.stg .p14-home .p14-playwrap>*,#mp-ov.stg .p14-home .p14-namebox,#mp-ov.stg .p14-home .p14-nav{pointer-events:auto!important}
.p14-chat{background:linear-gradient(180deg,#2d3a3d,#273336)!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:16px!important;box-shadow:0 16px 38px rgba(0,0,0,.45)!important;position:relative}
.p14-chat .p14-ph{color:#a9bcc0;border-bottom:1px solid rgba(255,255,255,.07)}
.c13box{flex:1;min-height:120px;overflow-y:auto;overflow-x:hidden;padding:6px 18px 12px;display:flex;flex-direction:column;scrollbar-width:none;position:relative}
.c13box::-webkit-scrollbar{display:none}
.c15{position:relative;flex:0 0 auto;display:flex;align-items:flex-end;min-height:112px;padding:14px 40% 10px 0;margin:2px 0}
@keyframes c15in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.c15.mine{padding:14px 0 10px 38%}
.c15-hd{position:absolute;z-index:0;top:-34px;right:-26px;width:190px;height:176px;overflow:hidden;pointer-events:none;
 -webkit-mask-image:linear-gradient(180deg,#000 0%,#000 46%,rgba(0,0,0,.55) 72%,transparent 100%),linear-gradient(270deg,#000 0%,#000 58%,rgba(0,0,0,.35) 84%,transparent 100%);
 -webkit-mask-composite:source-in;mask-image:linear-gradient(180deg,#000 0%,#000 46%,rgba(0,0,0,.55) 72%,transparent 100%),linear-gradient(270deg,#000 0%,#000 58%,rgba(0,0,0,.35) 84%,transparent 100%);mask-composite:intersect;opacity:.92}
.c15-hd img{position:absolute;left:50%;top:-8px;width:338px;height:338px;max-width:none;transform:translateX(-50%);object-fit:contain;filter:saturate(.9) brightness(.93)}
.c15.mine .c15-hd{right:auto;left:-26px;
 -webkit-mask-image:linear-gradient(180deg,#000 0%,#000 46%,rgba(0,0,0,.55) 72%,transparent 100%),linear-gradient(90deg,#000 0%,#000 58%,rgba(0,0,0,.35) 84%,transparent 100%);
 mask-image:linear-gradient(180deg,#000 0%,#000 46%,rgba(0,0,0,.55) 72%,transparent 100%),linear-gradient(90deg,#000 0%,#000 58%,rgba(0,0,0,.35) 84%,transparent 100%)}
.c15-wrap{position:relative;z-index:1;display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.c15-nm{align-self:flex-end;font-family:'proxima',Verdana,sans-serif;font-size:11px;color:#8da0a4;padding:0 6px}
.c15-row{display:flex;align-items:center;gap:10px}
.c15-bd{position:relative;background:rgba(78,92,96,.86);border-radius:20px;padding:11px 46px 22px 16px;color:#f2f6f7;font-family:'proxima',Verdana,sans-serif;font-size:15px;line-height:1.38;word-break:break-word;min-width:92px;box-shadow:0 4px 12px rgba(0,0,0,.22)}
.c15-ts{position:absolute;right:13px;bottom:6px;font-size:10.5px;color:rgba(255,255,255,.52);font-family:'proxima',Verdana,sans-serif}
.c15-go{flex:0 0 auto;background:linear-gradient(180deg,#a4f23c,#82dc1c)!important;border:0!important;border-radius:999px!important;color:#18300a!important;font-family:'proxima',Verdana,sans-serif;font-weight:800;font-size:14px!important;letter-spacing:.6px!important;padding:10px 22px!important;cursor:pointer;box-shadow:0 5px 14px rgba(120,220,30,.28);text-transform:none!important}
.c15-sys{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:9px;margin:10px 0;color:#c4d0d3;font-family:'proxima',Verdana,sans-serif;font-size:13.5px}
.c15-sys.err{color:#ff9ba3}
.c15-sys .sav{width:30px;height:30px;border-radius:50%;background:#1b2528;border:1px solid rgba(255,255,255,.16);object-fit:cover;object-position:top}
.c15.old,.c15-sys.old{opacity:.5}
.c13form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.14)}
.c13form input{flex:1;min-width:0;border:0!important;box-shadow:none!important;background:rgba(0,0,0,.28)!important;border-radius:999px!important;padding:10px 16px!important;color:#eef3f4!important}
.c13form button{flex:0 0 auto;width:40px;height:40px;border-radius:50%!important;background:#8ee02a!important;border:0!important;color:#18300a!important}
#mp-lchat{background:linear-gradient(180deg,#2d3a3d,#273336)!important;border-color:rgba(255,255,255,.08)!important}
#mp-lchat .cbox{padding:6px 16px 10px}
#mp-lchat .c15{min-height:96px}
#mp-lchat .cf input{background:rgba(0,0,0,.28)!important;border-radius:999px!important;border:0!important}
#mp-lchat .cf button{background:#8ee02a!important;color:#18300a!important;border-radius:50%!important;border:0!important;width:38px;height:38px}
.st-tag{gap:1px!important}
.st-tag small{background:none!important;border:0!important;padding:0!important;font-size:11.5px!important;letter-spacing:.5px!important;text-shadow:0 1px 3px rgba(0,0,0,.8);text-transform:none!important}
.st-tag small.ok{color:#59e07b!important}.st-tag small.no{color:#ff6b6b!important}.st-tag small.host{color:#ffd23f!important}.st-tag small.me{color:#7fd6ff!important}
`;

  var P16CSS = `
/* ===== Poki16: nametags (base, plates, effects) ===== */
.mp-lbl{position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;pointer-events:none!important;white-space:nowrap;border:0!important;background:none!important;padding:0!important;font-family:'torus','titan-one','proxima',Verdana,sans-serif;font-size:14px;line-height:1.15;transform-origin:50% 100%;will-change:transform;z-index:1}
.nt{display:inline-flex;align-items:center;gap:4px;color:var(--nc,#fff);font-weight:bold;letter-spacing:.4px;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.6);transform-origin:50% 100%}
.nt .nn{color:inherit;padding:0 1px;display:inline-block}
.nt.np1{background:rgba(8,12,22,.74);border-radius:999px;padding:2px 12px;border:1px solid var(--nc)}
.nt.np2{background:rgba(4,8,16,.7);border-radius:6px;padding:2px 12px;border:1px solid var(--nc);box-shadow:0 0 8px var(--nc),inset 0 0 6px rgba(255,255,255,.08)}
.nt.np3{background:rgba(255,255,255,.14);border-radius:8px;padding:2px 12px;border:1px solid rgba(255,255,255,.32);backdrop-filter:blur(4px)}
.nt.np4{background:rgba(6,10,18,.72);border-left:5px solid var(--nc);border-radius:2px 6px 6px 2px;padding:2px 12px 2px 9px}
.nt.np5{background:linear-gradient(180deg,#ffe27a,#d99b22);border-radius:6px;padding:2px 12px;border:1px solid #fff0b0;color:#2a1c00!important;text-shadow:none}
.nt.nf1 .nn{text-shadow:0 0 6px var(--nc),0 0 14px var(--nc),0 1px 2px rgba(0,0,0,.8)}
.nt.nf2 .nn{text-shadow:2px 2px 0 rgba(0,0,0,.95),3px 3px 5px rgba(0,0,0,.6)}
.nt.nf3 .nn{background-image:linear-gradient(90deg,#ff5252,#ffd740,#69f0ae,#40c4ff,#e040fb,#ff5252)!important;background-size:200% 100%!important;background-repeat:repeat!important;background-position:0 0;-webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-fill-color:transparent;text-shadow:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.85));animation:p16rb 2.4s linear infinite;padding:0 2px 2px!important}
.nt.nf3[style*="--nu"] .nn{text-decoration:underline;text-decoration-color:var(--nu);text-decoration-thickness:3px;text-underline-offset:2px}
@keyframes p16rb{to{background-position:200% 0}}
.nt.nf4{animation:p16pu 1.5s ease-in-out infinite}
@keyframes p16pu{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}
.nt.nf6{animation:mqfl 2.4s steps(2) infinite}

/* ===== Poki16: Fortnite-inspired UI layer (dark, minimal, sharp, subtle motion) ===== */
body{--b0:#060912;--b1:#0a0f1d;--b2:#0e1526;--b3:#131c33;--b4:#070b15;--ln:#1b2644;--ln2:#2a3a60;--tx:#f1f5ff;--sub:#8f9fc4;--dim:#5a6a8f;--acc:#2f7bff;--acc-h:#5a9bff;--gold:#ffd23f;--rad:8px;--rad2:6px}
#mp-ov .mq-panel,#mp-ov .p14-panel,#mp-ov .p14-col>div{border-radius:8px}
.mq-panel{background:linear-gradient(180deg,rgba(14,21,38,.94),rgba(8,12,24,.94))!important;border:1px solid var(--ln)!important;box-shadow:0 18px 40px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04)!important;backdrop-filter:blur(6px)}
.mq-head h2,.m13-h h3,.p14-ph,.fnk-head h2{font-style:italic;letter-spacing:2.2px!important;color:#e8eeff}
.p14-ph{border-bottom:1px solid var(--ln)!important;background:linear-gradient(90deg,rgba(47,123,255,.12),transparent 70%)}
.mq-btn,.p14-navb,.mq-tab,.sp14-mb,.sp14-nb,.sp14-x,.fnk-pick{font-family:'torus','titan-one','proxima',Verdana,sans-serif;text-transform:uppercase;letter-spacing:1.3px;border-radius:5px!important;transition:transform .14s ease,background .14s ease,border-color .14s ease,box-shadow .14s ease,filter .14s ease}
.mq-btn:hover,.p14-navb:hover,.mq-tab:hover,.fnk-pick:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(0,0,0,.4)}
.mq-btn:active,.p14-navb:active,.mq-tab:active,.p14-play:active{transform:translateY(0) scale(.98)}
.mq-btn.pri,.mq-tab.on,.fnk-pick.sel{background:linear-gradient(180deg,#ffe066,#f2b81f)!important;border-color:#ffe98a!important;color:#1d1400!important;box-shadow:0 0 0 1px rgba(255,210,63,.25),0 8px 20px rgba(242,184,31,.25)}
.p14-play{border-radius:6px!important;clip-path:polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%);font-style:italic;letter-spacing:3.5px;transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}
.p14-play:hover{transform:translateY(-2px) scale(1.02)}
.p14-chat,#mp-lchat{background:linear-gradient(180deg,rgba(14,21,38,.95),rgba(8,12,24,.95))!important;border:1px solid var(--ln)!important;border-radius:8px!important}
.p14-chat .p14-ph{color:#8f9fc4}
.c15-bd{background:rgba(30,42,72,.88)!important;border-radius:10px!important;color:#f1f5ff}
.c15-go,.c13form button,#mp-lchat .cf button{background:linear-gradient(180deg,#ffe066,#f2b81f)!important;color:#1d1400!important}
.c13form input,#mp-lchat .cf input{background:rgba(5,9,18,.7)!important;border:1px solid var(--ln)!important}
#mp-board,#mp-posbar,#mp-toast{background:rgba(7,11,22,.8)!important;border:1px solid var(--ln)!important;border-radius:6px!important;backdrop-filter:blur(4px)}
#mp-board,#mp-posbar{border-left:3px solid var(--gold)!important}
#mp-hudopen{border-radius:5px!important;background:rgba(7,11,22,.88)!important}
.sp14{background:linear-gradient(180deg,rgba(14,21,38,.94),rgba(7,11,22,.96))!important;border:1px solid var(--ln)!important;border-bottom:2px solid var(--gold)!important;border-radius:8px!important;animation:p16up .28s ease both}
@keyframes p16up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.sp14-mb,.sp14-nb{background:rgba(26,36,62,.9)!important;border:1px solid var(--ln2)!important}
.sp14-mb.on{background:linear-gradient(180deg,#ffe066,#f2b81f)!important;border-color:#ffe98a!important;color:#1d1400!important}
.sp14-hint{border-radius:4px!important;font-style:italic}
.sp14-t img{border-radius:6px!important}
#mp-spec{flex-wrap:wrap;max-width:98vw}
.sp14{flex-wrap:wrap;justify-content:center;max-width:98vw}
.mq-screen,.p14-home{animation:p16fade .3s ease both}
@keyframes p16fade{from{opacity:0}to{opacity:1}}
`;

  var CSS17 = `
/* ===================== Poki17 design system - Fortnite-inspired, dark, minimal, premium ===================== */
body{--b0:#05070d;--b1:#090d17;--b2:#0d1320;--b3:#121a2b;--b4:#070b13;
--ln:#1d2740;--ln2:#2c3a5c;--tx:#f2f5fc;--sub:#94a0bc;--dim:#5c6880;
--acc:#3d8bff;--acc-h:#6aa5ff;--vio:#b26bff;--ok:#2fd47f;--bad:#ff5d6c;--warn:#ffb14d;--gold:#ffd23f;
--rad:10px;--rad2:8px;--sh:0 18px 44px rgba(0,0,0,.55);
--ovglow:rgba(61,139,255,.12);--accrgb:61,139,255}
#mp-ov{padding:16px}
.mq-panel,.p14-panel,.sm-panel,.mp-card,.mq-lb,.mq-auth,.m13,.fnk-right,.p14-lob,.p14-chat,.p14-side,.f14-season,.f14-mode,.f14-party,.f14-go,.pf14-grid .p14-panel,.p14-acc{
 background:linear-gradient(180deg,rgba(13,19,32,.96),rgba(7,11,19,.97));border:1px solid var(--ln);border-radius:var(--rad);box-shadow:var(--sh),inset 0 1px 0 rgba(255,255,255,.05);color:var(--tx)}
#mp-ov .mq-panel,#mp-ov .p14-panel,#mp-ov .p14-col>div{border-radius:var(--rad)}
.mq-screen>.mq-panel,.mq-screen>.mq-auth,.mq-screen>.mq-lb,.fnk-locker{animation:mq17in .34s cubic-bezier(.2,.85,.25,1) both}
@keyframes mq17in{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.mq-screen>.mq-panel,.mq-screen>.mq-auth,.mq-screen>.mq-lb,.fnk-locker{animation:none}}
.mq-head h2,.m13-h h3,.p14-ph,.fnk-head h2{font-style:italic;color:#e9eeff}
.mq-err{color:#ffb3ba}
.mq-bar{background:#080c15;border-color:var(--ln)}
.mq-bar i,.p14-minibar i,.f14-xp i,.pf14-xpbig .bar i{background:linear-gradient(90deg,var(--acc),var(--acc-h))!important}
/* buttons */
#mp-ov .mq-btn,.m13 button,.bn-go,.c13-go,.sp14 button,.p14-navb,.p14-mini,.f14-navb,.pf14-mini,.p13-mini,.f13-mini{
 border-radius:8px;border:1px solid var(--ln2);background:linear-gradient(180deg,#1a2438,#121a2b);color:#e6ecf8}
#mp-ov .mq-btn:hover,.m13 button:hover,.p14-navb:hover,.p14-mini:hover,.p13-mini:hover,.f13-mini:hover{background:linear-gradient(180deg,#223052,#182238);border-color:#3d4f7a}
#mp-ov .mq-btn.pri,#mp-ov .mq-btn.blue{background:linear-gradient(180deg,#4d95ff,#2b6ce8);border-color:rgba(140,190,255,.6);color:#fff;box-shadow:0 6px 18px rgba(43,108,232,.35),inset 0 1px 0 rgba(255,255,255,.25)}
#mp-ov .mq-btn.pri:hover,#mp-ov .mq-btn.blue:hover{filter:brightness(1.08);box-shadow:0 8px 24px rgba(43,108,232,.45)}
.mq-btn.pri,.mq-tab.on,.fnk-pick.sel{background:linear-gradient(180deg,#4d95ff,#2b6ce8)!important;border-color:rgba(140,190,255,.6)!important;color:#fff!important;box-shadow:0 0 0 1px rgba(90,150,255,.25),0 8px 20px rgba(43,108,232,.3)!important}
.mq-btn.gold,.sp14-mb.on{background:linear-gradient(180deg,#ffd95e,#eda22c)!important;border-color:rgba(255,225,150,.6)!important;color:#3a2708!important}
#mp-ov .mq-btn:focus-visible,#mp-ov button:focus-visible,#mp-ov input:focus-visible,#mp-ov select:focus-visible,#mp-ov a:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
/* inputs + selects (native widgets fixed at source) */
#mp-ov input[type=text],#mp-ov input[type=password],#mp-ov input[type=number],#mp-ov textarea,
.m13 input[type=text],.fr-add input,.p14-share input{
 background:#080c15;border:1px solid var(--ln);border-radius:8px;color:var(--tx);font-size:13px;padding:10px 13px;outline:0;transition:border-color .15s,box-shadow .15s,background .15s}
#mp-ov input:hover,#mp-ov textarea:hover{border-color:var(--ln2)}
#mp-ov input:focus,#mp-ov select:focus,#mp-ov textarea:focus,.m13 input:focus,.fr-add input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--accrgb),.22);background:#0a0f1a}
#mp-ov select,.bo-selw select{
 -webkit-appearance:none;appearance:none;background:#080c15 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2394a0bc' stroke-width='1.8' stroke-linecap='round'/></svg>") no-repeat right 11px center;
 border:1px solid var(--ln);border-radius:8px;color:var(--tx);font-size:13px;padding:10px 30px 10px 13px;cursor:pointer;transition:border-color .15s,box-shadow .15s;outline:0}
#mp-ov select:hover,#mp-ov select:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--accrgb),.18)}
#mp-ov input[type=number]{-moz-appearance:textfield}
/* leaderboard: properly contained */
.mq-lb{padding:16px 18px;height:min(680px,92vh);overflow:hidden}
.mq-lb .hd{padding-bottom:12px}
.mq-lbtabs{margin:12px 0 10px}
.mq-lbscroll{padding-right:4px}
/* auth: split premium layout */
.mq-auth.a17{width:min(860px,100%);height:min(560px,94vh);flex-direction:row;padding:0;overflow:hidden;gap:0}
.mq-auth.a17 .art{flex:0 0 44%;display:flex;flex-direction:column;justify-content:flex-end;border:0;border-right:1px solid var(--ln);border-radius:0;background:radial-gradient(120% 90% at 20% 8%,rgba(var(--accrgb),.30),transparent 55%),linear-gradient(180deg,#101a30,#080c16);padding:22px;margin:0}
.mq-auth.a17 .art img.c{display:block;height:min(190px,28vh);margin:6px auto 0;filter:drop-shadow(0 18px 26px rgba(0,0,0,.6))}
.mq-auth.a17 .art ul{margin:16px 0 0;padding:0;list-style:none;font-size:12.5px;color:#b9c4dc;line-height:2}
.mq-auth.a17 .art ul li:before{content:'\\25B8';color:var(--acc);margin-right:8px;font-size:11px}
.mq-auth.a17 .art ul li b{color:#fff}
.a17-badge{align-self:flex-start;font-size:10px;letter-spacing:3px;color:#cfe0ff;background:rgba(var(--accrgb),.16);border:1px solid rgba(var(--accrgb),.4);border-radius:6px;padding:5px 11px;text-transform:uppercase}
.a17-note{margin-top:14px;color:var(--dim);font-size:10.5px;letter-spacing:.4px}
.mq-auth.a17 form{flex:1;display:flex;flex-direction:column;justify-content:center;padding:26px 32px;min-width:0}
.a17-head h2{margin:0;font-family:'torus','titan-one',Verdana,sans-serif;font-weight:normal;font-size:24px;letter-spacing:1.5px;text-transform:uppercase;color:var(--tx)}
.a17-head p{margin:5px 0 14px;color:var(--sub);font-size:12.5px}
.mq-auth.a17 .mq-seg{margin-bottom:2px}
.a17-cta{height:44px;font-size:14px;letter-spacing:2px;margin-top:16px}
.a17-back{margin-top:10px;align-self:center;background:none;border:0;color:var(--sub);cursor:pointer;font-size:12px;padding:6px 10px;font-family:'proxima',Verdana,sans-serif}
.a17-back:hover{color:#fff}
@media(max-width:760px){
 .mq-auth.a17{flex-direction:column;height:auto;max-height:100%;overflow:auto}
 .mq-auth.a17 .art{flex:0 0 auto;border-right:0;border-bottom:1px solid var(--ln);padding:16px}
 .mq-auth.a17 .art img.c{height:110px}.mq-auth.a17 .art ul{display:none}
 .mq-auth.a17 form{padding:18px 20px}}
/* host options: bento box + search */
.bo-search{display:flex;align-items:center;gap:9px;background:#080c15;border:1px solid var(--ln);border-radius:9px;padding:0 12px;margin-bottom:12px;transition:border-color .15s,box-shadow .15s}
.bo-search:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--accrgb),.2)}
.bo-search svg{width:15px;height:15px;color:var(--dim);flex:none}
.bo-search input{flex:1;border:0!important;background:transparent!important;box-shadow:none!important;padding:10px 0;font-size:13px}
.bo-wrap{display:flex;flex-direction:column;gap:14px}
.bo-gh{font-family:'torus','titan-one',Verdana,sans-serif;font-size:10.5px;letter-spacing:2.4px;text-transform:uppercase;color:#8fa2cf;margin:2px 2px 8px;display:flex;align-items:center;gap:10px}
.bo-gh:after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--ln),transparent)}
.bo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.bo-tile{position:relative;display:flex;align-items:center;gap:10px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid rgba(120,150,220,.14);border-radius:10px;padding:11px 13px;min-height:62px;transition:border-color .15s,background .15s,transform .15s;animation:mq17tile .25s ease both}
@keyframes mq17tile{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.bo-tile:hover{border-color:rgba(var(--accrgb),.55);transform:translateY(-1px)}
.bo-tile.on{border-color:rgba(var(--accrgb),.6);background:linear-gradient(180deg,rgba(var(--accrgb),.12),rgba(var(--accrgb),.04))}
.bo-ic{flex:0 0 34px;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:rgba(var(--accrgb),.1);border:1px solid rgba(var(--accrgb),.25);font-size:15px;overflow:hidden}
.bo-tile.tog .bo-ic{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1)}
.bo-tx{flex:1;min-width:0}
.bo-tx b{display:block;font-size:12.5px;letter-spacing:.3px}
.bo-tx small{display:block;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:var(--dim);margin-top:2px;line-height:1.45}
.bo-ctl{flex:0 0 auto}
.bo-val{flex:0 0 auto;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:11px;color:var(--sub);letter-spacing:1px}
.bo-tile.on .bo-val{color:var(--ok)}
.bo-sw{position:relative;display:inline-block;width:44px;height:24px;flex:0 0 auto;cursor:pointer}
.bo-sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.bo-sw .knob{position:absolute;inset:0;border-radius:14px;background:#1d2740;border:1px solid var(--ln2);transition:background .18s,border-color .18s;pointer-events:none}
.bo-sw .knob:after{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#94a0bc;transition:left .18s,background .18s}
.bo-sw.on .knob{background:linear-gradient(180deg,#33c47e,#22a565);border-color:rgba(120,230,170,.6)}
.bo-sw.on .knob:after{left:23px;background:#fff}
.bo-selw{position:relative;display:inline-flex;max-width:200px}
.bo-selw select{max-width:200px;padding-right:28px}
.bo-num,.bo-txt{max-width:150px}
.bo-none{border:1px dashed var(--ln2);border-radius:10px;color:var(--sub);text-align:center;padding:16px;font-size:12px}
@media(max-width:640px){.bo-grid{grid-template-columns:1fr 1fr}}
@media(max-width:480px){.bo-grid{grid-template-columns:1fr}}
/* client settings */
.set17{width:min(680px,100%);padding:18px 20px;height:min(660px,94vh);display:flex;flex-direction:column;overflow:hidden}
.set17 .mq-scroll{overflow:auto;flex:1;min-height:0;padding-right:4px}
.set17-themes{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:10px}
.set17-th{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:8px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid rgba(120,150,220,.16);border-radius:10px;padding:12px;cursor:pointer;text-align:left;transition:border-color .15s,transform .15s,box-shadow .15s;font-family:'proxima',Verdana,sans-serif}
.set17-th:hover{transform:translateY(-2px);border-color:rgba(var(--accrgb),.5)}
.set17-th .sw{width:100%;height:44px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 4px 10px rgba(0,0,0,.35)}
.set17-th b{font-size:12.5px;color:var(--tx);letter-spacing:.4px}
.set17-th small{font-size:10px;color:var(--dim);letter-spacing:.3px}
.set17-th .tick{position:absolute;right:9px;top:9px;width:20px;height:20px;border-radius:50%;background:var(--acc);color:#fff;font-size:11px;line-height:20px;text-align:center;display:none}
.set17-th.sel{border-color:var(--acc);box-shadow:0 0 0 2px rgba(var(--accrgb),.3)}
.set17-th.sel .tick{display:block}
.set17-row{display:flex;align-items:center;gap:12px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid rgba(120,150,220,.14);border-radius:10px;padding:12px 14px;margin-bottom:9px}
.set17-row .tx{flex:1;min-width:0}
.set17-row .tx b{display:block;font-size:12.5px}
.set17-row .tx small{display:block;color:var(--dim);font-size:10.5px;margin-top:2px;line-height:1.5}
/* FPS counter (draggable) */
#mp-fps{position:fixed;right:14px;top:58px;z-index:99999;display:none;background:rgba(6,10,18,.82);border:1px solid var(--ln2);border-left:3px solid var(--acc);border-radius:8px;color:#cfe0ff;font-family:Verdana,sans-serif;font-size:11px;font-weight:bold;letter-spacing:1px;padding:6px 11px;cursor:grab;user-select:none;touch-action:none;backdrop-filter:blur(4px)}
#mp-fps:active{cursor:grabbing}
#mp-fps.low{border-left-color:var(--bad);color:#ffb3ba}
/* settings gear in nav */
.p14-set{padding:8px 10px!important;display:inline-flex;align-items:center}
.p14-set svg{width:15px;height:15px;display:block}
/* profile: 3D viewer anchored top-left, more presence */
.pf14-head{gap:14px}
.pf14-viewer{flex:0 0 262px;min-height:232px;border:1px solid rgba(var(--accrgb),.4);border-radius:12px;background:radial-gradient(120% 100% at 50% 0%,rgba(var(--accrgb),.22),rgba(7,11,19,.4) 62%),linear-gradient(180deg,rgba(13,19,32,.5),rgba(7,11,19,.2));box-shadow:0 0 34px rgba(var(--accrgb),.14),inset 0 0 40px rgba(10,20,50,.3)}
.pf14-viewer:before{content:'3D PREVIEW';position:absolute;left:11px;top:9px;font-family:'proxima',Verdana,sans-serif;font-size:8.5px;letter-spacing:2.6px;color:rgba(180,205,255,.65);z-index:1}
.pf14-liftchip{bottom:10px}
.pf14-name{font-style:italic}
/* responsive polish */
@media(max-width:900px){
 .set17-themes{grid-template-columns:1fr 1fr}
 .pf14-head{flex-wrap:wrap}
 .pf14-viewer{flex:0 0 46%;min-width:170px}}
@media(max-width:640px){
 .set17-themes{grid-template-columns:1fr 1fr}
 .mq-lb{height:min(560px,94vh)}
 .p14-navr .p14-pill{display:none}}
`;

  // ================================= POKI18 design layer (themes + new UI) ====
  var CSS18 = `
/* ---------- POKI18: full theme system ---------- */
/* Midnight stays the baseline (CSS17 vars). Each other theme overrides the
   hardcoded dark surfaces at the component level so the whole UI changes. */
body[data-theme="glass"] #mp-ov .mq-panel,body[data-theme="glass"] .p14-panel,body[data-theme="glass"] .sm-panel,body[data-theme="glass"] .mp-card,body[data-theme="glass"] .mq-lb,body[data-theme="glass"] .mq-auth,body[data-theme="glass"] .m13,body[data-theme="glass"] .p14-lob,body[data-theme="glass"] .p14-chat,body[data-theme="glass"] .p14-side,body[data-theme="glass"] .f14-season,body[data-theme="glass"] .f14-mode,body[data-theme="glass"] .f14-party,body[data-theme="glass"] .f14-go,body[data-theme="glass"] .p14-acc{
 background:rgba(18,36,54,.55)!important;border:1px solid rgba(140,200,255,.28)!important;backdrop-filter:blur(14px) saturate(1.25);-webkit-backdrop-filter:blur(14px) saturate(1.25);box-shadow:0 18px 44px rgba(0,0,0,.4),inset 0 1px 0 rgba(220,240,255,.16)}
body[data-theme="glass"] #mp-lchat{background:rgba(16,32,50,.62)!important;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-color:rgba(140,200,255,.28)!important}
body[data-theme="glass"] #mp-board,body[data-theme="glass"] #mp-posbar,body[data-theme="glass"] #mp-specboard,body[data-theme="glass"] #mp-toast{background:rgba(14,28,44,.6)!important;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-color:rgba(140,200,255,.3)!important}
body[data-theme="glass"] #mp-ov input[type=text],body[data-theme="glass"] #mp-ov input[type=password],body[data-theme="glass"] #mp-ov input[type=number],body[data-theme="glass"] #mp-ov select,body[data-theme="glass"] #mp-ov textarea{background:rgba(8,18,30,.5)!important;border-color:rgba(140,200,255,.26)!important}
body[data-theme="glass"] #mp-ov .mq-btn,body[data-theme="glass"] .p14-navb{background:rgba(30,52,74,.6)!important;border-color:rgba(140,200,255,.3)!important;backdrop-filter:blur(8px)}
body[data-theme="glass"] .p14-pill,body[data-theme="glass"] .p14-accchip{background:rgba(14,30,46,.6)!important;backdrop-filter:blur(8px)}
body[data-theme="glass"] #mp-ov{background:radial-gradient(1200px 700px at 50% -20%,rgba(95,192,255,.10) 0%,transparent 60%),linear-gradient(180deg,rgba(10,22,36,.30),rgba(10,22,36,.10) 30%,rgba(10,22,36,.10) 70%,rgba(10,22,36,.35))}
body[data-theme="glass"] .set17-row,body[data-theme="glass"] .bo-tile{background:rgba(120,190,255,.07)!important;border-color:rgba(140,200,255,.25)!important}

/* Light Mode: real light surfaces everywhere */
body[data-theme="light"] #mp-ov{color:#1a2434;background:radial-gradient(1200px 700px at 50% -20%,rgba(47,111,216,.10) 0%,transparent 60%),linear-gradient(180deg,rgba(226,236,246,.72),rgba(226,236,246,.55))}
body[data-theme="light"] #mp-ov .mq-panel,body[data-theme="light"] .p14-panel,body[data-theme="light"] .sm-panel,body[data-theme="light"] .mp-card,body[data-theme="light"] .mq-lb,body[data-theme="light"] .mq-auth,body[data-theme="light"] .m13,body[data-theme="light"] .p14-lob,body[data-theme="light"] .p14-chat,body[data-theme="light"] .p14-side,body[data-theme="light"] .f14-season,body[data-theme="light"] .f14-mode,body[data-theme="light"] .f14-party,body[data-theme="light"] .f14-go,body[data-theme="light"] .p14-acc{
 background:rgba(255,255,255,.92)!important;border:1px solid #c2d2e2!important;box-shadow:0 14px 34px rgba(30,50,80,.14)!important;color:#1a2434}
body[data-theme="light"] #mp-ov .mq-head h2,body[data-theme="light"] .m13-h h3,body[data-theme="light"] .p14-ph,body[data-theme="light"] .fnk-head h2,body[data-theme="light"] .mq-sec,body[data-theme="light"] .mq-lab{color:#3c4f68!important}
body[data-theme="light"] .mq-head,body[data-theme="light"] .p14-ph,body[data-theme="light"] .fnk-tabs{border-color:#d3e0ec!important}
body[data-theme="light"] #mp-ov .mq-btn,body[data-theme="light"] .m13 button,body[data-theme="light"] .p14-navb,body[data-theme="light"] .p14-mini,body[data-theme="light"] .mq-tab,body[data-theme="light"] .mq-pill,body[data-theme="light"] .fnk-pick{background:#eef4fa;border-color:#c2d2e2;color:#2c3d55}
body[data-theme="light"] #mp-ov .mq-btn:hover,body[data-theme="light"] .p14-navb:hover,body[data-theme="light"] .mq-tab:hover,body[data-theme="light"] .mq-pill:hover,body[data-theme="light"] .fnk-pick:hover{background:#e2ecf6;border-color:#9fb6cf}
body[data-theme="light"] #mp-ov .mq-btn.pri,body[data-theme="light"] .mq-btn.pri,body[data-theme="light"] .mq-tab.on,body[data-theme="light"] .fnk-pick.sel,body[data-theme="light"] .mq-pill.on{background:linear-gradient(180deg,#4f8cf0,#2f6fd8)!important;border-color:#7aa9f2!important;color:#fff!important}
body[data-theme="light"] #mp-ov .mq-btn.gold,body[data-theme="light"] .mq-btn.gold{background:linear-gradient(180deg,#ffd95e,#eda22c)!important;border-color:#e8c76a!important;color:#3a2708!important}
body[data-theme="light"] #mp-ov input[type=text],body[data-theme="light"] #mp-ov input[type=password],body[data-theme="light"] #mp-ov input[type=number],body[data-theme="light"] #mp-ov select,body[data-theme="light"] #mp-ov textarea,body[data-theme="light"] .m13 input[type=text],body[data-theme="light"] .fnk-tools input{background:#fff;border-color:#c2d2e2;color:#1a2434}
body[data-theme="light"] #mp-ov select,body[data-theme="light"] .bo-selw select{background-color:#fff;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2351678a' stroke-width='1.8' stroke-linecap='round'/></svg>")}
body[data-theme="light"] .mq-chip{background:#eef4fa;border-color:#c2d2e2;color:#3c4f68}
body[data-theme="light"] .p14-pill,body[data-theme="light"] .p14-accchip{background:#fff!important;border-color:#c2d2e2!important;color:#1a2434}
body[data-theme="light"] .p14-accchip .i small{color:#51617a}
body[data-theme="light"] .mq-bar,body[data-theme="light"] .p14-minibar,body[data-theme="light"] .f14-xp,body[data-theme="light"] .pf14-xpbig .bar{background:#e4edf5;border-color:#c2d2e2}
body[data-theme="light"] .mq-empty{border-color:#b8c9da;color:#51617a}
body[data-theme="light"] .mq-note,body[data-theme="light"] .bo-tx small,body[data-theme="light"] .set17-row .tx small{color:#76879e!important}
body[data-theme="light"] .fnk-tile{border-color:#ccd9e6;background:#f4f8fc}
body[data-theme="light"] .fnk-tile.ch{background:#e7f0fa}
body[data-theme="light"] .fnk-tile.bd{background:#f3eede}
body[data-theme="light"] .fnk-imgw{background:#e6eef6}
body[data-theme="light"] .fnk-badge,body[data-theme="light"] .fnk-swatch{background:#eef4fa;border-color:#c2d2e2}
body[data-theme="light"] .mq-sw i,body[data-theme="light"] .mq-sw .i18{background:#eef4fa;border-color:#c2d2e2;color:#2c3d55}
body[data-theme="light"] .bo-tile,body[data-theme="light"] .set17-row,body[data-theme="light"] .set17-th{background:#f4f8fc!important;border-color:#c9d8e6!important;color:#1a2434}
body[data-theme="light"] .bo-tile.on{background:#e9f2fd!important;border-color:#7aa9f2!important}
body[data-theme="light"] .lrw,body[data-theme="light"] .p14-lobrow,body[data-theme="light"] .mq-lob,body[data-theme="light"] .pf14-frrow,body[data-theme="light"] .pf14-hrow,body[data-theme="light"] .pf14-achrow,body[data-theme="light"] .pf14-tile,body[data-theme="light"] .m13-row{background:#f2f7fb!important;border-color:#d3e0ec!important;color:#1a2434}
body[data-theme="light"] .lrw .v,body[data-theme="light"] .pod .pc .ps{color:#1e9e5a!important}
body[data-theme="light"] .lrw .no,body[data-theme="light"] .p14-lbr>span{color:#76879e}
body[data-theme="light"] .pod .pc{background:#f2f7fb!important;border-color:#d3e0ec!important}
body[data-theme="light"] .mq-win{background:#fdf6e4!important;border-color:#e2c56a!important}
body[data-theme="light"] .mq-win h3{color:#a06b00}
body[data-theme="light"] .c15-bd{background:#e6eef6!important;color:#1a2434!important}
body[data-theme="light"] .c15-nm,body[data-theme="light"] .c13-nm{color:#76879e!important}
body[data-theme="light"] .c15.mine .c15-bd{background:#dbe9fb!important}
body[data-theme="light"] .c13form input,body[data-theme="light"] #mp-lchat .cf input{background:#fff!important;border-color:#c2d2e2!important;color:#1a2434!important}
body[data-theme="light"] #mp-lchat{background:#f6f9fc!important;border-color:#c2d2e2!important;color:#1a2434}
body[data-theme="light"] #mp-board,body[data-theme="light"] #mp-posbar,body[data-theme="light"] #mp-specboard,body[data-theme="light"] #mp-toast,body[data-theme="light"] #mp-hudopen,body[data-theme="light"] .mp-ntf,body[data-theme="light"] #mp-fps{background:rgba(255,255,255,.94)!important;border-color:#c2d2e2!important;color:#1a2434!important}
body[data-theme="light"] #mp-board div,body[data-theme="light"] .spbr-row b,body[data-theme="light"] #mp-fps{color:#1a2434}
body[data-theme="light"] .sp14{background:rgba(255,255,255,.95)!important;border-color:#c2d2e2!important;color:#1a2434}
body[data-theme="light"] .sp14-mb,.sp14-nb{background:#eef4fa!important;border-color:#c2d2e2!important;color:#2c3d55}
body[data-theme="light"] .mp-lbl .nt,body[data-theme="light"] .st-tag .nt{text-shadow:none}
body[data-theme="light"] .nt.np3{background:rgba(30,50,80,.14)}
body[data-theme="light"] .st-tag small{background:rgba(255,255,255,.9);border-color:#c2d2e2;color:#3c4f68}
body[data-theme="light"] .mq-auth.a17 .art{background:radial-gradient(120% 90% at 20% 8%,rgba(47,111,216,.14),transparent 55%),linear-gradient(180deg,#eef4fa,#e2ecf6)!important;border-color:#c2d2e2!important}
body[data-theme="light"] .mq-auth.a17 .art ul{color:#51617a}
body[data-theme="light"] .mq-auth.a17 .art ul li b{color:#1a2434}
body[data-theme="light"] .mq-auth.a17 form{background:rgba(255,255,255,.94)}
body[data-theme="light"] .a17-head h2{color:#1a2434}
body[data-theme="light"] .a17-head p,body[data-theme="light"] .a17-note{color:#76879e}
body[data-theme="light"] .mp-logo-img{filter:drop-shadow(0 6px 14px rgba(30,50,80,.25))}
body[data-theme="light"] .mq-lb .hd h2,body[data-theme="light"] .mq-lb .hd .ring{color:#1a2434}
body[data-theme="light"] #mp-modal{background:rgba(120,140,170,.45)}
body[data-theme="light"] .bn-in{background:#fff!important;border-color:#e2c56a!important}
body[data-theme="light"] .bn-in .tx{color:#1a2434}
body[data-theme="light"] .bn-in .tx small{color:#76879e}
body[data-theme="light"] .mp-cd-p span,body[data-theme="light"] .mp-cd-t,body[data-theme="light"] .mp-cd-h{color:#1a2434;text-shadow:none}
body[data-theme="light"] .bo-gh{color:#51617a}
body[data-theme="light"] .fnk-hint{background:rgba(255,255,255,.85);border-color:#c2d2e2;color:#3c4f68}
body[data-theme="light"] .p14-namebox{background:#fff!important;border-color:#c2d2e2!important}
body[data-theme="light"] .p14-err,body[data-theme="light"] .mq-err{color:#b3202e}
body[data-theme="light"] .c15-sys,body[data-theme="light"] .c15-sys .sav{color:#76879e}
body[data-theme="light"] .p14-xpmini .lab{color:#76879e}
body[data-theme="light"] .set17-th b,body[data-theme="light"] .bo-tx b,body[data-theme="light"] .set17-row .tx b{color:#1a2434}
body[data-theme="light"] #mp-ov.stg:not(.dim){background:linear-gradient(180deg,rgba(230,240,250,.42),rgba(230,240,250,0) 24%,rgba(230,240,250,0) 66%,rgba(230,240,250,.6))!important}

/* Neon / Ember: accent glow lift */
body[data-theme="neon"] .mq-btn.pri,body[data-theme="neon"] .mq-tab.on{box-shadow:0 0 18px rgba(178,107,255,.45)!important}
body[data-theme="neon"] .p14-play{box-shadow:0 8px 30px rgba(178,107,255,.4)}
body[data-theme="neon"] .mq-live i{background:#c05cff;box-shadow:0 0 8px #c05cff}
body[data-theme="ember"] .mq-live i{background:#ff9d4d;box-shadow:0 0 8px #ff9d4d}
body[data-theme="ember"] .p14-play{box-shadow:0 8px 30px rgba(255,120,50,.4)}
body[data-theme="glass"] .mq-live i{background:#5fc0ff;box-shadow:0 0 8px #5fc0ff}
body[data-theme="light"] .mq-live i{background:#2f6fd8;box-shadow:none}

/* ---------- bento tooltips (description on hover) ---------- */
.bo-tile[data-tip]{position:relative}
.bo-tile[data-tip] .bo-tx small{display:none}
.bo-tile[data-tip]:hover::after{content:attr(data-tip);position:absolute;left:0;bottom:calc(100% + 7px);z-index:30;max-width:280px;width:max-content;background:rgba(6,10,18,.96);border:1px solid rgba(var(--accrgb),.45);border-radius:9px;color:#dbe6fa;font-family:'proxima',Verdana,sans-serif;font-size:11px;line-height:1.5;padding:8px 11px;box-shadow:0 10px 26px rgba(0,0,0,.5);pointer-events:none;animation:tipin .16s ease both}
body[data-theme="light"] .bo-tile[data-tip]:hover::after{background:rgba(255,255,255,.98);color:#2c3d55;border-color:#a4b8cc}
@keyframes tipin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.bo-tile{min-height:56px}

/* ---------- spectator live leaderboard (draggable) ---------- */
#mp-specboard{position:fixed;right:16px;top:70px;z-index:99989;display:none;flex-direction:column;width:250px;max-width:88vw;max-height:min(430px,62vh);background:rgba(7,11,22,.92);border:1px solid var(--ln2);border-left:3px solid var(--gold);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.5);overflow:hidden;backdrop-filter:blur(6px)}
#mp-specboard .sb-hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--ln);cursor:grab;touch-action:none;user-select:none}
#mp-specboard .sb-hd:active{cursor:grabbing}
#mp-specboard .sb-hd b{font-family:'torus','titan-one',Verdana,sans-serif;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:#ffdf8a}
#mp-specboard .sb-hd .sb-live{margin-left:auto}
#mp-specboard .sb-hd button{background:#1a2231;border:1px solid var(--ln2);border-radius:6px;color:#c3d0ea;width:22px;height:20px;cursor:pointer;font-size:10px;line-height:1;padding:0}
#mp-specboard .sb-hd button:hover{color:#fff;border-color:#3d4f7a}
#mp-specboard .sb-rows{overflow:auto;display:flex;flex-direction:column;padding:6px}
.spbr-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:7px;font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#dbe3f2}
.spbr-row.me{background:rgba(var(--accrgb),.14);border:1px solid rgba(var(--accrgb),.4)}
.spbr-row .no{width:20px;text-align:center;font-family:'torus','titan-one',sans-serif;color:#9aa5bd;font-size:12px}
.spbr-row img{width:24px;height:24px;border-radius:6px;background:#0a0d14;border:2px solid;object-fit:cover;object-position:top}
.spbr-row b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.spbr-row .v{font-weight:bold;color:#7ce0ac;font-size:12px}
.spbr-row .t{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#ffdf8a}
.spbr-row.out{opacity:.45;filter:grayscale(.7)}
@media(max-width:640px){#mp-specboard{width:200px;right:10px;top:60px}}

/* ---------- lobby chat collapsed to icon ---------- */
#mp-lchat.gone{display:none!important}
#mp-lchaticon{position:fixed;left:14px;bottom:14px;z-index:99994;display:none;width:48px;height:48px;border-radius:50%;background:rgba(13,19,32,.94);border:1px solid var(--ln2);color:#8ecaff;cursor:pointer;align-items:center;justify-content:center;box-shadow:0 10px 26px rgba(0,0,0,.45);transition:transform .15s,border-color .15s}
#mp-lchaticon:hover{transform:scale(1.08);border-color:var(--acc)}
#mp-lchaticon svg{width:21px;height:21px}
#mp-lchaticon .ub{position:absolute;right:-4px;top:-4px;min-width:18px;height:18px;border-radius:10px;background:var(--bad);color:#fff;font-family:'proxima',Verdana,sans-serif;font-size:10px;font-weight:bold;line-height:18px;text-align:center;padding:0 4px;display:none}
#mp-lchaticon .ub.on{display:block}

/* ---------- ranked matchmaking ---------- */
.rk18{width:min(1150px,100%);height:min(700px,94vh);display:flex;flex-direction:column;padding:18px 20px;position:relative;overflow:hidden}
.rk18-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(240px,320px) 1fr minmax(240px,320px);gap:16px;align-items:stretch}
.rk18 .rk-card{background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;min-height:0}
.rk18 .rk-card img{width:64px;height:64px;border-radius:14px;background:#0a0d14;border:2px solid var(--ln2);object-fit:cover;object-position:top}
.rk18 .rk-card .rk-nm{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:15px}
.rk18 .rk-card small{color:var(--dim);font-size:11px}
.rk18 .rk-vs{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;position:relative}
.rk18 .vs-ring{width:132px;height:132px;border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative;background:radial-gradient(circle,rgba(var(--accrgb),.16),transparent 70%)}
.rk18 .vs-ring:before{content:'';position:absolute;inset:0;border-radius:50%;border:2px dashed rgba(var(--accrgb),.55);animation:rkspin 7s linear infinite}
.rk18 .vs-ring:after{content:'';position:absolute;inset:12px;border-radius:50%;border:2px solid rgba(var(--accrgb),.25);animation:rkspin 4.5s linear infinite reverse}
@keyframes rkspin{to{transform:rotate(360deg)}}
.rk18 .vs-word{font-family:'torus','titan-one',Verdana,sans-serif;font-size:clamp(40px,6vw,64px);font-style:italic;letter-spacing:6px;color:linear-gradient(180deg,#fff,var(--acc));background:linear-gradient(180deg,#fff,var(--acc));-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 6px 22px rgba(var(--accrgb),.4);animation:vspulse 1.6s ease-in-out infinite}
@keyframes vspulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
.rk18 .vs-status{font-family:'proxima',Verdana,sans-serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#c3d0ea;display:flex;align-items:center;gap:10px}
.rk18 .vs-dots i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--acc);margin:0 3px;animation:vsdot 1.2s infinite}
.rk18 .vs-dots i:nth-child(2){animation-delay:.2s}
.rk18 .vs-dots i:nth-child(3){animation-delay:.4s}
@keyframes vsdot{0%,80%,100%{opacity:.25}40%{opacity:1}}
.rk18 .vs-sub{font-size:11px;color:var(--dim);letter-spacing:1.4px;text-transform:uppercase}
.rk18 .rk-modes{display:flex;gap:8px;justify-content:center;margin:12px 0 0}
.rk18 .rk-searching .rk-card{opacity:.85}
.rk18 .opp-in{animation:oppin .4s cubic-bezier(.2,.85,.25,1) both}
@keyframes oppin{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
.rk18 .rk-elo{display:flex;gap:10px;margin-top:4px}
.rk18 .rk-elo div{background:rgba(255,255,255,.04);border:1px solid rgba(120,150,220,.16);border-radius:9px;padding:7px 13px;min-width:74px}
.rk18 .rk-elo b{display:block;font-size:15px;color:#8ecaff}
.rk18 .rk-elo small{font-size:9px;letter-spacing:1.6px;color:var(--dim);text-transform:uppercase}
.rk18 .rk-wait{font-size:11px;color:var(--dim);text-align:center;line-height:1.6}
.rk18 .radar{width:110px;height:110px;position:relative;margin:6px auto}
.rk18 .radar:before{content:'';position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(var(--accrgb),.22) 0%,transparent 62%)}
.rk18 .radar i{position:absolute;inset:10%;border-radius:50%;border:1px solid rgba(var(--accrgb),.3)}
.rk18 .radar i:nth-child(2){inset:26%}
.rk18 .radar i:nth-child(3){inset:42%}
.rk18 .radar b{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(var(--accrgb),.55),transparent 28%);animation:rkspin 1.7s linear infinite}
@media(max-width:860px){.rk18-grid{grid-template-columns:1fr 1fr}.rk18 .rk-vs{order:-1;grid-column:1/-1;min-height:190px}.rk18{height:auto;max-height:100%}}

/* ---------- animated connecting overlay ---------- */
.mp-connect{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;animation:mq17in .3s ease both}
.mp-connect .mp-logo-img{max-height:110px}
.mp-connect .cn-ring{width:64px;height:64px;border-radius:50%;border:4px solid rgba(var(--accrgb),.18);border-top-color:var(--acc);animation:rkspin .9s linear infinite}
.mp-connect .cn-t{font-family:'torus','titan-one',Verdana,sans-serif;font-size:19px;letter-spacing:3px;text-transform:uppercase;color:#e9eeff}
.mp-connect .cn-d{font-size:12px;color:var(--sub);letter-spacing:1px}
.mp-connect .cn-steps{display:flex;gap:8px;margin-top:4px}
.mp-connect .cn-steps i{width:34px;height:5px;border-radius:4px;background:rgba(var(--accrgb),.2);animation:cnstep 1.5s infinite}
.mp-connect .cn-steps i:nth-child(2){animation-delay:.2s}
.mp-connect .cn-steps i:nth-child(3){animation-delay:.4s}
@keyframes cnstep{0%,100%{background:rgba(var(--accrgb),.2)}50%{background:var(--acc)}}

/* ---------- leaderboard v2: categories ---------- */
.lb18-cats{display:flex;gap:8px;margin-bottom:10px}
.lb18-cat{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.16);border-radius:11px;padding:11px 8px;cursor:pointer;font-family:'proxima',Verdana,sans-serif;transition:border-color .15s,background .15s,transform .15s;text-transform:uppercase}
.lb18-cat b{font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:14px;letter-spacing:1.6px;color:#cdd8ee}
.lb18-cat small{font-size:9px;letter-spacing:1.6px;color:var(--dim)}
.lb18-cat:hover{transform:translateY(-2px);border-color:#3d4f7a}
.lb18-cat.on{border-color:var(--acc);background:rgba(var(--accrgb),.12)}
.lb18-cat.on b{color:#fff}
.lb18-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;margin:0 0 10px}
.lb18-stat{background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.14);border-radius:10px;padding:9px 12px}
.lb18-stat small{display:block;font-size:8.5px;letter-spacing:1.8px;color:var(--dim);text-transform:uppercase;margin-bottom:3px}
.lb18-stat b{font-size:16px;font-family:'proxima',Verdana,sans-serif;color:#e8edf6}
.lb18-body{animation:lb18in .28s ease both}
@keyframes lb18in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.lb18-modes{display:flex;gap:6px;margin-bottom:10px}

/* ---------- account badges ---------- */
.abchip{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.05);border:1px solid rgba(120,150,220,.22);border-radius:20px;padding:3px 10px 3px 6px;font-family:'proxima',Verdana,sans-serif}
.abchip b{font-size:10px;letter-spacing:.8px;text-transform:uppercase}
.abchip .ab-ic{width:15px;height:15px}
.abshelf{display:flex;flex-wrap:wrap;gap:7px}
.abshelf .abchip{padding:6px 13px 6px 8px}
.abshelf .abchip b{font-size:11px}
.abshelf .abchip .ab-ic{width:18px;height:18px}
.ab-owner{border-color:rgba(255,210,63,.6)!important;background:rgba(255,210,63,.1)!important;box-shadow:0 0 14px rgba(255,210,63,.25)}
.nt .nab{display:inline-flex;align-items:center;margin-right:2px}
.nt .nab .ab-ic{width:1.2em;height:1.2em;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}

/* ---------- admin console ---------- */
.m13.tabs .atabs{display:flex;gap:6px;margin-bottom:8px}
.m13 .atab{flex:1;background:#1a2231;border:1px solid var(--ln2);border-radius:8px;color:#c3d0ea;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;padding:8px;cursor:pointer}
.m13 .atab.on{background:var(--acc);border-color:var(--acc);color:#fff}
.apick{display:flex;flex-wrap:wrap;gap:5px}
.apick i{font-style:normal;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;font-weight:bold;letter-spacing:.6px;background:#1a2231;border:1px solid var(--ln2);color:#c3d0ea;border-radius:7px;padding:5px 11px;cursor:pointer;text-transform:uppercase}
.apick i.sel{border-color:var(--acc);background:rgba(var(--accrgb),.16);color:#fff}
.permrow{display:flex;align-items:center;gap:9px;padding:7px 4px;border-bottom:1px solid rgba(35,43,58,.5);font-size:12px}
.permrow:last-child{border-bottom:0}
.permrow b{flex:1}
.permrow small{color:var(--dim);font-size:10px}

/* ---------- stopwatch ---------- */
.hdr-sw{color:#ffdf8a;border-color:rgba(246,196,83,.4)!important}
.sw-time{font-family:'proxima',Verdana,sans-serif;font-weight:bold;color:#ffdf8a}
.sb-firstcoin{font-size:9px;color:#ffdf8a;letter-spacing:.4px}

/* ---------- auth: forgot password + signup extra ---------- */
.a17-forgot{align-self:flex-end;background:none;border:0;color:#8ecaff;font-size:11.5px;cursor:pointer;font-family:'proxima',Verdana,sans-serif;padding:4px 2px;margin-top:-6px}
.a17-forgot:hover{color:#fff;text-decoration:underline}
.a17-ok{color:#7ce0ac;font-size:12px;min-height:16px;margin-top:6px}
.a17-hintline{display:flex;justify-content:space-between;align-items:center;margin-top:2px}
.a17-sec{border:1px dashed rgba(var(--accrgb),.4);border-radius:10px;padding:11px 13px;margin-top:12px;background:rgba(var(--accrgb),.05)}
.a17-sec .mq-lab{margin-top:0}
.a17-sec small.ttl{display:block;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8fa2cf;margin-bottom:8px}

/* ---------- customisation overflow / alignment fixes ---------- */
.fnk-grid{max-width:100%}
.fnk-grid.tags{grid-template-columns:repeat(auto-fill,minmax(86px,1fr));align-items:start}
.fnk-grid .fnk-sub{grid-column:1/-1;scroll-margin-top:8px}
.fnk-scr{overscroll-behavior:contain;scrollbar-gutter:stable}
.fnk-locker{min-height:0}
.fnk-left{min-height:220px}
.fnk-desc{max-width:min(430px,44vw)}
@media(max-width:1100px){.fnk-desc{max-width:min(430px,60vw)}}
.mq-sw{max-width:100%}
.mq-sw .i18{min-width:104px}
.set17 .mq-sw{row-gap:8px}
@media(max-width:560px){.set17-themes{grid-template-columns:1fr}.fnk-grid.tags{grid-template-columns:repeat(auto-fill,minmax(74px,1fr))}.fnk-urow{gap:5px}}

/* ---------- ranked home button ---------- */
.mq-btn.ranked18{background:linear-gradient(180deg,#2a3550,#1b2438);border-color:rgba(255,210,63,.45);color:#ffdf8a;letter-spacing:2px}
.mq-btn.ranked18:hover{border-color:#ffd23f;box-shadow:0 6px 18px rgba(255,210,63,.2)}

/* ---------- responsive: lobby + home polish ---------- */
@media(max-width:640px){
 .p14-nav{gap:8px}
 .p14-navr{gap:5px}
 .p14-accchip .i{display:none}
 .f14-go{padding:11px}
 .f14-ready{font-size:16px;padding:11px}
 .mp-connect .mp-logo-img{max-height:84px}
 .rk18 .vs-ring{width:100px;height:100px}
}
@media(max-height:520px){
 .p14-center{min-height:220px}
 .p14-play{padding:10px 44px;font-size:22px}
}

/* ---------- POKI19: music picker + preview player ---------- */
.mp18-tracks{display:flex;flex-direction:column;gap:7px;margin-bottom:10px}
.mp18-track{display:flex;align-items:center;gap:11px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));border:1px solid rgba(120,150,220,.16);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s,background .15s;user-select:none}
.mp18-track:hover{border-color:rgba(var(--accrgb),.55)}
.mp18-track.sel{border-color:var(--acc);background:rgba(var(--accrgb),.13)}
.mp18-track:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.mp18-rad{flex:0 0 auto;width:15px;height:15px;border-radius:50%;border:2px solid #4a5878;position:relative;transition:border-color .15s}
.mp18-track.sel .mp18-rad{border-color:var(--acc)}
.mp18-track.sel .mp18-rad::after{content:'';position:absolute;inset:2px;border-radius:50%;background:var(--acc)}
.mp18-tx{flex:1;min-width:0}
.mp18-tx b{display:block;font-size:12.5px;color:var(--tx)}
.mp18-tx small{display:block;color:var(--dim);font-size:10.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp18-track.sel .mp18-tx b{color:var(--acc-h)}
.mp18-tx small u{color:var(--warn);text-decoration:none}
.mp18-pv{flex:0 0 auto;width:34px;height:34px;border-radius:8px;border:1px solid var(--ln2);background:#1a2231;color:#dbe3f2;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.mp18-pv svg{width:16px;height:16px;pointer-events:none}
.mp18-pv:hover{border-color:var(--acc);color:#fff;background:rgba(var(--accrgb),.18)}
.mp18-pv.on{background:linear-gradient(180deg,#4d95ff,#2b6ce8);border-color:rgba(140,190,255,.6);color:#fff}
.mp18-prevbar{display:flex;align-items:center;gap:9px;background:rgba(var(--accrgb),.08);border:1px solid rgba(var(--accrgb),.4);border-radius:10px;padding:9px 12px;margin:-2px 0 10px}
.mp18-pvb{flex:0 0 auto;width:32px;height:32px;border-radius:8px;border:1px solid var(--ln2);background:#1a2231;color:#dbe3f2;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:border-color .15s,color .15s}
.mp18-pvb svg{width:15px;height:15px;pointer-events:none}
.mp18-pvb.on{background:linear-gradient(180deg,#4d95ff,#2b6ce8);border-color:rgba(140,190,255,.6);color:#fff}
.mp18-pvb.x:hover{border-color:var(--bad);color:var(--bad)}
.mp18-pn{font-family:'proxima',Verdana,sans-serif;font-size:11px;font-weight:bold;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.mp18-pt{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:var(--sub);white-space:nowrap}
#mp18-prevseek{flex:1;min-width:60px;-webkit-appearance:none;appearance:none;height:4px;border-radius:3px;background:#2a3550;outline:0;cursor:pointer}
#mp18-prevseek::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--acc);border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer}
#mp18-prevseek::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--acc);border:2px solid #fff;cursor:pointer}
body[data-theme="light"] .mp18-track{background:#f4f8fc!important;border-color:#c9d8e6!important;color:#1a2434}
body[data-theme="light"] .mp18-track.sel{background:#e9f2fd!important;border-color:#7aa9f2!important}
body[data-theme="light"] .mp18-tx b{color:#1a2434}
body[data-theme="light"] .mp18-track.sel .mp18-tx b{color:#2b6ce8}
body[data-theme="light"] .mp18-tx small{color:#76879e!important}
body[data-theme="light"] .mp18-pv,body[data-theme="light"] .mp18-pvb{background:#eef4fa;border-color:#c2d2e2;color:#2c3d55}
body[data-theme="light"] .mp18-pv.on,body[data-theme="light"] .mp18-pvb.on{background:linear-gradient(180deg,#4f8cf0,#2f6fd8)!important;border-color:#7aa9f2!important;color:#fff!important}
body[data-theme="light"] .mp18-prevbar{background:rgba(47,111,216,.07)!important;border-color:#7aa9f2!important}
body[data-theme="light"] .mp18-pn{color:#1a2434}
body[data-theme="light"] #mp18-prevseek{background:#c2d2e2}
@media(max-width:560px){.mp18-tx small{white-space:normal}.mp18-pn{max-width:64px}}
`;


  // ============================================== POKI18 client settings ====
  // Five selectable UI themes - each restyles the WHOLE interface (surfaces,
  // borders, buttons, inputs, HUD, chats) and pairs with a matching 3D
  // environment. An independent environment picker allows any UI theme with
  // any 3D scene (6 scenes). Everything is saved locally.
  var THEMES = [
    { id: 'midnight', name: 'Midnight', desc: 'Dark, premium interface', scene: 'midnight', c1: '#0b1430', c2: '#3d8bff' },
    { id: 'glass', name: 'Frosted Glass', desc: 'Translucent glassmorphism', scene: 'glass', c1: '#16324a', c2: '#8fd0ff' },
    { id: 'light', name: 'Light Mode', desc: 'Clean light interface', scene: 'light', c1: '#dcecf8', c2: '#5a86a8' },
    { id: 'neon', name: 'Neon', desc: 'Vibrant futuristic styling', scene: 'neon', c1: '#1c0b3a', c2: '#c05cff' },
    { id: 'ember', name: 'Ember', desc: 'Warm orange/red styling', scene: 'ember', c1: '#2a0f06', c2: '#ff9d4d' }
  ];
  var ENVS = [
    { id: 'midnight', name: 'Midnight Yard' },
    { id: 'glass', name: 'Frosted Glass' },
    { id: 'light', name: 'Morning City' },
    { id: 'neon', name: 'Neon Night' },
    { id: 'ember', name: 'Golden Hour' },
    { id: 'frost', name: 'Snow Morning' }
  ];
  var THEME_VARS = {
    midnight: { '--b0': '#05070d', '--b1': '#090d17', '--b2': '#0d1320', '--b3': '#121a2b', '--b4': '#070b13', '--ln': '#1d2740', '--ln2': '#2c3a5c', '--acc': '#3d8bff', '--acc-h': '#6aa5ff', '--ovglow': 'rgba(61,139,255,.12)', '--accrgb': '61,139,255' },
    glass: { '--b0': '#0a1420', '--b1': '#0e1a28', '--b2': '#13212f', '--b3': '#1a2c3e', '--b4': '#0c1622', '--ln': '#24405c', '--ln2': '#385a7c', '--acc': '#5fc0ff', '--acc-h': '#8fd4ff', '--ovglow': 'rgba(95,192,255,.14)', '--accrgb': '95,192,255' },
    light: { '--b0': '#e8eff6', '--b1': '#f2f7fb', '--b2': '#ffffff', '--b3': '#e2ebf4', '--b4': '#dfe8f0', '--ln': '#c2d2e2', '--ln2': '#a4b8cc', '--tx': '#1a2434', '--sub': '#51617a', '--dim': '#76879e', '--acc': '#2f6fd8', '--acc-h': '#4f8cf0', '--ovglow': 'rgba(47,111,216,.12)', '--accrgb': '47,111,216' },
    neon: { '--b0': '#070510', '--b1': '#0b0818', '--b2': '#110c22', '--b3': '#171030', '--b4': '#090613', '--ln': '#241a44', '--ln2': '#38286a', '--acc': '#b26bff', '--acc-h': '#cd93ff', '--ovglow': 'rgba(178,107,255,.14)', '--accrgb': '178,107,255' },
    ember: { '--b0': '#0a0503', '--b1': '#120a06', '--b2': '#190f09', '--b3': '#221409', '--b4': '#0e0805', '--ln': '#2e1c10', '--ln2': '#4a2e18', '--acc': '#ff8f45', '--acc-h': '#ffab6e', '--ovglow': 'rgba(255,143,69,.13)', '--accrgb': '255,143,69' }
  };
  var curTheme = 'midnight', curEnv = '', setBack = null;
  function themeById(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }
  function envById(id) { for (var i = 0; i < ENVS.length; i++) if (ENVS[i].id === id) return ENVS[i]; return null; }
  function applyTheme(id, save) {
    var t = themeById(id); curTheme = t.id;
    var v = THEME_VARS[t.id] || THEME_VARS.midnight;
    for (var k in v) { try { document.body.style.setProperty(k, v[k]); } catch (e) { } }
    try { document.body.setAttribute('data-theme', t.id); } catch (e) { }
    try { if (save) localStorage.setItem('mp17_theme', t.id); } catch (e) { }
    // environment: explicit pick wins, otherwise the theme's matching scene
    var env = envById(curEnv) ? curEnv : (t.scene || 'midnight');
    if (W.MPScene && W.MPScene.setTheme) { try { W.MPScene.setTheme(env); } catch (e) { } }
    if (phase === 'settings') { try { showSettings(); } catch (e) { } }
  }
  function applyEnv(id, save) {
    if (!envById(id)) id = 'midnight';
    curEnv = id;
    try { if (save) localStorage.setItem('mp18_env', id); } catch (e) { }
    if (W.MPScene && W.MPScene.setTheme) { try { W.MPScene.setTheme(id); } catch (e) { } }
    if (phase === 'settings') { try { showSettings(); } catch (e) { } }
  }
  function icoGear() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.8l1 2.6a6.8 6.8 0 0 1 2.3 1l2.6-.8 1.7 3-2 1.8a6.9 6.9 0 0 1 0 2.6l2 1.8-1.7 3-2.6-.8a6.8 6.8 0 0 1-2.3 1l-1 2.6h-1.9l-1-2.6a6.8 6.8 0 0 1-2.3-1l-2.6.8-1.7-3 2-1.8a6.9 6.9 0 0 1 0-2.6l-2-1.8 1.7-3 2.6.8a6.8 6.8 0 0 1 2.3-1l1-2.6z"/></svg>';
  }
  // ---- POKI19: time helper + preview-bar live ticker -----------------------
  function mp18Time(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  var mp18PrevDrag = 0;                                    // last user seek on the preview slider
  function showSettings() {
    if (phase !== 'settings') setBack = phase;
    phase = 'settings'; stopList(); closeGlobalChat(); hideModal();
    // POKI19: developer account logged in but the backend grant not confirmed yet?
    // Re-check once so the Developer console row can appear without a reload.
    try {
      var su = W.MPAcc && W.MPAcc.user();
      if (W.MP18 && W.MP18.admin && su && su.key === ((W.MP18.admin.OWNER_KEY) || 'brune') && !W.MP18.admin.isOwner() && !showSettings._admTry) {
        showSettings._admTry = true;
        W.MP18.admin.ensureGrant().then(function () { return W.MP18.admin.refresh(); }).then(function (ok) { if (ok && phase === 'settings') showSettings(); });
      }
    } catch (e) { }
    var fps = false; try { fps = localStorage.getItem('mp17_fps') === '1'; } catch (e) { }
    var M = W.MP18 && W.MP18.music;
    if (M) M.init();
    var themeCards = THEMES.map(function (t) {
      return '<button class="set17-th' + (t.id === curTheme ? ' sel' : '') + '" data-act="theme" data-t="' + t.id + '">' +
        '<i class="sw" style="background:linear-gradient(135deg,' + t.c1 + ',' + t.c2 + ')"></i>' +
        '<b>' + esc(t.name) + '</b><small>' + esc(t.desc) + '</small><span class="tick">&#10003;</span></button>';
    }).join('');
    var envCards = ENVS.map(function (t) {
      var th = themeById(t.id);
      var c1 = th ? th.c1 : '#0b1430', c2 = th ? th.c2 : '#3d8bff';
      if (t.id === 'light') { c1 = '#cfe4f4'; c2 = '#6ea4cc'; }
      var on = curEnv ? (curEnv === t.id) : (themeById(curTheme) && themeById(curTheme).scene === t.id);
      return '<button class="set17-th' + (on ? ' sel' : '') + '" data-act="env" data-t="' + t.id + '">' +
        '<i class="sw" style="background:linear-gradient(135deg,' + c1 + ',' + c2 + ')"></i>' +
        '<b>' + esc(t.name) + '</b><small>3D lobby scene</small><span class="tick">&#10003;</span></button>';
    }).join('');
    // ---- POKI19: music selector (radio track list + preview player + mute)
    var trackRows = '', prevBar = '', muteRow = '';
    if (M) {
      var pvS = M.previewState ? M.previewState() : { active: false, id: '', playing: false };
      var icoPlay = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.2 5.6v12.8L19 12z"/></svg>';
      var icoPause = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 5h3.6v14H7.5zM12.9 5h3.6v14h-3.6z"/></svg>';
      function mp18Row(id, name, desc, miss) {
        var selNow = M.sel === id && !M.muted;
        return '<div class="mp18-track' + (selNow ? ' sel' : '') + '" data-act="musicsel" data-t="' + id + '" role="button" tabindex="0" title="' + esc(desc) + '">' +
          '<span class="mp18-rad"></span>' +
          '<span class="mp18-tx"><b>' + esc(name) + '</b><small>' + (miss ? '<u>missing</u> - drop ' + esc(desc) + ' into assets/music/ and it will play' : esc(desc)) + '</small></span>' +
          '<button class="mp18-pv' + (pvS.active && pvS.id === id ? ' on' : '') + '" data-act="musicprev" data-t="' + id + '" title="Preview - play any section of this track">' + (pvS.active && pvS.id === id ? icoPause : icoPlay) + '</button>' +
          '</div>';
      }
      M.TRACKS.forEach(function (tr) { trackRows += mp18Row(tr.id, tr.name, tr.desc, M.missing[tr.id] === 1); });
      if (M.customUrl) trackRows += mp18Row('custom', 'Custom', M.customName || 'Uploaded track', false);
      if (pvS.active) {
        var pdur = pvS.dur || 0, ppos = Math.min(pvS.pos || 0, pdur || pvS.pos || 0);
        prevBar = '<div class="mp18-prevbar" id="mp18-prevbar">' +
          '<button class="mp18-pvb' + (pvS.playing ? ' on' : '') + '" data-act="musicptoggle" title="' + (pvS.playing ? 'Pause preview' : 'Play preview') + '">' + (pvS.playing ? icoPause : icoPlay) + '</button>' +
          '<span class="mp18-pn">' + esc(pvS.name) + '</span>' +
          '<input type="range" id="mp18-prevseek" min="0" max="1000" value="' + Math.round(1000 * (pdur ? ppos / pdur : 0)) + '">' +
          '<span class="mp18-pt" id="mp18-ptime">' + mp18Time(ppos) + ' / ' + mp18Time(pdur) + '</span>' +
          '<button class="mp18-pvb x" data-act="musicpstop" title="Stop preview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
          '</div>';
      }
      muteRow = '<div class="set17-row" style="margin-top:9px"><div class="tx"><b>Mute music</b><small>Silences the race theme entirely. The music picker and previews keep working.</small></div>' +
        '<button class="f14-switch' + (M.muted ? ' on' : '') + '" data-act="musicmute" title="Toggle music"><i></i></button></div>';
    }
    var adm = W.MP18 && W.MP18.admin && W.MP18.admin.isOwner();
    setOv('<div class="mq-screen"><div class="mq-panel set17">' +
      '<div class="mq-head"><button class="mq-x" data-act="setback">&larr;</button><h2>Settings</h2><span class="mq-live"><i></i>SAVED LOCALLY</span></div>' +
      '<div class="mq-scroll">' +
      '<div class="mq-sec">UI theme</div>' +
      '<div class="mq-note" style="margin:-4px 2px 10px">Restyles the whole interface. The 3D environment follows unless you pick one below.</div>' +
      '<div class="set17-themes">' + themeCards + '</div>' +
      '<div class="mq-sec">3D environment</div>' +
      '<div class="set17-themes">' + envCards + '</div>' +
      '<div class="mq-sec">Music</div>' +
      '<div class="mq-note" style="margin:-4px 2px 10px">Pick the race theme - switching is instant, even mid-race. Press the play button on a track to preview any section of it, or upload your own music below. Orchestral, Trap 1 and Trap 2 live in the assets/music/ folder.</div>' +
      (M ? '<div class="mp18-tracks">' + trackRows + '</div>' + prevBar + muteRow : '') +
      (M ? '<div class="set17-row" style="margin-top:9px"><div class="tx"><b>Upload custom music</b><small>' + (M.customUrl ? 'Stored: ' + esc(M.customName) + ' (max 20 MB, ogg / mp3 / wav).' : 'Pick an audio file - it is stored in this browser and becomes the race theme.') + '</small></div>' +
        '<span style="display:flex;gap:7px"><input type="file" id="mp-musicfile" accept="audio/*" style="display:none"><button class="mq-btn sm" data-act="musicupload">' + (M.customUrl ? 'REPLACE' : 'UPLOAD') + '</button>' + (M.customUrl ? '<button class="mq-btn sm danger" data-act="musicdel">REMOVE</button>' : '') + '</span></div>' : '') +
      '<div class="mq-sec">Interface</div>' +
      '<div class="set17-row"><div class="tx"><b>FPS counter</b><small>Live frames-per-second readout. Drag it anywhere on screen &ndash; its position is remembered.</small></div>' +
      '<button class="f14-switch' + (fps ? ' on' : '') + '" data-act="fpsT" title="Toggle FPS counter"><i></i></button></div>' +
      '<div class="set17-row"><div class="tx"><b>Reset HUD layout</b><small>Puts the scoreboard, position bar, chats and FPS counter back where they started.</small></div>' +
      '<button class="mq-btn sm" data-act="resetlayout">RESET</button></div>' +
      (adm ? '<div class="set17-row" style="border-color:rgba(255,210,63,.5)"><div class="tx"><b>Developer console</b><small>Badge studio, badge assignment and lobby control for authorised developers.</small></div><button class="mq-btn gold sm" data-act="admin">OPEN</button></div>' : '') +
      '<div class="mq-note" style="margin-top:10px">Preferences are stored in this browser and applied automatically next time you play.</div>' +
      '</div></div></div>');
  }
  function setGoBack() {
    var b = setBack || 'home';
    if (b === 'lobby') { phase = 'lobby'; showLobby(); }
    else if (b === 'leaderboard') showLeaderboard();
    else if (b === 'profile') showProfile(profView && profView.key);
    else if (b === 'browse') showBrowse();
    else if (b === 'create') showCreate();
    else showHome();
  }
  // ---- FPS counter (toggleable + draggable, position remembered)
  var fpsEl = null, fpsRaf = 0, fpsT0 = 0, fpsN = 0;
  function buildFps() {
    if (fpsEl) return;
    fpsEl = document.createElement('div'); fpsEl.id = 'mp-fps'; fpsEl.textContent = '-- FPS';
    document.body.appendChild(fpsEl);
    try { makeDrag(fpsEl, '', 'fps'); } catch (e) { }
    fpsLoop();
  }
  function fpsLoop(ts) {
    fpsRaf = requestAnimationFrame(fpsLoop);
    if (!ts) return;
    fpsN++;
    if (!fpsT0) { fpsT0 = ts; return; }
    var dt = ts - fpsT0;
    if (dt >= 500) {
      var v = Math.round(fpsN * 1000 / dt);
      fpsEl.textContent = v + ' FPS';
      fpsEl.classList.toggle('low', v < 30);
      fpsN = 0; fpsT0 = ts;
    }
  }
  function fpsOn(v) {
    try { localStorage.setItem('mp17_fps', v ? '1' : '0'); } catch (e) { }
    if (v && !fpsEl) buildFps();
    if (fpsEl) fpsEl.style.display = v ? 'block' : 'none';
  }

  // ---- UI shell
  function buildUI() {
    var st = document.createElement('style'); st.textContent = css + css2 + css3 + css4 + (typeof V13CSS === 'string' ? V13CSS : '') + P15CSS + (typeof P16CSS === 'string' ? P16CSS : '') + (typeof CSS17 === 'string' ? CSS17 : '') + (typeof CSS18 === 'string' ? CSS18 : ''); document.head.appendChild(st);
    panoCv = document.createElement('canvas'); panoCv.id = 'mp-pano'; document.body.appendChild(panoCv); panoCtx = panoCv.getContext('2d');
    var pc = (W.MP_CONFIG || {}).panorama;
    if (pc) { var im = new Image(); im.onload = function () { panoImg = im; }; im.onerror = function () { panoImg = null; }; im.src = pc; }
    ov = document.createElement('div'); ov.id = 'mp-ov'; document.body.appendChild(ov);
    hud = document.createElement('div'); hud.id = 'mp-hud';
    hud.innerHTML = '<div id="mp-board" style="display:none"></div><div id="mp-track" style="display:none"></div><div id="mp-posbar"></div><div id="mp-round"></div>' +
      '<div id="mp-lchat"><div class="hd">' + icoChat() + ' Lobby chat <small>Enter to type</small></div><div class="cbox" id="mp-lm"></div><form class="cf" data-chat="lobby"><input type="text" maxlength="120" placeholder="Message the lobby\u2026" autocomplete="off"><button title="Send"><svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.4-8.4L3.4 3.6l-.02 6.5L14 12l-10.62 1.9z" fill="currentColor"/></svg></button></form></div>' +
      '<div id="mp-big"></div><div id="mp-toast"></div><div id="mp-spec"></div><div id="mp-notifs"></div><div id="mp-banner"></div><div id="mp-pclick" data-act="profclick" title="Lift / drop"></div>';
    document.body.appendChild(hud);
    // POKI18: draggable spectator leaderboard + collapsible lobby chat icon
    var sb = document.createElement('div'); sb.id = 'mp-specboard';
    sb.innerHTML = '<div class="sb-hd"><b>Live standings</b><span class="mq-live sb-live"><i></i>LIVE</span><button data-sbact="hide" title="Hide (B)">\u2715</button></div><div class="sb-rows" id="mp-sbrows"></div>';
    document.body.appendChild(sb);
    sb.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-sbact]'); if (b) { specBoardOn = false; updateSpecBoard(); } });
    var lci = document.createElement('button'); lci.id = 'mp-lchaticon'; lci.setAttribute('data-act', 'lchaticong'); lci.title = 'Open lobby chat';
    lci.innerHTML = icoChat() + '<span class="ub" id="mp-lchatub">0</span>';
    lci.addEventListener('click', function (e) { e.stopPropagation(); lchatToggleIcon(false); });   // outside ov/hud: own handler
    document.body.appendChild(lci);
    board = hud.querySelector('#mp-board'); big = hud.querySelector('#mp-big'); toastEl = hud.querySelector('#mp-toast');
    var lc = document.getElementById('mp-lchat');
    document.body.appendChild(lc); // outside #mp-hud so it stacks above the overlay
    lc.addEventListener('focusin', function () { lc.classList.add('act'); });
    lc.addEventListener('focusout', function () { lc.classList.remove('act'); });
    document.addEventListener('submit', function (e) {
      var f = e.target; if (!f || !f.getAttribute) return;
      if (f.getAttribute('data-auth')) { e.preventDefault(); doAuth(f.getAttribute('data-kind') || authMode); return; }
      var sc = f.getAttribute('data-chat'); if (!sc) return;
      e.preventDefault(); var inp = f.querySelector('input'); sendChat(sc, inp.value); inp.value = '';
      if (sc === 'lobby' && (phase === 'running' || phase === 'spectate')) inp.blur();
    });
    ov.addEventListener('click', onClick); hud.addEventListener('click', onClick); ov.addEventListener('change', onChange); ov.addEventListener('input', onInput);
    // POKI19: preview player - re-render on preview end/stop + live position ticker
    document.addEventListener('mp18:preview', function () { if (phase === 'settings') { try { showSettings(); } catch (e) { } } });
    setInterval(function () {
      if (phase !== 'settings' || !W.MP18 || !W.MP18.music || !W.MP18.music.previewState) return;
      var ps = W.MP18.music.previewState();
      if (!ps.active) return;
      var sl = document.getElementById('mp18-prevseek'), tl = document.getElementById('mp18-ptime');
      if (sl && tl && Date.now() - mp18PrevDrag > 350) {
        sl.value = String(Math.round(1000 * (ps.dur ? Math.min(1, (ps.pos || 0) / ps.dur) : 0)));
        tl.textContent = mp18Time(ps.pos || 0) + ' / ' + mp18Time(ps.dur || 0);
      }
    }, 300);
    var mdl = document.createElement('div'); mdl.id = 'mp-modal'; mdl.className = 'none'; document.body.appendChild(mdl);
    mdl.addEventListener('click', onClick); mdl.addEventListener('change', onChange); mdl.addEventListener('input', onInput);
    W.addEventListener('resize', function () { cvRect = null; });
    document.addEventListener('mousemove', function (e) {
      var c = document.getElementById('mq-char'); if (!c) return;
      c.style.setProperty('--ry', ((e.clientX / innerWidth - 0.5) * 34).toFixed(1) + 'deg'); c.style.setProperty('--rx', (-(e.clientY / innerHeight - 0.5) * 12).toFixed(1) + 'deg');
    });
    W.addEventListener('keydown', function (e) {
      var tg = e.target, inChat = tg && tg.closest && tg.closest('#mp-lchat');
      if (inChat) { e.stopPropagation(); if (e.key === 'Escape') tg.blur(); return; }
      if ((phase === 'running' || phase === 'spectate') && e.key === 'Enter' && !(tg && /INPUT|TEXTAREA|SELECT/.test(tg.tagName))) {
        var li = document.querySelector('#mp-lchat input'); if (li && lchat) { e.preventDefault(); e.stopPropagation(); li.focus(); return; }
      }
      if (phase === 'spectate' || phase === 'specwatch') {
        var sk = (e.key || '').toLowerCase();
        if (sk === 'b' && phase === 'spectate') { specBoardOn = !specBoardOn; updateSpecBoard(); }
        if (phase === 'specwatch') { if (e.key === 'Escape') { } e.stopPropagation(); return; }
        if (sk === '1') setSpecMode('third'); else if (sk === '2') setSpecMode('first'); else if (sk === '3') setSpecMode('aerial'); else if (sk === '4') setSpecMode('free');
        else if (specMode === 'free' && { w: 1, a: 1, s: 1, d: 1, ' ': 1, c: 1, shift: 1, control: 1 }[sk]) { specKeys[sk] = 1; e.preventDefault(); }
        if (specMode !== 'free') {
          if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') specCycle(-1);
          else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') specCycle(1);
        } else if (e.key === '[' || e.key === ',') specCycle(-1);
        else if (e.key === ']' || e.key === '.') specCycle(1);
        e.stopPropagation(); return;
      }
      if (phase === 'running' && opts.noPause && (e.key === 'Escape' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); e.stopPropagation(); return; }
      if (phase !== 'running') e.stopPropagation();
    }, true);
    ['keyup', 'keypress'].forEach(function (n) { W.addEventListener(n, function (e) { var tg = e.target; if (n === 'keyup' && e.key) specKeys[e.key.toLowerCase()] = 0; if (phase !== 'running' || (tg && tg.closest && tg.closest('#mp-lchat'))) e.stopPropagation(); }, true); });
    // WebGL watchdog: a lost context on the MAIN game canvas leaves a white screen -> offer a one-click reload that rejoins the lobby
    document.addEventListener('webglcontextlost', function (e) {
      var c = e.target; if (!c || !c.width || c.width < 400 || c.id === 'mp-pano') return;
      console.warn('[MP] game WebGL context lost'); if (e.preventDefault) e.preventDefault();
      if (phase === 'running' || phase === 'countdown' || phase === 'spectate' || phase === 'results') {
        var t = document.getElementById('mp-toast'); if (!t) return;
        t.innerHTML = '\u26A0 Graphics context lost \u2013 <a href="#" style="color:#ffd23f" id="mp-rl">reload game</a>'; t.style.opacity = 1; t.style.pointerEvents = 'auto';
        var a = document.getElementById('mp-rl'); if (a) a.onclick = function (ev) { ev.preventDefault(); location.href = location.pathname + '?mp=1' + (code ? '&join=' + code : ''); };
      }
    }, true);
    W.addEventListener('beforeunload', function () { try { net && net.leave(); } catch (e) {} });
  }


  // ---- draggable panels (top bar, scoreboard, lobby chat); positions are remembered
  function makeDrag(el, handleSel, key) {
    if (!el || el.__drag) return; el.__drag = 1;
    function put(l, t) {
      var w = el.offsetWidth, h = el.offsetHeight;
      l = Math.max(0, Math.min(innerWidth - Math.min(w, 80), l)); t = Math.max(0, Math.min(innerHeight - 30, t));
      ['left', 'top'].forEach(function (k, i) { el.style.setProperty(k, (i ? t : l) + 'px', 'important'); });
      ['right', 'bottom', 'transform'].forEach(function (k) { el.style.setProperty(k, k === 'transform' ? 'none' : 'auto', 'important'); });
    }
    try { var sv = JSON.parse(localStorage.getItem('mp_pos_' + key) || 'null'); if (sv) put(sv.l, sv.t); } catch (e) {}
    el.style.setProperty('pointer-events', 'auto', 'important');
    el.addEventListener('pointerdown', function (e) {
      var h = e.target.closest && (handleSel ? e.target.closest(handleSel) : el);
      if (!h || !el.contains(h) || (e.target.closest && e.target.closest('input,button,textarea,select,a'))) return;
      var r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      function mv(ev) { put(ev.clientX - ox, ev.clientY - oy); }
      function up() {
        el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        try { var b = el.getBoundingClientRect(); localStorage.setItem('mp_pos_' + key, JSON.stringify({ l: Math.round(b.left), t: Math.round(b.top) })); } catch (x) {}
      }
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    el.addEventListener('dblclick', function (e) { if (e.target.closest('input,button')) return; try { localStorage.removeItem('mp_pos_' + key); } catch (x) {} ['left', 'top', 'right', 'bottom', 'transform'].forEach(function (k) { el.style.removeProperty(k); }); });
  }
  function makeDraggables() {
    var st = document.createElement('style'); st.textContent = '#mp-board,#mp-posbar,#mp-lchat .hd,#mp-specboard .sb-hd{cursor:grab;touch-action:none}#mp-board:active,#mp-posbar:active,#mp-lchat .hd:active,#mp-specboard .sb-hd:active{cursor:grabbing}#mp-board,#mp-posbar,#mp-specboard{user-select:none}';
    document.head.appendChild(st);
    makeDrag(document.getElementById('mp-board'), '', 'board');
    makeDrag(document.getElementById('mp-posbar'), '', 'posbar');
    makeDrag(document.getElementById('mp-lchat'), '.hd', 'lchat');
    makeDrag(document.getElementById('mp-specboard'), '.sb-hd', 'specboard');
  }

  // ---- chat
  var lchatGone = false, lchatUnread = 0;                 // POKI18: collapse chat into the floating icon
  function lobbyChatVisible() { return !!lchat && (phase === 'lobby' || phase === 'countdown' || phase === 'running' || phase === 'spectate' || phase === 'results' || phase === 'specwatch'); }
  function syncChat() {
    var el = document.getElementById('mp-lchat'), ico = document.getElementById('mp-lchaticon');
    if (!el) return;
    var show = lobbyChatVisible() && !lchatGone, ing = phase === 'running' || phase === 'spectate';
    el.style.display = show ? 'flex' : 'none'; el.classList.toggle('ing', ing);
    if (ico) ico.style.display = (lobbyChatVisible() && lchatGone) ? 'inline-flex' : 'none';
    clearInterval(chatFadeT);
    if (show) { paintChat('mp-lm', lmsgs, lerr); lchatUnread = 0; var ub = document.getElementById('mp-lchatub'); if (ub) ub.classList.remove('on'); if (ing) chatFadeT = setInterval(function () { paintChat('mp-lm', lmsgs, lerr); }, 2000); }
  }
  function lchatToggleIcon(gone) {
    lchatGone = gone === undefined ? !lchatGone : !!gone;
    try { localStorage.setItem('mp18_lchatgone', lchatGone ? '1' : '0'); } catch (e) { }
    if (lchatGone) {
      // baseline = what was already visible when the chat collapsed, so only NEW messages count
      paintChat._seen = lmsgs.filter(function (m) { return !m.sys && m.u !== me.uid; }).length;
    } else { lchatUnread = 0; paintChat._seen = null; }
    syncChat();
  }
  function setOv(html, mode) { ov.className = (mode || '') + (STG.on ? ' stg' : ''); if (ov.innerHTML !== html) ov.innerHTML = html; panoShow(mode !== 'dim' && !!html); syncChat(); var pc3 = document.getElementById('mp-pclick'); if (pc3) pc3.style.display = phase === 'profile' ? 'block' : 'none'; }
  function hideOv() { ov.className = 'none'; ov.innerHTML = ''; panoShow(false); syncChat(); }
  function sysNote(t, ch) { lsys.push({ sys: 1, t: t, ch: ch || '', ts: Date.now() }); if (lsys.length > 20) lsys.shift(); if (lchat) paintChat('mp-lm', lmsgs, lerr); }
  function mergeSys(l) { return lsys.length ? l.concat(lsys).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }) : l; }
  function chatHtml(l, err, live) {
    var warn = err ? '<div class="c15-sys err">\u26A0 ' + esc(err) + '</div>' : '', now = Date.now();
    if (live) l = l.slice(-8);
    if (!l.length) return warn + (err || live ? '' : '<div class="c15-sys"><span>No messages yet \u2013 say hi!</span></div>');
    return warn + l.map(function (m) {
      if (m.sys) {
        var sch = m.ch || (function () { for (var k in players) { if (players[k] && players[k].name === m.t.split(' ')[0]) return players[k].char; } return ''; })();
        var sav = sch ? '<img class="sav" src="' + preview(sch) + '" alt="">' : '<svg class="sav" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="#5a6a76"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="#5a6a76"/></svg>';
        return '<div class="c15-sys' + (live && now - m.ts > 12000 ? ' old' : '') + '">' + sav + '<span>' + esc(m.t) + '</span></div>';
      }
      var mine = m.u === me.uid, nm = String(m.n || '?');
      var d = m.ts ? new Date(m.ts) : null, tm = d ? ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) : '';
      var inv = (String(m.t).match(/join\s+([A-Z0-9]{4})/i) || [])[1];
      var av = m.ch ? preview(m.ch) : '';
      var port = av ? '<div class="c15-hd"><img src="' + av + '" alt="" draggable="false"></div>' : '';
      var joinBtn = inv ? '<button class="c15-go" data-act="chatjoin" data-code="' + esc(inv.toUpperCase()) + '">START</button>' : '';
      return '<div class="c15' + (mine ? ' mine' : '') + (live && m.ts && now - m.ts > 12000 ? ' old' : '') + '">' + port +
        '<div class="c15-wrap">' + (mine ? '' : '<div class="c15-nm">' + esc(nm) + '</div>') +
        '<div class="c15-row"><div class="c15-bd">' + esc(m.t) + '<span class="c15-ts">' + tm + '</span></div>' + joinBtn + '</div></div></div>';
    }).join('');
  }
  function paintChat(id, l, err) {
    var el = document.getElementById(id); if (!el) return;
    var live = id === 'mp-lm' && (phase === 'running' || phase === 'spectate'), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    el.innerHTML = chatHtml(id === 'mp-lm' ? mergeSys(l) : l, err, live);
    if (atEnd || err || live) el.scrollTop = el.scrollHeight;
    // unread badge on the floating chat icon while collapsed
    if (id === 'mp-lm' && lchatGone) {
      var vis = l ? l.filter(function (m) { return !m.sys && m.u !== me.uid; }).length : 0;
      var base = paintChat._seen == null ? (paintChat._seen = vis) : paintChat._seen;
      var add = Math.max(0, vis - base);
      if (add > lchatUnread) lchatUnread = add;
      paintChat._seen = vis;
      var ub = document.getElementById('mp-lchatub');
      if (ub) { ub.textContent = lchatUnread > 9 ? '9+' : String(lchatUnread); ub.classList.toggle('on', lchatUnread > 0); }
    }
  }
  function openGlobalChat() { if (gchat) return; try { gchat = W.MPNet.chat('global', '', function (l, err) { gmsgs = l; gerr = err ? err.message : ''; paintChat('mp-gm', l, gerr); }); } catch (e) { gchat = null; } }
  function closeGlobalChat() { try { gchat && gchat.close(); } catch (e) {} gchat = null; }
  function openLobbyChat() { closeLobbyChat(); lmsgs = []; lsys = []; try { lchat = W.MPNet.chat('lobby', code, function (l, err) { lmsgs = l; lerr = err ? err.message : ''; paintChat('mp-lm', l, lerr); }); } catch (e) { lchat = null; } }
  function closeLobbyChat() { try { lchat && lchat.close(); } catch (e) {} lchat = null; lmsgs = []; lsys = []; }
  function sendChat(scope, text) {
    text = String(text || '').trim().slice(0, 120); if (!text) return;
    var c = scope === 'global' ? gchat : lchat; if (!c) return;
    var nm0 = (phase === 'home' && $('#mp-name') && $('#mp-name').value.trim()) || me.name || localStorage.getItem('mp_name') || 'Player';
    var pr = c.send({ n: nm0.slice(0, 14), t: text, c: NAMECOLS[me.tc] || '#ffe14d', ts: Date.now(), u: me.uid, ch: me.char });
    if (pr && pr.catch) pr.catch(function (e) {
      var m = (e && e.message) || String(e);
      if (scope === 'global') { gerr = m; paintChat('mp-gm', gmsgs, gerr); } else { lerr = m; paintChat('mp-lm', lmsgs, lerr); }
    });
  }
  function $(sel) { return ov.querySelector(sel); }
  function bigText(t, ms) { big.textContent = t; if (ms) setTimeout(function () { if (big.textContent === t) big.textContent = ''; }, ms); }
  function toast(t, ms) { toastEl.textContent = t; toastEl.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(function () { toastEl.style.opacity = 0; }, ms || 2000); }
  function backendName() { return W.MPNet.kind(); }
  function netNote() { return backendName() === 'firebase' ? 'Online \u2013 works across computers & phones' : 'Local mode \u2013 only tabs of this browser can see each other'; }
  function uchatHtml() {
    return '<div class="p14-panel p14-chat" id="mq-uc"><div class="p14-ph">' + icoGlobe() + ' Universal chat<span class="cnt">' + (backendName() === 'firebase' ? 'everyone online' : 'this browser') + '</span><button data-act="ucmin" title="Collapse">&ndash;</button></div>' +
      '<div class="c13box" id="mp-gm"></div><form class="c13form" data-chat="global"><input type="text" maxlength="120" placeholder="Chat with everyone&hellip;" autocomplete="off"><button type="submit" title="Send"><svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.4-8.4L3.4 3.6l-.02 6.5L14 12l-10.62 1.9z" fill="currentColor"/></svg></button></form></div>';
  }

  // ---- HOME
  var smLb = 'global';
  function charIdx() { for (var i = 0; i < CHARS.length; i++) if (CHARS[i][0] === me.char) return i; return 0; }
  function cycleChar(d) {
    var i = (charIdx() + d + CHARS.length) % CHARS.length; MP.ui.pickChar(CHARS[i][0]);
  }
  function paintHomeChar(anim) {
    var th = document.querySelectorAll('.sm-th'); for (var k = 0; k < th.length; k++) th[k].classList.toggle('on', th[k].getAttribute('data-ch') === me.char);
    var tp = document.getElementById('mq-tagp'); if (tp) tp.innerHTML = bn(myTag(me.name || 'Player'));
  }
  function renderHomeList() {
    var el = document.getElementById('sm-list'); if (!el) return;
    if (listErr) { el.innerHTML = '<div class="mq-empty">Could not load lobbies<br><small>' + esc(listErr) + '</small></div>'; return; }
    var extra18 = [];
    if (W.MP18) { var live18 = {}; lobbies.forEach(function (l) { live18[l.code] = 1; }); Object.keys(W.MP18.persist.map || {}).forEach(function (k18) { if (!live18[k18]) { var r18 = W.MP18.persist.map[k18]; extra18.push({ code: k18, name: r18.name || 'Persistent lobby', host: r18.host || '?', count: 0, max: r18.max || 8, status: 'lobby', created: r18.ts || 0, persist: 1, hc: r18.hc || 'jake' }); } }); }
    var arr = lobbies.concat(extra18).filter(function (l) { return l.status === 'lobby'; }).sort(function (a, b) { return (b.created || 0) - (a.created || 0); }).slice(0, 12);
    if (!arr.length) { el.innerHTML = '<div class="mq-empty">No open lobbies yet.<br><small>Create one and friends will see it here!</small></div>'; return; }
    el.innerHTML = arr.map(function (l, i) {
      var full = (l.count || 0) >= (l.max || 8) && !l.persist;
      return '<div class="p14-lobrow" style="animation-delay:' + (i * 50) + 'ms"><img src="' + preview(l.hc || 'jake') + '" alt="">' +
        '<div class="i"><b>' + esc(l.name || 'Lobby') + (l.persist ? ' <span class="mq-chip gold" style="font-size:9px">24H</span>' : '') + '</b><small>' + (l.count || 0) + ' / ' + (l.max || 8) + ' &middot; host <b>' + esc(l.host || '?') + '</b></small></div>' +
        '<button class="mq-btn sm pri" data-act="join" data-code="' + esc(l.code) + '"' + (full ? ' disabled' : '') + '>' + (full ? 'FULL' : 'JOIN') + '</button></div>';
    }).join('');
  }
  function renderHomeLb() {
    var el = document.getElementById('sm-lbrows'); if (!el) return;
    if (!W.MPAcc) { el.innerHTML = '<div class="mq-empty">Leaderboard unavailable</div>'; return; }
    var friends = smLb === 'friends', mk = (MPAcc.user() || {}).key;
    el.innerHTML = '<div class="mq-empty" style="border:0;padding:10px">Loading&hellip;</div>';
    MPAcc.board('pts', 50).then(function (res) {
      var el2 = document.getElementById('sm-lbrows'); if (!el2 || (smLb === 'friends') !== friends) return;
      var rows = res.rows;
      if (friends) rows = rows.filter(function (r) { return r.key === mk; });
      rows = rows.slice(0, 5);
      if (!rows.length) { el2.innerHTML = '<div class="mq-empty" style="border:0;padding:10px">' + (friends ? 'No friends on the board yet.' : 'No one on the board yet &ndash; win a lobby race!') + '</div>'; return; }
      el2.innerHTML = rows.map(function (r, i) {
        var rk = W.MPAcc ? MPAcc.rankOf(r.pts | 0) : null;
        return '<div class="p14-lbr' + (r.key === mk ? ' me' : '') + '" style="animation-delay:' + (i * 60) + 'ms"><span>' + (r.pos || i + 1) + '</span><img src="' + preview(r.ch) + '" alt=""><b>' + esc(r.name) + '</b>' +
          (rk ? '<i class="rk-inline">' + rk.sigil + '</i>' : '') + '<em>' + num(r.value) + '</em></div>';
      }).join('');
    }).catch(function (e) { var el3 = document.getElementById('sm-lbrows'); if (el3) el3.innerHTML = '<div class="mq-empty">Could not load<br><small>' + esc(e.message || e) + '</small></div>'; });
  }
  // shared top navigation (home + lobby)
  function navHtml(active) {
    var tabs = active === 'lobby'
      ? [['lobby', 'LOBBY', 'navlobby'], ['cust', 'LOCKER', 'cust'], ['lb', 'LEADERBOARDS', 'lb'], ['prof', 'PROFILE', 'prof']]
      : [['home', 'PLAY', 'home'], ['cust', 'LOCKER', 'cust'], ['lb', 'LEADERBOARDS', 'lb'], ['prof', 'PROFILE', 'prof']];
    var u = W.MPAcc && MPAcc.user();
    var prof = (W.MPAcc && MPAcc.profile && MPAcc.profile()) || { };
    var right;
    if (u) {
      var rk = MPAcc.rankOf(MPAcc.points());
      right = '<div class="p14-pill" title="Coins collected">' + gemSvg() + '<b>' + num(prof.cc | 0) + '</b></div>' +
        '<div class="p14-accchip" data-act="prof" title="Your profile"><img src="' + preview(me.char) + '" alt="">' +
        '<div class="i"><b>' + esc(u.name) + '</b><small><i class="rk-svg-wrap">' + rk.sigil + '</i><span style="color:' + rk.color + '">' + esc(rk.name) + '</span></small></div></div>';
    } else {
      right = '<button class="mq-btn pri sm" data-act="auth" data-m="login">LOG IN</button>';
    }
    return '<div class="p14-nav"><div class="p14-logo">' + logoImg(true) + '</div>' +
      '<div class="p14-tabs">' + tabs.map(function (t) { return '<button class="p14-navb' + (active === t[0] ? ' on' : '') + '" data-act="' + t[2] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="p14-navr">' + right + '<button class="mq-btn p14-set" data-act="set" title="Settings">' + icoGear() + '</button></div></div>';
  }
  function showHome(err) {
    phase = 'home'; custOpen = false; stopTimers(); openGlobalChat(); startList();
    STG.lift = false; STG.paused = false;
    var saved = localStorage.getItem('mp_name') || '', inv = (params.get('join') || '').toUpperCase(), u = W.MPAcc && MPAcc.user();
    if (u) me.name = u.name; else if (!me.name) me.name = saved;
    var prof = (W.MPAcc && MPAcc.profile && MPAcc.profile()) || { }, pts = u ? MPAcc.points() : 0;
    var lv0 = W.MPAcc ? MPAcc.levelOf(prof.xp | 0) : { lvl: 1, cur: 0, need: 1000, pct: 0 };
    var rk = W.MPAcc ? MPAcc.rankOf(pts) : null;
    var DIVN = ['I', 'II', 'III'];
    var accCard;
    if (u) {
      accCard = '<div class="p14-panel p14-acc"><div class="top"><img src="' + preview(me.char) + '" alt="">' +
        '<div class="i"><b>' + esc(u.name) + '</b><small>' + rk.sigil + ' <span style="color:' + rk.color + '">' + esc(rk.name) + (rk.next ? ' ' + DIVN[rk.div - 1] : '') + '</span> &middot; ' + num(pts) + ' RP</small></div></div>' +
        '<div class="p14-xpmini"><div class="lab"><span>LEVEL ' + lv0.lvl + '</span><span>' + num(lv0.cur) + ' / ' + num(lv0.need) + ' XP</span></div><div class="p14-minibar"><i style="width:' + lv0.pct + '%"></i></div></div>' +
        '<div class="row"><button class="mq-btn" data-act="prof">PROFILE</button><button class="mq-btn danger" data-act="logout">LOG OUT</button></div></div>';
    } else {
      accCard = '<div class="p14-panel p14-acc p14-guest"><div class="top"><img src="' + preview(me.char) + '" alt=""><div class="i"><b>Guest racer</b><small>progress not saved</small></div></div>' +
        '<p>Log in to earn Rank Points and XP, climb the leaderboards, add friends and receive lobby invites.</p>' +
        '<div class="row"><button class="mq-btn pri" data-act="auth" data-m="login">LOG IN</button><button class="mq-btn" data-act="auth" data-m="signup">SIGN UP</button></div></div>';
    }
    var center = '<div class="p14-col p14-c p14-center">' +
      '<div class="mq-tagplate" id="mq-tagp">' + bn(myTag(me.name || 'Player')) + '</div>' +
      (u ? '' : '<div class="p14-namebox"><input type="text" id="mp-name" maxlength="14" placeholder="Your name" value="' + esc(me.name || '') + '" autocomplete="off"></div>') +
      '<div class="p14-playwrap"><button class="p14-play" data-act="' + (inv ? 'join' : 'play') + '"' + (inv ? ' data-code="' + esc(inv) + '"' : '') + '>PLAY<small>' + (inv ? 'JOIN LOBBY ' + esc(inv) : 'JOIN A LOBBY') + '</small></button>' +
      (u ? '<button class="mq-btn ranked18" data-act="ranked" title="Competitive 1v1 matchmaking"><svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M12 2.6l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.9-5.4 2.9 1-6L3.3 9l6-.9z" fill="#ffd23f"/></svg> RANKED PLAY</button>' : '') +
      '<button class="mq-btn" data-act="cust">' + icoShirt() + (u ? ' LOCKER' : ' SELECT CHARACTER') + '</button></div></div>';
    var left = '<div class="p14-col p14-l">' +
      '<div class="p14-panel p14-lob"><div class="p14-ph">JOIN A LOBBY<span class="cnt" id="mq-lcount"></span><button data-act="refresh" title="Refresh lobbies">&#8635;</button></div>' +
      '<div class="p14-lobs mq-scroll" id="sm-list"></div>' +
      '<button class="mq-btn pri p14-create" data-act="create"><svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>CREATE LOBBY</button></div>' +
      '<div class="p14-panel p14-chat"><div class="p14-ph">' + icoGlobe() + ' Universal chat<span class="cnt">' + (backendName() === 'firebase' ? 'online' : 'local') + '</span></div>' +
      '<div class="c13box" id="mp-gm"></div>' +
      '<form class="c13form" data-chat="global"><input type="text" maxlength="120" placeholder="Chat with everyone&hellip;" autocomplete="off"><button type="submit" title="Send"><svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.4-8.4L3.4 3.6l-.02 6.5L14 12l-10.62 1.9z" fill="currentColor"/></svg></button></form></div></div>';
    var right = '<div class="p14-col p14-r">' + accCard +
      '<div class="p14-panel p14-side"><div class="p14-ph">' + icoTrophy(15) + ' Leaderboard<span class="cnt"><a data-act="lb" style="cursor:pointer;color:#8ecaff">see more &rsaquo;</a></span></div>' +
      '<div class="p14-lbtabs"><button class="' + (smLb === 'global' ? 'on' : '') + '" data-act="smlb" data-t="global">GLOBAL</button><button class="' + (smLb === 'friends' ? 'on' : '') + '" data-act="smlb" data-t="friends">FRIENDS</button></div>' +
      '<div class="p14-lbrows" id="sm-lbrows"></div></div>' +
      '<div class="p14-panel p14-side" id="mp-frp"></div></div>';
    setOv('<div class="p14-home">' + navHtml('home') +
      '<div class="p14-body">' + left + center + right + '</div>' +
      '<div class="p14-err" id="mp-err">' + esc(err || '') + '</div></div>', 'sm');
    paintChat('mp-gm', gmsgs, gerr); renderList(); renderHomeLb(); renderFriends(); fitHome();
  }
  // Poki15: the home is laid out on a 1500x860 design grid and scaled to the window
  function fitHome() {
    var h = document.querySelector('.p14-home'); if (!h) return;
    h.style.setProperty('--s', Math.max(0.62, Math.min(1.45, Math.min(innerWidth / 1500, innerHeight / 860))).toFixed(3));
  }
  W.addEventListener('resize', function () { fitHome(); });

  // ---- lobby browser
  function startList() {
    stopList(); lobbies = []; listErr = null;
    if (W.MP18) { try { W.MP18.persist.refresh().then(function () { if (phase === 'home' || phase === 'browse') renderList(); }); } catch (e) { } }
    try {
      listNet = W.MPNet.create();
      stopListFn = listNet.list(function (arr, e) { lobbies = arr || []; listErr = e ? (e.message || String(e)) : null; if (phase === 'home' || phase === 'browse') renderList(); });
    } catch (e) { listErr = e.message; }
  }
  function stopList() { try { stopListFn && stopListFn(); } catch (e) {} stopListFn = null; listNet = null; }
  function renderList() {
    renderHomeList();
    var cnt = document.getElementById('mq-lcount');
    if (cnt) { var n = lobbies.filter(function (l) { return l.status === 'lobby' && (l.count || 0) < (l.max || 8); }).length; cnt.textContent = listErr ? 'offline' : n + ' OPEN'; }
    var el = document.getElementById('mp-list'); if (!el) return;
    if (listErr) { el.innerHTML = '<div class="mq-empty">Could not load lobbies:<br>' + esc(listErr) + '<br><small>Check your Firebase config and database rules.</small></div>'; return; }
    // POKI18: merge 24h persistent lobbies that are not currently live
    var live = {};
    lobbies.forEach(function (l) { live[l.code] = 1; });
    var extra = [];
    if (W.MP18) {
      var map18 = W.MP18.persist.map || {};
      Object.keys(map18).forEach(function (k18) {
        if (live[k18]) return;
        var r18 = map18[k18];
        extra.push({ code: k18, name: r18.name || 'Persistent lobby', host: r18.host || '?', count: 0, max: r18.max || 8, status: 'lobby', created: r18.ts || 0, persist: 1, hc: r18.hc || 'jake' });
      });
    }
    var q = brQ.trim().toLowerCase();
    var arr = lobbies.concat(extra).filter(function (l) {
      if (brF === 'open' && !(l.status === 'lobby' && (l.count || 0) < (l.max || 8))) return false;
      if (brF === 'race' && l.status === 'lobby') return false;
      return !q || String(l.name || '').toLowerCase().indexOf(q) >= 0 || String(l.host || '').toLowerCase().indexOf(q) >= 0 || String(l.code || '').toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    if (!arr.length) { el.innerHTML = '<div class="mq-empty">' + (lobbies.length ? 'No lobbies match your filter.' : 'No open lobbies yet.<br><small>Create one and your friends will see it here!</small>') + '</div>'; return; }
    el.innerHTML = arr.map(function (l) {
      var full = (l.count || 0) >= (l.max || 8), open = l.status === 'lobby' && !full, pct = Math.min(100, Math.round((l.count || 0) / (l.max || 8) * 100));
      var tags = (Array.isArray(l.tags) ? l.tags : []).slice(0, 4).map(function (t) { return '<span class="mq-chip">' + esc(t) + '</span>'; }).join('');
      if (l.persist) tags += '<span class="mq-chip gold">\u23F1 24H</span>';
      var btnTxt = l.status === 'lobby' ? (l.persist && !(l.count || 0) ? 'OPEN' : 'JOIN') : 'SPECTATE';
      return '<div class="mq-lob"><img src="' + preview(l.hc || 'jake') + '" alt=""><div class="i"><b>' + esc(l.name || 'Lobby') + '</b><small>host ' + esc(l.host || '?') + ' &middot; <b>' + esc(l.code || '') + '</b> ' + tags + '</small></div>' +
        '<div class="cnt"><span class="mq-chip ' + (l.status === 'lobby' ? (full ? 'gold' : 'ok') : 'hot') + '">' + (l.status === 'lobby' ? (full ? 'FULL' : 'OPEN') : 'RACING') + '</span><div class="mq-bar"><i style="width:' + pct + '%"></i></div><small class="mq-note">' + (l.count || 0) + '/' + (l.max || 8) + '</small></div>' +
        '<button class="mq-btn sm pri" data-act="join" data-code="' + esc(l.code) + '"' + (open || l.persist ? '' : '') + '>' + btnTxt + '</button></div>';
    }).join('');
  }
  function showBrowse() {
    phase = 'browse'; custOpen = false; openGlobalChat(); if (!stopListFn) startList();
    var pills = [['all', 'All'], ['open', 'Open'], ['race', 'In race']].map(function (f) { return '<button class="mq-pill' + (brF === f[0] ? ' on' : '') + '" data-act="brf" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join('');
    setOv('<div class="mq-screen"><div class="mq-panel mq-browse"><div class="mq-head"><button class="mq-x" data-act="home">&larr;</button><h2>Find a lobby</h2><span class="mq-live"><i></i>LIVE</span></div>' +
      '<div class="mq-tools"><input type="text" id="mq-q" placeholder="Search lobby, host or code&hellip;" value="' + esc(brQ) + '" autocomplete="off"><div class="mq-pills">' + pills + '</div></div>' +
      '<div class="mq-lobs mq-scroll" id="mp-list"></div>' +
      '<div class="mq-foot2"><button class="mq-btn pri" data-act="create">+ Create your own lobby</button><button class="mq-btn" data-act="cust">Customise</button></div><div class="mq-err" id="mp-err"></div></div></div>');
    renderList();
  }

  // ---- create lobby + host options
  function optsBlock__legacy__() { }

  var OPTGROUPS = [
    ['GAME RULES', ['noCoin', 'coinKeep', 'stopwatch', 'boards', 'boardCount', 'boardInf']],
    ['RACE & OBJECTIVE', ['goalType', 'goalValue', 'timeLimit', 'countdown', 'hudMode']],
    ['TRACK & VISIBILITY', ['seed', 'noGhosts', 'noNames', 'noSpectate', 'noPause']]
  ];
  function optCtl(d, v) {
    if (d.t === 'bool') return '<label class="bo-sw' + (v ? ' on' : '') + '"><input type="checkbox" data-opt="' + d.k + '"' + (v ? ' checked' : '') + '><span class="knob"></span></label>';
    if (d.t === 'sel') return '<span class="bo-selw"><select data-opt="' + d.k + '">' + d.ch.map(function (c) { return '<option value="' + c[0] + '"' + (String(c[0]) === String(v) ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</select></span>';
    if (d.t === 'num') return '<input class="bo-num" type="number" data-opt="' + d.k + '" min="100" step="100" value="' + esc(v) + '">';
    return '<input class="bo-txt" type="text" data-opt="' + d.k + '" maxlength="20" value="' + esc(v) + '" placeholder="random">';
  }
  function optTile(d, v, edit) {
    var ctl;
    if (!edit) {
      var shown = d.t === 'sel' ? (d.ch.filter(function (c) { return String(c[0]) === String(v); })[0] || [0, v])[1] : (d.t === 'txt' && !v ? 'random' : v);
      ctl = '<div class="bo-val">' + (d.t === 'bool' ? (v ? 'ON' : 'OFF') : esc(shown)) + '</div>';
    } else ctl = '<div class="bo-ctl">' + optCtl(d, v) + '</div>';
    // POKI18: minimal bento tile - the description lives in an attractive tooltip on hover
    return '<div class="bo-tile' + (d.t === 'bool' && v ? ' on' : '') + '" data-tip="' + esc(d.d) + '" data-search="' + esc((d.n + ' ' + d.d + ' ' + d.k).toLowerCase()) + '">' +
      '<div class="bo-ic">' + d.i + '</div><div class="bo-tx"><b>' + esc(d.n) + '</b></div>' + ctl + '</div>';
  }
  function optsBlock(edit, o) {
    o = o || {};
    var search = edit ? '<div class="bo-search"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '<input type="text" id="hq-q" placeholder="Search host options&hellip;" autocomplete="off"></div>' : '';
    var groups = OPTGROUPS.map(function (g) {
      var tiles = '';
      g[1].forEach(function (k) { for (var i = 0; i < OPTDEFS.length; i++) if (OPTDEFS[i].k === k) { tiles += optTile(OPTDEFS[i], optVal(o, OPTDEFS[i]), edit); return; } });
      if (!tiles) return '';
      return '<div class="bo-g"><div class="bo-gh">' + esc(g[0]) + '</div><div class="bo-grid">' + tiles + '</div></div>';
    }).join('');
    return search + '<div class="bo-wrap" id="mp-optgrid">' + groups + '<div class="bo-none" style="display:none">No options match your search.</div></div>';
  }
  function optFilter(q) {
    q = String(q || '').trim().toLowerCase();
    var wrap = document.getElementById('mp-optgrid'); if (!wrap) return;
    var any = false;
    wrap.querySelectorAll('.bo-tile').forEach(function (t) {
      var hit = !q || (t.getAttribute('data-search') || '').indexOf(q) >= 0;
      t.style.display = hit ? '' : 'none'; if (hit) any = true;
    });
    wrap.querySelectorAll('.bo-g').forEach(function (g) {
      var vis = 0; g.querySelectorAll('.bo-tile').forEach(function (t) { if (t.style.display !== 'none') vis++; });
      g.style.display = vis ? '' : 'none';
    });
    var nn = wrap.querySelector('.bo-none'); if (nn) nn.style.display = any ? 'none' : '';
  }
  function showCreate(err) {
    phase = 'create'; stopList();
    var nm = me.name || localStorage.getItem('mp_name') || 'Player';
    setOv('<div class="mq-screen"><div class="mq-panel" style="max-width:820px;max-height:100%;display:flex;flex-direction:column"><div class="mq-head"><button class="mq-x" data-act="home">\u2190 Back</button><h2>Create lobby</h2></div>' +
      '<div class="mq-scroll" style="overflow:auto;flex:1;min-height:0;padding-right:4px"><label class="mq-lab">Lobby name</label><input type="text" id="mp-lname" maxlength="22" value="' + esc(nm + "'s lobby") + '" autocomplete="off">' +
      '<label class="mq-lab">Max players</label><select id="mp-max">' + [2, 3, 4, 5, 6, 7, 8].map(function (n) { return '<option value="' + n + '"' + (n === 8 ? ' selected' : '') + '>' + n + ' players</option>'; }).join('') + '</select>' +
      (W.MPAcc && MPAcc.user() ? '<label class="mq-opt" style="margin-top:10px"><span><b>Persistent lobby (24 hours)</b><small>The lobby stays discoverable and joinable for 24 hours. If you leave, a co-owner (or anyone present) can keep it alive and you take host back the moment you return.</small></span><input type="checkbox" id="mp-persist" style="flex:0 0 auto"></label>' : '') +
      '<div class="mq-sec">Host options</div>' + optsBlock(true, draft) + '</div>' +
      '<button class="mq-btn pri ctr" data-act="docreate" style="margin-top:12px">Create lobby</button><div class="mq-err">' + esc(err || '') + '</div></div></div>');
  }

  // ---- LOBBY ROOM
  function sortedPlayers() { return Object.keys(players).sort(function (a, b) { return (players[a].name || '').localeCompare(players[b].name || '') || (a < b ? -1 : 1); }); }
  function readyInfo(ids) {
    var n = ids.length, rc = 0; ids.forEach(function (u) { if (u === room.host || (players[u] && players[u].rdy)) rc++; });
    var need = n > 1 ? n : 0, loaded = ids.length > 0 && ids.every(function (u) { return players[u].ready; });
    return { n: n, rc: rc, need: need, loaded: loaded, ok: loaded && rc >= need };
  }
  // -------------------------------- POKI18: lobby ownership & permissions ----
  var PERMS = [
    ['kick', 'Kick players', 'Remove players from the lobby'],
    ['opts', 'Edit settings', 'Change host options live'],
    ['start', 'Start races', 'Start the next round'],
    ['invite', 'Invite players', 'Send lobby invites'],
    ['coowners', 'Manage co-owners', 'Grant or edit co-owner permissions']
  ];
  function coOwners() { return (room && room.coowners) || {}; }
  function isCoOwner(uid) { return !!coOwners()[uid]; }
  function can(perm) {
    if (!room) return false;
    if (room.host === me.uid) return true;
    var list = coOwners()[me.uid];
    return !!list && list.indexOf(perm) >= 0;
  }
  function canManage() { return isHost || can('coowners'); }
  function lobbyTags(o) {
    var t = []; o = o || { };
    if (o.noCoin) t.push(o.coinKeep ? '\uD83E\uDE99 No coin (elim)' : '\uD83E\uDE99 No coin');
    if (o.goalType && o.goalType !== 'none') t.push('\uD83C\uDFAF ' + ({ dist: o.goalValue + ' m', coins: o.goalValue + ' coins', score: o.goalValue + ' pts' })[o.goalType]);
    if (o.timeLimit > 0) t.push('\u23F1 ' + (o.timeLimit / 60) + ' min');
    if (o.seed) t.push('\uD83C\uDF31 seeded');
    if (o.boards === false) t.push('\uD83D\uDEAB boards');
    else if (o.boardInf) t.push('\u221E boards');
    if (o.stopwatch) t.push('\u23F1 stopwatch');
    if (room && room.ranked) t.push('\u2B50 ranked');
    if (room && room.persist) t.push('\uD83D\uDD58 24h');
    return t;
  }
  function pushLobbyMeta() {
    if (!isHost || !net || !room) return;
    var tags = lobbyTags(room.opts), sig = tags.join('|') + '|' + me.char;
    if (sig === lastMetaSig) return; lastMetaSig = sig;
    try { net.setLobby({ tags: tags, hc: me.char }); } catch (e) {}
  }
  function showLobby() {
    if (!room || phase !== 'lobby') return;
    if (custOpen) { showCustom(); return; }
    pushLobbyMeta();
    var ids = sortedPlayers(), RI = readyInfo(ids), allReady = RI.ok, open = room.status === 'lobby', max = room.max || 8;
    var mp = players[me.uid] || { };
    var ro = cleanOpts(room.opts || { });
    var acc = W.MPAcc && MPAcc.user(), prof = (W.MPAcc && MPAcc.profile && MPAcc.profile()) || { };
    var lv0 = W.MPAcc ? MPAcc.levelOf(prof.xp | 0) : { lvl: 1, cur: 0, need: 1000, pct: 0 };
    var pts = acc ? MPAcc.points() : 0, rk = W.MPAcc ? MPAcc.rankOf(pts) : null;
    var DIVN = ['I', 'II', 'III'];
    var gt = ro.goalType && ro.goalType !== 'none' ? ro.goalType : '';
    var modeName = gt ? ({ dist: 'DISTANCE', coins: 'COIN HUNT', score: 'SCORE RUN' }[gt] || 'CUSTOM') : (ro.noCoin ? 'NO COIN' : 'SQUAD');
    var fillOn = room.fill !== false;
    var roster = ids.map(function (u2) {
      var p = players[u2] || { };
      var stat = !p.ready ? 'LOADING&hellip;' : (u2 === room.host ? 'HOST' : p.rdy ? 'READY' : 'NOT READY');
      var lv2 = p.lv | 0, rk2 = W.MPAcc && p.rk != null ? MPAcc.rankOf(p.rk | 0) : null;
      var meta = [];
      if (lv2) meta.push('<span class="lvchip">LVL ' + lv2 + '</span>');
      if (rk2 && p.tr) meta.push('<i class="rk-inline">' + rk2.sigil + '</i>');
      if (u2 === me.uid) meta.push('<i class="fr-on"></i>');
      if (isCoOwner(u2)) meta.push('<span class="lvchip" style="color:#ffdf8a;border-color:rgba(246,196,83,.4)">CO-OWNER</span>');
      if (p.ow) meta.push('<span class="lvchip" style="color:#ffdf8a;border-color:rgba(246,196,83,.45)">' + MP18_badgeCrown() + ' OWNER</span>');
      return '<div class="f14-ros"><img src="' + preview(p.char) + '" alt=""><div class="i">' + bn(p) +
        '<small class="' + (u2 === room.host ? 'host' : p.rdy ? 'ok' : 'no') + '">' + stat + '</small>' +
        (meta.length ? '<small>' + meta.join('') + '</small>' : '') + '</div>' +
        (isHost && u2 !== me.uid ? '<button class="f14-mini" data-act="coown" data-uid="' + esc(u2) + '" title="Co-owner permissions" style="margin-right:4px">&#9881;</button><button class="f14-kick" data-act="kick" data-uid="' + esc(u2) + '" title="Kick">&#10005;</button>' : '') +
        (!isHost && u2 !== me.uid && can('kick') ? '<button class="f14-kick" data-act="kick" data-uid="' + esc(u2) + '" title="Kick">&#10005;</button>' : '') + '</div>';
    }).join('');
    var hostAbsent = room.standIn || hostGone;
    var claimBtn = (!isHost && (W.MP18 && W.MP18.admin.isOwner()) && room.host !== me.uid)
      ? '<button class="mq-btn gold sm" data-act="claimhost" style="width:100%" title="Developer action">CLAIM HOST</button>' : '';
    var coStart = !isHost && can('start') && !hostAbsent;
    var action;
    if (isHost || coStart) action = '<button class="f14-ready" data-act="start"' + (allReady && open ? '' : ' disabled') + '>' + (!open ? 'RACE IN PROGRESS&hellip;' : allReady ? '<svg viewBox="0 0 24 24" class="ric"><path d="M13 2L4.5 13.5h5L9 22l9-12h-5.4l.9-8z" fill="currentColor"/></svg>' + (isHost ? 'START' : 'START (CO-HOST)') : (!RI.loaded ? 'LOADING PLAYERS&hellip;' : 'WAITING FOR ' + (RI.need - RI.rc) + ' TO READY UP')) + '</button>';
    else action = '<button class="f14-ready' + (mp.rdy ? ' un' : '') + '" data-act="toggleready"' + (open ? '' : ' disabled') + '>' + (mp.rdy ? '&#10004; READY &ndash; TAP TO CANCEL' : 'READY UP') + '</button>';
    var hostGoneNote = hostAbsent ? '<div class="mq-note" style="text-align:center">The host is away. ' + (claimBtn || 'A co-owner with Start permission can keep the lobby running.') + '</div>' : '';
    setOv('<div class="f14">' +
      navHtml('lobby') +
      '<div class="f14-mid">' +
      '<div class="f14-left">' +
      '<div class="p14-panel f14-season"><span class="stag">SEASON 2</span>' +
      '<div class="f14-lv"><span class="f14-shield"><svg viewBox="0 0 64 64"><path d="M32 4l22 8v16c0 15-9.5 26.5-22 32C19.5 54.5 10 43 10 28V12z" fill="#2653c8"/><path d="M32 10l16 6v12c0 11-6.8 19.6-16 24.4C22.8 47.6 16 39 16 28V16z" fill="#3e7bfa"/><path d="M25 24l5 5 11-11" stroke="#cfe0ff" stroke-width="3.5" fill="none"/></svg></span>' +
      '<div class="f14-lvmid"><div class="f14-lvnum">LEVEL ' + lv0.lvl + '</div><div class="f14-xptxt">' + num(lv0.cur) + ' / ' + num(lv0.need) + ' XP</div><div class="f14-xp"><i style="width:' + lv0.pct + '%"></i></div></div></div>' +
      (rk ? '<div class="f14-rkrow">' + rk.svg + '<div class="i"><b style="color:' + rk.color + '">' + esc(rk.name) + (rk.next ? ' ' + DIVN[rk.div - 1] : '') + '</b><small>' + num(pts) + ' RP' + (rk.next ? ' &middot; ' + num(rk.toNext) + ' to ' + esc(rk.next.name) : '') + '</small></div></div>' : '') +
      '</div>' +
      '<div class="p14-panel f14-mode"><div class="mh">GAME MODE</div><div class="mn">' + esc(modeName) + '</div>' +
      '<button class="mq-btn sm pri" data-act="opts" style="width:100%">Change mode</button>' +
      '<div class="f14-fillrow"><span>Squad fill</span><button class="f14-switch' + (fillOn ? ' on' : '') + '" data-act="fill" title="Squad fill"><i></i></button><em class="f14-fillop">' + (fillOn ? 'FILL' : 'NO FILL') + '</em></div></div>' +
      '<div class="p14-panel f14-lobinfo"><small>' + esc(room.name || 'Lobby') + ' &middot; code <b>' + esc(code) + '</b></small>' +
      '<div class="tags">' + lobbyTags(ro).map(function (tg) { return '<span class="mq-chip">' + esc(tg) + '</span>'; }).join('') + '</div>' +
      '<div class="rf"><a data-act="copy">copy invite link</a></div></div>' +
      '</div>' +
      '<div class="p14-panel f14-party" id="f13-ros"><div class="rh">Party<span class="cnt">' + ids.length + ' / ' + max + '</span></div>' + roster +
      '<div style="padding:8px 9px 2px"><button class="mq-btn sm pri f14-inv" data-act="inv" style="width:100%">+ INVITE PLAYERS</button></div></div>' +
      '<button class="f14-cam" data-act="recenter" title="Reset camera"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
      '<div class="p14-panel f14-go"><div class="f14-readyline">' + (RI.need ? 'READY ' + RI.rc + '/' + ids.length + ' &middot; ' + (allReady ? 'ALL SET' : 'everyone must ready up') : (isHost ? 'READY TO START' : (open ? 'WAITING FOR THE HOST&hellip;' : 'RACE IN PROGRESS&hellip;'))) + '</div>' +
      hostGoneNote + action +
      '<div class="f14-gorow"><button class="mq-btn sm" data-act="cust">LOCKER</button><button class="mq-btn sm danger" data-act="leave">LEAVE</button></div>' +
      '</div>' +
      '</div></div>', 'stg');
  }

  // ---- CUSTOMISE  (Fortnite locker layout)
  var boardQ = '';
  function lockerTile(cls, sel, act, attrs, inner) {
    return '<div class="fnk-tile ' + cls + (sel ? ' sel' : '') + '" data-act="' + act + '" ' + attrs + '>' + inner + '</div>';
  }
  function lockerBody() {
    var body = '', inLobby = custOpen;
    if (custTab === 'outfit') {
      body = '<div class="fnk-grid">' + CHARS.map(function (c) { return lockerTile('ch', me.char === c[0], 'pickch', 'data-ch="' + c[0] + '"', '<div class="fnk-imgw"><img src="' + preview(c[0]) + '" alt="" loading="lazy"><div class="fnk-floor"></div></div><b>' + esc(c[1]) + '</b>'); }).join('') + '</div>';
    } else if (custTab === 'board') {
      var q = boardQ.trim().toLowerCase();
      var list = BOARDS.filter(function (b) { return !q || bname(b).toLowerCase().indexOf(q) >= 0 || b.indexOf(q) >= 0; });
      body = '<div class="fnk-grid boards">' + list.map(function (b) { return lockerTile('bd', me.board === b, 'pickbd', 'data-bd="' + b + '"', '<div class="fnk-imgw" data-bdimg="' + b + '"><img class="bd3d" alt="" loading="lazy"></div><b>' + esc(bname(b)) + '</b>'); }).join('') + '</div>';
    } else {
      var hasRank = myPts() != null;
      body = '<div class="fnk-grid tags">' +
        '<div class="fnk-sub">Name colour</div>' + NAMECOLS.map(function (c, i) { return '<i class="fnk-swatch' + (me.tc === i ? ' sel' : '') + '" data-act="pickcol" data-i="' + i + '" style="background:' + c + '"></i>'; }).join('') +
        '<div class="fnk-sub">Badge</div>' + BADGE_ICONS.map(function (b, i) { return '<i class="fnk-badge' + (me.tt === b.id ? ' sel' : '') + '" data-act="picktt" data-i="' + i + '" title="' + esc(b.name) + '">' + (b.svg ? '<svg viewBox="0 0 24 24">' + b.svg + '</svg>' : '\u2014') + '</i>'; }).join('') +
        '<div class="fnk-sub">Plate style</div>' + PLATES.map(function (b, i) { return '<i class="fnk-pick' + ((me.tp | 0) === i ? ' sel' : '') + '" data-act="picktp" data-i="' + i + '">' + esc(b) + '</i>'; }).join('') +
        '<div class="fnk-sub">Text effect</div>' + EFFECTS.map(function (b, i) { return '<i class="fnk-pick' + ((me.tf | 0) === i ? ' sel' : '') + '" data-act="picktf" data-i="' + i + '">' + esc(b) + '</i>'; }).join('') +
        '<div class="fnk-sub">Tag size</div>' + ['Small', 'Normal', 'Large'].map(function (b, i) { return '<i class="fnk-pick' + ((me.tq | 0) === i ? ' sel' : '') + '" data-act="picktq" data-i="' + i + '">' + b + '</i>'; }).join('') +
        '<div class="fnk-sub">Tag opacity</div><input type="range" class="fnk-range" id="mp-to" min="4" max="10" step="1" value="' + (me.to == null ? 10 : me.to) + '">' +
        '<div class="fnk-sub">Underline colour</div><div class="fnk-urow">' + NAMECOLS.map(function (c, i) { return '<i class="fnk-swatch sm' + (me.tu === i ? ' sel' : '') + '" data-act="picktu" data-i="' + i + '" style="background:' + c + '"></i>'; }).join('') +
        '<i class="fnk-pick' + (me.tu == null || me.tu < 0 ? ' sel' : '') + '" data-act="picktu" data-i="-1">None</i></div>' +
        '<div class="fnk-sub">Rank</div><i class="fnk-pick' + (me.tr ? ' sel' : '') + '" data-act="picktr" style="' + (hasRank ? '' : 'opacity:.5') + '">' + (me.tr ? '\u2714 Show my rank icon' : 'Show my rank icon') + '</i>' +
        '</div>';
    }
    if (custTab === 'outfit') body += outfitRows();
    return body;
  }
  function showCustom() {
    if (!custOpen) phase = 'custom';
    var tabs = [['outfit', 'OUTFIT'], ['board', 'BOARD'], ['tag', 'NAMETAG']].map(function (t) { return '<button class="mq-tab' + (custTab === t[0] ? ' on' : '') + '" data-act="custtab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('');
    var descSub = custTab === 'outfit' ? (me.tr ? 'RANKED OUTFIT' : 'STANDARD OUTFIT') + ' \u00B7 ' + OUTFITS[me.ot | 0].toUpperCase() + ' STYLE' : custTab === 'board' ? 'HOVERBOARD \u00B7 READY TO RIDE' : 'NAMETAG \u00B7 HOW RIVALS SEE YOU';
    setOv('<div class="mq-screen"><div class="fnk-locker">' +
      '<div class="fnk-left"><div class="fnk-hint"><svg viewBox="0 0 24 24"><path d="M9 11.5V5a1.5 1.5 0 0 1 3 0v6l4.8-1.2a1.8 1.8 0 0 1 1.4 3.3l-4.4 4.6a4.6 4.6 0 0 1-3.3 1.4h-1.1a4.4 4.4 0 0 1-3.1-1.3l-2.9-3a1.6 1.6 0 0 1 2.3-2.3l2.3 2.3" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.6" stroke-linejoin="round"/></svg> DRAG TO ROTATE \u00B7 SCROLL TO ZOOM</div>' +
      '<div class="fnk-desc"><small class="fnk-rar">' + descSub + '</small><b>' + esc(cname(me.char)) + '</b><span>' + esc(bname(me.board)) + ' board \u00B7 ' + OUTFITS[me.ot | 0] + '</span><p>' + esc(CINFO[me.char] || '') + '</p></div></div>' +
      '<div class="mq-panel fnk-right"><div class="fnk-head"><h2>' + (custTab === 'outfit' ? 'CHARACTER' : custTab === 'board' ? 'HOVERBOARD' : 'NAMETAG') + '</h2><span class="mq-live"><i></i>3D PREVIEW</span></div>' +
      '<div class="mq-tabs fnk-tabs">' + tabs + '</div>' +
      (custTab === 'board' ? '<div class="fnk-tools"><input type="text" id="fnk-bq" placeholder="Search boards\u2026" value="' + esc(boardQ) + '" autocomplete="off"><svg viewBox="0 0 24 24" class="fltr"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>' : '') +
      '<div class="scr mq-scroll fnk-scr">' + lockerBody() + '</div>' +
      '<div class="fnk-btns"><button class="mq-btn" data-act="custdone">\u2190 Back</button><button class="mq-btn pri" data-act="custdone">\u2714 Done</button></div></div>' +
      '</div></div>');
    fillBoardRenders();
  }
  function repaintLockerGrid() {
    var scr = ov && ov.querySelector('.fnk-scr'); if (!scr) return;
    scr.innerHTML = lockerBody();
    fillBoardRenders();
  }
  function fillBoardRenders() {
    var wrap = ov && ov.querySelector('.fnk-locker'); if (!wrap) return;
    wrap.querySelectorAll('[data-bdimg]').forEach(function (el) {
      var b = el.getAttribute('data-bdimg'), img = el.querySelector('img.bd3d');
      if (!img) return;
      var hit = (W.MPScene && W.MPScene.boardCache && W.MPScene.boardCache(b)) || null;
      if (hit) { if (img.getAttribute('data-src3d') !== hit) { img.setAttribute('data-src3d', hit); img.src = hit; img.classList.add('r3d'); } return; }
      img.src = 'assets/boards/board-' + b + '-tex.webp';  // texture fallback until the 3D render is ready
      W.MPScene.snapBoard(b, 220).then(function (url) {
        if (!url) return;
        var live = document.querySelector('[data-bdimg="' + b + '"] img.bd3d');
        if (live) { live.src = url; live.classList.add('r3d'); }
      });
    });
  }

  // ---- click / change / input
  function onClick(e) {
    var t = e.target.closest && e.target.closest('[data-act]'); if (!t) return;
    var a = t.getAttribute('data-act');
    if (a === 'copy') { e.preventDefault(); var u = location.origin + location.pathname + '?mp=1&join=' + code; try { navigator.clipboard.writeText(u); t.textContent = 'copied!'; } catch (x) { } }
    else if (a === 'create') { if (phase === 'home') me.name = cleanName(($('#mp-name') || { }).value || me.name); MP.ui.openCreate(me.name); }
    else if (a === 'docreate') MP.ui.createLobby(($('#mp-lname') || { }).value, ($('#mp-max') || { }).value);
    else if (a === 'home') showHome();
    else if (a === 'play') { if (phase === 'home' && !(W.MPAcc && MPAcc.user())) me.name = ($('#mp-name') || { }).value || me.name; showBrowse(); }
    else if (a === 'brf') { brF = t.getAttribute('data-f'); showBrowse(); }
    else if (a === 'join') MP.ui.joinLobby(t.getAttribute('data-code'), phase === 'home' ? ($('#mp-name') || { }).value : '');
    else if (a === 'pickch') MP.ui.pickChar(t.getAttribute('data-ch'));
    else if (a === 'pickch2') { MP.ui.pickChar(t.getAttribute('data-ch')); paintHomeChar(true); }
    else if (a === 'prevch') { cycleChar(-1); paintHomeChar(true); }
    else if (a === 'nextch') { cycleChar(1); paintHomeChar(true); }
    else if (a === 'smlb') { smLb = t.getAttribute('data-t'); var tb = document.querySelectorAll('.sm-lbtabs button'); for (var q = 0; q < tb.length; q++) tb[q].classList.toggle('on', tb[q].getAttribute('data-t') === smLb); renderHomeLb(); }
    else if (a === 'refresh') { startList(); renderHomeLb(); }
    else if (a === 'pickbd') MP.ui.pickBoard(t.getAttribute('data-bd'));
    else if (a === 'start') MP.ui.start();
    else if (a === 'leave') MP.ui.leave();
    else if (a === 'back') MP.ui.backToLobby();
    else if (a === 'kick') { var ku = t.getAttribute('data-uid'); if ((isHost || can('kick')) && net && room && ku && ku !== me.uid) net.setRoom({ kick: Object.assign({ }, room.kick || { }, (function (o) { o[ku] = 1; return o; })()) }); }
    else if (a === 'toggleready') { if (net) net.setPlayer({ rdy: !(players[me.uid] && players[me.uid].rdy) }); }
    else if (a === 'cust') { if (phase === 'lobby') { custOpen = true; custBack = 'lobby'; } else custBack = 'home'; showCustom(); }
    else if (a === 'custdone') { if (custOpen) { custOpen = false; if (custBack === 'lobby' && phase === 'custom') { phase = 'lobby'; showLobby(); } else showHome(); } else showHome(); }
    else if (a === 'custtab') { custTab = t.getAttribute('data-tab'); showCustom(); }
    else if (a === 'pickcol') { me.tc = parseInt(t.getAttribute('data-i'), 10); saveCust(); refreshCust(); }
    else if (a === 'picktt') { me.tt = (BADGE_ICONS[parseInt(t.getAttribute('data-i'), 10)] || { id: '' }).id; saveCust(); refreshCust(); }
    else if (a === 'picktp') { me.tp = parseInt(t.getAttribute('data-i'), 10) || 0; saveCust(); refreshCust(); }
    else if (a === 'picktf') { me.tf = parseInt(t.getAttribute('data-i'), 10) || 0; saveCust(); refreshCust(); }
    else if (a === 'picktq') { me.tq = parseInt(t.getAttribute('data-i'), 10) || 0; saveCust(); refreshCust(); }
    else if (a === 'picktu') { var ti = parseInt(t.getAttribute('data-i'), 10); me.tu = ti < 0 ? null : ti; saveCust(); refreshCust(); }
    else if (a === 'picktr') { if (myPts() == null) { toast('Sign in to show your rank', 1800); return; } me.tr = me.tr ? 0 : 1; saveCust(); refreshCust(); }
    else if (a === 'pickot') { me.ot = parseInt(t.getAttribute('data-i'), 10) || 0; try { localStorage.setItem('mp_ot', me.ot); } catch (x) { } if (net) net.setPlayer({ ot: me.ot }); refreshCust(); }
    else if (a === 'pickpose') { me.pose = parseInt(t.getAttribute('data-i'), 10) || 0; try { localStorage.setItem('mp_pose', me.pose); } catch (x) { } refreshCust(); }
    else if (a === 'auth') { var am = t.getAttribute('data-m'); if (am) authMode = am; showAuth(); }
    else if (a === 'authmode') { authMode = t.getAttribute('data-m'); showAuth(); }
    else if (a === 'pwt') { var pi = $('#mp-ap'); if (pi) pi.type = pi.type === 'password' ? 'text' : 'password'; }
    else if (a === 'logout') { MPAcc.logout(); me.tr = 0; showHome(); }
    else if (a === 'lb') showLeaderboard();
    else if (a === 'lbtab') { lbCat = t.getAttribute('data-cat'); showLeaderboard(); }
    else if (a === 'lbback') { if (lbBack === 'results' && finished) { phase = 'results'; showResults(lastList || standings(), lastCoin); recordResult([]); } else showHome(); }
    else if (a === 'set') { setBack = phase; showSettings(); }
    else if (a === 'setback') setGoBack();
    else if (a === 'theme') { applyTheme(t.getAttribute('data-t') || 'midnight', true); }
    else if (a === 'fpsT') { fpsOn(!(localStorage.getItem('mp17_fps') === '1')); if (phase === 'settings') showSettings(); }
    else if (a === 'resetlayout') { ['board', 'posbar', 'lchat', 'fps'].forEach(function (k17) { try { localStorage.removeItem('mp_pos_' + k17); } catch (x17) { } }); toast('HUD layout reset', 2000); }
    else if (a === 'ucmin') { var uc = document.getElementById('mq-uc'); if (uc) { uc.classList.toggle('min'); try { localStorage.setItem('mp_uc_min', uc.classList.contains('min') ? '1' : '0'); } catch (x) { } } }
    else if (a === 'hudclose') { hudHide = true; updateHud(); }
    else if (a === 'hudopen') { hudHide = false; updateHud(); }
    else if (a === 'hudmin') { hudMin = !hudMin; updateHud(); }
    else if (a === 'specprev') specCycle(-1);
    else if (a === 'specnext') specCycle(1);
    else if (a === 'specmode') setSpecMode(t.getAttribute('data-m'));
    else if (a === 'specexit') specExit();
    // ---------------- POKI18 ----------------
    else if (a === 'sbopen') { specBoardOn = true; updateSpecBoard(); }
    else if (a === 'lchaticong') lchatToggleIcon(false);
    else if (a === 'lchatmin18') lchatToggleIcon(true);
    else if (a === 'ranked') { stopRanked(); showRanked(); }
    else if (a === 'rmode') { if (!rkUI.searching) { rkUI.mode = t.getAttribute('data-m') === 'nocoin' ? 'nocoin' : 'coin'; if (W.MP18) W.MP18.ranked.mode = rkUI.mode; showRanked(); } }
    else if (a === 'rfind') rkFind();
    else if (a === 'rcancel') { stopRanked(); showRanked(); }
    else if (a === 'rinvite') rkInvite();
    else if (a === 'env') { applyEnv(t.getAttribute('data-t') || 'midnight', true); }
    else if (a === 'musicsel') {
      if (!W.MP18) return;
      var msel = t.getAttribute('data-t') || 'default';
      if (msel === 'custom' && !(W.MP18.music && W.MP18.music.customUrl)) { toast('Upload a custom track first', 2000); return; }
      W.MP18.music.select(msel).then(function (r) { if (!r.ok) { toast(r.msg, 4200); if (phase === 'settings') showSettings(); } else { W.MP18.music.setMute(false); var mt18 = (W.MP18.music.TRACKS.filter(function (x) { return x.id === msel; })[0] || { name: msel }).name; toast('Music: ' + mt18, 1500); if (phase === 'settings') showSettings(); } });
    }
    else if (a === 'musicmute') { if (!W.MP18) return; W.MP18.music.setMute(!W.MP18.music.muted); if (phase === 'settings') showSettings(); }
    else if (a === 'musicprev') {
      if (!W.MP18 || !W.MP18.music) return;
      var mpv = t.getAttribute('data-t') || 'default';
      var pst = W.MP18.music.previewState ? W.MP18.music.previewState() : { active: false, id: '' };
      if (pst.active && pst.id === mpv) { W.MP18.music.previewStop(); if (phase === 'settings') showSettings(); }
      else {
        W.MP18.music.previewStart(mpv).then(function () { if (phase === 'settings') showSettings(); })
          .catch(function (er) { toast(er.message || er, 3400); if (phase === 'settings') showSettings(); });
        if (phase === 'settings') showSettings();           // show the player bar right away
      }
    }
    else if (a === 'musicptoggle') { if (W.MP18 && W.MP18.music) W.MP18.music.previewToggle().then(function () { if (phase === 'settings') showSettings(); }); }
    else if (a === 'musicpstop') { if (W.MP18 && W.MP18.music) W.MP18.music.previewStop(); }
    else if (a === 'musicupload') { var mf = document.getElementById('mp-musicfile'); if (mf) mf.click(); }
    else if (a === 'musicdel') { if (W.MP18) W.MP18.music.removeCustom().then(function () { if (phase === 'settings') showSettings(); toast('Custom track removed', 1600); }); }
    else if (a === 'claimhost') rkClaimHost();
    else if (a === 'coown') showCoOwn(t.getAttribute('data-uid'));
    else if (a === 'perm18') {
      var pu = t.getAttribute('data-uid'), pk = t.getAttribute('data-k');
      if (isHost && net && room && pu && pk) {
        var co = Object.assign({}, room.coowners || {});
        var list = (co[pu] || []).slice();
        var ix = list.indexOf(pk);
        if (ix >= 0) list.splice(ix, 1); else list.push(pk);
        if (list.length) co[pu] = list; else delete co[pu];
        net.setRoom({ coowners: co });
        showCoOwn(pu);
      }
    }
    else if (a === 'admin') showAdmin('badges');
    else if (a === 'atab') { admTab = t.getAttribute('data-tab') || 'badges'; showAdmin(admTab); }
    else if (a === 'mkbadge') admMakeBadge();
    else if (a === 'delbadge') { var dbid = t.getAttribute('data-id'); if (W.MP18 && dbid) W.MP18.admin.deleteBadge(dbid).then(function () { showAdmin(admTab); }); }
    else if (a === 'admuser') { admUser = t.getAttribute('data-key') || ''; showAdmin(admTab); }
    else if (a === 'assignb') {
      var abid = t.getAttribute('data-id');
      if (W.MP18 && admUser && abid) {
        var cur = (W.MP18.badges.userCustom[admUser] || []).indexOf(abid) >= 0;
        W.MP18.admin.assign(admUser, abid, !cur).then(function () { if (!cur) toast('Badge assigned to ' + admUser, 2000); showAdmin(admTab); }).catch(function (er) { toast(er.message || er, 2600); });
      }
    }
    else if (a === 'forgot') { authMode = 'forgot'; showAuth(); }
    else if (a === 'authmode2') { authMode = t.getAttribute('data-m'); showAuth(); }
    else if (a === 'lbcat18') { lbCat18 = t.getAttribute('data-cat') || 'unranked'; showLeaderboard(); }
    else if (a === 'lbmode') { lbMode = t.getAttribute('data-m') === 'nocoin' ? 'nocoin' : 'coin'; showLeaderboard(); }
    else if (a === 'lbfield') { lbField = t.getAttribute('data-f') || 'bs'; showLeaderboard(); }
    else if (a === 'recovery18') { authMode = 'recovery'; showAuth(); }
    else if (a === 'admico') { admNewIco = t.getAttribute('data-ic') || 'crown'; showAdmin(admTab); }
    else if (a === 'admcol') { admNewCol = t.getAttribute('data-col') || '#ffd23f'; showAdmin(admTab); }
    else if (a === 'admjoin') { var aj = t.getAttribute('data-code'); hideModal(); MP.ui.joinLobby(aj, '').then(function () { setTimeout(function () { if (net && room && room.host !== me.uid) rkClaimHost(); }, 900); }); }
    // ---- v13: nav + lobby + social + profile
    else if (a === 'navlobby') { hideModal(); }
    else if (a === 'opts') { if (room) showModal('<div class="m13 wide"><div class="m13-h"><h3>' + (isHost ? 'HOST OPTIONS' : 'LOBBY OPTIONS') + '</h3><button class="m13-x" data-act="optsclose">&#10005;</button></div><div class="mq-scroll" style="overflow:auto">' + optsBlock(isHost, room.opts) + '</div>' + (isHost ? '<div class="m13-note">Options apply live to everyone in the lobby.</div>' : '<div class="m13-note">Only the host can change these.</div>') + '</div>'); }
    else if (a === 'optsclose') hideModal();
    else if (a === 'fill') { if (isHost && net && room) { net.setRoom({ fill: room.fill === false }); } else toast('Only the host can change Squad Fill', 1600); }
    else if (a === 'party') { lobbyRosOpen = !lobbyRosOpen; var ros = document.getElementById('f13-ros'); if (ros) ros.classList.toggle('open', lobbyRosOpen); }
    else if (a === 'recenter') { STG.yaw = 0; STG.pitch = 0; STG.zoom = 1; STG.azBase = 0; STG.piBase = 0.4; }
    else if (a === 'inv') { if (room && isHost) showInvite(); else if (room) toast('Only the host can send invites', 1800); else if (W.MPAcc && MPAcc.user()) showInvite(); else toast('Log in to invite players', 1800); }
    else if (a === 'rinvsend') {
      var rk = t.getAttribute('data-key'), rkn = t.getAttribute('data-n');
      t.disabled = true; t.textContent = 'SENDING\u2026';
      // create the ranked lobby now, then invite the opponent to its code
      var rcode = ''; for (var ri = 0; ri < 4; ri++) rcode += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)];
      MP.ui.createRankedLobby(rcode, rkUI.mode, { n: rkn }).then(function () {
        return W.MPSocial.sendInvite(code, rk, 'Ranked ' + (rkUI.mode === 'nocoin' ? 'No Coin' : 'Coin') + ' duel', { ranked: 1, mode: rkUI.mode });
      }).then(function () { t.textContent = 'SENT \u2713'; toast('Ranked duel sent to ' + rkn + ' \u00B7 lobby ' + code, 3200); hideModal(); })
        .catch(function (er) { t.disabled = false; t.textContent = 'DUEL'; toast(er.message || er, 2600); });
    }
    else if (a === 'invsend') {
      var ik = t.getAttribute('data-key'), iN = t.getAttribute('data-n');
      t.disabled = true; t.textContent = 'SENDING…';
      MPSocial.sendInvite(code, ik, (room && room.name) || '').then(function () { t.textContent = 'SENT \u2713'; toast('Invite sent to ' + iN, 2200); })
        .catch(function (er) { t.disabled = false; t.textContent = 'INVITE'; toast(er.message || er, 2600); });
    }
    else if (a === 'fradd') {
      var fv = ($('#mp-frn') || { }).value;
      if (!fv) return;
      MPSocial.addFriend(fv).then(function () { toast('Friend request sent to ' + fv, 2400); var i2 = $('#mp-frn'); if (i2) i2.value = ''; })
        .catch(function (er) { toast(er.message || er, 2800); });
    }
    else if (a === 'facc') MPSocial.acceptRequest(t.getAttribute('data-key')).then(function () { toast('Friend added!', 1800); }).catch(function (er) { toast(er.message || er, 2400); });
    else if (a === 'fdec') MPSocial.declineRequest(t.getAttribute('data-key'));
    else if (a === 'frem') MPSocial.removeFriend(t.getAttribute('data-key')).then(function () { toast('Friend removed', 1600); });
    else if (a === 'chatjoin' || a === 'bannergo') {
      var jc = t.getAttribute('data-code');
      hideModal(); hideBanner();
      if (a === 'bannergo' && t.getAttribute('data-id')) MPSocial.declineInvite(t.getAttribute('data-id'));
      if (phase !== 'home' && net) { MP.ui.leave(); setTimeout(function () { MP.ui.joinLobby(jc, ''); }, 550); }
      else setTimeout(function () { MP.ui.joinLobby(jc, ''); }, 120);
    }
    else if (a === 'bannerx') { MPSocial.declineInvite(t.getAttribute('data-id')); hideBanner(); }
    else if (a === 'prof') { profBack = (phase === 'lobby') ? 'lobby' : 'home'; if (W.MPAcc && MPAcc.user()) showProfile(); else { authMode = 'login'; showAuth(); } }
    else if (a === 'profview') { profBack = (phase === 'lobby') ? 'lobby' : 'home'; showProfile(t.getAttribute('data-key')); }
    else if (a === 'profback') { if (profBack === 'lobby') { phase = 'lobby'; showLobby(); } else showHome(); }
    else if (a === 'profclick') {
      STG.lift = !STG.lift;
      var chip = document.querySelector('.p13-liftchip');
      if (chip) chip.textContent = 'CLICK TO ' + (STG.lift ? 'DROP' : 'LIFT');
    }
    else if (a === 'proppose') {
      STG.lift = false; STG.paused = false;
      var e1 = STG.ents[me.uid];
      if (e1) { try { e1.ent.anim.speed = 1; e1.ent.anim.play('run_HighScore_main', { loop: true, sudden: true }); } catch (x) { } }
      var chip2 = document.querySelector('.p13-liftchip'); if (chip2) chip2.textContent = 'CLICK TO LIFT';
    }
    else if (a === 'protpose') {
      me.pose = ((me.pose | 0) + 1) % POSES.length;
      try { localStorage.setItem('mp_pose', me.pose); } catch (x) { }
      toast('Pose: ' + POSES[me.pose][1], 1400);
      var pl2 = document.querySelector('.p13-posename'); if (pl2) pl2.textContent = POSES[me.pose][1].toUpperCase();
    }
    else if (a === 'prodoor') { hideModal(); custOpen = profBack === 'lobby'; custBack = profBack; custTab = 'outfit'; showCustom(); }
    else if (a === 'proplay') {
      var e3 = STG.ents[me.uid];
      if (e3) { STG.paused = !STG.paused; try { e3.ent.anim.speed = STG.paused ? 0 : 1; } catch (x) { } }
      var pb = document.querySelector('[data-act="proplay"]'); if (pb) pb.classList.toggle('act', !!STG.paused);
    }
    else if (a === 'promove') {
      STG.spin = !STG.spin;
      var mb = document.querySelector('[data-act="promove"]'); if (mb) mb.classList.toggle('act', !!STG.spin);
    }
    else if (a === 'copyid') { var ck = t.getAttribute('data-key') || ''; try { navigator.clipboard.writeText(ck); toast('Player ID copied', 1600); } catch (x) { } }
    else if (a === 'proskin') { var oi = parseInt(t.getAttribute('data-i'), 10) || 0; me.ot = oi; try { localStorage.setItem('mp_ot', String(oi)); } catch (x2) { } if (net) net.setPlayer({ ot: me.ot | 0 }); showProfile(profView && profView.key); }
    else if (a === 'biosave') { var bv = ($('#mp-bio') || { }).value || ''; MPSocial.setBio(bv).then(function () { toast('Bio saved', 1600); }).catch(function (er) { toast(er.message || er, 2400); }); }
    else if (a === 'remsave') { var rv = ($('#mp-remail') || { }).value || ''; if (W.MPAcc && MPAcc.setRecovery) MPAcc.setRecovery(rv).then(function () { toast('Recovery email saved', 1800); }).catch(function (er) { toast(er.message || er, 2600); }); }
    else if (a === 'profshare') { var lu = location.origin + location.pathname + '?mp=1&profile=' + encodeURIComponent((W.MPAcc.user() || { }).key || ''); try { navigator.clipboard.writeText(lu); toast('Profile link copied', 1800); } catch (x) { } }
  }
  function onChange(e) {
    // POKI18: custom music upload
    if (e.target && e.target.id === 'mp-musicfile' && e.target.files && e.target.files[0] && W.MP18) {
      var f0 = e.target.files[0];
      toast('Storing ' + (f0.name || 'track') + '\u2026', 2200);
      W.MP18.music.upload(f0).then(function () { toast('Custom track ready', 1800); if (phase === 'settings') showSettings(); })
        .catch(function (er) { toast(er.message || er, 2800); });
      return;
    }
    var k = e.target.getAttribute && e.target.getAttribute('data-opt'); if (!k) return;
    var v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'checkbox') { var sw17 = e.target.closest('.bo-sw'); if (sw17) sw17.classList.toggle('on', !!v); var tl17 = e.target.closest('.bo-tile'); if (tl17) tl17.classList.toggle('on', !!v); }
    if (phase === 'create') draft[k] = v;
    else if (phase === 'lobby' && isHost && room && net) { var o = Object.assign({}, room.opts || {}); o[k] = v; net.setRoom({ opts: cleanOpts(o) }); }
  }
  function onInput(e) {
    var t = e.target; if (!t || !t.id) return;
    if (t.id === 'mp-name') { me.name = t.value.slice(0, 14); var tp = document.getElementById('mq-tagp'); if (tp) tp.innerHTML = bn(myTag(me.name || 'Player')); }
    else if (t.id === 'mq-q') { brQ = t.value; renderList(); }
    else if (t.id === 'hq-q') { optFilter(t.value); }
    else if (t.id === 'fnk-bq') { boardQ = t.value.slice(0, 24); repaintLockerGrid(); var ni = $('#fnk-bq'); if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); } }
    else if (t.id === 'mp-iq') { invQ = t.value.slice(0, 24); paintInviteList(); var qi = $('#mp-iq'); if (qi) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); } }
    else if (t.id === 'mp-to') { me.to = parseInt(t.value, 10) || 10; saveCust(); var tp2 = $('#mq-tagplate'); if (tp2) tp2.innerHTML = bn(myTag()); }
    // POKI19: preview player scrubber - seek to any section of the track
    else if (t.id === 'mp18-prevseek') {
      mp18PrevDrag = Date.now();
      if (W.MP18 && W.MP18.music && W.MP18.music.previewSeekTo) W.MP18.music.previewSeekTo((parseInt(t.value, 10) || 0) / 1000);
      if (W.MP18 && W.MP18.music && W.MP18.music.previewState) { var pqs = W.MP18.music.previewState(); var tlq = document.getElementById('mp18-ptime'); if (tlq) tlq.textContent = mp18Time(pqs.pos || 0) + ' / ' + mp18Time(pqs.dur || 0); }
    }
  }

  // ---- countdown
  function showCountdown(r) {
    var part = (r.participants || []).map(function (u) { return '<span style="border:2px solid ' + colorOf(u) + '">' + esc((players[u] && players[u].name) || lastName[u] || '?') + '</span>'; }).join('');
    var o = r.opts || {};
    setOv('<div class="mq-screen" style="pointer-events:none"><div class="mp-cd"><div class="mp-cd-t">ROUND ' + (r.round || 1) + '</div><div class="mp-cd-t" style="font-size:16px;letter-spacing:3px">GET READY</div><div class="mp-cd-n" id="mp-cdn"></div><div class="mp-cd-p">' + part + '</div>' +
      '<div class="mp-cd-h">' + (o.noCoin ? 'NO COIN MODE &ndash; do not touch a coin! &nbsp;' : '') + (o.stopwatch ? '\u23F1 STOPWATCH ON' : '') + (o.boards === false ? '' : ' &nbsp; double-tap / space = hoverboard') + '</div></div></div>');
  }
  function coinHitName(list) { var c = list.filter(function (p) { return p.coinT; }).sort(function (a, b) { return a.coinT - b.coinT; })[0]; return c ? c.name : 'Someone'; }
  function ord(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  // POKI18: m:ss.d format for stopwatch + first-coin times
  function mmss(ms) {
    ms = Math.max(0, ms | 0);
    var s = Math.floor(ms / 1000), d = Math.floor((ms % 1000) / 100);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + (d ? '.' + d : '');
  }
  function coinTimeTxt(p) {
    if (!p || !p.coinT || !raceStart) return '';
    return mmss(Math.max(0, p.coinT - raceStart));
  }
  function rkBadge(pts) { var r = MPAcc.rankOf(pts); return '<span class="mp-rk">' + r.svg + '<span style="color:' + r.color + '">' + esc(r.name) + '</span></span>'; }

  // ---- podium leaderboard
  function lrow(pos, ch, nameHtml, sub2, valTxt, isMe, gem) {
    return '<div class="lrw' + (isMe ? ' me' : '') + '"><div class="no">' + pos + '</div><img src="' + preview(ch) + '" alt=""><div class="n">' + nameHtml + '<small>' + sub2 + '</small></div><div class="v">' + (gem ? gemSvg() : '') + valTxt + '</div></div>';
  }
  function podiumHtml(rows, valFn, meFn, gem) {
    var lc = ['#ffe08a', '#dfe8ff', '#ffd0a0'], on = ['1<sup>st</sup>', '2<sup>nd</sup>', '3<sup>rd</sup>'];
    return '<div class="pod">' + [1, 0, 2].map(function (i) {
      var p = rows[i]; if (!p) return '<div class="pc empty p' + (i + 1) + '"></div>';
      return '<div class="pc p' + (i + 1) + '">' + (i === 0 ? '<span class="crw"><svg viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z" fill="#ffd23f" stroke="rgba(0,0,0,.4)"/></svg></span>' : '') + '<div class="lw">' + laurel(lc[i]) + '<b>' + on[i] + '</b></div><div class="av"><img src="' + preview(p.ch) + '" alt=""></div>' +
        '<div class="pn">' + bn(p) + (meFn(p) ? ' \u2605' : '') + '</div><div class="ps">' + (gem ? gemSvg() : '') + valFn(p) + '</div></div>';
    }).join('') + '</div>';
  }
  function num(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
  function showResults(list, coinHit) {
    var winner = list[0], myRank = 0;
    list.forEach(function (p, i) { if (p.uid === me.uid) myRank = i + 1; });
    var isMe = function (p) { return p.uid === me.uid; };
    var title = coinHit ? '\uD83E\uDE99 ' + esc(coinHitName(list)) + ' grabbed a coin!' : (winner.uid === me.uid ? 'Congratulations!' : esc(winner.name) + ' wins!');
    var rows = list.slice(3).map(function (p, i) {
      var status = p.coinT ? '\uD83E\uDE99 coin' + (opts.stopwatch ? ' \u00B7 ' + coinTimeTxt(p) : '') : p.gone && !p.dead ? 'left' : p.dead ? '\u2620 crashed' : 'ended';
      var extraT = opts.stopwatch && raceStart && net ? ' \u00B7 \u23F1 ' + mmss(Math.max(0, net.now() - raceStart)) : '';
      return lrow(i + 4, p.ch, bn(p) + (isMe(p) ? ' \u2605' : ''), Math.round(p.d) + ' m \u00B7 ' + p.c + ' coins \u00B7 ' + status + extraT, num(p.sc), isMe(p), true);
    }).join('');
    setOv('<div class="mq-screen"><div class="mq-lb wide">' +
      '<div class="mq-win"><div class="crown"><svg viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z" fill="#ffd23f" stroke="rgba(0,0,0,.4)"/></svg></div><div class="av"><img src="' + preview(winner.ch) + '" alt=""></div><h3 style="margin-top:12px">' + title + '</h3><div class="nm">' + bn(winner) + '</div><div class="lw">' + laurel('#ffe08a') + '<b>1<sup>st</sup></b></div><div class="sc">' + gemSvg() + num(winner.sc) + '</div>' +
      '<div class="mq-note" style="margin-top:10px">' + (myRank ? 'You finished #' + myRank + ' of ' + list.length : '') + '</div><div class="mq-rp" id="mp-rp"></div></div>' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column"><div class="hd"><div class="ring"></div><h2>Leaderboard</h2><div class="menu"><i></i><i></i><i></i></div></div>' +
      podiumHtml(list, function (p) { return num(p.sc); }, isMe, true) + (rows ? '<div class="mq-lbscroll mq-scroll" style="max-height:30vh">' + rows + '</div>' : '') +
      '<div class="btns"><button class="mq-btn green" data-act="back">Back to lobby</button><button class="mq-btn blue" data-act="lb">\uD83C\uDFC6 Boards</button><button class="mq-btn" data-act="leave">Leave</button></div></div></div></div>', 'dim');
  }
  function recordResult(list) {
    var e = document.getElementById('mp-rp'); if (!e) return;
    if (!W.MPAcc || !MPAcc.user()) {
      if (list.length > 1) e.innerHTML = '<small style="font-family:proxima,Verdana,sans-serif;font-size:11.5px;color:#9aa5bd">Log in from the home screen to earn Rank Points and XP</small>';
      return;
    }
    var idx = -1, mp = null; list.forEach(function (p, i) { if (p.uid === me.uid) { idx = i; mp = p; } }); if (!mp) return;
    var rec = { key: code + '|' + round + '|' + seed, players: list.length, won: idx === 0, place: idx + 1, score: mp.sc, dist: Math.round(mp.d), coins: mp.c, ch: me.char, mode: (opts && opts.noCoin) ? 'nocoin' : 'coin', ranked: !!(room && room.ranked) };
    MPAcc.record(rec).then(function (r) {
      if (!e || !r) return;
      var lv = r.level || MPAcc.levelOf(0);
      e.innerHTML =
        '<div class="xpline"><div class="lab"><span>+' + (r.xp | 0) + ' XP</span><span>LEVEL ' + lv.lvl + ' &middot; ' + num(lv.cur) + ' / ' + num(lv.need) + '</span></div>' +
        '<div class="p14-minibar"><i style="width:' + lv.pct + '%"></i></div></div>' +
        (r.gained ? '<b style="color:' + (r.ranked && r.rpDelta < 0 ? '#ff9ba3' : '#7ce0ac') + ';font-family:proxima,Verdana,sans-serif;font-size:14px">' + (r.ranked && r.rpDelta < 0 ? '' : '+') + r.gained + (r.ranked ? ' RANKED RP' : ' RP') + '</b>' : '') +
        rkBadge(r.total) +
        (r.levelUp ? '<div class="lvup">LEVEL UP! ' + r.levelUp.from + ' &rarr; ' + r.levelUp.to + '</div>' : '') +
        (r.rankedUp ? '<div class="lvup" style="color:#7ce0ac">RANK UP!</div>' : '');
      try { if (net) net.setPlayer({ lv: myLevel() }); } catch (x) { }
      try { saveCust(); } catch (x) { }
    });
  }

  // ============================================== POKI18: RANKED MODE ====
  var rkUI = { searching: false, mode: 'coin', opp: null };
  var rkEnter = null;   // set while creating a ranked lobby (consumed in onRoom)
  var persistReopen = null;   // set while reopening a 24h lobby offline (consumed in onRoom)
  function rkProfileCard(opp, cls) {
    var pr = opp && opp.pr || null, u = opp || {};
    var pts = pr ? (pr.pts | 0) : (u.rk | 0);
    var lv = pr ? W.MPAcc.levelOf(pr.xp | 0).lvl : (u.lv | 0);
    var rk = W.MPAcc ? MPAcc.rankOf(pts) : null;
    var wins = pr ? (pr.w | 0) : 0, races = pr ? (pr.r | 0) : 0;
    return '<div class="rk-card ' + (cls || '') + '"><img src="' + preview((opp && opp.ch) || me.char) + '">' +
      '<div class="rk-nm">' + esc(opp ? (opp.n || u.name || '?') : (me.name || 'You')) + '</div>' +
      (rk ? '<small style="color:' + rk.color + ';display:inline-flex;align-items:center;gap:5px">' + rk.sigil + ' ' + esc(rk.name) + '</small>' : '') +
      '<div class="rk-elo"><div><b>' + num(pts) + '</b><small>RANKED RP</small></div><div><b>' + lv + '</b><small>LEVEL</small></div><div><b>' + races + '</b><small>RACES</small></div></div>' +
      '<small>' + num(wins) + ' wins \u00B7 ' + num(races) + ' races</small></div>';
  }
  function showRanked(err) {
    phase = 'ranked'; stopList(); closeGlobalChat(); hideModal(); stopTimers();
    var u = W.MPAcc && W.MPAcc.user();
    if (!u) { authMode = 'login'; showAuth('Log in to play ranked matches'); return; }
    if (W.MP18) { try { W.MP18.ranked.mode = rkUI.mode; } catch (e) { } }
    var prof = (W.MPAcc && MPAcc.profile && MPAcc.profile()) || { };
    var searching = rkUI.searching;
    var meCard = rkProfileCard(null, '');
    var oppCard = searching
      ? '<div class="rk-card rk-searching"><div class="radar"><b></b><i></i><i></i><i></i></div><div class="rk-nm" style="color:var(--sub)">SEARCHING\u2026</div><div class="rk-wait">Looking for another ranked racer in ' + (rkUI.mode === 'nocoin' ? 'No Coin Mode' : 'Coin Mode') + '.<br>You will both be dropped into the same lobby automatically.</div></div>'
      : '<div class="rk-card"><div class="radar" style="opacity:.35"><b style="animation-play-state:paused"></b><i></i><i></i><i></i></div><div class="rk-nm" style="color:var(--dim)">WAITING</div><div class="rk-wait">Pick your mode and press FIND MATCH.<br>You can also invite a friend to a ranked duel.</div></div>';
    var vsCenter = '<div class="rk-vs">' +
      '<div class="vs-ring"><span class="vs-word">VS</span></div>' +
      '<div class="vs-status">' + (searching ? 'Finding Ranked Match <span class="vs-dots"><i></i><i></i><i></i></span>' : 'Ranked \u00B7 ' + (rkUI.mode === 'nocoin' ? 'NO COIN' : 'COIN') + ' MODE') + '</div>' +
      '<div class="vs-sub">best of one \u00B7 same seeded track \u00B7 RP at stake</div>' +
      '<div class="rk-modes"><button class="mq-tab' + (rkUI.mode === 'coin' ? ' on' : '') + '" data-act="rmode" data-m="coin">COIN MODE</button><button class="mq-tab' + (rkUI.mode === 'nocoin' ? ' on' : '') + '" data-act="rmode" data-m="nocoin">NO COIN MODE</button></div>' +
      (searching
        ? '<div class="f14-gorow" style="width:min(320px,90%)"><button class="mq-btn danger" data-act="rcancel" style="flex:1">CANCEL SEARCH</button></div>'
        : '<div class="f14-gorow" style="width:min(320px,90%)"><button class="mq-btn pri" data-act="rfind" style="flex:1.4">FIND MATCH</button><button class="mq-btn" data-act="rinvite" title="Invite a friend to a ranked duel">INVITE</button></div>') +
      '</div>';
    setOv('<div class="mq-screen"><div class="mq-panel rk18">' +
      '<div class="mq-head"><button class="mq-x" data-act="home">&larr;</button><h2>Ranked</h2><span class="mq-live"><i></i>' + (searching ? 'SEARCHING' : 'READY') + '</span>' +
      '<span class="mq-chip" style="margin-left:8px"><svg viewBox="0 0 24 24" style="width:12px;height:12px"><path d="M12 2.6l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.9-5.4 2.9 1-6L3.3 9l6-.9z" fill="#ffd23f"/></svg> ' + num(prof.pts | 0) + ' RP</span></div>' +
      '<div class="rk18-grid">' + meCard + vsCenter + oppCard + '</div>' +
      '<div class="mq-err" style="text-align:center">' + esc(err || '') + '</div>' +
      '</div></div>');
  }
  function rkSetSearching(on) { rkUI.searching = !!on; if (phase === 'ranked') showRanked(); }
  function rkFind() {
    if (!W.MP18 || !(W.MPAcc && MPAcc.user())) { showRanked('Log in to play ranked'); return; }
    if (rkUI.searching) return;
    W.MP18.ranked.mode = rkUI.mode;
    rkSetSearching(true);
    W.MP18.ranked.start(function (pair) {
      if (pair && pair.code) rkEnterMatch(pair);
      else rkSetSearching(false);
    }).catch(function (e) { rkUI.searching = false; showRanked(e.message || String(e)); });
  }
  function stopRanked() { if (W.MP18) { try { W.MP18.ranked.stop(); } catch (e) { } } rkUI.searching = false; }
  function rkInvite() {
    if (!W.MP18) return;
    showInviteRanked();
  }
  function showInviteRanked() {
    if (!W.MPSocial) { toast('Social layer unavailable', 2000); return; }
    showModal('<div class="m13"><div class="m13-h"><h3>INVITE TO RANKED</h3><button class="m13-x" data-act="optsclose">\u2715</button></div>' +
      '<div class="mq-note">Your opponent gets a ranked duel invite (' + (rkUI.mode === 'nocoin' ? 'No Coin' : 'Coin') + ' mode). Accepting drops you both into a ranked lobby.</div>' +
      '<input type="text" id="mp-iq" placeholder="Search players\u2026" autocomplete="off">' +
      '<div class="m13-list mq-scroll" id="mp-ilist"><div class="m13-empty">Loading players\u2026</div></div></div>');
    MPSocial.allPlayers(function (rows) { invRows = rows || []; paintRankedInviteList(); });
  }
  function paintRankedInviteList() {
    var el = document.getElementById('mp-ilist'); if (!el) return;
    var q = (invQ || '').trim().toLowerCase();
    var arr = invRows.filter(function (r) { return !q || (r.n || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 40);
    if (!arr.length) { el.innerHTML = '<div class="m13-empty">No players found yet.</div>'; return; }
    el.innerHTML = arr.map(function (r) {
      return '<div class="m13-row"><img src="' + preview(r.ch) + '" alt="">' +
        '<div class="i"><b>' + esc(r.n) + '</b><small>' + (r.online ? 'online' : 'offline') + ' \u00B7 ' + num(r.pts) + ' RP</small></div>' +
        '<button class="mq-btn sm pri" data-act="rinvsend" data-key="' + esc(r.key) + '" data-n="' + esc(r.n) + '">DUEL</button></div>';
    }).join('');
  }
  function rkEnterMatch(pair) {
    // pair: {code, mine, opp}. Host creates the lobby with ranked opts; the
    // other player joins it a moment later.
    rkUI.searching = false;
    var mode = rkUI.mode;
    var oppName = (pair.opp && (pair.opp.n || pair.opp.name)) || 'opponent';
    try { W.MP18.ranked.confirmPair && W.MP18.ranked.confirmPair(); } catch (e) { }
    toast('Ranked match found vs ' + oppName + '!', 3200);
    if (pair.mine) {
      MP.ui.createRankedLobby(pair.code, mode, pair.opp);
    } else {
      setTimeout(function () { MP.ui.joinLobby(pair.code, ''); }, 500);
    }
  }

  // ---- accounts + leaderboard screens
  var lbCat = 'pts', lbBack = 'home';
  var lbCat18 = 'unranked', lbMode = 'coin', lbField = 'bs';   // POKI18 categories
  // POKI18: premium auth with forgot-password flow (recovery-email verified,
  // handled by the existing authentication backend in mp-accounts.js)
  function showAuth(err, ok) {
    phase = 'auth'; stopList(); closeGlobalChat();
    var signup = authMode === 'signup', forgot = authMode === 'forgot', reset = authMode === 'reset';
    var head2 = signup ? 'Create account' : forgot ? 'Reset password' : reset ? 'New password' : 'Welcome back';
    var sub = signup ? 'Pick a name, grab a board and race the world.'
      : forgot ? 'Enter your username and the recovery email you registered. We verify it against the account database.'
      : reset ? 'Verified! Choose a new password for ' + esc(rstName || 'your account') + '.'
      : 'Log in to race, rank up and keep your stats.';
    var seg = (!forgot && !reset)
      ? '<div class="mq-seg"><button type="button" class="' + (!signup ? 'on' : '') + '" data-act="authmode" data-m="login">Log in</button><button type="button" class="' + (signup ? 'on' : '') + '" data-act="authmode" data-m="signup">Sign up</button></div>' : '';
    var emField = (signup || forgot)
      ? '<label class="mq-lab">' + (signup ? 'Recovery email (optional)' : 'Recovery email') + '</label><input type="email" id="mp-aem" maxlength="80" autocomplete="email" placeholder="you@example.com' + (signup ? ' - used to reset your password' : '') + '">' : '';
    var pwField = (!forgot)
      ? '<label class="mq-lab">' + (reset ? 'New password' : 'Password') + '</label><div class="mq-pw"><input type="password" id="mp-ap" autocomplete="' + (signup || reset ? 'new-password' : 'current-password') + '" placeholder="min 4 characters"><button type="button" class="mq-x" data-act="pwt" title="Show / hide"><svg viewBox="0 0 24 24" style="width:15px;height:15px;display:block"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button></div>' : '';
    var forgotLink = (!signup && !forgot && !reset)
      ? '<div class="a17-hintline"><button type="button" class="a17-forgot" data-act="forgot">Forgot password?</button></div>' : '';
    var cta = signup ? 'CREATE ACCOUNT' : forgot ? 'VERIFY EMAIL' : reset ? 'SAVE NEW PASSWORD' : 'LOG IN';
    var submitKind = signup ? 'signup' : forgot ? 'forgot' : reset ? 'reset' : 'login';
    setOv('<div class="mq-screen"><div class="mq-auth a17">' +
      '<div class="art"><div class="a17-badge">SUBWAY RACERS &middot; MP</div><img class="c" src="' + preview(me.char) + '" alt="">' +
      '<ul><li><b>Rank up.</b> Earn Rank Points for every lobby win</li><li><b>Climb.</b> Weekly &amp; all-time leaderboards</li><li><b>Flex.</b> Your rank shows on your nametag</li></ul>' +
      '<div class="a17-note">' + netNote() + '</div></div>' +
      '<form data-auth="1" data-kind="' + submitKind + '" autocomplete="on"><div class="a17-head"><h2>' + head2 + '</h2><p>' + sub + '</p></div>' +
      seg +
      '<label class="mq-lab">Username</label><input type="text" id="mp-au" maxlength="14" autocomplete="username" placeholder="3-14 letters, numbers or _"' + (reset ? ' value="' + esc(rstName || '') + '" readonly' : '') + '>' +
      emField + pwField + forgotLink +
      '<button type="submit" class="mq-btn pri ctr a17-cta">' + cta + '</button><button type="button" class="a17-back" data-act="home">&larr; Back to the game</button>' +
      (ok ? '<div class="a17-ok">' + esc(ok) + '</div>' : '') +
      '<div class="mq-err" id="mp-err" style="margin-top:6px">' + esc(err || '') + '</div></form></div></div>');
    var au = $('#mp-au'); if (au && !reset) au.focus();
  }
  function doAuth(kind) {
    var u = ($('#mp-au') || {}).value, pw = ($('#mp-ap') || {}).value, er = $('#mp-err'); if (er) er.textContent = 'Please wait\u2026';
    // POKI18: extra auth flows
    if (kind === 'signup') {
      var em = ($('#mp-aem') || {}).value || '';
      MPAcc.signup(u, pw, em).then(function (usr) { try { localStorage.setItem('mp_name', usr.name); } catch (e) { } me.name = usr.name; if (W.MP18) W.MP18.admin.ensureGrant(); showHome(); }).catch(function (e) { showAuth(e.message || String(e)); });
      return;
    }
    if (kind === 'forgot') {
      MPAcc.checkRecovery(u, ($('#mp-aem') || {}).value).then(function () { authMode = 'reset'; rstName = u; rstEmail = ($('#mp-aem') || {}).value; showAuth('Verified! Pick a new password.'); })
        .catch(function (e) { showAuth(e.message || String(e)); });
      return;
    }
    if (kind === 'reset') {
      MPAcc.resetPassword(rstName, rstEmail, pw).then(function () { authMode = 'login'; showAuth('Password updated - log in with your new password.'); })
        .catch(function (e) { authMode = 'reset'; showAuth(e.message || String(e)); });
      return;
    }
    MPAcc[kind](u, pw).then(function (usr) { try { localStorage.setItem('mp_name', usr.name); } catch (e) { } me.name = usr.name; if (W.MP18) { W.MP18.admin.ensureGrant(); W.MP18.admin.refresh(); } showHome(); }).catch(function (e) { showAuth(e.message || String(e)); });
  }
  var rstName = '', rstEmail = '';
  // POKI18: leaderboard reorganised into Unranked / Ranked categories with
  // Coin Mode and No Coin Mode sub-boards, live stat cards and smooth switching.
  function lb18StatCards(myPr, ranked) {
    if (!myPr) return '';
    var mk2 = (ranked ? 'r' : '') + (lbMode === 'nocoin' ? 'nocoin' : 'coin');
    var b = (myPr.md || {})[mk2] || { r: 0, w: 0, bs: 0, bd: 0, cc: 0 };
    var rw = ranked ? (myPr.rw | 0) : null, rl = ranked ? (myPr.rl | 0) : null;
    return '<div class="lb18-stats">' +
      '<div class="lb18-stat"><small>Races</small><b>' + num(b.r | 0) + '</b></div>' +
      '<div class="lb18-stat"><small>Wins</small><b>' + num(b.w | 0) + '</b></div>' +
      '<div class="lb18-stat"><small>High score</small><b>' + num(b.bs | 0) + '</b></div>' +
      '<div class="lb18-stat"><small>Best distance</small><b>' + num(b.bd | 0) + ' m</b></div>' +
      '<div class="lb18-stat"><small>Coins</small><b>' + num(b.cc | 0) + '</b></div>' +
      (ranked ? '<div class="lb18-stat"><small>Ranked W / L</small><b>' + num(rw | 0) + ' / ' + num(rl | 0) + '</b></div>' : '') +
      '</div>';
  }
  function showLeaderboard() {
    var prev = phase; if (phase !== 'leaderboard') lbBack = prev === 'results' ? 'results' : 'home';
    phase = 'leaderboard'; stopList();
    if (!W.MPAcc) { showHome(); return; }
    var u = W.MPAcc && MPAcc.user();
    var prof = (W.MPAcc && MPAcc.profile && MPAcc.profile()) || { };
    var cats = [['unranked', 'UNRANKED', 'Friendly races'], ['ranked', 'RANKED', 'RP on the line'], ['classic', 'CLASSIC', 'All-time boards']];
    var catHtml = cats.map(function (c) { return '<button class="lb18-cat' + (lbCat18 === c[0] ? ' on' : '') + '" data-act="lbcat18" data-cat="' + c[0] + '"><b>' + c[1] + '</b><small>' + c[2] + '</small></button>'; }).join('');
    var modeTabs = lbCat18 !== 'classic'
      ? '<div class="lb18-modes"><button class="mq-tab' + (lbMode === 'coin' ? ' on' : '') + '" data-act="lbmode" data-m="coin">COIN MODE</button><button class="mq-tab' + (lbMode === 'nocoin' ? ' on' : '') + '" data-act="lbmode" data-m="nocoin">NO COIN MODE</button></div>' : '';
    var fieldTabs = lbCat18 !== 'classic'      ? '<div class="mq-lbtabs">' + [['bs', 'High Score'], ['bd', 'Best Distance'], ['w', 'Most Wins'], ['cc', 'Coins'], ['r', 'Races']].map(function (f) { return '<button class="' + (lbField === f[0] ? 'on' : '') + '" data-act="lbfield" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>' : '';
    var classicTabs = lbCat18 === 'classic'      ? '<div class="mq-lbtabs">' + MPAcc.BOARDS.map(function (b) { return '<button class="' + (b.id === lbCat ? 'on' : '') + '" data-act="lbtab" data-cat="' + b.id + '">' + esc(b.name) + '</button>'; }).join('') + '</div>' : '';
    setOv('<div class="mq-screen"><div class="mq-lb"><div class="hd"><div class="ring"></div><h2>Leaderboard</h2><div class="menu"><i></i><i></i><i></i></div></div>' +
      '<div class="lb18-cats">' + catHtml + '</div>' + modeTabs + fieldTabs + classicTabs +
      '<div id="mp-lb" class="lb18-body" style="display:flex;flex-direction:column;min-height:0;flex:1"><div class="mq-empty">Loading\u2026</div></div>' +
      '<div class="btns"><button class="mq-btn" data-act="lbback">\u2190 Back</button></div></div></div>', lbBack === 'results' ? 'dim' : '');
    var el0 = $('#mp-lb'), mk = (MPAcc.user() || {}).key;
    if (lbCat18 === 'classic') {
      var cat = lbCat;
      MPAcc.board(cat, 50).then(function (res) {
        var el = $('#mp-lb'); if (!el || cat !== lbCat || lbCat18 !== 'classic') return;
        if (!res.rows.length) { el.innerHTML = '<div class="mq-empty">No one on this board yet \u2013 win a lobby race to get on it!</div>'; return; }
        var un = res.def.unit, gem = !un, val = function (r) { return num(r.value) + (un ? ' ' + un : ''); }, isMe = function (r) { return r.key === mk; };
        var prow = res.rows.map(function (r) { return Object.assign({}, r, { name: r.name, ch: r.ch }); });
        var rows = res.rows.slice(3).map(function (r) { return lrow(r.pos, r.ch, esc(r.name), MPAcc.rankOf(r.pts).name + ' \u00B7 ' + r.wins + ' wins \u00B7 ' + r.races + ' races', val(r), isMe(r), gem); }).join('');
        el.innerHTML = lb18StatCards(prof, false) + podiumHtml(prow, val, isMe, gem) + '<div class="mq-lbscroll mq-scroll">' + rows + '</div>';
      }).catch(function (e) { var el = $('#mp-lb'); if (el) el.innerHTML = '<div class="mq-empty">Could not load: ' + esc(e.message || e) + '</div>'; });
      return;
    }
    var ranked = lbCat18 === 'ranked';
    MPAcc.board18(lbField, lbMode, ranked, 50).then(function (res) {
      var el = $('#mp-lb'); if (!el || lbCat18 === 'classic') return;
      var meta = MPAcc.MODE_META[lbMode] || { name: lbMode };
      var sub = res.rows.map(function (r) { var b = r.b || {}; return MPAcc.rankOf(r.pts).name + ' \u00B7 ' + (ranked ? (r.rw | 0) + 'W/' + (r.rl | 0) + 'L \u00B7 ' : '') + (b.r | 0) + ' races'; });
      if (!res.rows.length) { el.innerHTML = lb18StatCards(prof, ranked) + '<div class="mq-empty">No ' + esc(meta.name.toLowerCase() + (ranked ? ' ranked' : '') + ' results yet') + '.<br><small>Finish a ' + esc(meta.name.toLowerCase()) + ' race to appear here.</small></div>'; return; }
      var un = res.def.unit, gem = false, val = function (r) { return num(r.value) + (un ? ' ' + un : ''); }, isMe = function (r) { return r.key === mk; };
      var prow = res.rows.map(function (r) { return Object.assign({}, r, { name: r.name, ch: r.ch }); });
      var rows = res.rows.slice(3).map(function (r, i) { return lrow(r.pos, r.ch, esc(r.name), sub[i], val(r), isMe(r), gem); }).join('');
      el.innerHTML = lb18StatCards(prof, ranked) + podiumHtml(prow, val, isMe, gem) + '<div class="mq-lbscroll mq-scroll">' + rows + '</div>';
    }).catch(function (e) { var el = $('#mp-lb'); if (el) el.innerHTML = '<div class="mq-empty">Could not load: ' + esc(e.message || e) + '</div>'; });
  }

  // ---- race top bar
  function hdrHtml() {
    var parts = ['<span>ROUND ' + round + '</span>'], gt = opts.goalType && opts.goalType !== 'none' ? opts.goalType : '';
    if (gt) parts.push('<span class="g">\uD83C\uDFAF first to ' + num(opts.goalValue) + (gt === 'dist' ? ' m' : gt === 'coins' ? ' coins' : ' pts') + '</span>');
    if (opts.timeLimit > 0 && raceStart && net) { var left = Math.max(0, Math.ceil(opts.timeLimit - (net.now() - raceStart) / 1000)); parts.push('<span>\u23F1 ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2) + '</span>'); }
    // POKI18 stopwatch: elapsed race timer (server clock - identical for every client)
    if (opts.stopwatch && raceStart && net) { var el18 = Math.max(0, net.now() - raceStart); parts.push('<span class="hdr-sw">\u23F1 ' + mmss(el18) + '</span>'); }
    if (opts.noCoin) parts.push('<span class="g">\uD83E\uDE99 NO COIN</span>');
    parts.push('<span>Track #' + String(hash(seed) % 10000).padStart(4, '0') + '</span>');
    return parts.join('');
  }
  function barsHud(pb, list, gt) {
    var val = function (p) { return gt === 'coins' ? p.c : p.sc; }, mx = Math.max.apply(null, list.map(val).concat([1])), goal = opts.goalValue || 0;
    var denom = Math.max(gt === 'coins' ? 10 : 1000, mx * 1.2), BH = 50, area;
    if (pb.getAttribute('data-kind') !== 'bars') { pb.setAttribute('data-kind', 'bars'); pb.innerHTML = '<div class="hdr"></div><div class="mqb"><div class="area"></div></div>'; }
    area = pb.querySelector('.area'); pb.querySelector('.hdr').innerHTML = hdrHtml();
    var keep = {};
    list.forEach(function (p, i) {
      keep[p.uid] = 1;
      var col = null; for (var k = 0; k < area.children.length; k++) if (area.children[k].getAttribute('data-uid') === p.uid) col = area.children[k];
      if (!col) { col = document.createElement('div'); col.setAttribute('data-uid', p.uid); col.innerHTML = '<span class="cr"></span><div class="val"></div><div class="bar"></div><img alt="">'; area.appendChild(col); }
      col.className = 'col' + (p.uid === me.uid ? ' me' : '') + (p.dead || p.gone ? ' out' : ''); col.style.order = i;
      col.querySelector('.cr').textContent = i === 0 && val(p) > 0 ? '\uD83D\uDC51' : '';
      col.querySelector('.val').textContent = num(val(p));
      var b = col.querySelector('.bar'); b.style.height = Math.max(4, Math.round(BH * val(p) / denom)) + 'px'; b.style.background = colorOf(p.uid);
      var im = col.querySelector('img'); im.src = preview(p.ch); im.style.borderColor = colorOf(p.uid); im.title = p.name;
    });
    for (var j = area.children.length - 1; j >= 0; j--) { var c = area.children[j]; if (c.className === 'goal') continue; if (!keep[c.getAttribute('data-uid')]) area.removeChild(c); }
    var gl = area.querySelector('.goal'); if (gl) area.removeChild(gl);
    if (goal > 0 && goal <= denom) { gl = document.createElement('div'); gl.className = 'goal'; gl.style.bottom = (31 + Math.round(BH * goal / denom)) + 'px'; gl.innerHTML = '<em>' + num(goal) + '</em>'; area.appendChild(gl); }
  }
  function stripHud(pb, list, gt) {
    var val = function (p) { return p.d; }, lead = Math.max.apply(null, list.map(val).concat([1]));
    var denom = gt === 'dist' ? Math.max(1, opts.goalValue || 10000) : Math.max(300, Math.ceil(lead / 100) * 100 * 1.15);
    if (pb.getAttribute('data-kind') !== 'strip') { pb.setAttribute('data-kind', 'strip'); pb.innerHTML = '<div class="hdr"></div><div class="mqt"><div class="rail"></div></div>'; }
    pb.querySelector('.hdr').innerHTML = hdrHtml();
    var tr = pb.querySelector('.mqt'), old = tr.querySelectorAll('.tk'); for (var q = 0; q < old.length; q++) tr.removeChild(old[q]);
    [0.25, 0.5, 0.75].forEach(function (f) { var v = Math.round(denom * f), tk = document.createElement('div'); tk.className = 'tk'; tk.style.left = 'calc(20px + (100% - 40px) * ' + f + ')'; tk.textContent = (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'K' : v) + 'm'; tr.appendChild(tk); });
    var keep = {};
    list.forEach(function (p, i) {
      keep[p.uid] = 1;
      var pin = null; for (var k = 0; k < tr.children.length; k++) if (tr.children[k].getAttribute('data-uid') === p.uid) pin = tr.children[k];
      if (!pin) { pin = document.createElement('div'); pin.setAttribute('data-uid', p.uid); pin.innerHTML = '<img alt=""><b></b>'; tr.appendChild(pin); }
      pin.className = 'pin' + (p.uid === me.uid ? ' me' : '') + (p.dead || p.gone ? ' out' : '');
      var f = Math.max(0, Math.min(1, val(p) / denom)); pin.style.left = 'calc(20px + (100% - 40px) * ' + f.toFixed(4) + ')'; pin.style.zIndex = p.uid === me.uid ? 60 : 50 - i;
      var im = pin.querySelector('img'); im.src = preview(p.ch); im.style.borderColor = colorOf(p.uid); im.title = p.name + ' \u2013 ' + Math.round(p.d) + ' m'; pin.querySelector('b').textContent = i + 1;
    });
    for (var j = tr.children.length - 1; j >= 0; j--) { var c = tr.children[j]; if (c.className === 'rail' || c.className === 'tk') continue; if (!keep[c.getAttribute('data-uid')]) tr.removeChild(c); }
  }
  function updateHud() {
    var ho0 = document.getElementById('mp-hudopen'); if (ho0) ho0.style.display = (running && hudHide) ? 'block' : 'none';
    var pb = document.getElementById('mp-posbar'), tr = document.getElementById('mp-track');
    if (!running) { board.style.display = 'none'; if (tr) tr.style.display = 'none'; if (pb) { pb.style.display = 'none'; pb.removeAttribute('data-kind'); pb.innerHTML = ''; } return; }
    var list = standings(), hm = opts.hudMode || 'board', gt = opts.goalType && opts.goalType !== 'none' ? opts.goalType : '';
    board.style.display = (hudHide || hm === 'bar') ? 'none' : 'block';
    var bh = list.map(function (p, i) { return '<div><i style="background:' + colorOf(p.uid) + '"></i>' + (i + 1) + '. ' + esc(p.name) + (p.uid === me.uid ? '*' : '') + ' \u2013 ' + p.sc + (opts.stopwatch && opts.noCoin && p.coinT ? ' <span class="sw-time">' + coinTimeTxt(p) + '</span>' : '') + (p.dead ? ' \u2620' : p.gone ? ' \u2716' : '') + '</div>'; }).join('');
    if (board._p21sig !== bh) { board._p21sig = bh; board.innerHTML = bh; }   // POKI21: skip identical rebuilds
    if (tr) tr.style.display = 'none';
    pb.style.display = hudHide ? 'none' : 'flex'; pb.classList.toggle('cmp', hudMin);
    if (hm === 'board') { var hh = '<div class="hdr">' + hdrHtml() + '</div>'; if (pb._p21sig !== hh) { pb._p21sig = hh; pb.setAttribute('data-kind', 'hdr'); pb.innerHTML = hh; } }
    else if (gt === 'coins' || gt === 'score') barsHud(pb, list, gt);
    else stripHud(pb, list, gt);
    if (!hudHide && !pb.querySelector('.hc')) pb.insertAdjacentHTML('beforeend', '<div class="hc"><button data-act="hudmin" title="Compact">' + (hudMin ? '\u25A2' : '\u2013') + '</button><button data-act="hudclose" title="Hide">\u2715</button></div>');
    if (phase === 'spectate') updateSpecBar();
    updateSpecBoard();
  }

  // ==================================== POKI18: spectator live leaderboard ===
  var specBoardOn = false;
  function updateSpecBoard() {
    var el = document.getElementById('mp-specboard'); if (!el) return;
    var rowsEl = document.getElementById('mp-sbrows');
    var want = specBoardOn && (phase === 'spectate' || phase === 'specwatch');
    el.style.display = want ? 'flex' : 'none';
    if (!want) return;
    if (!rowsEl) return;
    var list = standings();
    var gt = opts.goalType && opts.goalType !== 'none' ? opts.goalType : '';
    // POKI21 anti-flicker: rows are pooled per player and updated in place, so
    // live value changes never re-create the avatar images (no flashing).
    var keep = {};
    list.forEach(function (p, i) {
      keep[p.uid] = 1;
      var row = null;
      for (var k = 0; k < rowsEl.children.length; k++) if (rowsEl.children[k].getAttribute('data-uid') === p.uid) { row = rowsEl.children[k]; break; }
      if (!row) {
        row = document.createElement('div'); row.setAttribute('data-uid', p.uid);
        row.innerHTML = '<span class="no"></span><img alt=""><b></b><span class="t" style="display:none"></span><span class="v"></span>';
        rowsEl.appendChild(row);
      }
      row.className = 'spbr-row' + (p.uid === me.uid ? ' me' : '') + (p.dead || p.gone ? ' out' : '');
      row.querySelector('.no').textContent = i + 1;
      var im = row.querySelector('img'); im.src = preview(p.ch); im.style.borderColor = colorOf(p.uid);
      row.querySelector('b').textContent = p.name + (p.uid === me.uid ? ' (you)' : '');
      var ct = row.querySelector('.t');
      if (opts.noCoin && opts.stopwatch && p.coinT) { ct.style.display = ''; ct.textContent = coinTimeTxt(p); } else ct.style.display = 'none';
      var v = gt === 'coins' ? p.c : gt === 'dist' ? Math.round(p.d) : p.sc;
      row.querySelector('.v').textContent = num(v) + (gt === 'coins' ? '' : gt === 'dist' ? ' m' : '');
      rowsEl.appendChild(row);   // re-append keeps the standings order without re-creating nodes
    });
    for (var j = rowsEl.children.length - 1; j >= 0; j--) { var c = rowsEl.children[j]; if (!keep[c.getAttribute('data-uid')]) rowsEl.removeChild(c); }
  }
  // =============================== POKI18: late-join spectator (active lobby) ===
  // Joining while a race is running: watch the live standings as a spectator and
  // automatically become a normal player when the next round begins.
  var specWatchShell = '';
  function showSpecWatch() {
    phase = 'specwatch';
    var open = room && room.status === 'lobby';
    // POKI21 anti-flicker: the modal shell is written only when missing or when
    // the lobby-open state changes; the live rows update in place every packet.
    var shell = '<div class="mq-screen"><div class="mq-panel" style="width:min(640px,100%);max-height:100%;display:flex;flex-direction:column">' +
      '<div class="mq-head"><h2>Spectating</h2><span class="mq-live"><i></i>RACE LIVE</span><button class="mq-x" data-act="leave" title="Leave" style="margin-left:auto">\u2715</button></div>' +
      '<div class="mq-note" style="margin:0 2px 10px">A race is already running in this lobby. You join as a spectator and start racing with everyone in the next round.</div>' +
      '<div class="mq-scroll" id="mp-swrows" style="display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;min-height:0"></div>' +
      '<div class="btns"><button class="mq-btn pri" data-act="sbopen">LIVE STANDINGS</button>' + (open ? '<button class="mq-btn green" data-act="back">LOBBY OPEN \u2192</button>' : '') + '<button class="mq-btn danger" data-act="leave">LEAVE</button></div>' +
      '</div></div>';
    if (specWatchShell !== shell || !document.getElementById('mp-swrows')) { specWatchShell = shell; setOv(shell, 'dim'); }
    updateSpecWatchRows();
    updateSpecBoard();
  }
  function updateSpecWatchRows() {
    var rowsEl = document.getElementById('mp-swrows'); if (!rowsEl) return;
    var list = standings().filter(function (p) { return p.uid !== me.uid; });
    if (!list.length) {
      var empty = '<div class="mq-empty">No runners yet \u2013 waiting for live data\u2026</div>';
      if (rowsEl.innerHTML !== empty) rowsEl.innerHTML = empty;
      return;
    }
    // POKI21 anti-flicker: pooled rows (same technique as the HUD progress strip)
    var keep = {};
    list.forEach(function (p, i) {
      keep[p.uid] = 1;
      var row = null;
      for (var k = 0; k < rowsEl.children.length; k++) if (rowsEl.children[k].getAttribute && rowsEl.children[k].getAttribute('data-uid') === p.uid) { row = rowsEl.children[k]; break; }
      if (!row) {
        row = document.createElement('div'); row.setAttribute('data-uid', p.uid); row.className = 'lrw';
        row.innerHTML = '<div class="no"></div><img alt=""><div class="n"></div><div class="v"></div>';
      }
      row.querySelector('.no').textContent = i + 1;
      row.querySelector('img').src = preview(p.ch);
      var ct = opts.noCoin && opts.stopwatch && p.coinT ? '<small style="color:#ffdf8a">\u00B7 first coin ' + coinTimeTxt(p) + '</small>' : '';
      row.querySelector('.n').innerHTML = esc(p.name) + '<small>' + Math.round(p.d) + ' m \u00B7 ' + num(p.sc) + ' pts \u00B7 ' + p.c + ' coins ' + ct + ' ' + (p.dead ? '\u00B7 crashed' : '') + '</small>';
      row.querySelector('.v').textContent = p.dead ? '\u2620' : 'RACING';
      rowsEl.appendChild(row);
    });
    for (var j = rowsEl.children.length - 1; j >= 0; j--) { var c = rowsEl.children[j]; if (!keep[c.getAttribute('data-uid')]) rowsEl.removeChild(c); }
  }

  // ==================================== POKI18: spectator live leaderboard ===
// ------------------------------------------------------------- flow -------
  function stopTimers() { clearInterval(cdTimer); clearInterval(pubTimer); clearInterval(hudTimer); }
  function noteNames() { Object.keys(players).forEach(function (u) { lastName[u] = players[u].name; lastChar[u] = players[u].char || 'jake'; }); }

  function onRoom(r) {
    room = r;
    if (r && r.kick && r.kick[me.uid] && !isHost) { leaveToHome('You were kicked by the host'); return; }
    // POKI18: host flag follows the room (persistent-lobby reclaim, admin claim-host)
    if (r && r.host && net) {
      if (r.host === me.uid && !isHost) {
        isHost = true;
        try { toast('You are the host now', 2200); } catch (e18h) { }
        if (phase === 'lobby') showLobby();
      } else if (r.host !== me.uid && isHost && r.standIn !== me.uid) {
        // someone else took over (reclaim / claim-host)
        isHost = false;
        if (phase === 'lobby') showLobby();
      }
    }
    // POKI18: when I created a ranked lobby, stamp it (ranked flag + mode) once
    if (r && rkEnter && isHost && net) { try { net.setRoom({ ranked: 1, rmode: rkEnter.mode, hostKey: (W.MPAcc && W.MPAcc.user() || {}).key || '' }); } catch (e) { } rkEnter = null; }
    // POKI18: reopening a persistent lobby offline -> mark stand-in host
    if (r && persistReopen && isHost && net) {
      try { net.setRoom({ persist: 1, pHostKey: persistReopen.pHostKey, standIn: me.uid, name: persistReopen.name, max: persistReopen.max || 8 }); } catch (e) { }
      toast('You are keeping this lobby alive until the host returns', 3200);
      persistReopen = null;
    }
    // POKI18: the original persistent-lobby host returned -> hand the crown back
    if (r && isHost && r.standIn === me.uid && r.pHostKey && net) {
      var came = Object.keys(players || {}).filter(function (u9) { return players[u9] && players[u9].key === r.pHostKey && u9 !== me.uid; })[0];
      if (came) {
        try { net.setRoom({ host: came, standIn: 0 }); } catch (e) { }
        isHost = false;
        try { toast((players[came].name || 'The host') + ' returned and took over as host', 3200); } catch (e2) { }
        if (phase === 'lobby') showLobby();
      }
    }
    if (!r) {
      if (phase === 'lobby' || phase === 'countdown') leaveToHome('The host closed the lobby');
      else hostGone = true;
      return;
    }
    if (phase === 'lobby') showLobby();
    // POKI18: late joiners spectate the live race and join the next round
    if (r.status === 'racing' && phase === 'specwatch') { round = r.round || round || 1; if (!opts.stopwatch && r.opts) opts = r.opts || opts; showSpecWatch(); updateSpecBoard(); }
    if (r.status === 'lobby' && phase === 'specwatch') { phase = 'lobby'; showLobby(); toast('Round over \u2013 you are in the lobby now', 2400); }
    if (r.status === 'racing' && r.startAt && scheduledFor !== r.startAt && (r.participants || []).indexOf(me.uid) >= 0 && r.startAt > net.now() - 2500 && (phase === 'lobby' || phase === 'specwatch')) {
      scheduledFor = r.startAt; beginCountdown(r);
    }
  }
  var lastPSig = '';
  function onPlayers(p) {
    var sig = JSON.stringify(p || {}, function (k, v) { return k === 'ts' ? undefined : v; });
    if (sig === lastPSig) { players = p || {}; return; }   // heartbeat only: skip redraw (keeps buttons / inputs stable)
    lastPSig = sig;
    var oldP = players; players = p || {}; noteNames();
    if (lchat && Object.keys(oldP).length) {
      Object.keys(players).forEach(function (u) { if (!oldP[u] && u !== me.uid) sysNote((players[u].name || 'Someone') + ' join chat', players[u].char); try { notif((players[u].name || 'Someone') + ' joined the party'); } catch (e0) { } });
      Object.keys(oldP).forEach(function (u) { if (!players[u] && u !== me.uid) sysNote((oldP[u].name || 'Someone') + ' left', oldP[u] && oldP[u].char); try { notif((oldP[u].name || 'Someone') + ' left the party'); } catch (e0) { } });
    }
    Object.keys(players).forEach(function (u) { if (players[u].char && !charLoaded(players[u].char)) loadChar(players[u].char); });
    if (isHost && net && phase !== 'home') { try { net.setLobby({ count: Object.keys(players).length }); } catch (e) {} }
    if (phase === 'lobby') showLobby();
    applyStates(); if (running) updateHud();
  }
  function onStates(s) {
    states = s || {};
    Object.keys(states).forEach(function (u) { var v = states[u]; if (v && v.rd === round && u !== me.uid) { lastState[u] = v; if (v.sq) { (theirSh[u] = theirSh[u] || {})[v.sq] = v.sh; if (shAt[v.sq] != null && v.sh !== shAt[v.sq]) flagDesync(u, v.sq); } } });
    applyStates();
    if (phase === 'specwatch') { showSpecWatch(); }        // POKI18: late-join spectator panel follows live
  }

  function warmGhosts(r) {
    var i = 0; (r.participants || []).forEach(function (u) {
      if (u === me.uid) return;
      setTimeout(function () { if (phase === 'countdown') { var gh = ghostOf(u); if (gh) { gh.ent.visible = false; gh.label.style.display = 'none'; } } }, 150 * (i++));
    });
  }
  function beginCountdown(r) {
    phase = 'countdown'; custOpen = false; MP.desync = null; theirSh = {}; round = r.round || 1; opts = r.opts || {}; seed = String(r.seed); raceStart = r.startAt;
    states = {}; lastState = {}; mine = null; dead = false; frozen = null; coinT = 0; gtMine = 0; finished = false; deathWz = 0;
    clearGhosts();
    Object.keys(players).forEach(function (u) { if (players[u].char) loadChar(players[u].char); });
    try { net.setPlayer({ ready: false, rdy: false }); } catch (e) {}
    showCountdown(r);
    clearInterval(cdTimer);
    var warmed = false;
    cdTimer = setInterval(function () {
      var ms = r.startAt - net.now(), el = document.getElementById('mp-cdn');
      if (ms > 0) { if (el) el.textContent = Math.ceil(ms / 1000); if (!warmed && ms < 3200) { warmed = true; warmGhosts(r); } return; }
      clearInterval(cdTimer); hideOv(); bigText('GO!', 900); startRun(r);
    }, 60);
  }

  // ---- engine tweaks while racing
  var eng = null;
  function tweakEngine() {
    var g = W.game; restoreEngine(); eng = { saved: [] };
    function over(obj, name, val) { if (!obj) return; var own = Object.prototype.hasOwnProperty.call(obj, name); eng.saved.push([obj, name, own, obj[name]]); try { obj[name] = val; } catch (e) {} }
    // The stock loop clamps every frame to 100 ms, so a slow machine runs the game slower than real time -> that player falls behind.
    over(g.time, 'maxDeltaTime', 200); over(g.time, 'smooth', 0);
    if (opts.noPause) {
      var nop = function () {};
      over(g, 'pause', nop); over(g, 'onBlur', nop); over(g.hud, 'pause', nop); over(g.hud, 'onBtnPausePress', nop);
      try { if (g.hud && g.hud.btnPause) { eng.saved.push([g.hud.btnPause, 'visible', true, g.hud.btnPause.visible]); g.hud.btnPause.visible = false; eng.saved.push([g.hud.btnPause, 'alpha', true, g.hud.btnPause.alpha]); g.hud.btnPause.alpha = 0; } } catch (e) {}
      try { if (g.paused && g.resume) g.resume(); } catch (e) {}
    }
  }
  function restoreEngine() {
    if (!eng) return;
    eng.saved.forEach(function (x) { try { if (x[2] || x[1] === 'visible') x[0][x[1]] = x[3]; else delete x[0][x[1]]; } catch (e) {} });
    eng = null;
  }
  function startRun(r) {
    phase = 'running'; running = true; finished = false;
    applyLoadout();
    try { W.game.hero.visible = true; } catch (e) {}
    MP.begin(r.seed); tweakEngine();
    [300, 1200].forEach(function (ms) { setTimeout(function () { try { applySkin(W.game.hero, me.char, me.ot | 0); } catch (e) {} }, ms); });
    clearInterval(pubTimer); pubTimer = setInterval(tick, 66);
    clearInterval(hudTimer); hudTimer = setInterval(function () { updateHud(); manage(); }, 300);
    updateHud();
  }

  function manage() {
    if (!running || finished) return;
    var list = standings();
    var coinHit = !!opts.noCoin && !opts.coinKeep && list.some(function (p) { return p.coinT > 0; });
    if (list.some(function (p) { return p.gt; }) || (opts.timeLimit > 0 && raceStart && net.now() - raceStart > opts.timeLimit * 1000)) { finishRace(list, false); return; }
    var live = list.filter(function (p) { return !p.dead && !p.gone; });
    if (coinHit || live.length === 0) { finishRace(list, coinHit); return; }
    if (dead && !spec.exit && performance.now() - deathAt > 1500) {
      var o = aliveOthers(list);
      if (phase !== 'spectate') { if (o.length) startSpectate(list); }
      else if (!o.some(function (p) { return p.uid === spec.uid; })) { if (o.length) { spec.uid = o[0].uid; updateSpecBar(); } }
    }
  }

  var lastList = null, lastCoin = false;
  function finishRace(list, coinHit) {
    restoreEngine(); finished = true; running = false; clearInterval(pubTimer); clearInterval(hudTimer);
    phase = 'results';
    spec.exit = false;
    var el = document.getElementById('mp-spec'); if (el) el.style.display = 'none';
    updateHud(); clearGhosts();
    lastList = list; lastCoin = coinHit;
    showResults(list, coinHit); recordResult(list);
  }

  function resetGameForMenu() {
    var g = W.game, h = g.hero;
    try { h.visible = true; h.body.ghost = false; } catch (e) {}
    showGuard(); restoreEngine();
    try { W.__MP_APP.nav.toTitleScreen(); } catch (e) { console.warn('[MP] toTitleScreen', e); }
  }
  function backToLobby() {
    if (hostGone || !net) { leaveToHome(hostGone ? 'The host closed the lobby' : ''); return; }
    running = false; finished = false; dead = false; frozen = null; hostGone = false; spec.uid = null; spec.exit = false; custOpen = false;
    clearGhosts(); stopTimers(); updateHud(); bigText('');
    resetGameForMenu();
    phase = 'lobby';
    try { net.clearState(); } catch (e) {}
    if (isHost) { try { net.setRoom({ status: 'lobby' }); net.setLobby({ status: 'lobby' }); } catch (e) {} }
    try { net.setPlayer({ ready: false, rdy: false }); } catch (e) {}
    showLobby();
  }
  function leaveToHome(msg) {
    var wasRacing = running || phase === 'results' || phase === 'spectate';
    running = false; finished = false; dead = false; frozen = null; spec.exit = false; stopTimers(); clearGhosts(); updateHud();
    var sp = document.getElementById('mp-spec'); if (sp) sp.style.display = 'none';
    try { if (isHost && code && W.MP18) W.MP18.persist.remove(code); } catch (e0) { }
    try { net && net.leave(); } catch (e) {}
    try { W.MPSocial && MPSocial.setLobby(''); } catch (e) { } closeLobbyChat(); restoreEngine(); net = null; room = null; players = {}; states = {}; lastState = {}; isHost = false; hostGone = false; scheduledFor = 0; code = '';
    if (wasRacing || phase === 'countdown') resetGameForMenu();
    showHome(msg);
  }

  function cleanName(n) { n = String(n || '').trim().slice(0, 14) || ('Player' + Math.floor(Math.random() * 900 + 100)); localStorage.setItem('mp_name', n); return n; }
  function connect(c, asHost, hostInfo) {
    stopList(); closeGlobalChat();
    try { if (net) net.leave(); } catch (e) { }                     // never leave a ghost connection behind: it keeps announcing stale player state
    try { if (listNet) listNet = null; } catch (e) { }
    code = c; isHost = asHost; players = {}; states = {}; lastState = {}; room = null; round = 0; scheduledFor = 0; hostGone = false;
    sessionStorage.setItem('mp_uid', me.uid);
    net = MP.net = W.MPNet.create();
    phase = 'connecting';
    // POKI18: polished lobby transition animation (create / join)
    setOv('<div class="mp-shell narrow"><div class="mp-connect">' + logoImg() +
      '<div class="cn-ring"></div>' +
      '<div class="cn-t">' + (asHost ? 'Creating lobby' : 'Joining lobby') + ' ' + esc(c) + '</div>' +
      '<div class="cn-d">' + netNote() + '</div>' +
      '<div class="cn-steps"><i></i><i></i><i></i></div>' +
      '</div></div>');
    return net.connect(code, { uid: me.uid, name: me.name, char: me.char, board: me.board }, { onRoom: onRoom, onPlayers: onPlayers, onStates: onStates }, asHost, hostInfo).then(function () {
      phase = 'lobby'; loadChar(me.char); openLobbyChat(); sysNote('You joined lobby ' + code); try { W.MPSocial && MPSocial.setLobby(code); } catch (e) { } lastMetaSig = ''; try { net.setPlayer({ ot: me.ot | 0, tc: me.tc, tt: me.tt || '', tp: me.tp | 0, tf: me.tf | 0, tr: me.tr ? 1 : 0, rk: myPts(), lv: myLevel(), rdy: false, key: (W.MPAcc && MPAcc.user() || {}).key || '', ab: (W.MP18 && W.MP18.badges.myAb) || '', ow: (W.MP18 && W.MP18.admin.isOwner()) ? 1 : 0 }); } catch (e) {}
      if (asHost && hostInfo && hostInfo.persist && W.MP18) {
        try { W.MP18.persist.register(code, { name: hostInfo.name, host: me.name || '', hostKey: hostInfo.hostKey || '', max: hostInfo.max || 8, hc: me.char }); } catch (e) { }
        try { net.setRoom({ persist: 1, pHostKey: hostInfo.hostKey || '' }); } catch (e) { }
      }
      // POKI18: race already in progress -> spectate until the next round
      if (room && room.status === 'racing' && (room.participants || []).indexOf(me.uid) < 0) {
        round = room.round || 1; opts = room.opts || opts; phase = 'specwatch';
        showSpecWatch(); toast('Joined mid-race \u2013 spectating until the next round', 3200);
      } else showLobby();
      clearInterval(readyTimer);
      readyTimer = setInterval(function () {
        if (!net || phase !== 'lobby') return;
        var want = MP.ready() && charLoaded(me.char), have = !!(players[me.uid] && players[me.uid].ready);
        if (want !== have) net.setPlayer({ ready: want });
      }, 400);
    }).catch(function (e) {
      console.warn('[MP] connect failed', e); try { net && net.leave(); } catch (x) {} net = null; code = '';
      showHome(e && e.message || 'Could not connect');
      return Promise.reject(e);   // POKI18: callers (persistent-lobby reopen) can still react
    });
  }

  MP.ui = {
    openCreate: function (name) { me.name = cleanName(name); showCreate(); },
    createRankedLobby: function (codeIn, mode, opp) {
      if (!me.name) me.name = cleanName('');
      var c = String(codeIn || ('R' + Math.floor(Math.random() * 9000 + 1000))).toUpperCase().slice(0, 5);
      rkEnter = { ranked: true, mode: mode || 'coin' };
      return connect(c, true, { name: 'Ranked \u00B7 ' + (mode === 'nocoin' ? 'No Coin' : 'Coin') + ' \u00B7 ' + (me.name || 'Player') + ' vs ' + ((opp && (opp.n || opp.name)) || '?'), max: 2, opts: Object.assign({}, cleanOpts(draft), { noCoin: mode === 'nocoin', coinKeep: false, stopwatch: true }) }).catch(function () {});   // connect() already surfaces the error
    },
    createLobby: function (lname, max) {
      if (!me.name) me.name = cleanName('');
      var c = ''; for (var i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)];
      var persist18 = false;
      try { var pc18 = document.getElementById('mp-persist'); persist18 = !!(pc18 && pc18.checked && W.MPAcc && MPAcc.user()); } catch (e) { }
      return connect(c, true, { name: String(lname || (me.name + "'s lobby")).trim().slice(0, 22), max: Math.max(2, Math.min(8, parseInt(max, 10) || 8)), opts: cleanOpts(draft), persist: persist18, hostKey: (W.MPAcc && MPAcc.user() || {}).key || '' }).catch(function () {});   // connect() already surfaces the error
    },
    joinLobby: function (c, name) {
      me.name = cleanName(name || me.name); c = String(c || '').trim().toUpperCase();
      if (!c) { showHome('Pick a lobby first'); return Promise.resolve(); }
      return connect(c, false).catch(function (err) {
        // offline persistent lobby: reopen it (first comer stands in as host);
        // the registry is checked lazily so late-arriving data still counts
        if (/not found/i.test(String(err && err.message)) && W.MP18) {
          return W.MP18.persist.refresh().then(function () {
            var p18 = W.MP18.persist.get(c);
            if (!p18) throw err;
            toast('Reopening persistent lobby ' + c, 2600);
            persistReopen = { pHostKey: p18.hostKey || '', name: p18.name || 'Persistent lobby', max: p18.max || 8, code: c };
            return connect(c, true, { name: p18.name || ('Persistent ' + c), max: p18.max || 8, opts: {}, persist: true, hostKey: (W.MPAcc && MPAcc.user() || {}).key || '', reopen: true });
          });
        }
        throw err;
      }).catch(function (err) { showHome(err && err.message || 'Could not connect'); });
    },
    pickChar: function (id) {
      me.char = id; localStorage.setItem('mp_char', id);
      if (net) net.setPlayer({ char: id, ready: false });
      loadChar(id).then(function () { refreshCust(); });
      refreshCust();
    },
    pickBoard: function (id) { me.board = id; localStorage.setItem('mp_board', id); if (net) net.setPlayer({ board: id }); refreshCust(); },
    start: function () {
      if ((!isHost && !can('start')) || !room || room.status !== 'lobby') return;
      var ids = sortedPlayers();
      if (!ids.length || !readyInfo(ids).ok) return;
      net.setRoom({ status: 'racing', seed: (room.opts && room.opts.seed) ? String(room.opts.seed) : String(Math.floor(Math.random() * 1e9)), startAt: net.now() + ((+((room.opts || {}).countdown) || 4.5) * 1000), participants: ids, round: (room.round || 0) + 1 });
      net.setLobby({ status: 'racing', count: ids.length });
    },
    backToLobby: backToLobby,
    leave: function () { leaveToHome(''); }
  };


  // ======================================================================= v10 ===
  var OUTFITS = ['Classic', 'Remix', 'Midnight'];
  var POSES = [['hold_magnet', 'Wave', '\uD83D\uDC4B'], ['run_HighScore_main', 'Hero', '\uD83E\uDDB8'], ['IconJump', 'Jump', '\uD83E\uDD38'], ['superRun', 'Sprint', '\uD83D\uDCA8'], ['DoubleJump_Hangtime_02_BackFlip', 'Flip', '\uD83E\uDD85'], ['Custom_Teleport', 'Pop', '\u2728']];
  var CINFO = { jake: 'Graffiti artist and the kid who started the whole chase.', tricky: 'Quick feet, quicker attitude. Never gets caught.', yutani: 'Calm under pressure, always on the fastest line.', lucy: 'Dresses for the show and runs like she is late for the encore.', tagbot: 'A wind-up robot built to tag every wall in town.', ninja: 'Silent on the rails and gone before the guard turns.', tasha: 'Runs to her own rhythm. The party follows.', king: 'Crowns the yard in style. Bows to nobody.', brody: 'Loves a jump, loves a grind, loves the finish line.' };
  var hudHide = false, hudMin = false;

  // ---- outfit (texture) swap on any avatar entity. Returns number of meshes handled.
  var skinImgs = {};
  function skinImg(ch, ot) {
    var k = ch + '|' + ot; if (skinImgs[k]) return skinImgs[k];
    var im = new Image(); im.src = 'assets/characters-idle/' + ch + '-tex' + (ot ? '-' + ot : '') + '.webp'; return (skinImgs[k] = im);
  }
  function applySkin(ent, ch, ot) {
    ot = ot | 0; var im = ot ? skinImg(ch, ot) : null;
    if (im && !im.complete) { im.addEventListener('load', function () { applySkin(ent, ch, ot); }, { once: true }); return 0; }
    if (im && !im.naturalWidth) return 0;
    var list = [], cnt = {}, best = null, bn2 = 0;
    try { ent.traverse(function (o) { var v = o.view3d, m = v && v.material; if (m && m.map) { if (!o.__om) o.__om = m.map; list.push(o); var im0 = o.__om.image; if (im0) { im0.__id = im0.__id || ('i' + Math.random()); cnt[im0.__id] = (cnt[im0.__id] || 0) + 1; if (cnt[im0.__id] > bn2) { bn2 = cnt[im0.__id]; best = im0; } } } }); } catch (e) { return 0; }
    var done = 0;
    list.forEach(function (o) {
      var m = o.view3d.material, om = o.__om; if (!om || om.image !== best) return;
      var t = om;
      if (ot) { om.__sk = om.__sk || {}; t = om.__sk[ot]; if (!t) { t = new om.constructor(im); ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'generateMipmaps', 'anisotropy', 'premultiplyAlpha', 'channel'].forEach(function (k) { try { if (om[k] !== undefined) t[k] = om[k]; } catch (e) {} }); t.needsUpdate = true; om.__sk[ot] = t; } }
      try { m.map = t; if (m.uniforms && m.uniforms.uDiffuseMap) m.uniforms.uDiffuseMap.value = t; m.needsUpdate = true; } catch (e) {}
      done++;
    });
    return done;
  }
  function skinLater(ent, ch, ot) { [0, 400, 1500].forEach(function (ms) { setTimeout(function () { try { applySkin(ent, ch, ot); } catch (e) {} }, ms); }); }

  // ---- real 3D stage: the game's own world + .pk avatars drawn behind the UI
  var STG = { on: false, hooked: false, ents: {}, hidden: [], azBase: 0, yaw: 0, pitch: 0, zoom: 1, off: 0, offCur: 0, M: null, INV: null, drag: null, tags: null, t: 0, ptr: 0 };
  var C0 = 1.2, GY = 5.5, VIEW_AZ = [-22, -12, 0, 12, 22], VIEW_PI = [0, 0.6, 1.2];
  function stageOK() { var A = W.__MP_APP, g = W.game; return !!(A && A.stage && A.stage.renderer && g && g.hero && g.hero.anim && g.view3d && g.view3d.camera && g.view3d.camera.threeCamera && MP.ready()); }
  function stageHook() {
    if (STG.hooked) return; STG.hooked = true;
    var r = W.__MP_APP.stage.renderer, orig = r.render.bind(r);
    r.render = function (scene, cam) {
      if (STG.on && STG.sc) { try { if (STG.sc.root.parent !== scene) scene.add(STG.sc.root); } catch (e) {} }
      if (STG.on && STG.M && cam === cam3()) {
        try { var c = W.game.view3d.camera; c.matrixWorldAutoUpdate = false; cam.matrixWorldAutoUpdate = false; var a = cam.matrixWorld.elements, b = cam.matrixWorldInverse.elements; for (var i = 0; i < 16; i++) { a[i] = STG.M[i]; b[i] = STG.INV[i]; } cam.projectionMatrix.elements[8] = -STG.offCur; } catch (e) {}
      }
      // spectate camera: last-say override so the engine can never snap the view back
      if (phase === 'spectate' && SPEC.M && cam === cam3()) {
        try { var c2 = W.game.view3d.camera; c2.matrixWorldAutoUpdate = false; cam.matrixWorldAutoUpdate = false; var a2 = cam.matrixWorld.elements, b2 = cam.matrixWorldInverse.elements; for (var j = 0; j < 16; j++) { a2[j] = SPEC.M[j]; b2[j] = SPEC.INV[j]; } } catch (e) {}
      }
      return orig(scene, cam);
    };
  }
  function stageOn() {
    stageHook(); STG.on = true; STG.yaw = 0; STG.pitch = 0; STG.zoom = 1;
    STG.azBase = VIEW_AZ[Math.floor(Math.random() * VIEW_AZ.length)] * Math.PI / 180; STG.piBase = VIEW_PI[Math.floor(Math.random() * VIEW_PI.length)];
    var g = W.game, A = W.__MP_APP;
    try { A.ui.visible = false; } catch (e) {}
    try { g.hero.visible = false; } catch (e) {}
    STG.hidden = [];
    try { hideGuard(); } catch (e) {}
    stageWorld(true);
    newStageScene();
    stagePtr(); if (ov) { ov.classList.add('stg'); } panoShow(false);
  }
  function stageOff() {
    STG.on = false; var g = W.game, A = W.__MP_APP;
    Object.keys(STG.ents).forEach(function (u) { killEnt(u, true); });
    try { g.view3d.camera.threeCamera.projectionMatrix.elements[8] = 0; } catch (e) {}
    try { var c = g.view3d.camera; c.matrixWorldAutoUpdate = true; c.threeCamera.matrixWorldAutoUpdate = true; } catch (e) {}
    try { A.ui.visible = true; } catch (e) {}
    try { g.hero.visible = true; } catch (e) {}
    STG.hidden.forEach(function (e) { try { if (e.__mpHidden) { e.visible = e.__mpWasVis !== false; e.__mpHidden = 0; } else { e.visible = true; } } catch (x) {} }); STG.hidden = [];
    try { if (STG.sc) { STG.sc.dispose(); } } catch (x) {} STG.sc = null;
    stageWorld(false);
    if (STG.tags) STG.tags.innerHTML = '';
    if (ov) ov.classList.remove('stg');
  }
  // Poki15: hide the game's own world (sky, ground, trains) while the studio stage is shown
  function stageWorld(on) {
    try {
      var c = cam3(), sc = c; while (sc && sc.parent) sc = sc.parent;
      if (on) {
        if (sc && !STG.bgSaved) STG.bgSaved = { sc: sc, bg: sc.background, fog: sc.fog };
        try { if (sc) { sc.background = null; sc.fog = null; } } catch (e) {}
        try { var rr = W.__MP_APP.stage.renderer; if (rr.setClearColor) rr.setClearColor((W.MPScene && W.MPScene.bgColor ? W.MPScene.bgColor() : 0x040816), 1); } catch (e) {}
      } else {
        var sv = STG.bgSaved; if (sv) { try { sv.sc.background = sv.bg; sv.sc.fog = sv.fog; } catch (e) {} STG.bgSaved = null; }
      }
    } catch (e) { console.warn('[MP] stageWorld', e); }
  }
  function newStageScene() {
    if (!W.MPScene) return;
    var tok = STG.tok = (STG.tok | 0) + 1;
    var attempt = function (n) {
      W.MPScene.load().then(function (T) {
        if (!T || !STG.on || tok !== STG.tok) return;
        var sc = null;
        try { sc = W.MPScene.build(); } catch (e) { }
        if (!sc && n < 4) { setTimeout(function () { attempt(n + 1); }, 1200); return; }
        try { var old = STG.sc; if (sc) { STG.sc = sc; if (old) old.dispose(); console.log('[MP] stage scene', sc.theme.n, sc.key); } } catch (e) { }
      });
    };
    attempt(0);
  }
  function stagePtr() {
    if (STG.ptr) return; STG.ptr = 1;
    function isBg(t) { return t && (t.tagName === 'CANVAS' || t === document.body || t === document.documentElement); }
    W.addEventListener('pointerdown', function (e) { if (!STG.on || !isBg(e.target) || e.target.id === 'mp-pano') return; STG.drag = { x: e.clientX, y: e.clientY, yaw: STG.yaw, pit: STG.pitch }; });
    W.addEventListener('pointermove', function (e) { var d = STG.drag; if (!d) return; STG.yaw = d.yaw - (e.clientX - d.x) * 0.007; STG.pitch = Math.max(-2, Math.min(6, d.pit + (e.clientY - d.y) * 0.03)); });
    ['pointerup', 'pointercancel'].forEach(function (n) { W.addEventListener(n, function () { STG.drag = null; }); });
    W.addEventListener('wheel', function (e) { if (!STG.on || !isBg(e.target)) return; STG.zoom = Math.max(0.5, Math.min(1.8, STG.zoom * (e.deltaY > 0 ? 1.08 : 0.92))); }, { passive: true });
  }
  function mkStageEnt(ch) {
    var g = W.game, h = g.hero, Is = h.anim.constructor, G = Object.getPrototypeOf(h.constructor), M = h.model.constructor;
    var ent = new G(); ent.model = new M(); ent.addChild(ent.model); ent.add(Is);
    ent.anim.character = ch;
    ent.anim.addSharedAvatar({ character: ch, modelFile: 'avatar_' + ch, texture: ch + '-tex', sources: h.anim.sharedAvatarData.sources });
    g.addChild(ent); ent.model.position.y = -4.5; ent.model.rotation.y = 0; return ent;
  }
  function killEnt(u, now) {
    var e = STG.ents[u]; if (!e) return;
    if (!now) { if (!e.leaving) { e.leaving = 1; stagePoof(e); } return; }
    try { e.ent.parent && e.ent.parent.removeChild(e.ent); } catch (x) {}
    try { e.ent.destroy && e.ent.destroy(); } catch (x) {}
    try { e.tag && e.tag.remove(); } catch (x) {}
    try { if (e.bview && e.bview.parent) e.bview.parent.remove(e.bview); } catch (x) {}
    e.bview = null;
    delete STG.ents[u];
  }
  function stageProj(x, y, z) {
    var tc = cam3(); if (!tc || !STG.INV) return null;
    var e = STG.INV, p = tc.projectionMatrix.elements;
    var vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    var cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12], cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13], cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (cw <= 0) return null; return { x: (cx / cw * 0.5 + 0.5) * innerWidth, y: (1 - (cy / cw * 0.5 + 0.5)) * innerHeight, s: 1 / cw };
  }
  function stagePoof(e) {
    if (!STG.tags) return; var p = stageProj(e.x, 1.2, e.tz || 0); if (!p) return;
    var d = document.createElement('div'); d.className = 'st-poof'; d.style.left = p.x + 'px'; d.style.top = p.y + 'px'; d.style.setProperty('--w', Math.round(220 * p.s * 14) + 'px');
    STG.tags.appendChild(d); setTimeout(function () { d.remove(); }, 650);
  }
  function stageData(u) {
    var isOwnerKey = W.MP18 && W.MP18.admin.isOwner();
    if (phase === 'profile' && profView) return { name: profView.name, tc: 0, tt: '', tp: 0, tf: 0, tr: 0, rk: profView.pts, tq: 0, to: 10, tu: null, char: profView.char, ot: profView.ot | 0, ow: profView.key === 'brune' && isOwnerKey ? 1 : 0, ab: '' };
    if (u === me.uid) return { name: me.name || 'Player', tc: me.tc, tt: me.tt, tp: me.tp, tf: me.tf, tr: me.tr, rk: myPts(), tq: me.tq, to: me.to, tu: me.tu, char: me.char, ot: me.ot | 0, ow: isOwnerKey ? 1 : 0, ab: (W.MP18 && W.MP18.badges.myAb) || '' };
    var p18d = players[u] || { name: lastName[u] || '?' };
    p18d.ow = p18d.ow | 0; p18d.ab = p18d.ab || '';
    return p18d;
  }
  function stageRoster() { if (W.__MP_FAKE) return W.__MP_FAKE; if (phase === 'profile') return [me.uid]; return (phase === 'lobby' && room && Object.keys(players).length) ? sortedPlayers() : [me.uid]; }
  // attach one of the game's real board scenes under a stage character (locker BOARD tab preview)
  function setStageBoard(e, id) {
    if (e.bid === id) return;
    e.bid = id;
    if (e.bview) { try { e.bview.parent && e.bview.parent.remove(e.bview); } catch (x) {} e.bview = null; }
    if (!id) return;
    var A = W.__MP_APP;
    if (!A || !A.library || !A.library.hasScene('board-' + id)) return;
    try {
      var view = A.library.getScene('board-' + id, { map: 'board-' + id + '-tex' }), ap = null;
      e.ent.traverse(function (o) { if (!ap && o.name === 'attachPoint1') ap = o; });
      if (!ap) return;
      view.rx = -Math.PI / 2; view.ry = 0; view.rz = 0; view.x = 0; view.y = 0; view.z = 0;
      ap.addChild(view);
      try {
        var data = A.data && A.data.getBoardData && A.data.getBoardData(id), feat = (data && data.features) || [], nodes = [], shown = 0;
        view.traverse(function (o) { if (o.view3d && o.name) nodes.push(o); });
        if (feat.length) {
          nodes.forEach(function (o) { var on = feat.indexOf(o.name) >= 0; o.view3d.renderable = on; if (on) shown++; });
          if (!shown) nodes.forEach(function (o) { o.view3d.renderable = true; });
        }
      } catch (x) {}
      e.bview = view;
    } catch (x) { console.warn('[MP] stage board', x); }
  }
  function stageFrame(ts) {
    requestAnimationFrame(stageFrame);
    var want = !!UI_ON && !running && ['countdown', 'running', 'spectate', 'results'].indexOf(phase) < 0 && stageOK();
    if (want && !STG.on) stageOn(); else if (!want && STG.on) stageOff();
    if (!STG.on) return;
    var dt = Math.min(0.1, (ts - (STG.t || ts)) / 1000); STG.t = ts;
    STG.profile = phase === 'profile'; if (STG.spin) STG.yaw += dt * 0.75;
    if (ov && !ov.classList.contains('stg')) ov.classList.add('stg');
    var ids = stageRoster(), set = {}, n = ids.length, sp = 6.6, half = (n - 1) * sp / 2;
    ids.forEach(function (u, i) {
      set[u] = 1;
      var d = stageData(u), ch = d.char || 'jake', e = STG.ents[u];
      if (e && (e.ch !== ch || e.leaving)) { killEnt(u, true); e = null; }
      if (!e) {
        if (!charLoaded(ch)) { loadChar(ch); return; }
        try { var ent = mkStageEnt(ch); e = STG.ents[u] = { ent: ent, ch: ch, x: C0 - half + i * sp, y: GY + 15, vy: 0, s: 1, pose: '', sk: '', landed: 0, tag: null, sig: '' }; ent.position.set(e.x, e.y, 0); }
        catch (x) { console.warn('[MP] stage ent', x); return; }
      }
      e.tx = C0 - half + i * sp; e.tz = -Math.pow(Math.abs(i - (n - 1) / 2), 1.6) * 0.9; e.ot = d.ot | 0;   // Fortnite-style arc
    });
    Object.keys(STG.ents).forEach(function (u) { if (!set[u] && !STG.ents[u].leaving) killEnt(u, false); });
    try { if (W.game.hero) W.game.hero.visible = false; } catch (e1) {}
    try {
      if (STG.sc && STG.sc.placePads) STG.sc.placePads(ids.length, ids.map(function (u) { var pl = players[u] || {}; return phase !== 'lobby' || u === me.uid || (room && u === room.host) || !!pl.rdy; }));
    } catch (e0) {}
    try { if (STG.sc && STG.sc.update) STG.sc.update(); } catch (e2) {}
    // world guard: everything in the game scene except the stage avatars + studio stays hidden while the stage is up
    try {
      var LENT = (W.game && W.game.level && W.game.level.entities) || [];
      var isStage = function (e) { for (var k in STG.ents) if (STG.ents[k].ent === e) return true; return false; };
      LENT.forEach(function (e) {
        if (!e || !e.position || isStage(e) || e === W.game.hero) return;
        if (!e.__mpHidden) { e.__mpWasVis = e.visible !== false; e.__mpHidden = 1; if (STG.hidden.indexOf(e) < 0) STG.hidden.push(e); }
        e.visible = false;
      });
      var c0 = cam3(), sc0 = c0; while (sc0 && sc0.parent) sc0 = sc0.parent;
      if (sc0) {
        sc0.background = null;
        var keep = []; for (var kk in STG.ents) keep.push(STG.ents[kk].ent);
        sc0.children.forEach(function (R) {
          if (STG.sc && R === STG.sc.root) return;
          (R.children || []).forEach(function (o) {
            if (keep.indexOf(o) >= 0 || o === W.game.hero || o.__mpKeep) return;
            if (!o.__mpHidden) { o.__mpWasVis = o.visible !== false; o.__mpHidden = 1; if (STG.hidden.indexOf(o) < 0) STG.hidden.push(o); }
            o.visible = false;
          });
        });
      }
    } catch (e3) {}
    var offT = phase === 'custom' ? -0.4 : (phase === 'profile' ? -0.575 : 0); STG.off = offT; STG.offCur += (STG.off - STG.offCur) * Math.min(1, dt * 4);
    Object.keys(STG.ents).forEach(function (u) {
      var e = STG.ents[u], ent = e.ent;
      if (e.leaving) { e.s -= dt * 3.2; e.y += dt * 6; if (e.s <= 0.05) { killEnt(u, true); return; } }
      else { e.x += (e.tx - e.x) * Math.min(1, dt * 8); if (e.y > GY || e.vy) { e.vy -= 70 * dt; e.y += e.vy * dt; if (e.y <= GY) { e.y = GY; e.vy = 0; if (!e.landed) { e.landed = 1; stagePoof(e); } } } }
      e.lc = e.lc || 0; if (STG.profile && u === me.uid) { e.lc += (((STG.lift ? 4.3 : 0) + (STG.paused ? 0.45 : 0)) - e.lc) * Math.min(1, dt * 5); } else e.lc += (0 - e.lc) * Math.min(1, dt * 5);
      try { ent.position.set(e.x, e.y + e.lc, e.tz || 0); var sc2 = e.s * (1 + e.lc * 0.035); ent.scale.set(sc2, sc2, sc2); } catch (x) {}
      var dd = stageData(u);
      // default pose everywhere is "Hero"; you keep whatever pose you picked in the locker
      var pose = 'run_HighScore_main';                       // "Hero"
      if (u === me.uid) pose = POSES[Math.max(0, Math.min(POSES.length - 1, me.pose == null ? 1 : (me.pose | 0)))][0];
      if (e.pose !== pose && !e.leaving) { e.pose = pose; try { ent.anim.play(pose, { loop: true, sudden: true }); } catch (x) {} }
      var k = e.ch + '|' + e.ot;
      if (e.sk !== k) { if (!e.ot) { applySkin(ent, e.ch, 0); e.sk = k; } else if (!e.skT || ts - e.skT > 350) { e.skT = ts; if (applySkin(ent, e.ch, e.ot) > 0) e.sk = k; } }
      // BOARD tab: the 3D character actually stands on the selected board
      setStageBoard(e, (custTab === 'board' && u === me.uid) ? (me.board || '') : '');
    });
    // camera
    var drift = STG.drag ? 0 : Math.sin(ts / 7000) * 0.06, az = STG.profile ? (STG.yaw + drift) : (STG.azBase + STG.yaw + drift);
    var homeV = phase === 'home', dist = (STG.profile ? 14.6 : (homeV ? Math.max(15.5, half / 0.36 + 6) : Math.max(19.5, half / 0.36 + 5))) * STG.zoom * (STG.profile && STG.lift ? 0.8 : 1), T = [C0 + (STG.profile ? 3.1 : 0), homeV ? 3.3 : 4.2, 0], P = [T[0] + dist * Math.sin(az), (STG.profile ? 6.1 : (homeV ? T[1] + 3.4 : 8.2)) + (STG.profile ? 0.35 : STG.piBase * (homeV ? 0.7 : 1)) + STG.pitch, T[2] + dist * Math.cos(az)];
    var z = [P[0] - T[0], P[1] - T[1], P[2] - T[2]], zl = Math.hypot(z[0], z[1], z[2]); z = [z[0] / zl, z[1] / zl, z[2] / zl];
    var x = [z[2], 0, -z[0]], xl = Math.hypot(x[0], x[1], x[2]); x = [x[0] / xl, 0, x[2] / xl];
    var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    var tx = -(x[0] * P[0] + x[1] * P[1] + x[2] * P[2]), ty = -(y[0] * P[0] + y[1] * P[1] + y[2] * P[2]), tz = -(z[0] * P[0] + z[1] * P[1] + z[2] * P[2]);
    STG.M = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, P[0], P[1], P[2], 1];
    STG.INV = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, tx, ty, tz, 1];
    // name tags
    Object.keys(STG.ents).forEach(function (u) {
      var e = STG.ents[u], d = stageData(u), pr = stageProj(e.x, e.y + 5.5 * e.s, e.tz || 0);
      if (!e.tag) { e.tag = document.createElement('div'); e.tag.className = 'st-tag'; STG.tags && STG.tags.appendChild(e.tag); }
      if (!pr || e.leaving || STG.profile) { e.tag.style.opacity = 0; return; }
      var host = room && u === room.host, pl = players[u] || {}, st = phase !== 'lobby' ? (u === me.uid ? 'you' : '') : (!pl.ready && u !== me.uid ? 'LOADING\u2026' : host ? 'READY' : (pl.rdy ? 'READY' : 'NOT READY'));
      var sig = JSON.stringify([d.name, d.tc, d.tt, d.tp, d.tf, d.tr, d.rk, d.tq, d.to, d.tu, d.ow, d.ab, st, u === me.uid]);
      if (sig !== e.sig) { e.sig = sig; e.tag.innerHTML = (host ? '<svg class="sthc" viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z" fill="#ffd23f"/></svg>' : '') + bn(d) + (st ? '<small class="' + (host ? 'host' : pl.rdy ? 'ok' : u === me.uid ? 'me' : 'no') + '">' + st + '</small>' : ''); }
      e.tag.style.transform = 'translate(' + pr.x.toFixed(1) + 'px,' + pr.y.toFixed(1) + 'px) translate(-50%,-100%)';
      e.tag.style.opacity = 1;
    });
  }
  function outfitRows() {
    var h = '<div class="mq-sec">Outfit style</div><div class="mq-sw sq">' + OUTFITS.map(function (n, i) { return '<i class="' + ((me.ot | 0) === i ? 'sel' : '') + '" data-act="pickot" data-i="' + i + '">' + n + '</i>'; }).join('') + '</div>';
    h += '<div class="mq-sec">Pose</div><div class="mq-sw sq">' + POSES.map(function (p, i) { return '<i class="' + ((me.pose | 0) === i ? 'sel' : '') + '" data-act="pickpose" data-i="' + i + '">' + p[2] + ' ' + p[1] + '</i>'; }).join('') + '</div>';
    return h;
  }
  function initV10() {
    var st = document.createElement('style'); st.textContent = V10CSS; document.head.appendChild(st);
    try { var st11 = document.createElement('style'); st11.textContent = V11CSS; document.head.appendChild(st11); } catch (e) {}
    try { var st12 = document.createElement('style'); st12.textContent = V12CSS; document.head.appendChild(st12); } catch (e) {}
    STG.tags = document.createElement('div'); STG.tags.id = 'mp-stagetags'; document.body.appendChild(STG.tags);
    var ho = document.createElement('button'); ho.id = 'mp-hudopen'; ho.setAttribute('data-act', 'hudopen'); ho.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 15l3-4 2.5 2.5L17 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; ho.title = 'Show standings'; hud.appendChild(ho);
    var lc = document.getElementById('mp-lchat'), hd = lc && lc.querySelector('.hd'), sz = 0;
    if (hd) {
      hd.insertAdjacentHTML('beforeend', '<button class="cb" data-c="ico" title="Collapse to chat icon">\u2199</button><button class="cb" data-c="sz" title="Resize">\u2922</button><button class="cb" data-c="min" title="Minimise">\u2013</button>');
      lc.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('.cb'); if (!b) return;
        if (b.getAttribute('data-c') === 'min') lc.classList.toggle('cmin');
        else if (b.getAttribute('data-c') === 'ico') lchatToggleIcon(true);
        else { sz = (sz + 1) % 3; lc.classList.remove('sz0', 'sz1', 'sz2'); lc.classList.add('sz' + sz); lc.classList.remove('cmin'); }
      });
    }
    specPtr();
    requestAnimationFrame(stageFrame);
  }
  var V10CSS = `
/* ---------- Poki14: stage mode + stage tags + spectator UI ---------- */
#mp-ov.stg:not(.dim){background:linear-gradient(180deg,rgba(4,6,12,.42),rgba(4,6,12,0) 24%,rgba(4,6,12,0) 66%,rgba(4,6,12,.55))!important;pointer-events:none}
#mp-ov.stg [data-act],#mp-ov.stg input,#mp-ov.stg select,#mp-ov.stg textarea,#mp-ov.stg a,#mp-ov.stg .mq-panel,#mp-ov.stg .p14-nav,#mp-ov.stg .f14-go,#mp-ov.stg .f14-party,#mp-ov.stg .f14-left,#mp-ov.stg .f14-cam,#mp-ov.stg .pf14-head,#mp-ov.stg .pf14-grid,#mp-ov.stg .fnk-locker,#mp-ov.stg .c13box,#mp-ov.stg .c13form,#mp-ov.stg .mq-lb,#mp-ov.stg .mq-auth,#mp-ov.stg .p13,#mp-ov.stg .p14-home>*{pointer-events:auto}
#mp-ov.stg .mq-tagplate{visibility:hidden}
#mp-stagetags{position:fixed;inset:0;z-index:99985;pointer-events:none;overflow:hidden;font-family:'proxima',Verdana,sans-serif;color:#fff}
.st-tag{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:2px;font-size:clamp(14px,1.4vw,19px);text-shadow:0 2px 4px rgba(0,0,0,.55);transition:opacity .25s;will-change:transform}
.st-tag .nt{filter:drop-shadow(0 3px 6px rgba(0,0,0,.55))}
.st-tag small{font-family:'proxima',Verdana,sans-serif;font-size:10px;font-weight:bold;letter-spacing:1px;padding:1px 9px;border-radius:8px;background:rgba(8,12,20,.72);border:1px solid rgba(120,150,220,.22);color:#c3d0ea;text-transform:uppercase}
.st-tag small.ok{color:#7ce0ac}.st-tag small.host{color:#ffdf8a}.st-tag small.me{color:#8ecaff}.st-tag small.no{color:#ff9ba3}
.st-poof{position:absolute;transform:translate(-50%,-50%);border-radius:50%;border:3px solid rgba(160,190,255,.75);animation:stpoof .6s ease-out forwards}
@keyframes stpoof{from{width:10px;height:4px;opacity:.9}to{width:var(--w,160px);height:calc(var(--w,160px)*.3);opacity:0;border-width:1px}}
/* ---------- spectator bar ---------- */
#mp-spec{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99993;display:none;flex-direction:column;align-items:center;gap:7px;pointer-events:auto}
.sp14{display:flex;align-items:center;gap:12px;background:rgba(10,14,22,.92);border:1px solid #313d52;border-radius:14px;padding:9px 14px;box-shadow:0 14px 34px rgba(0,0,0,.45)}
.sp14-g{display:flex;gap:5px;align-items:center}
.sp14-mb,.sp14-nb{width:38px;height:38px;border-radius:10px;border:1px solid #313d52;background:#1a2231;color:#c3d0ea;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:all .15s}
.sp14-mb svg,.sp14-nb svg{width:21px;height:21px}
.sp14-mb:hover,.sp14-nb:hover{color:#fff;border-color:#3d4c68;background:#222b3c}
.sp14-mb.on{background:#3e7bfa;border-color:#3e7bfa;color:#fff}
.sp14-t{display:flex;align-items:center;gap:9px;min-width:150px;max-width:290px}
.sp14-t img{width:36px;height:36px;border-radius:9px;background:#0a0d14;border:1px solid #313d52;object-fit:cover;object-position:top}
.sp14-t .i{display:flex;flex-direction:column;align-items:flex-start;min-width:0;line-height:1.3}
.sp14-t .i b{font-family:'proxima',Verdana,sans-serif;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
.sp14-t .i small{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#9aa5bd;display:flex;align-items:center;gap:4px;white-space:nowrap}
.sp14-t .i small .rk-svg-w{display:inline-flex}
.sp14-t .i small .rk-svg-w .rk-svg{width:13px;height:13px}
.sp14-x{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;background:rgba(224,86,86,.14);border:1px solid rgba(224,86,86,.5);color:#ff9ba3;border-radius:9px;padding:10px 15px;cursor:pointer;transition:background .15s}
.sp14-x:hover{background:rgba(224,86,86,.28);color:#fff}
.sp14-hint{font-family:'proxima',Verdana,sans-serif;font-size:10px;letter-spacing:1px;color:#7a86a0;background:rgba(8,11,18,.75);border:1px solid rgba(49,61,82,.7);border-radius:16px;padding:4px 14px;text-transform:uppercase}
@media(max-width:760px){.sp14-hint{display:none}.sp14-t{min-width:0}.sp14-t .i small{max-width:120px;overflow:hidden;text-overflow:ellipsis}}

`;

  var V11CSS = `
/* Poki14: chat styles live in the main design system (css3 layer). */

`;

  var V12CSS = `
/* Poki14: legacy v12 theme removed - the unified design system covers it. */

`;



  var V13CSS = `
/* ---------- Poki14: profile, modals, banner, notifs, nametag variants ---------- */
/* profile (LABY.net inspired) */
.pf14{position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;gap:12px;padding:12px 16px}
.pf14-back{position:relative;z-index:5;align-self:flex-start}
.pf14-head{position:relative;display:flex;gap:12px;padding:0;align-items:stretch;min-height:220px;background:none;border:0;box-shadow:none}
.pf14-idpanel{flex:1;min-width:0;display:flex;gap:18px;padding:14px 18px;align-items:stretch}
.pf14-viewer{position:relative;flex:0 0 230px;min-height:200px;border:1px solid #313d52;border-radius:12px;background:linear-gradient(180deg,rgba(10,14,22,.18),rgba(10,14,22,.05));box-shadow:inset 0 0 40px rgba(20,40,90,.14)}
.pf14-vwin{position:absolute;inset:0;cursor:pointer}
.pf14-liftchip{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(8,12,20,.82);border:1px solid #313d52;color:#c3d0ea;font-family:'proxima',Verdana,sans-serif;font-size:9.5px;letter-spacing:1.8px;padding:5px 14px;border-radius:16px;cursor:pointer;text-transform:uppercase;transition:all .15s}
.pf14-liftchip:hover{border-color:#3e7bfa;color:#fff}
.pf14-id{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:7px}
.pf14-kicker{font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:3.5px;text-transform:uppercase;color:#8296c4}
.pf14-name{margin:0;font-family:'torus','titan-one',Verdana,sans-serif;font-weight:normal;font-size:clamp(26px,3.4vw,40px);letter-spacing:1px;color:#f2f5fc;text-shadow:0 3px 10px rgba(0,0,0,.5);line-height:1.05}
.pf14-idrow{display:flex;align-items:center;gap:8px;font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#9aa5bd;flex-wrap:wrap}
.pf14-idrow b{color:#c3d0ea;font-weight:normal;letter-spacing:.5px}
.pf14-copyid{background:#1a2231;border:1px solid #313d52;border-radius:7px;color:#c3d0ea;font-size:10px;letter-spacing:1px;padding:4px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;text-transform:uppercase;font-family:'proxima',Verdana,sans-serif;font-weight:bold}
.pf14-copyid:hover{border-color:#3e7bfa;color:#fff}
.pf14-copyid svg{width:12px;height:12px}
.pf14-chips{display:flex;flex-wrap:wrap;gap:6px}
.pf14-chips .mq-chip{font-size:11px}
.pf14-chips .rk-svg{width:15px;height:15px}
.pf14-bio{font-family:'proxima',Verdana,sans-serif;font-size:12.5px;color:#b9c4d8;line-height:1.5;max-width:560px}
.pf14-bio textarea{width:100%;min-height:50px;margin-top:5px;resize:vertical}
.pf14-tiles{flex:0 0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;align-self:center;min-width:300px}
.pf14-tile{background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.13);border-radius:10px;padding:9px 12px;transition:border-color .15s,transform .15s}
.pf14-tile:hover{border-color:rgba(62,123,250,.4);transform:translateY(-2px)}
.pf14-tile small{display:block;color:#626e88;font-family:'proxima',Verdana,sans-serif;font-size:8.5px;letter-spacing:1.6px;margin-bottom:3px;text-transform:uppercase}
.pf14-tile b{font-size:15px;letter-spacing:.4px;font-family:'proxima',Verdana,sans-serif}
.pf14-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(320px,42%) 1fr;gap:12px;overflow:auto;pointer-events:auto;align-items:start}
.pf14-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.pf14-grid .p14-panel{padding:13px 15px}
.pf14-ph{display:flex;align-items:center;gap:8px;font-family:'proxima',Verdana,sans-serif;font-weight:bold;font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:#8296c4;border-bottom:1px solid #232b3a;padding-bottom:8px;margin-bottom:10px}
.pf14-ph .cnt{margin-left:auto;color:#626e88;letter-spacing:1px}
.pf14-curchar{display:flex;align-items:center;gap:12px}
.pf14-curchar img{width:56px;height:56px;border-radius:12px;background:#0a0d14;border:1px solid #313d52;object-fit:cover;object-position:top}
.pf14-curchar .i{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
.pf14-curchar .i b{font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:17px;letter-spacing:1px;text-transform:uppercase}
.pf14-curchar .i small{font-family:'proxima',Verdana,sans-serif;font-size:11px;color:#9aa5bd}
.pf14-skins{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.pf14-skin{width:74px;cursor:pointer;border-radius:10px;border:1px solid rgba(120,150,220,.16);background:rgba(255,255,255,.03);padding:6px;text-align:center;transition:border-color .15s,transform .15s}
.pf14-skin:hover{transform:translateY(-2px);border-color:#3d4c68}
.pf14-skin.sel{border-color:#3e7bfa;box-shadow:0 0 0 2px rgba(62,123,250,.3)}
.pf14-skin img{width:100%;aspect-ratio:1;object-fit:cover;object-position:top;border-radius:7px;background:#0a0d14}
.pf14-skin span{display:block;font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#c3d0ea;margin-top:4px}
.pf14-skins-note{margin-top:8px;font-family:'proxima',Verdana,sans-serif;font-size:11px;color:#626e88}
.pf14-cos{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pf14-cos .fnk-badge{width:40px;height:40px}
.pf14-cos .fnk-badge svg{width:23px;height:23px}
.pf14-cosrow{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.pf14-cosrow .lbl{font-family:'proxima',Verdana,sans-serif;font-size:10px;letter-spacing:1.6px;color:#626e88;text-transform:uppercase;min-width:90px}
.pf14-sw{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;display:inline-block}
.pf14-sw.sel{border-color:#fff;box-shadow:0 0 0 2px rgba(62,123,250,.6)}
.pf14-frrow{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.13);border-radius:9px;padding:7px 10px;margin-bottom:6px;transition:border-color .15s}
.pf14-frrow:hover{border-color:rgba(62,123,250,.35)}
.pf14-frrow img{width:32px;height:32px;border-radius:8px;background:#0a0d14;object-fit:cover;object-position:top}
.pf14-frrow b{font-size:12.5px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf14-frrow .on{width:7px;height:7px;border-radius:50%;background:#3fbf7f;box-shadow:0 0 7px #3fbf7f;flex:0 0 auto}
.pf14-mini{font-family:'proxima',Verdana,sans-serif;font-weight:bold;background:#1a2231;border:1px solid #313d52;color:#c3d0ea;border-radius:7px;padding:5px 11px;font-size:9.5px;letter-spacing:1px;cursor:pointer;text-transform:uppercase}
.pf14-mini.go{background:rgba(63,191,127,.16);border-color:rgba(120,220,170,.45);color:#7ce0ac}
.pf14-mini.x{background:rgba(224,86,86,.12);border-color:rgba(224,86,86,.4);color:#ff9ba3}
.pf14-add{display:flex;gap:7px;margin-bottom:9px}
.pf14-add input{flex:1;min-width:0}
.pf14-xpbig{margin-top:4px}
.pf14-xpbig .lab{display:flex;justify-content:space-between;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#9aa5bd;letter-spacing:1px;margin-bottom:5px}
.pf14-xpbig .lab b{color:#e8edf6;font-size:14px;font-family:'torus','titan-one',sans-serif;font-weight:normal;letter-spacing:1px}
.pf14-xpbig .bar{height:10px;border-radius:6px;background:#0d1119;border:1px solid #232b3a;overflow:hidden}
.pf14-xpbig .bar i{display:block;height:100%;background:linear-gradient(90deg,#3e7bfa,#6fa0ff);box-shadow:0 0 10px rgba(62,123,250,.5);transition:width .6s ease}
.pf14-xpbig .next{font-family:'proxima',Verdana,sans-serif;font-size:10.5px;color:#626e88;margin-top:6px}
.pf14-rankbig{display:flex;align-items:center;gap:14px}
.pf14-rankbig .rk-svg{width:62px;height:62px;flex:0 0 auto;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}
.pf14-rankbig .i{display:flex;flex-direction:column;align-items:flex-start;gap:3px;flex:1;min-width:0}
.pf14-rankbig .i b{font-family:'torus','titan-one',sans-serif;font-weight:normal;font-size:21px;letter-spacing:1px}
.pf14-rankbig .i small{font-family:'proxima',Verdana,sans-serif;font-size:11px;color:#9aa5bd}
.pf14-divbar{height:8px;border-radius:6px;background:#0d1119;border:1px solid #232b3a;overflow:hidden;margin-top:8px}
.pf14-divbar i{display:block;height:100%;background:linear-gradient(90deg,var(--rk-col,#f6c453),rgba(255,255,255,.35));transition:width .6s ease}
.pf14-divlab{display:flex;justify-content:space-between;font-family:'proxima',Verdana,sans-serif;font-size:9.5px;color:#626e88;letter-spacing:1px;margin-top:4px;text-transform:uppercase}
.pf14-statgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:7px}
.pf14-hrow{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.13);border-radius:9px;padding:7px 10px;margin-bottom:5px;font-family:'proxima',Verdana,sans-serif;font-size:12px;animation:p14in .25s ease both}
.pf14-hrow .pl{width:30px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:11px;background:#1a2231;border:1px solid #313d52;color:#c3d0ea;flex:0 0 auto}
.pf14-hrow .pl.w{background:rgba(63,191,127,.16);border-color:rgba(120,220,170,.45);color:#7ce0ac}
.pf14-hrow .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;line-height:1.35}
.pf14-hrow .i b{font-size:11.5px}
.pf14-hrow .i small{font-size:9.5px;color:#626e88}
.pf14-hrow .g{display:flex;flex-direction:column;align-items:flex-end;line-height:1.3;flex:0 0 auto}
.pf14-hrow .g b{color:#7ce0ac;font-size:12px}
.pf14-hrow .g small{color:#626e88;font-size:9.5px}
.pf14-ach{display:flex;flex-direction:column;gap:6px}
.pf14-achrow{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.13);border-radius:9px;padding:7px 10px}
.pf14-achrow.done{border-color:rgba(63,191,127,.35);background:rgba(63,191,127,.06)}
.pf14-achrow .ic{width:30px;height:30px;border-radius:8px;background:#1a2231;border:1px solid #313d52;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.pf14-achrow.done .ic{background:rgba(63,191,127,.2);border-color:rgba(120,220,170,.5)}
.pf14-achrow .ic svg{width:16px;height:16px}
.pf14-achrow .i{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:3px}
.pf14-achrow .i b{font-size:12px}
.pf14-achrow .i small{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#626e88}
.pf14-achrow .i .pbar{width:100%;height:5px;border-radius:4px;background:#0d1119;border:1px solid #232b3a;overflow:hidden}
.pf14-achrow .i .pbar i{display:block;height:100%;background:linear-gradient(90deg,#3e7bfa,#6fa0ff)}
.pf14-achrow .st{font-family:'proxima',Verdana,sans-serif;font-size:10px;color:#626e88;flex:0 0 auto}
.pf14-achrow.done .st{color:#7ce0ac}
.pf14-share{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.pf14-share input{flex:1;min-width:150px;color:#9aa5bd;font-size:11px}
.pf14-sicon{width:30px;height:30px;border-radius:8px;background:#1a2231;border:1px solid #313d52;color:#c3d0ea;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;text-decoration:none;transition:all .15s}
.pf14-sicon:hover{border-color:#3e7bfa;color:#fff;transform:translateY(-2px)}
.pf14-kv{display:flex;justify-content:space-between;gap:10px;font-family:'proxima',Verdana,sans-serif;font-size:12px;padding:6px 2px;border-bottom:1px solid rgba(35,43,58,.6)}
.pf14-kv:last-child{border-bottom:0}
.pf14-kv span{color:#626e88}
.pf14-kv b{color:#c3d0ea;font-weight:bold}
/* modals */
#mp-modal{position:fixed;inset:0;z-index:99995;display:flex;align-items:center;justify-content:center;background:rgba(4,7,14,.66);backdrop-filter:blur(3px)}
#mp-modal.none{display:none}
.m13{width:min(470px,92vw);max-height:min(580px,88vh);display:flex;flex-direction:column;gap:11px;padding:16px;animation:p14mod .2s ease}
.m13.wide{width:min(620px,94vw)}
@keyframes p14mod{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.m13-h{display:flex;align-items:center}
.m13-h h3{margin:0;font-size:15px}
.m13-x{margin-left:auto;background:#1a2231;border:1px solid #313d52;border-radius:8px;color:#c3d0ea;width:30px;height:30px;cursor:pointer;font-size:13px;padding:0}
.m13-x:hover{background:rgba(224,86,86,.2);color:#ff9ba3;border-color:rgba(224,86,86,.5)}
.m13-list{overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:120px;flex:1}
.m13-row{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,150,220,.13);border-radius:10px;padding:8px 11px;transition:border-color .15s}
.m13-row:hover{border-color:rgba(62,123,250,.4)}
.m13-row img{width:38px;height:38px;border-radius:9px;background:#0a0d14}
.m13-row .i{flex:1;min-width:0}
.m13-row b{display:block;font-size:13px}
.m13-row small{color:#9aa5bd;font-family:'proxima',Verdana,sans-serif;font-size:10.5px;display:flex;align-items:center;gap:5px}
.m13-row small .on{width:7px;height:7px;border-radius:50%;background:#3fbf7f;box-shadow:0 0 6px #3fbf7f;display:inline-block}
.m13-row button{padding:7px 13px;font-size:10.5px}
.m13-row button.mq-btn{padding:7px 13px;font-size:10.5px}
.m13-empty{text-align:center;color:#9aa5bd;font-family:'proxima',Verdana,sans-serif;font-size:12px;padding:20px}
.m13-note{font-family:'proxima',Verdana,sans-serif;font-size:11px;color:#626e88;line-height:1.5}
/* invite banner */
#mp-banner{position:fixed;top:12px;left:50%;transform:translate(-50%,-170%);transition:transform .35s cubic-bezier(.2,.8,.3,1.1);z-index:99996;pointer-events:auto}
#mp-banner.on{transform:translate(-50%,0)}
.bn-in{display:flex;align-items:center;gap:11px;background:linear-gradient(180deg,#141a26,#10141d);border:1px solid rgba(246,196,83,.45);border-radius:13px;padding:10px 13px;box-shadow:0 14px 36px rgba(0,0,0,.55)}
.bn-in img{width:42px;height:42px;border-radius:10px;background:#0a0d14;object-fit:cover;object-position:top}
.bn-in .tx{font-family:'proxima',Verdana,sans-serif;font-size:12px;color:#e8edf6;max-width:300px}
.bn-in .tx b{color:#ffdf8a}
.bn-in .tx small{display:block;color:#9aa5bd;font-size:10.5px;margin-top:2px}
.bn-go{background:linear-gradient(180deg,#3fbf7f,#27995f);border:1px solid rgba(120,220,170,.5);border-radius:9px;color:#fff;font-family:'proxima',Verdana,sans-serif;font-weight:bold;letter-spacing:1px;font-size:12px;text-transform:uppercase;padding:9px 18px;cursor:pointer}
.bn-go:hover{filter:brightness(1.1)}
.bn-x{background:#1a2231;border:1px solid #313d52;border-radius:8px;color:#c3d0ea;width:30px;height:30px;cursor:pointer;padding:0}
.bn-x:hover{color:#fff;border-color:#3d4c68}
/* notifications */
#mp-notifs{position:fixed;left:16px;bottom:86px;display:flex;flex-direction:column;gap:6px;z-index:99992;pointer-events:none}
.mp-ntf{background:rgba(10,14,22,.9);border:1px solid #313d52;border-left:3px solid #3e7bfa;border-radius:10px;color:#dbe3f2;font-family:'proxima',Verdana,sans-serif;font-size:12px;padding:8px 13px;animation:p14ntf .3s ease;transition:opacity .4s,transform .4s;max-width:280px}
.mp-ntf.out{opacity:0;transform:translateX(-14px)}
@keyframes p14ntf{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}}
/* profile click layer + nametag variants (kept) */
#mp-pclick{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);width:44%;height:62%;display:none;z-index:2;pointer-events:auto;cursor:pointer}
.nt{opacity:var(--no,1)}
.nt.ns1{font-size:.82em}
.nt.ns2{font-size:1.32em}
.nt.np6{background:rgba(8,14,26,.8);padding:3px 17px;clip-path:polygon(11px 0,calc(100% - 11px) 0,100% 50%,calc(100% - 11px) 100%,11px 100%,0 50%);border:0!important;box-shadow:none!important}
.nt.np7{background:rgba(0,0,0,.5);padding:3px 15px;border:0!important;position:relative;box-shadow:none!important}
.nt.np7 .nn{position:relative;z-index:1}
.nt.np7::before{content:'';position:absolute;left:0;top:0;bottom:0;width:9px;border-left:3px solid var(--nc);border-top:3px solid var(--nc);border-bottom:3px solid var(--nc);border-radius:3px 0 0 3px}
.nt.np7::after{content:'';position:absolute;right:0;top:0;bottom:0;width:9px;border-right:3px solid var(--nc);border-top:3px solid var(--nc);border-bottom:3px solid var(--nc);border-radius:0 3px 3px 0}
.nt.np8{background:linear-gradient(180deg,var(--nc),rgba(0,0,0,.4));padding:3px 16px;border-radius:4px 4px 12px 12px;border:0!important;box-shadow:0 3px 0 rgba(0,0,0,.5)!important;color:#fff!important;text-shadow:0 1px 2px rgba(0,0,0,.7)}
.nt.nf5 .nn{-webkit-text-stroke:1.1px rgba(0,0,0,.85);paint-order:stroke fill}
.nt.nf6{animation:mqfl 2.4s steps(2) infinite}
@keyframes mqfl{0%,86%{opacity:var(--no,1)}91%{opacity:calc(var(--no,1) * .3)}95%{opacity:calc(var(--no,1) * .9)}100%{opacity:var(--no,1)}}
.nt.nf7 .nn{display:inline-block;animation:mqbn 1.7s ease-in-out infinite}
@keyframes mqbn{0%,100%{transform:translateY(0)}50%{transform:translateY(-3.5px)}}
.nt[style*="--nu"] .nn{background-image:linear-gradient(var(--nu),var(--nu));background-size:100% 3px;background-position:0 100%;background-repeat:no-repeat;padding-bottom:3px}
.nt .nbd{font-style:normal;display:inline-flex;align-items:center}
.nt .nbd .bdg{width:1.15em;height:1.15em;vertical-align:-.2em;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55))}
.sthc{width:1.05em;height:1.05em;margin-right:4px;vertical-align:-.12em;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.mp-lbl.mp-mine{display:flex;align-items:center;justify-content:center;border:0!important;background:none!important;padding:0!important;transform:translate(-50%,-100%);text-shadow:0 2px 4px rgba(0,0,0,.8);font-size:15px}
.nrk{display:inline-flex;align-items:center;margin-right:2px;font-style:normal}
.nrk .rk-svg{width:1.05em;height:1.05em;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.rk-svg-wrap{display:inline-flex;font-style:normal}
.rk-svg-wrap .rk-svg{width:14px;height:14px}
.rk-inline{display:inline-flex;vertical-align:-2px;font-style:normal}
.rk-inline .rk-svg{width:13px;height:13px}

/* responsive */
@media(max-width:1080px){
  .p14-body{grid-template-columns:1fr 1fr;grid-template-areas:"c c" "l r"}
  .p14-l{grid-area:l}.p14-r{grid-area:r}.p14-c{grid-area:c;min-height:320px}
  .pf14-grid{grid-template-columns:1fr}
  .pf14-tiles{min-width:0;width:100%}
  .pf14-head{flex-wrap:wrap}
  .f14-left{width:min(280px,40vw)}
  .f14-party{width:min(280px,40vw)}
}
@media(max-width:860px){
  .p14-body{grid-template-columns:1fr;grid-template-areas:"c" "l" "r"}
  .p14-center{min-height:300px}
  .f14{padding:10px}
  .f14-left,.f14-party{position:relative;width:100%;max-height:36vh}
  .f14-go{position:relative;width:100%;left:0;right:0}
  .f14-cam{display:none}
  .fnk-locker{grid-template-columns:1fr;height:auto}
  .p14-nav .p14-tabs{display:none}
  .mq-lb.wide{flex-direction:column}
  .mq-win{flex:0 0 auto}
}

`;

  // ================================================================== v13 ===
  var ICO = {
    drop: '<svg viewBox="0 0 24 24"><path d="M12 3v9M12 12l-3.5-3.5M12 12l3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18.4" r="2.7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    door: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="14.8" cy="12" r="1.5" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8.5 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="7" y="5.5" width="3.6" height="13" rx="1" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1" fill="currentColor"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="M12 2.5v19M2.5 12h19M12 2.5l-2.6 2.6M12 2.5l2.6 2.6M12 21.5l-2.6-2.6M12 21.5l2.6-2.6M2.5 12l2.6-2.6M2.5 12l2.6 2.6M21.5 12l-2.6-2.6M21.5 12l-2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    users: '<svg viewBox="0 0 24 24" class="ico"><circle cx="9" cy="8.2" r="3.4" fill="none" stroke="#cfe0ff" stroke-width="1.8"/><path d="M2.6 19.2c.6-3.6 3.2-5.4 6.4-5.4s5.8 1.8 6.4 5.4" fill="none" stroke="#cfe0ff" stroke-width="1.8"/><path d="M16.4 5.4a3.4 3.4 0 0 1 0 5.7M21.4 19.2c-.4-2.4-1.7-4-3.6-4.8" fill="none" stroke="#cfe0ff" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  var invRows = [], invQ = '', profJob = '', profBack = 'home', lobbyRosOpen = false;
  var profView = null;   // Poki14: character shown in the profile 3D viewer
  var frOn = { }, frOnT = 0, bannerT = null;

  function notif(t) {
    var el = document.getElementById('mp-notifs'); if (!el) return;
    var d = document.createElement('div'); d.className = 'mp-ntf'; d.textContent = t; el.appendChild(d);
    while (el.children.length > 3) el.removeChild(el.firstChild);
    setTimeout(function () { d.classList.add('out'); setTimeout(function () { try { d.remove(); } catch (e) { } }, 450); }, 4200);
  }

  function showModal(html) { var m = document.getElementById('mp-modal'); if (!m) return; if (m.innerHTML !== html) m.innerHTML = html; m.className = ''; }
  function hideModal() { var m = document.getElementById('mp-modal'); if (m) { m.className = 'none'; m.innerHTML = ''; } }

  function showCoOwn(uid) {
    if (!room) return;
    if (!canManage()) { toast('Only the host (or a co-owner with permission) can manage co-owners', 2400); return; }
    if (uid === me.uid || uid === room.host) { toast('The host cannot be a co-owner', 2000); return; }
    var p = players[uid] || { };
    var cur = coOwners()[uid] || [];
    var rows = PERMS.map(function (pm) {
      var on = cur.indexOf(pm[0]) >= 0;
      return '<div class="permrow"><div style="flex:1;min-width:0"><b>' + esc(pm[1]) + '</b><small>' + esc(pm[2]) + '</small></div>' +
        '<button class="f14-switch' + (on ? ' on' : '') + '" data-act="perm18" data-uid="' + esc(uid) + '" data-k="' + pm[0] + '"><i></i></button></div>';
    }).join('');
    showModal('<div class="m13"><div class="m13-h"><h3>CO-OWNER \u00B7 ' + esc(p.name || uid) + '</h3><button class="m13-x" data-act="optsclose">\u2715</button></div>' +
      '<div class="mq-note">Co-owners keep their role until you remove every permission. Changes apply instantly for everyone.</div>' +
      '<div style="margin-top:4px">' + rows + '</div>' +
      '<div class="m13-note">Tip: remove all permissions to revoke co-owner status.</div></div>');
  }
  // ---- admin claim host (owner) + stand-in host for persistent lobbies
  function rkClaimHost() {
    if (!net || !room || room.host === me.uid) { toast('You already host this lobby', 1800); return; }
    if (!(W.MP18 && W.MP18.admin.isOwner()) && !(room.persist && room.standIn && can('start'))) { toast('Only the host can do that', 2200); return; }
    try { net.setRoom({ host: me.uid, standIn: 0 }); } catch (e) { toast('Could not claim host', 2000); return; }
    isHost = true;
    if (W.MP18 && room.persist) W.MP18.persist.touch(code, { host: me.name || '', hostKey: (W.MPAcc && MPAcc.user() || {}).key || '' });
    showLobby(); toast('You are now the host', 2000);
  }
  function showInvite() {
    if (!W.MPSocial) { toast('Social layer unavailable', 2000); return; }
    showModal('<div class="m13"><div class="m13-h"><h3>INVITE PLAYERS</h3><button class="m13-x" data-act="optsclose">\u2715</button></div>' +
      '<input type="text" id="mp-iq" placeholder="Search players\u2026" autocomplete="off">' +
      '<div class="m13-list mq-scroll" id="mp-ilist"><div class="m13-empty">Loading players\u2026</div></div>' +
      '<div class="m13-note">Invited players get a banner with a JOIN button. You can also share the lobby code.</div></div>');
    MPSocial.allPlayers(function (rows) { invRows = rows || []; paintInviteList(); });
  }
  function paintInviteList() {
    var el = document.getElementById('mp-ilist'); if (!el) return;
    var q = (invQ || '').trim().toLowerCase();
    var arr = invRows.filter(function (r) { return !q || (r.n || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 40);
    if (!arr.length) { el.innerHTML = '<div class="m13-empty">No players found' + (q ? ' for \u201C' + esc(q) + '\u201D' : ' yet \u2013 invite friends to create accounts!') + '</div>'; return; }
    el.innerHTML = arr.map(function (r) {
      return '<div class="m13-row"><img src="' + preview(r.ch) + '" alt="">' +
        '<div class="i"><b>' + esc(r.n) + '</b><small>' + (r.online ? '<span class="on"></span>online' + (r.lobby ? ' \u00B7 lobby ' + esc(r.lobby) : '') : 'offline') + ' \u00B7 ' + num(r.pts) + ' RP</small></div>' +
        '<button class="mq-btn sm pri" data-act="invsend" data-key="' + esc(r.key) + '" data-n="' + esc(r.n) + '">INVITE</button></div>';
    }).join('');
  }


  // ============================== POKI18: developer admin console (Brune) ====
  var admTab = 'badges', admUser = '', admRows = [], admBadgeList = [], admUserBadges = [];
  function showAdmin(tab, msg) {
    if (!W.MP18 || !W.MP18.admin.isOwner()) {
      // Logged in as the developer account but the backend grant is not confirmed
      // yet? Re-check live (writes mp-admin/grants/brune and reads it back). If the
      // database rules still block the mp-admin node, say exactly how to fix it.
      var u18 = W.MPAcc && W.MPAcc.user();
      var ownerKey18 = (W.MP18.admin && W.MP18.admin.OWNER_KEY) || 'brune';
      if (u18 && u18.key === ownerKey18 && Date.now() - (showAdmin._retTry || 0) > 8000) {
        showAdmin._retTry = Date.now();
        toast('Re-checking the developer grant with the backend\u2026', 2200);
        W.MP18.admin.ensureGrant().then(function () { return W.MP18.admin.refresh(); }).then(function (ok) {
          if (ok) { toast('Developer grant confirmed by the backend', 2400); showAdmin(tab, msg); }
          else toast('Backend grant missing. Firebase console -> Realtime Database -> Rules -> paste database.rules.json (adds the mp-admin node) -> Publish, then reload the game.', 6500);
        }).catch(function () { toast('Could not reach the database to verify the developer grant', 3200); });
        return;
      }
      toast(!u18 ? 'Developer access is authorised by the backend only - log in with the Brune account first'
                 : 'Developer access is authorised by the backend only - this account is not the authorised developer', 3400);
      return;
    }
    admTab = tab || admTab;
    admBadgeList = (W.MP18.badges.custom || []).slice();   // always reflect the live badge store
    phase = phase === 'admin' ? phase : phase;
    var tabs = [['badges', 'Badge studio'], ['assign', 'Assign badges'], ['lobbies', 'Lobby control']].map(function (x) { return '<button class="atab' + (admTab === x[0] ? ' on' : '') + '" data-act="atab" data-tab="' + x[0] + '">' + x[1] + '</button>'; }).join('');
    var body = '';
    if (admTab === 'badges') {
      var list = admBadgeList.map(function (b) {
        return '<div class="m13-row"><span style="width:34px;height:34px;display:flex;align-items:center;justify-content:center">' + MP18_customBadgeSvg(b) + '</span>' +
          '<div class="i"><b>' + esc(b.n) + '</b><small>id ' + esc(b.id) + ' \u00B7 by ' + esc(b.by || '?') + '</small></div>' +
          '<button class="mq-btn sm danger" data-act="delbadge" data-id="' + esc(b.id) + '">DELETE</button></div>';
      }).join('') || '<div class="m13-empty">No custom badges yet.</div>';
      var icoPick = ['crown', 'star', 'flame', 'bolt', 'gem', 'medal', 'shield', 'spark', 'g50', 'g100', 'g500', 'w25', 'w100', 'lvl', 'goldrk'].map(function (ic, ix) { return '<i class="' + (admNewIco === ic ? 'sel' : '') + '" data-act="admico" data-ic="' + ic + '">' + MP18_customBadgeSvg({ ico: ic, col: admNewCol }) + '</i>'; }).join('');
      var colPick = ['#ffd23f', '#ff5252', '#ff9100', '#69f0ae', '#40c4ff', '#b26bff', '#ffffff', '#e23b4e'].map(function (cc) { return '<i class="' + (admNewCol === cc ? 'sel' : '') + '" data-act="admcol" data-col="' + cc + '"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + cc + '"></span></i>'; }).join('');
      body = '<div class="a17-sec"><small class="ttl">Create a badge</small>' +
        '<div style="display:flex;gap:7px;margin-bottom:8px"><input type="text" id="mp-nb-name" maxlength="18" placeholder="Badge name" style="flex:1"><button class="mq-btn sm pri" data-act="mkbadge">CREATE</button></div>' +
        '<div class="mq-lab" style="margin:2px 2px 4px">Icon</div><div class="apick">' + icoPick + '</div>' +
        '<div class="mq-lab" style="margin:8px 2px 4px">Colour</div><div class="apick">' + colPick + '</div></div>' +
        '<div class="mq-sec" style="margin-top:10px">Existing custom badges</div><div class="m13-list mq-scroll">' + list + '</div>';
    } else if (admTab === 'assign') {
      var pick = admBadgeList.map(function (b) {
        var on = admUserBadges.indexOf(b.id) >= 0;
        return '<div class="permrow"><div style="flex:1;min-width:0"><b>' + esc(b.n) + '</b><small>' + esc(b.id) + '</small></div>' +
          '<button class="mq-btn sm ' + (on ? '' : 'pri') + '" data-act="assignb" data-id="' + esc(b.id) + '">' + (on ? 'REMOVE' : 'GRANT') + '</button></div>';
      }).join('') || '<div class="m13-empty">Create badges first.</div>';
      var rows = admRows.map(function (r) { return '<div class="m13-row" style="cursor:pointer" data-act="admuser" data-key="' + esc(r.key) + '"><img src="' + preview(r.ch) + '"><div class="i"><b>' + esc(r.n) + '</b><small>' + num(r.pts) + ' RP' + (r.key === admUser ? ' \u00B7 SELECTED' : '') + '</small></div></div>'; }).join('') || '<div class="m13-empty">Loading players\u2026</div>';
      body = '<div class="mq-lab" style="margin-top:0">Player: ' + (admUser ? esc(admUser) : 'pick one below') + '</div>' +
        '<input type="text" id="mp-iq" placeholder="Search players\u2026" autocomplete="off" oninput="void 0">' +
        '<div class="m13-list mq-scroll" style="max-height:130px">' + rows + '</div>' +
        '<div class="mq-sec">Custom badges for ' + (admUser ? esc(admUser) : '-') + '</div><div>' + pick + '</div>';
    } else {
      var lb = admRows.map(function (r) { }).join('');
      var live = (W.MP18 ? [] : []);
      // live lobbies from the browser listing (startList keeps them fresh)
      var items = lobbies.map(function (l) {
        return '<div class="m13-row"><img src="' + preview(l.hc || 'jake') + '"><div class="i"><b>' + esc(l.name || 'Lobby') + '</b><small>' + esc(l.code) + ' \u00B7 host ' + esc(l.host || '?') + ' \u00B7 ' + (l.count || 0) + '/' + (l.max || 8) + ' \u00B7 ' + esc(l.status) + '</small></div>' +
          '<button class="mq-btn sm gold" data-act="admjoin" data-code="' + esc(l.code) + '">JOIN + HOST</button></div>';
      }).join('') || '<div class="m13-empty">No live lobbies found. Open the lobby browser once so the list is fresh.</div>';
      body = '<div class="mq-note">Join any lobby and instantly take over as host. Requires you to be logged in as the authorised developer.</div>' +
        '<div class="m13-list mq-scroll">' + items + '</div>' +
        '<div class="mq-note">In a lobby the CLAIM HOST button appears for you automatically.</div>';
    }
    showModal('<div class="m13 tabs wide"><div class="m13-h"><h3>DEVELOPER CONSOLE</h3><button class="m13-x" data-act="optsclose">\u2715</button></div>' +
      '<div class="atabs">' + tabs + '</div>' + (msg ? '<div class="mq-note" style="color:#7ce0ac">' + esc(msg) + '</div>' : '') + body + '</div>');
    if (admTab === 'assign' && W.MPSocial && !showAdmin._busy) {
      showAdmin._busy = true;
      MPSocial.allPlayers(function (rows) {
        showAdmin._busy = false;
        var sig = JSON.stringify((rows || []).map(function (r2) { return r2.key; }).sort());
        if (sig !== showAdmin._psig) { showAdmin._psig = sig; admRows = rows || []; if (admTab === 'assign') showAdmin(admTab); }
      });
    }
  }
  // DevTools hook: type MP18.admin.open() in the browser console (F12) to open
  // the developer console directly. Same owner-only gate as the settings button,
  // so non-owners just get the usual "authorised by the backend" toast.
  try { if (W.MP18 && W.MP18.admin && !W.MP18.admin.open) W.MP18.admin.open = function (tab, msg) { return showAdmin(tab, msg); }; } catch (e) {}
  var admNewIco = 'crown', admNewCol = '#ffd23f';
  function admMakeBadge() {
    var nm = (document.getElementById('mp-nb-name') || {}).value || '';   // modal lives outside #mp-ov
    if (!nm) { toast('Give the badge a name', 1800); return; }
    W.MP18.admin.createBadge(nm, { n: nm, ico: admNewIco, col: admNewCol }).then(function () {
      toast('Badge created: ' + nm, 2200); return W.MP18.badges.refreshCustom();
    }).then(function () { MP18_custom = W.MP18.badges.custom.slice(); showAdmin('badges', 'Badge created.'); })
      .catch(function (e) { toast(e.message || e, 2600); });
  }

  function showBanner(b) {
    var el = document.getElementById('mp-banner'); if (!el) return;
    var rkb = b && b.ranked ? '<div class="tx"><b>' + esc(b.from || 'A player') + '</b> challenges you to a RANKED DUEL!<small>' + esc((b.mode === 'nocoin' ? 'No Coin' : 'Coin') + ' mode \u00B7 code ' + b.code) + '</small></div>' : '';
    el.innerHTML = '<div class="bn-in"' + (b && b.ranked ? ' style="border-color:rgba(255,210,63,.7)"' : '') + '><img src="' + preview((players[b.key] || { }).char || 'jake') + '" alt="">' +
      (rkb || ('<div class="tx"><b>' + esc(b.from || 'A player') + '</b> invited you to their lobby!<small>Code ' + esc(b.code) + (b.lobby ? ' \u00B7 ' + esc(b.lobby) : '') + '</small></div>')) +
      '<button class="bn-go" data-act="bannergo" data-code="' + esc(b.code) + '" data-id="' + esc(b.id || '') + '">JOIN</button>' +
      '<button class="bn-x" data-act="bannerx" data-id="' + esc(b.id || '') + '">\u2715</button></div>';
    el.classList.add('on');
    try { notif((b.from || 'A player') + ' invited you to ' + b.code); } catch (e) { }
    clearTimeout(bannerT); bannerT = setTimeout(hideBanner, 15000);
  }
  function hideBanner() { var el = document.getElementById('mp-banner'); if (el) { el.classList.remove('on'); } }

  function humanSpan(ms) {
    if (!(ms > 0)) return '\u2014';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
  }

  function renderFriends() {
    var el = document.getElementById('mp-frp'); if (!el || !W.MPSocial) return;
    var u = W.MPAcc && MPAcc.user();
    var head = '<div class="p14-ph">' + ICO.users + ' Friends<span class="cnt" id="fr-cnt"></span></div>';
    if (!u) { el.innerHTML = head + '<div class="mq-empty" style="border:0;padding:12px">Log in to add friends and see who is online.</div>'; return; }
    var frs = MPSocial.friends(), rq = MPSocial.requestsIn(), out = MPSocial.requestsOut();
    function row(k, n, online, btns) {
      return '<div class="pf14-frrow"><img src="' + preview((players[k] || { }).char || 'jake') + '" alt="">' +
        '<b>' + esc(n || k) + '</b>' + (online ? '<i class="on"></i>' : '') + (btns || '') + '</div>';
    }
    if (Date.now() - frOnT > 4500) {
      frOnT = Date.now();
      try { MPSocial.online(function (rows) { frOn = { }; (rows || []).forEach(function (r3) { frOn[r3.key] = 1; }); if (phase === 'home') { renderFriendsSafed(); } }); } catch (e) { }
    }
    var html = head +
      '<div class="pf14-add" style="padding:2px 9px 4px"><input type="text" id="mp-frn" maxlength="14" placeholder="Add by username&hellip;"><button class="mq-btn sm pri" data-act="fradd" title="Send request">+</button></div>';
    if (rq.length) html += '<div class="mq-sec" style="margin:8px 10px 4px">Requests</div>' + rq.map(function (r2) { return row(r2.key, r2.n, frOn[r2.key], '<button class="pf14-mini go" data-act="facc" data-key="' + esc(r2.key) + '" title="Accept">&#10003;</button><button class="pf14-mini x" data-act="fdec" data-key="' + esc(r2.key) + '" title="Decline">&#10005;</button>'); }).join('');
    if (out.length) html += '<div class="mq-sec" style="margin:8px 10px 4px">Sent</div>' + out.map(function (r2) { return row(r2.key, r2.n, false, '<small class="mq-note" style="margin-right:6px">pending</small>'); }).join('');
    html += '<div class="mq-sec" style="margin:8px 10px 4px">My friends' + (frs.length ? ' (' + frs.length + ')' : '') + '</div>';
    html += frs.length ? frs.map(function (r2) { return row(r2.key, r2.n, frOn[r2.key], '<button class="pf14-mini" data-act="profview" data-key="' + esc(r2.key) + '">VIEW</button><button class="pf14-mini x" data-act="frem" data-key="' + esc(r2.key) + '" title="Remove">&#10005;</button>'); }).join('')
      : '<div class="mq-note" style="padding:6px 10px 10px">No friends yet. Add someone by username!</div>';
    el.innerHTML = html;
    var cnt = document.getElementById('fr-cnt'); if (cnt) cnt.textContent = frs.length ? String(frs.length) : '';
  }
  function renderFriendsSafed() { try { renderFriends(); } catch (e) { } }

  function showProfile(key, err) {
    var acc0 = W.MPAcc && MPAcc.user();
    key = key || (acc0 && acc0.key);
    if (!key) { authMode = 'login'; showAuth(); return; }
    phase = 'profile'; custOpen = false; stopList(); hideModal();
    profView = { key: key, char: 'jake', name: String(key), ot: 0, pts: 0 };
    loadChar('jake');
    STG.lift = false; STG.paused = false; STG.spin = false;
    setOv('<div class="pf14">' +
      '<button class="mq-btn sm pf14-back" data-act="profback">&larr; BACK</button>' +
      '<div class="pf14-head">' +
      '<div class="pf14-viewer"><div class="pf14-vwin" data-act="profclick" title="Lift / drop"></div><div class="pf14-liftchip" data-act="profclick">CLICK TO LIFT</div></div>' +
      '<div class="p14-panel pf14-idpanel"><div class="pf14-id"><div class="pf14-kicker">Player profile</div>' +
      '<h1 class="pf14-name">' + esc(profView.name) + '</h1>' +
      '<div class="pf14-idrow"><span>ID</span><b>' + esc(key) + '</b>' +
      '<button class="pf14-copyid" data-act="copyid" data-key="' + esc(key) + '"><svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16" fill="none" stroke="currentColor" stroke-width="2"/></svg>COPY</button></div>' +
      '<div class="pf14-chips" id="pf-chips"></div>' +
      '<div class="pf14-bio" id="pf-bio"></div></div>' +
      '<div class="pf14-tiles" id="pf-tiles"></div>' +
      '</div></div>' +
      '<div class="pf14-grid mq-scroll"><div class="pf14-col" id="pf-left"></div><div class="pf14-col" id="pf-right"></div></div>' +
      '</div>', 'stg');
    var job = key + '|' + Math.random();
    profJob = job;
    Promise.all([
      W.MPSocial ? MPSocial.profileOf(key) : Promise.resolve({ profile: { }, friends: [], friendsCount: 0, created: 0, online: false }),
      (W.MPAcc && MPAcc.board('pts', 600)) || Promise.resolve({ rows: [], all: [] }),
      own(key) && W.MPAcc ? MPAcc.refresh() : Promise.resolve(null)
    ]).then(function (r) {
      if (phase !== 'profile' || profJob !== job) return;
      paintProfile(key, own(key), r[0], r[1]);
    }).catch(function (e2) {
      if (phase !== 'profile' || profJob !== job) return;
      var el = document.getElementById('pf-right');
      if (el) el.innerHTML = '<div class="p14-panel" style="padding:14px;color:#ff9ba3">Could not load profile: ' + esc(e2.message || e2) + '</div>';
    });
  }
  function own(key) { var u = W.MPAcc && W.MPAcc.user(); return !!u && u.key === key; }
  function ago(ts) {
    var s = (Date.now() - (ts || 0)) / 1000; if (!(s > 0)) return '\u2014';
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function paintProfile(key, isOwn, sp, lbres) {
    var prof = sp.profile || { }, ap = isOwn ? ((W.MPAcc.profile && W.MPAcc.profile()) || prof) : prof;
    var pts = ap.pts | 0, rk = W.MPAcc ? MPAcc.rankOf(pts) : null;
    var lv = W.MPAcc ? MPAcc.levelOf(ap.xp | 0) : { lvl: 1, cur: 0, need: 1000, pct: 0 };
    var DIVN = ['I', 'II', 'III'];
    var pos = null;
    ((lbres && lbres.all) || []).forEach(function (r2) { if (r2.key === key) pos = r2.pos; });
    if (!pos && (lbres && lbres.rows)) (lbres.rows).forEach(function (r2) { if (r2.key === key) pos = r2.pos; });
    var created = sp.created || ap.c0 || 0;
    var age = created ? humanSpan(Math.max(0, Date.now() + (W.MP_SERVER_OFF || 0) - created)) : '\u2014';
    var races = ap.r | 0, wins = ap.w | 0, wr = races ? Math.round(wins / races * 100) : 0;
    var ch = isOwn ? (me.char || 'jake') : (ap.ch || 'jake');
    profView = { key: key, char: ch, name: ap.n || ap.u || key, ot: isOwn ? (me.ot | 0) : 0, pts: pts };
    loadChar(ch);
    // header chips + bio + tiles
    var chips = '';
    if (rk) chips += '<span class="mq-chip">' + rk.svg + '<span style="color:' + rk.color + '">' + esc(rk.name) + (rk.next ? ' ' + DIVN[rk.div - 1] : '') + '</span>&middot; ' + num(pts) + ' RP</span>';
    chips += '<span class="mq-chip on">LEVEL ' + lv.lvl + '</span>';
    if (sp.online) chips += '<span class="mq-chip ok"><i class="fr-on"></i>ONLINE</span>';
    chips += '<span class="mq-chip">' + esc(cname(ch)) + '</span>';
    // POKI18: account badges (OWNER crown, custom admin badges, earned)
    var ab18 = [];
    if (W.MP18) {
      try { W.MP18.badges.refreshCustom().then(function () { MP18_custom = W.MP18.badges.custom.slice(); }); } catch (e0b) { }
      ab18 = W.MP18.badges.forProfile(key, ap, sp.created || created);
      // POKI19 fix: custom badge assignments arrive from the backend asynchronously,
      // so re-render the badge chips and the Account badges panel when they land.
      try {
        if (W.MP18.badges._wk !== key) { W.MP18.badges._wk = key; W.MP18.badges.watchUser(key); }
        if (W.MP18.badges._wk2 !== key) {
          W.MP18.badges._wk2 = key;
          W.MP18.admin.userBadges(key, function (ids) {
            if (!profView || profView.key !== key || phase !== 'profile') return;
            W.MP18.badges.userCustom[key] = ids || [];
            var ab2 = W.MP18.badges.forProfile(key, ap, sp.created || created);
            var chipEl2 = document.getElementById('pf-chips');
            if (chipEl2) chipEl2.innerHTML = chips + ab2.slice(0, 3).map(function (b) { return W.MP18.badges.chipHtml(b).replace('<span class="abchip', '<span class="abchip ' + (b.owner ? 'ab-owner' : '') + '"'); }).join('');
            var abPanel2 = document.getElementById('pf-badges');
            if (abPanel2) abPanel2.innerHTML = '<div class="pf14-ph">Account badges<span class="cnt">' + ab2.length + '</span></div>' +
              (ab2.length ? '<div class="abshelf">' + ab2.map(function (b) { return W.MP18.badges.chipHtml(b).replace('<span class="abchip', '<span class="abchip ' + (b.owner ? 'ab-owner' : '') + '"'); }).join('') + '</div>' : '<div class="mq-note" style="padding:2px 0 6px">No account badges earned yet &ndash; play races and grow your account to collect them.</div>');
          });
        }
      } catch (e18) { }
    }
    var chipEl = document.getElementById('pf-chips'); if (chipEl) chipEl.innerHTML = chips + ab18.slice(0, 3).map(function (b) { return W.MP18.badges.chipHtml(b).replace('<span class="abchip', '<span class="abchip ' + (b.owner ? 'ab-owner' : '') + '"'); }).join('');
    var bioEl = document.getElementById('pf-bio');
    if (bioEl) {
      var bio = String(ap.b || '');
      bioEl.innerHTML = isOwn
        ? '<textarea id="mp-bio" maxlength="160" placeholder="Tell other racers about yourself&hellip;">' + esc(bio) + '</textarea><button class="pf14-mini go" data-act="biosave" style="margin-top:7px">SAVE BIO</button>'
        : (bio ? esc(bio) : '<span style="color:#626e88">This player has not written a bio yet.</span>');
    }
    var tiles = [
      ['LEADERBOARD', pos ? '#' + pos : 'Unranked'], ['RANK POINTS', num(pts)], ['LEVEL', String(lv.lvl)],
      ['RACES', num(races)], ['WINS', num(wins)], ['WIN RATE', wr + '%']
    ].map(function (t2) { return '<div class="pf14-tile"><small>' + t2[0] + '</small><b>' + t2[1] + '</b></div>'; }).join('');
    var tileEl = document.getElementById('pf-tiles'); if (tileEl) tileEl.innerHTML = tiles;
    // ---------------- LEFT COLUMN ----------------
    var left = '';
    // character + skin history
    var skins = OUTFITS.map(function (nm, i) {
      var tex = 'assets/characters-idle/' + ch + '-tex' + (i ? '-' + i : '') + '.webp';
      return '<div class="pf14-skin' + ((isOwn ? (me.ot | 0) : 0) === i ? ' sel' : '') + '" ' + (isOwn ? 'data-act="proskin" data-i="' + i + '" title="Use this outfit"' : '') + '><img src="' + tex + '" alt="" onerror="this.style.visibility=\'hidden\'"><span>' + esc(nm) + '</span></div>';
    }).join('');
    left += '<div class="p14-panel"><div class="pf14-ph">Character</div>' +
      '<div class="pf14-curchar"><img src="' + preview(ch) + '" alt=""><div class="i"><b>' + esc(cname(ch)) + '</b><small>' + OUTFITS[isOwn ? (me.ot | 0) : 0] + ' outfit &middot; ' + esc(bname(me.board)) + ' board</small></div>' +
      '<span style="flex:1"></span><button class="pf14-mini" data-act="prodoor">EDIT IN LOCKER</button></div>' +
      '<div class="mq-sec">Skin history</div><div class="pf14-skins">' + skins + '</div>' +
      '<div class="pf14-skins-note">Outfits are unlocked styles for ' + esc(cname(ch)) + '. Click one to wear it.</div></div>';
    // cosmetics
    var curTT = isOwn ? me.tt : ((players[key] || prof.badge) || { tt: '' }).tt || '';
    var curTP = isOwn ? (me.tp | 0) : 0, curTF = isOwn ? (me.tf | 0) : 0;
    var curTC = isOwn ? (me.tc == null ? 0 : me.tc) : 0;
    var badges = BADGE_ICONS.map(function (bg) {
      return '<i class="fnk-badge' + (curTT === bg.id ? ' sel' : '') + '" title="' + esc(bg.name) + '">' + (bg.svg ? '<svg viewBox="0 0 24 24">' + bg.svg + '</svg>' : '<span style="color:#626e88;font-size:10px">NONE</span>') + '</i>';
    }).join('');
    var shelfHtml = ab18.length ? '<div class="abshelf">' + ab18.map(function (b) { return W.MP18.badges.chipHtml(b).replace('<span class="abchip', '<span class="abchip ' + (b.owner ? 'ab-owner' : '') + '"'); }).join('') + '</div>' : '<div class="mq-note" style="padding:2px 0 6px">No account badges earned yet \u2013 play races and grow your account to collect them.</div>';
    left += '<div class="p14-panel" id="pf-badges"><div class="pf14-ph">Account badges<span class="cnt">' + ab18.length + '</span></div>' + shelfHtml + '</div>';
    left += '<div class="p14-panel"><div class="pf14-ph">Cosmetics<span class="cnt">' + (BADGE_ICONS.length - 1) + ' badges</span></div>' +
      '<div class="pf14-cos">' + badges + '</div>' +
      '<div class="pf14-cosrow"><span class="lbl">Nametag plate</span><i class="fnk-pick' + (curTP === 0 ? ' sel' : '') + '">' + esc(PLATES[curTP] || 'None') + '</i></div>' +
      '<div class="pf14-cosrow"><span class="lbl">Text effect</span><i class="fnk-pick' + (curTF === 0 ? ' sel' : '') + '">' + esc(EFFECTS[curTF] || 'None') + '</i></div>' +
      '<div class="pf14-cosrow"><span class="lbl">Name colour</span><i class="pf14-sw' + (curTC === 0 ? '' : ' sel') + '" style="background:' + (NAMECOLS[curTC] || '#fff') + '"></i></div>' +
      (isOwn ? '' : '<div class="pf14-skins-note">Cosmetics are visible in lobbies and races.</div>') + '</div>';
    // social
    var friends = sp.friends || [];
    var frRows = friends.map(function (f2) {
      return '<div class="pf14-frrow"><img src="' + preview((players[f2.key] || { }).char || 'jake') + '" alt=""><b>' + esc(f2.n || f2.key) + '</b>' + (frOn[f2.key] ? '<i class="on"></i>' : '') +
        '<span style="flex:1"></span><button class="pf14-mini" data-act="profview" data-key="' + esc(f2.key) + '">VIEW</button>' +
        (isOwn ? '<button class="pf14-mini x" data-act="frem" data-key="' + esc(f2.key) + '">REMOVE</button>' : '') + '</div>';
    }).join('') || '<div class="mq-note" style="padding:2px 0 6px">No friends yet.</div>';
    var reqRows = isOwn && W.MPSocial ? MPSocial.requestsIn().map(function (r3) {
      return '<div class="pf14-frrow"><img src="' + preview('jake') + '" alt=""><b>' + esc(r3.n || r3.key) + '</b><span style="flex:1"></span>' +
        '<button class="pf14-mini go" data-act="facc" data-key="' + esc(r3.key) + '">ACCEPT</button><button class="pf14-mini x" data-act="fdec" data-key="' + esc(r3.key) + '">DECLINE</button></div>';
    }).join('') : '';
    left += '<div class="p14-panel"><div class="pf14-ph">Social<span class="cnt">' + (sp.friendsCount | 0) + ' friends</span></div>' +
      (isOwn ? '<div class="pf14-add"><input type="text" id="mp-frn" maxlength="14" placeholder="Add by username&hellip;"><button class="mq-btn sm pri" data-act="fradd">+</button></div>' : '') +
      frRows +
      (reqRows ? '<div class="mq-sec">Friended by &middot; pending</div>' + reqRows : '') + '</div>';
    var le = document.getElementById('pf-left'); if (le) le.innerHTML = left;
    // ---------------- RIGHT COLUMN ----------------
    var right = '';
    // progression
    right += '<div class="p14-panel"><div class="pf14-ph">Progression</div>' +
      '<div class="pf14-xpbig"><div class="lab"><b>LEVEL ' + lv.lvl + '</b><span>' + num(lv.cur) + ' / ' + num(lv.need) + ' XP</span></div>' +
      '<div class="bar"><i style="width:' + lv.pct + '%"></i></div>' +
      '<div class="next">' + num(Math.max(0, lv.need - lv.cur)) + ' XP to level ' + (lv.lvl + 1) + ' &middot; ' + num(ap.xp | 0) + ' XP earned in total</div></div>' +
      '<div class="pf14-skins-note">XP is earned from every finished race: opponents, wins, distance and coins.</div></div>';
    // ranked
    if (rk) {
      var rkname = rk.name + (rk.next ? ' ' + DIVN[rk.div - 1] : '');
      right += '<div class="p14-panel"><div class="pf14-ph">Ranked</div>' +
        '<div class="pf14-rankbig">' + rk.svg + '<div class="i"><b style="color:' + rk.color + '">' + esc(rkname) + '</b><small>' + num(pts) + ' RP' + (rk.next ? ' &middot; ' + num(rk.toNext) + ' RP to ' + esc(rk.next.name) : ' &middot; highest rank') + '</small>' +
        '<div class="pf14-divbar"><i style="width:' + rk.divPct + '%;--rk-col:' + rk.color + '"></i></div>' +
        '<div class="pf14-divlab"><span>' + (rk.next ? 'DIVISION ' + DIVN[rk.div - 1] : 'MAX RANK') + '</span><span>' + rk.divPct + '%</span></div></div></div>' +
        '<div class="pf14-kv" style="margin-top:9px"><span>Rank points</span><b>' + num(pts) + '</b></div>' +
        '<div class="pf14-kv"><span>Weekly RP</span><b>' + num(ap.wp | 0) + '</b></div>' +
        '<div class="pf14-kv"><span>Next rank</span><b>' + (rk.next ? esc(rk.next.name) + ' at ' + num(rk.next.min) + ' RP' : '\u2014') + '</b></div>' +
        '</div>';
    }
    // match stats
    right += '<div class="p14-panel"><div class="pf14-ph">Match statistics</div><div class="pf14-statgrid">' +
      [['Races', num(races)], ['Wins', num(wins)], ['Win rate', wr + '%'], ['Best streak', String(ap.bst | 0)], ['High score', num(ap.bs | 0)], ['Best distance', num(ap.bd | 0) + ' m'], ['Total distance', num(ap.td | 0) + ' m'], ['Coins', num(ap.cc | 0)]].map(function (t2) { return '<div class="pf14-tile"><small>' + t2[0] + '</small><b>' + t2[1] + '</b></div>'; }).join('') +
      '</div></div>';
    // match history
    var hist = (ap.hist || []).slice().reverse();
    var hRows = hist.map(function (h2, i2) {
      var placeTxt = '#' + (h2.pl | 0) + ' / ' + (h2.n | 0);
      return '<div class="pf14-hrow" style="animation-delay:' + (i2 * 30) + 'ms"><span class="pl' + ((h2.pl | 0) === 1 ? ' w' : '') + '">' + (h2.pl | 0) + '</span>' +
        '<div class="i"><b>' + placeTxt + (h2.won ? ' &middot; WIN' : '') + '</b><small>' + num(h2.sc | 0) + ' pts &middot; ' + num(h2.d | 0) + ' m &middot; ' + num(h2.c | 0) + ' coins &middot; ' + ago(h2.ts) + '</small></div>' +
        '<div class="g"><b>' + (h2.rp | 0 ? '+' + (h2.rp | 0) + ' RP' : '0 RP') + '</b><small>+' + (h2.xp | 0) + ' XP</small></div></div>';
    }).join('');
    right += '<div class="p14-panel"><div class="pf14-ph">Match history<span class="cnt">' + hist.length + ' races</span></div>' +
      (hRows || '<div class="mq-note" style="padding:2px 0 6px">No races recorded yet. Finish a lobby race to build the history.</div>') + '</div>';
    // achievements
    var achs = W.MPAcc ? MPAcc.achievementsOf(ap, sp.friendsCount | 0) : [];
    var achHtml = achs.map(function (ac) {
      var ic = ac.done
        ? '<svg viewBox="0 0 24 24"><path d="M4.5 12.5l5 5L20 7" fill="none" stroke="#7ce0ac" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#5b6680" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="#5b6680"/></svg>';
      var stTxt = ac.done ? 'DONE' : (ac.prog >= ac.goal ? '' : num(ac.prog) + ' / ' + num(ac.goal) + (ac.unit || ''));
      return '<div class="pf14-achrow' + (ac.done ? ' done' : '') + '"><span class="ic">' + ic + '</span>' +
        '<div class="i"><b>' + esc(ac.name) + '</b><small>' + esc(ac.desc) + '</small>' +
        (ac.done ? '' : '<div class="pbar"><i style="width:' + Math.min(100, Math.round(ac.prog / ac.goal * 100)) + '%"></i></div>') + '</div>' +
        '<span class="st">' + (ac.done ? 'DONE' : stTxt) + '</span></div>';
    }).join('');
    right += '<div class="p14-panel"><div class="pf14-ph">Achievements<span class="cnt">' + achs.filter(function (x) { return x.done; }).length + ' / ' + achs.length + '</span></div><div class="pf14-ach">' + achHtml + '</div></div>';
    // account
    var link = location.origin + location.pathname + '?mp=1&profile=' + encodeURIComponent(key);
    right += '<div class="p14-panel"><div class="pf14-ph">Account</div>' +
      '<div class="pf14-kv"><span>Member since</span><b>' + (created ? new Date(created).toLocaleDateString() : '\u2014') + '</b></div>' +
      '<div class="pf14-kv"><span>Account age</span><b>' + age + '</b></div>' +
      '<div class="pf14-kv"><span>Status</span><b>' + (sp.online ? 'Online' : 'Offline') + '</b></div>' +
      (isOwn ? '<div class="mq-sec">Password recovery</div><div class="pf14-add"><input type="email" id="mp-remail" maxlength="80" placeholder="Recovery email for password resets" value="' + esc(ap.em || '') + '"><button class="pf14-mini go" data-act="remsave">SAVE</button></div><div class="mq-skins-note" style="font-size:10.5px;color:#626e88">Used by the Forgot Password flow. Stored on the account record - the password itself is never displayed.</div>' : '') +
      '<div class="mq-sec">Share profile</div><div class="pf14-share"><input readonly value="' + esc(link) + '" onfocus="this.select()">' +
      '<button class="pf14-mini go" data-act="profshare">COPY</button>' +
      '<a class="pf14-sicon" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent('Race me in Subway Surfers Multiplayer! ' + link) + '">X</a>' +
      '<a class="pf14-sicon" target="_blank" rel="noopener" href="https://www.reddit.com/submit?url=' + encodeURIComponent(link) + '">R</a>' +
      '<a class="pf14-sicon" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('Race me in Subway Surfers Multiplayer! ' + link) + '">W</a></div></div>';
    var re = document.getElementById('pf-right'); if (re) re.innerHTML = right;
  }

  function regInvites() {
    if (regInvites.off) { try { regInvites.off(); } catch (e) { } regInvites.off = null; }
    if (!(W.MPAcc && MPAcc.user()) || !W.MPSocial) return;
    try { regInvites.off = MPSocial.listenInvites(function (b) { showBanner(b); }); } catch (e) { }
  }

  // -------------------------------------------------------------- boot ------
  function boot() {
    if (!UI_ON) return;
    me.uid = sessionStorage.getItem('mp_uid') || ('u' + Math.random().toString(36).slice(2, 10));
    sessionStorage.setItem('mp_uid', me.uid);
    me.name = localStorage.getItem('mp_name') || '';
    var c = localStorage.getItem('mp_char'), b = localStorage.getItem('mp_board');
    if (c && CHARS.some(function (x) { return x[0] === c; })) me.char = c;
    if (b && BOARDS.indexOf(b) >= 0) me.board = b;
    me.ot = Math.max(0, Math.min(2, parseInt(localStorage.getItem('mp_ot'), 10) || 0));
    var pv = parseInt(localStorage.getItem('mp_pose'), 10); me.pose = Math.max(0, Math.min(POSES.length - 1, isNaN(pv) ? 1 : pv));
    try {
      var tc0 = parseInt(localStorage.getItem('mp_tc'), 10); if (tc0 >= 0 && tc0 < NAMECOLS.length) me.tc = tc0;
      me.tt = localStorage.getItem('mp_tt') || '';
      me.tp = parseInt(localStorage.getItem('mp_tp'), 10) || 0;
      me.tf = parseInt(localStorage.getItem('mp_tf'), 10) || 0;
      me.tr = parseInt(localStorage.getItem('mp_tr'), 10) || 0;
    } catch (e) { }
    me.tq = Math.max(0, Math.min(2, parseInt(localStorage.getItem('mp_tq'), 10) || 0));
    me.to = Math.max(4, Math.min(10, parseInt(localStorage.getItem('mp_to'), 10) || 10));
    var tu0 = parseInt(localStorage.getItem('mp_tu'), 10); me.tu = (tu0 >= 0 && tu0 < NAMECOLS.length) ? tu0 : null;
    if (!badgeKnown(me.tt)) me.tt = '';
    buildUI(); makeDraggables(); initV10(); requestAnimationFrame(frame);
    try { curEnv = localStorage.getItem('mp18_env') || ''; } catch (e) { }
    try { applyTheme(localStorage.getItem('mp17_theme') || 'midnight', false); } catch (e) { }
    try { fpsOn(localStorage.getItem('mp17_fps') === '1'); } catch (e) { }
    try { lchatGone = localStorage.getItem('mp18_lchatgone') === '1'; } catch (e) { }
    // POKI18 backend modules
    if (W.MP18) {
      try { W.MP18.music.init(); } catch (e) { }
      try { W.MP18.persist.refresh(); } catch (e) { }
      try { W.MP18.badges.refreshCustom().then(function () { MP18_custom = W.MP18.badges.custom.slice(); }); } catch (e) { }
      if (W.MPAcc && MPAcc.user()) {
        var myKey18 = MPAcc.user().key;
        try { W.MP18.badges.watchUser(myKey18); } catch (e3) { }
        try { W.MP18.admin.userBadges(myKey18, function (ids) { W.MP18.badges.myAb = (ids && ids[0]) || ''; if (net) { try { net.setPlayer({ ab: W.MP18.badges.myAb, ow: W.MP18.admin.isOwner() ? 1 : 0 }); } catch (e2) { } } }); } catch (e) { }
        try { W.MP18.admin.ensureGrant().then(function () { return W.MP18.admin.refresh(); }).then(function () { if (net) { try { net.setPlayer({ ow: W.MP18.admin.isOwner() ? 1 : 0 }); } catch (e2) { } } }); } catch (e) { }
      }
      W.MP18.admin.badgeList(function (arr) { MP18_custom = arr || []; W.MP18.badges.custom = arr || []; });
    }
    if (W.MPSocial) {
      MPSocial.onChange(function () { if (phase === 'home') { try { renderFriends(); } catch (e) { } } });
      try { regInvites(); } catch (e) { }
    }
    if (W.MPAcc) MPAcc.onChange(function (u) { try { regInvites(); } catch (e) { }
      if (u && W.MP18) { try { W.MP18.admin.ensureGrant().then(function () { W.MP18.admin.refresh(); }); } catch (e) { } }
    });
    var pk = params.get('profile');
    if (pk) { profBack = 'home'; setTimeout(function () { showProfile(String(pk).toLowerCase()); }, 900); } else showHome();
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})(window);
