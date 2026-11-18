/* mp-scene.js - home / lobby 3D stage scenery.
   The background IS the game's own world: the real chunks (assets/data/chunks-full.json ->
   placed by the engine) are left fully visible, so every train, pillar, platform and coin you
   see comes straight from the chunk data. Nothing on the ground is generated any more - the
   only thing this module builds is the row of glowing character pads (Fortnite-style platforms)
   plus tiny 3D snapshots of the hoverboards used by the locker grid. Exposes window.MPScene. */
(function (W) {
  'use strict';
  var T = null, loading = null;
  var C0 = 1.2, FY = 1.0;            // stage centre x, avatar feet height
  var SP = 6.6, MAXP = 8, PS = 1.32;            // character slot spacing / max pads
  var SNAP = { gl: null, cache: {}, pend: {} };

  // ------------------------------------------------------------ bootstrap ---
  // Collects the three.js constructors we need by instantiating every export once.
  function load() {
    if (T) return Promise.resolve(T);
    if (loading) return loading;
    loading = import('./assets/three-dhrglqPP.js').then(function (m) {
      var by = {};
      Object.keys(m).forEach(function (k) {
        try {
          var o = new m[k](); if (!o) return;
          if (o.type) by[o.type] = m[k];
          if (o.isWebGLRenderer) by.WebGLRenderer = m[k];
          else if (o.isScene) by.Scene = m[k];
          else if (o.isPerspectiveCamera) by.PerspectiveCamera = m[k];
          else if (o.isAmbientLight) by.AmbientLight = m[k];
          else if (o.isDirectionalLight) by.DirectionalLight = m[k];
          else if (o.isBox3) by.Box3 = m[k];
          else if (o.isVector3) by.Vector3 = m[k];
          else if (o.isColor) by.Color = m[k];
          if (o.isTexture) { var dep = 0, pr = m[k].prototype; while (pr) { dep++; pr = Object.getPrototypeOf(pr); } if (!by.__texD || dep < by.__texD) { by.__texD = dep; by.Texture = m[k]; } }
        } catch (e) {}
      });
      var need = ['Mesh', 'MeshBasicMaterial', 'Object3D', 'BufferGeometry', 'Scene', 'PerspectiveCamera'];
      for (var i = 0; i < need.length; i++) if (!by[need[i]]) throw new Error('three missing ' + need[i]);
      T = { Mesh: by.Mesh, Basic: by.MeshBasicMaterial, Obj: by.Object3D, Geo: by.BufferGeometry,
            Scene: by.Scene, Cam: by.PerspectiveCamera, Amb: by.AmbientLight, Dir: by.DirectionalLight,
            Box3: by.Box3, Vec3: by.Vector3, WebGLRenderer: by.WebGLRenderer, Color: by.Color, Tex: by.Texture, by: by };
      try { T.Attr = new by.BoxGeometry().attributes.position.constructor; } catch (e) { T.Attr = null; }
      if (!T.Attr) throw new Error('three missing attributes');
      return T;
    }).catch(function (e) { console.warn('[MPScene] load failed', e); T = null; loading = null; return null; });
    return loading;
  }

  // ------------------------------------------------------------- helpers ---
  function hex(c) { return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255]; }
  function lin(v) { return Math.pow(Math.min(1, Math.max(0, v)), 2.2); }
  function shade(c, f) { return [lin(c[0] * f), lin(c[1] * f), lin(c[2] * f)]; }
  function glowCol(c) { return [lin(c[0]), lin(c[1]), lin(c[2])]; }
  var LD = (function () { var v = [0.42, 0.78, 0.46], l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })();

  // flat-shaded geometry accumulator - light baked into vertex colours (MeshBasicMaterial is unlit)
  function G() { this.p = []; this.c = []; }
  G.prototype.tri = function (a, b, c, col, emissive) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    var f = emissive ? 1 : (0.52 + 0.48 * Math.max(0, nx * LD[0] + ny * LD[1] + nz * LD[2]) + (ny > 0.6 ? 0.08 : 0) - (ny < -0.4 ? 0.14 : 0));
    var r = shade(col, f);
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); this.c.push(r[0], r[1], r[2], r[0], r[1], r[2], r[0], r[1], r[2]);
  };
  G.prototype.quad = function (a, b, c, d, col, em) { this.tri(a, b, c, col, em); this.tri(a, c, d, col, em); };
  G.prototype.prism = function (tf, x, y, z, r, h, seg, col, em) { // cylinder-ish, y bottom
    for (var i = 0; i < seg; i++) {
      var a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      var p0 = tf(x + Math.cos(a0) * r, y, z + Math.sin(a0) * r), p1 = tf(x + Math.cos(a1) * r, y, z + Math.sin(a1) * r);
      var p2 = tf(x + Math.cos(a1) * r, y + h, z + Math.sin(a1) * r), p3 = tf(x + Math.cos(a0) * r, y + h, z + Math.sin(a0) * r);
      var f = 0.62 + 0.38 * Math.max(0, Math.cos(a0 + 0.9)); var c = em ? col : shade(col, f);
      this.quad(p0, p1, p2, p3, em ? col : c, em);
      var t0 = tf(x, y + h, z);
      this.tri(p3, p2, t0, em ? col : shade(col, 1.06), em);
    }
  };
  G.prototype.flat = function (tf, x, y, z, w, d, col, em) { // horizontal quad
    var x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, P = tf;
    this.quad(P(x0, y, z1), P(x1, y, z1), P(x1, y, z0), P(x0, y, z0), col, em);
  };
  function ID(x, y, z) { return [x, y, z]; }

  // ---------------------------------------------------------------- studio ---
  // Poki15: dark Fortnite-style lobby studio: navy dome, glossy floor, glowing pads with light beams.
  function cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function mkTex(c) { var t = new T.Tex(c); t.needsUpdate = true; try { t.colorSpace = 'srgb'; } catch (e) {} try { t.anisotropy = 4; } catch (e) {} return t; }
  function radialTex(size, stops) { var c = cv(size, size), g = c.getContext('2d'), r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); stops.forEach(function (s) { r.addColorStop(s[0], s[1]); }); g.fillStyle = r; g.fillRect(0, 0, size, size); return mkTex(c); }
  function vertTex(h, stops) { var c = cv(4, h), g = c.getContext('2d'), l = g.createLinearGradient(0, 0, 0, h); stops.forEach(function (s) { l.addColorStop(s[0], s[1]); }); g.fillStyle = l; g.fillRect(0, 0, 4, h); return mkTex(c); }
  function padTopTex(cols, ringc) {
    var S = 512, c = cv(S, S), g = c.getContext('2d'), m = S / 2, r = g.createRadialGradient(m, m, 0, m, m, m);
    r.addColorStop(0, cols[0]); r.addColorStop(0.45, cols[1]); r.addColorStop(0.9, cols[2]); r.addColorStop(1, cols[3]);
    g.fillStyle = r; g.beginPath(); g.arc(m, m, m, 0, 7); g.fill();
    g.lineWidth = 5; g.strokeStyle = ringc + '.55)'; g.beginPath(); g.arc(m, m, m * 0.62, 0, 7); g.stroke();
    g.lineWidth = 2; g.strokeStyle = ringc + '.28)'; g.beginPath(); g.arc(m, m, m * 0.36, 0, 7); g.stroke();
    return mkTex(c);
  }
  var TEXC = { }, curScene = 'midnight';
  var stageDome = null, stageFloor = null, stagePool = null, stagePads = [];
  // Poki17: selectable 3D environment themes (set from client settings)
  var SCENES = {
    midnight: { clear: 0x040816, skirt: 0x0e1530, rim: 0x2b3a6a, rim2: 0x5a6fae, rb: [0.09, 0.14, 0.28], rg: [0.27, 0.66, 0.72],
      dome: [[0, '#02050f'], [0.22, '#06123a'], [0.42, '#0c2460'], [0.52, '#173f8e'], [0.64, '#0a1d52'], [0.82, '#050d2a'], [1, '#02040c']],
      floor: [[0, 'rgba(26,62,148,1)'], [0.18, 'rgba(16,40,100,1)'], [0.5, 'rgba(8,18,52,.96)'], [0.8, 'rgba(5,10,30,.7)'], [1, 'rgba(3,6,18,0)']],
      glow: [[0, 'rgba(110,230,255,.85)'], [0.35, 'rgba(60,170,255,.38)'], [0.7, 'rgba(30,90,220,.12)'], [1, 'rgba(20,60,200,0)']],
      beam: [[0, 'rgba(150,240,255,0)'], [0.55, 'rgba(110,215,255,.14)'], [1, 'rgba(160,245,255,.85)']],
      top: ['#2a5fc4', '#17388a', '#0c1a46', '#091233'], ringc: 'rgba(120,225,255,' },
    neon: { clear: 0x0a0616, skirt: 0x180a30, rim: 0x3c1f6e, rim2: 0x7448b8, rb: [0.20, 0.05, 0.28], rg: [0.62, 0.24, 0.72],
      dome: [[0, '#070310'], [0.22, '#1d0640'], [0.42, '#3a0d7a'], [0.52, '#6a1fb0'], [0.64, '#2a0a5e'], [0.82, '#120530'], [1, '#05020c']],
      floor: [[0, 'rgba(150,60,230,1)'], [0.18, 'rgba(96,36,170,1)'], [0.5, 'rgba(44,16,90,.96)'], [0.8, 'rgba(20,8,44,.7)'], [1, 'rgba(10,4,20,0)']],
      glow: [[0, 'rgba(255,150,235,.85)'], [0.35, 'rgba(190,100,255,.38)'], [0.7, 'rgba(110,50,220,.12)'], [1, 'rgba(80,30,200,0)']],
      beam: [[0, 'rgba(240,170,255,0)'], [0.55, 'rgba(215,130,255,.16)'], [1, 'rgba(250,200,255,.85)']],
      top: ['#7a3bd6', '#4a1f96', '#1d0b46', '#12062e'], ringc: 'rgba(255,140,235,' },
    ember: { clear: 0x140604, skirt: 0x2a0f06, rim: 0x6e3316, rim2: 0xb8663a, rb: [0.30, 0.10, 0.04], rg: [0.70, 0.36, 0.12],
      dome: [[0, '#0c0302'], [0.22, '#360d06'], [0.42, '#742010'], [0.52, '#a84416'], [0.64, '#54260a'], [0.82, '#240e04'], [1, '#0a0302']],
      floor: [[0, 'rgba(220,90,40,1)'], [0.18, 'rgba(150,56,26,1)'], [0.5, 'rgba(70,26,12,.96)'], [0.8, 'rgba(34,12,6,.7)'], [1, 'rgba(16,6,3,0)']],
      glow: [[0, 'rgba(255,190,120,.85)'], [0.35, 'rgba(255,140,70,.38)'], [0.7, 'rgba(220,90,40,.12)'], [1, 'rgba(200,70,30,0)']],
      beam: [[0, 'rgba(255,220,180,0)'], [0.55, 'rgba(255,180,120,.16)'], [1, 'rgba(255,230,190,.85)']],
      top: ['#c45a2a', '#8a3a16', '#3a1608', '#200a04'], ringc: 'rgba(255,190,120,' },
    frost: { clear: 0x041018, skirt: 0x0a2030, rim: 0x1e5a78, rim2: 0x4890b8, rb: [0.06, 0.20, 0.26], rg: [0.16, 0.52, 0.74],
      dome: [[0, '#020a10'], [0.22, '#063048'], [0.42, '#0a5a80'], [0.52, '#1590b8'], [0.64, '#0a4a70'], [0.82, '#04283e'], [1, '#020a14']],
      floor: [[0, 'rgba(60,190,230,1)'], [0.18, 'rgba(36,120,160,1)'], [0.5, 'rgba(16,60,90,.96)'], [0.8, 'rgba(8,32,50,.7)'], [1, 'rgba(4,18,28,0)']],
      glow: [[0, 'rgba(180,250,255,.85)'], [0.35, 'rgba(100,220,250,.38)'], [0.7, 'rgba(50,150,220,.12)'], [1, 'rgba(30,110,200,0)']],
      beam: [[0, 'rgba(200,250,255,0)'], [0.55, 'rgba(150,235,255,.16)'], [1, 'rgba(210,250,255,.85)']],
      top: ['#2ab8d6', '#137a9a', '#0a3a52', '#062434'], ringc: 'rgba(180,250,255,' },
    // POKI18: two new environment themes - Frosted Glass (icy translucent look)
    // and Light (bright daytime studio)
    glass: { clear: 0x0a1420, skirt: 0x14273a, rim: 0x3a5a80, rim2: 0x7aa0c8, rb: [0.14, 0.26, 0.40], rg: [0.30, 0.50, 0.66],
      dome: [[0, '#0a1626'], [0.22, '#12283e'], [0.42, '#1d4060'], [0.52, '#2e6288'], [0.64, '#1a3c5e'], [0.82, '#0c1e34'], [1, '#081220']],
      floor: [[0, 'rgba(110,170,215,1)'], [0.18, 'rgba(70,120,165,1)'], [0.5, 'rgba(30,58,90,.96)'], [0.8, 'rgba(16,32,54,.7)'], [1, 'rgba(8,16,28,0)']],
      glow: [[0, 'rgba(200,235,255,.9)'], [0.35, 'rgba(140,200,245,.4)'], [0.7, 'rgba(80,150,220,.14)'], [1, 'rgba(50,110,200,0)']],
      beam: [[0, 'rgba(215,240,255,0)'], [0.55, 'rgba(170,220,250,.2)'], [1, 'rgba(225,245,255,.9)']],
      top: ['#7ab4e0', '#4179a8', '#1d3a58', '#12243c'], ringc: 'rgba(200,235,255,' },
    light: { clear: 0x28506e, skirt: 0x5a86a8, rim: 0x88b4d6, rim2: 0xc8e4f8, rb: [0.55, 0.72, 0.86], rg: [0.35, 0.24, 0.10],
      dome: [[0, '#9fd4f4'], [0.22, '#aee0fa'], [0.42, '#bfe8ff'], [0.52, '#d6f2ff'], [0.64, '#bfe4f8'], [0.82, '#8cc0e4'], [1, '#6ea4cc']],
      floor: [[0, 'rgba(235,248,255,1)'], [0.18, 'rgba(200,232,250,1)'], [0.5, 'rgba(150,196,228,.98)'], [0.8, 'rgba(110,164,204,.8)'], [1, 'rgba(90,140,180,0)']],
      glow: [[0, 'rgba(255,255,255,.95)'], [0.35, 'rgba(210,240,255,.5)'], [0.7, 'rgba(140,200,240,.18)'], [1, 'rgba(90,160,220,0)']],
      beam: [[0, 'rgba(255,255,255,0)'], [0.55, 'rgba(240,250,255,.28)'], [1, 'rgba(255,255,255,.95)']],
      top: ['#f2f8ff', '#c2dcf2', '#7aa8cc', '#5480a4'], ringc: 'rgba(255,255,255,' }
  };
  function textures(id) {
    id = id || curScene;
    if (TEXC[id]) return TEXC[id];
    var S = SCENES[id] || SCENES.midnight;
    TEXC[id] = {
      dome: vertTex(512, S.dome), floor: radialTex(512, S.floor), glow: radialTex(256, S.glow), beam: vertTex(256, S.beam), top: padTopTex(S.top, S.ringc)
    };
    return TEXC[id];
  }
  function BM(o) { var m = new T.Basic(o); try { m.fog = false; } catch (e) {} return m; }
  // the bundled three.js is tree-shaken (Plane/Box only) so round shapes are generated here
  function mkGeo(pos, uv, idx) { var g = new T.Geo(); g.setAttribute('position', new T.Attr(new Float32Array(pos), 3)); g.setAttribute('uv', new T.Attr(new Float32Array(uv), 2)); g.setIndex(idx); return g; }
  function circleGeo(r, seg) { var p = [0, 0, 0], u = [0.5, 0.5], ix = [], i; for (i = 0; i <= seg; i++) { var a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); p.push(c * r, s * r, 0); u.push(0.5 + c * 0.5, 0.5 + s * 0.5); } for (i = 1; i <= seg; i++) ix.push(0, i, i + 1); return mkGeo(p, u, ix); }
  function ringGeo(r0, r1, seg) { var p = [], u = [], ix = [], i, k = r0 / r1; for (i = 0; i <= seg; i++) { var a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); p.push(c * r0, s * r0, 0, c * r1, s * r1, 0); u.push(0.5 + c * 0.5 * k, 0.5 + s * 0.5 * k, 0.5 + c * 0.5, 0.5 + s * 0.5); } for (i = 0; i < seg; i++) { var o = i * 2; ix.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); } return mkGeo(p, u, ix); }
  function cylGeo(rt, rb, h, seg, open) {
    var p = [], u = [], ix = [], i;
    for (i = 0; i <= seg; i++) { var a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); p.push(c * rt, h / 2, s * rt, c * rb, -h / 2, s * rb); u.push(i / seg, 1, i / seg, 0); }
    for (i = 0; i < seg; i++) { var o = i * 2; ix.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    if (!open) { var base = p.length / 3; p.push(0, h / 2, 0); u.push(0.5, 1); for (i = 0; i <= seg; i++) { var a2 = i / seg * Math.PI * 2; p.push(Math.cos(a2) * rt, h / 2, Math.sin(a2) * rt); u.push(0.5, 1); } for (i = 0; i < seg; i++) ix.push(base, base + 2 + i, base + 1 + i); }
    return mkGeo(p, u, ix);
  }
  function sphereGeo(r, ws, hs) { var p = [], u = [], ix = [], x, y; for (y = 0; y <= hs; y++) for (x = 0; x <= ws; x++) { var th = x / ws * Math.PI * 2, ph = y / hs * Math.PI; p.push(-r * Math.cos(th) * Math.sin(ph), r * Math.cos(ph), r * Math.sin(th) * Math.sin(ph)); u.push(x / ws, 1 - y / hs); } for (y = 0; y < hs; y++) for (x = 0; x < ws; x++) { var a = y * (ws + 1) + x, b = a + ws + 1; ix.push(a, b, a + 1, b, b + 1, a + 1); } return mkGeo(p, u, ix); }

  function build() {
    if (!T || !T.Tex) return null;
    var X = textures(), root = new T.Obj();
    stageDome = stageFloor = stagePool = null; stagePads = [];
    var dome = new T.Mesh(sphereGeo(110, 48, 32), BM({ map: X.dome, side: 1, depthWrite: false, depthTest: false }));
    dome.renderOrder = -100; dome.frustumCulled = false; dome.position.set(C0, 0, 0); root.add(dome); stageDome = dome;
    var floor = new T.Mesh(circleGeo(64, 64), BM({ map: X.floor, transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(C0, 0.9, -2); floor.renderOrder = -50; floor.frustumCulled = false; root.add(floor); stageFloor = floor;
    var pool = new T.Mesh(circleGeo(30, 48), BM({ map: X.glow, transparent: true, opacity: 0.5, depthWrite: false, blending: 2 }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(C0, 0.93, -3); pool.renderOrder = -40; pool.frustumCulled = false; root.add(pool); stagePool = pool;
    var pads = [];
    for (var pi = 0; pi < MAXP; pi++) {
      var grp = new T.Obj();
      var skirt = new T.Mesh(cylGeo(2.28, 2.4, 0.3, 56), BM({ color: (SCENES[curScene] || SCENES.midnight).skirt })); skirt.position.y = 0.78;
      var rim = new T.Mesh(ringGeo(1.98, 2.28, 64), BM({ color: (SCENES[curScene] || SCENES.midnight).rim })); rim.rotation.x = -Math.PI / 2; rim.position.y = 0.935;
      var rim2 = new T.Mesh(ringGeo(2.2, 2.3, 64), BM({ color: (SCENES[curScene] || SCENES.midnight).rim2 })); rim2.rotation.x = -Math.PI / 2; rim2.position.y = 0.94;
      var top = new T.Mesh(circleGeo(1.98, 64), BM({ map: X.top })); top.rotation.x = -Math.PI / 2; top.position.y = 0.94;
      var ring = new T.Mesh(ringGeo(1.84, 1.98, 64), BM({ color: 0x5ce6ff })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.955;
      var glow = new T.Mesh(circleGeo(4.9, 48), BM({ map: X.glow, transparent: true, opacity: 0.6, depthWrite: false, blending: 2 })); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.975; glow.renderOrder = -30;
      var beam = new T.Obj(); beam.position.y = 0.95 + 4.0; beam.__l = [];
      [[0.95, 1.15, 0.50], [1.4, 1.65, 0.30], [1.85, 2.15, 0.18]].forEach(function (L) {
        var bm = new T.Mesh(cylGeo(L[0], L[1], 8.0, 40, true), BM({ map: X.beam, transparent: true, opacity: 0.5, depthWrite: false, blending: 2, side: 2 }));
        bm.frustumCulled = false; bm.renderOrder = 20; bm.__w = L[2]; beam.add(bm); beam.__l.push(bm);
      });
      [skirt, rim, rim2, top, ring, glow].forEach(function (m) { m.frustumCulled = false; grp.add(m); }); grp.add(beam);
      root.add(grp);
      pads.push({ g: grp, ring: ring, glow: glow, beam: beam, top: top, skirt: skirt, rim: rim, rim2: rim2, st: 1, lv: 1 }); stagePads = pads;
    }
    var t0 = performance.now();
    function update() {
      var t = (performance.now() - t0) / 1000;
      pads.forEach(function (p, i) {
        p.lv += (p.st - p.lv) * 0.12;
        var pulse = 0.5 + 0.5 * Math.sin(t * 2.1 + i * 0.8), lv = p.lv;
        var S = SCENES[curScene] || SCENES.midnight;
        p.ring.material.color.setRGB(S.rb[0] + S.rg[0] * lv + 0.04 * pulse * lv, S.rb[1] + S.rg[1] * lv + 0.06 * pulse * lv, S.rb[2] + S.rg[2] * lv);
        p.glow.material.opacity = 0.08 + 0.62 * lv + 0.08 * pulse * lv;
        p.beam.__l.forEach(function (bm) { bm.material.opacity = bm.__w * 0.55 * lv * lv * (0.9 + 0.1 * pulse); });
        var sc = 1 + 0.03 * pulse * lv; p.glow.scale.set(sc, sc, 1);
      });
      pool.material.opacity = 0.42 + 0.06 * Math.sin(t * 0.9);
      try { root.updateMatrixWorld(true); } catch (e) {}
    }
    return {
      root: root, theme: { n: curScene }, key: 'studio-' + ((Math.random() * 1e6) | 0), update: update,
      placePads: function (n, states) {
        n = Math.max(1, Math.min(MAXP, n | 0));
        var half = (n - 1) * SP / 2;
        pads.forEach(function (p, i) {
          p.g.visible = i < n; var d = i - (n - 1) / 2;
          p.g.position.set(C0 - half + i * SP, 0, -Math.pow(Math.abs(d), 1.6) * 0.9); p.g.scale.set(PS, 1, PS);
          p.st = states && states[i] != null ? (states[i] ? 1 : 0.18) : 1;
        });
      },
      dispose: function () {
        try { if (root.parent) root.parent.remove(root); } catch (e) {}
        stageDome = stageFloor = stagePool = null; stagePads = [];
        root.traverse && root.traverse(function (o) { try { if (o.geometry) o.geometry.dispose && o.geometry.dispose(); } catch (e) {} try { if (o.material) o.material.dispose && o.material.dispose(); } catch (e) {} });
      }
    };
  }


  // Poki17: live theme switching for the 3D stage (dome, floor, glow pads, beams)
  function setTheme(id) {
    if (!SCENES[id]) id = 'midnight';
    curScene = id;
    if (!T || !T.Tex) return (SCENES[curScene] || SCENES.midnight).clear;
    var X = textures(id), S = SCENES[id];
    try {
      if (stageDome) { stageDome.material.map = X.dome; stageDome.material.needsUpdate = true; }
      if (stageFloor) { stageFloor.material.map = X.floor; stageFloor.material.needsUpdate = true; }
      if (stagePool) { stagePool.material.map = X.glow; stagePool.material.needsUpdate = true; }
      stagePads.forEach(function (p) {
        if (p.top) { p.top.material.map = X.top; p.top.material.needsUpdate = true; }
        if (p.glow) { p.glow.material.map = X.glow; p.glow.material.needsUpdate = true; }
        if (p.skirt) p.skirt.material.color.setHex(S.skirt);
        if (p.rim) p.rim.material.color.setHex(S.rim);
        if (p.rim2) p.rim2.material.color.setHex(S.rim2);
        (p.beam.__l || []).forEach(function (bm) { bm.material.map = X.beam; bm.material.needsUpdate = true; });
      });
    } catch (e) { }
    try { var rr = W.__MP_APP && W.__MP_APP.stage && W.__MP_APP.stage.renderer; if (rr && rr.setClearColor) rr.setClearColor(S.clear, 1); } catch (e) { }
    return S.clear;
  }

  // ------------------------------------------------- 3D board snapshots ------
  // Renders one of the game's real hoverboard scenes ('board-<id>') with a tiny
  // offscreen renderer and returns a data-URL. Used by the locker grid so every
  // tile shows an actual 3D render of the board instead of a flat texture.
  function snapBoard(id, size) {
    size = size || 220;
    var A = W.__MP_APP;
    if (!id || !A || !A.library || !A.library.hasScene || !A.library.hasScene('board-' + id)) return Promise.resolve(null);
    if (SNAP.cache[id]) return Promise.resolve(SNAP.cache[id]);
    if (SNAP.pend[id]) return SNAP.pend[id];
    SNAP.pend[id] = load().then(function (K) {
      if (!K || !A.library.hasScene('board-' + id)) return null;
      var view = null;
      try { view = A.library.getScene('board-' + id, { map: 'board-' + id + '-tex' }); } catch (e) { view = null; }
      if (!view) return null;
      // show the same feature nodes the in-game board shows
      try {
        var data = A.data && A.data.getBoardData && A.data.getBoardData(id), feat = (data && data.features) || [], nodes = [], shown = 0;
        view.traverse(function (o) { if (o.view3d && o.name) nodes.push(o); });
        if (feat.length) {
          nodes.forEach(function (o) { var on = feat.indexOf(o.name) >= 0; o.view3d.renderable = on; if (on) shown++; });
          if (!shown) nodes.forEach(function (o) { o.view3d.renderable = true; });
        }
      } catch (e) {}
      if (!SNAP.gl) {
        SNAP.gl = new K.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
        SNAP.gl.setClearColor(0x000000, 0);
      }
      SNAP.gl.setSize(size, size, false);
      var sc = new K.Scene();
      try { if (K.Amb) sc.add(new K.Amb(0xffffff, 1.1)); } catch (e) {}
      try { if (K.Dir) { var dl = new K.Dir(0xffffff, 0.85); dl.position.set(4, 7, 5); sc.add(dl); } } catch (e) {}
      view.position.set(0, 0, 0);
      view.rx = -1.02; view.ry = 0.5; view.rz = 0;   // engine-style rotation props (if engine reads them)
      view.rotation.set(-1.02, 0.5, 0);              // mostly flat, showing the deck surface
      view.scale.set(1, 1, 1);
      sc.add(view);
      // frame the board: fit camera distance to its bounding sphere
      var dist = 5.2;
      try {
        var box = new K.Box3().setFromObject(view), sz = new K.Vec3();
        box.getSize(sz);
        var big = Math.max(sz.x, sz.y, sz.z) || 4;
        dist = Math.max(2.6, big * 1.55);
      } catch (e) {}
      var cam = new K.Cam(34, 1, 0.1, 300);
      cam.position.set(dist * 0.22, dist * 0.66, dist * 0.82);
      cam.lookAt(0, 0, 0);
      SNAP.gl.render(sc, cam);
      var url = '';
      try { url = SNAP.gl.domElement.toDataURL('image/png'); } catch (e) { url = ''; }
      sc.remove(view);
      return url || null;
    }).catch(function (e) { console.warn('[MPScene] snapBoard', id, e); return null; })
      .then(function (u) { if (u) SNAP.cache[id] = u; delete SNAP.pend[id]; return u; });
    return SNAP.pend[id];
  }

  W.MPScene = {
    load: load,
    build: function () { try { return build(); } catch (e) { console.warn('[MPScene] build failed', e && e.message); return null; } },
    snapBoard: snapBoard,
    boardCache: function (id) { return SNAP.cache[id] || null; },
    C0: C0, SP: SP, FY: FY,
    setTheme: setTheme,
    bgColor: function () { return (SCENES[curScene] || SCENES.midnight).clear; }
  };
})(window);
