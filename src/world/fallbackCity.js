// OWNER: city agent. Lightweight fallback city for mobile (MOBILE CITY MODE).
// The full procedural city (buildings.js GrowBufs, rooftops FBufs, tile batching,
// hundreds of MB of textures) exceeds Android Chrome's per-tab budget and kills
// the renderer ("Aw, Snap!") during load. This module builds a small deterministic
// box city instead: one merged vertex-coloured mesh + ground plane, a few hundred
// AABBs, zero textures, zero async loads. It implements the same world contract
// traversal/player/systems need (raycast, groundHeight, buildings, spawn,
// footprints, getMapFeatures, update), so gameplay (swing/zip/perch/combat)
// runs unmodified. Desktop never uses this path (see main.js ?city=full).
import * as THREE from 'three';
import { mulberry32 } from './layout.js';
import { nightK } from '../render/daynight.js';

const WALLS_LEGACY = [[0.72, 0.74, 0.77], [0.60, 0.63, 0.68], [0.79, 0.76, 0.70], [0.50, 0.55, 0.65], [0.63, 0.42, 0.35], [0.82, 0.82, 0.84]];
// Stage 1: wider empire/state palette (still vertex colors, still one material).
const WALLS = [...WALLS_LEGACY, [0.55, 0.50, 0.44], [0.44, 0.52, 0.60], [0.70, 0.58, 0.48], [0.38, 0.40, 0.45]];
const ROOF = [0.42, 0.43, 0.46];
const SLAB = [0.20, 0.22, 0.25];
const GROUND = [0.13, 0.14, 0.16];

function pushBox(P, C, I, V, x0, y0, z0, x1, y1, z1, wall, roof, baseCol = null, baseH = 0) {
  // 24 verts (4 per face, BoxGeometry order: +x,-x,+y,-y,+z,-z); top face gets roof colour.
  const base = V.n;
  const corners = [
    [x1, y0, z1], [x1, y0, z0], [x1, y1, z1], [x1, y1, z0], // +x
    [x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [x0, y1, z1], // -x
    [x0, y1, z1], [x1, y1, z1], [x0, y1, z0], [x1, y1, z0], // +y (roof)
    [x0, y0, z0], [x1, y0, z0], [x0, y0, z1], [x1, y0, z1], // -y
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1], // +z
    [x1, y0, z0], [x0, y0, z0], [x1, y1, z0], [x0, y1, z0], // -z
  ];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const p = corners[f * 4 + k];
      // Stage 1: darker base band on the street level of side faces (f==2 roof, f==3 unseen bottom).
      const c = f === 2 ? roof : (baseCol && f !== 3 && p[1] < y0 + baseH ? baseCol : wall);
      P.push(p[0], p[1], p[2]); C.push(c[0], c[1], c[2]);
    }
    const b = base + f * 4;
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  V.n = base + 24;
}

// slab ray vs AABB; returns {t, normal} or null
function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0, tmax = maxT, n = null;
  const mn = b.min, mx = b.max;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = a === 0 ? mn[0] : a === 1 ? mn[1] : mn[2];
    const hi = a === 0 ? mx[0] : a === 1 ? mx[1] : mx[2];
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d, nn = null;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; nn = a; } else nn = a;
    const sign = d > 0 ? -1 : 1;
    if (t1 > tmin) { tmin = t1; n = [0, 0, 0]; n[a] = sign; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (!n) n = [0, 1, 0];
  return { t: tmin, normal: n };
}

// unlit quad (DoubleSide: no winding bookkeeping), for the merged window meshes.
function pushQuad(P, C, I, V, a, b, c, d, col) {
  const base = V.n;
  for (const p of [a, b, c, d]) { P.push(p[0], p[1], p[2]); C.push(col[0], col[1], col[2]); }
  I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  V.n = base + 4;
}

export async function buildFallbackCity({ scene, renderer }, { onStage, fbq = 'med' } = {}) {
  void renderer;
  // fbq=low renders the original stable output exactly (legacy palette, no
  // jitter/base/windows). Guaranteed rollback: ?city=fallback&fbq=low.
  const Q = fbq === 'low' ? 0 : 2;
  const t0 = performance.now();
  const rnd = mulberry32(1234);
  const root = new THREE.Group(); root.name = 'fallbackCity';
  scene.add(root);

  // 9x9 blocks, 64 m lots + 26 m streets (pitch 90). Origin sits on a street
  // crossing so spawn (0, *, 0) is in the open.
  const N = 9, PITCH = 90;
  const boxes = []; // {min:[x,y,z], max:[x,y,z]}
  const P = [], C = [], I = [], V = { n: 0 };
  const half = (N * PITCH) / 2;
  await onStage?.('city/fallback-grid');
  for (let bx = 0; bx < N; bx++) for (let bz = 0; bz < N; bz++) {
    const x0 = -half + bx * PITCH, z0 = -half + bz * PITCH;
    // sidewalk slab covers the 64 m lot only; streets read as the dark gaps.
    // (spawn (-38.5,-38.5) sits on a street crossing: cell offsets 0..13 are street)
    boxes.push({ min: [x0 + 13, 0, z0 + 13], max: [x0 + 77, 0.3, z0 + 77] });
    pushBox(P, C, I, V, x0 + 13, 0, z0 + 13, x0 + 77, 0.3, z0 + 77, SLAB, SLAB);
    // 2-4 buildings per block, inside the lot with a 2 m margin
    const nb = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < nb; b++) {
      const w = 14 + rnd() * 16, d = 14 + rnd() * 16;
      const px = x0 + 15 + rnd() * Math.max(1, 60 - w), pz = z0 + 15 + rnd() * Math.max(1, 60 - d);
      const tall = rnd() < 0.12;
      const h = tall ? 110 + rnd() * 50 : 16 + Math.pow(rnd(), 1.6) * 80;
      // Stage 1: wider palette + per-building brightness jitter + dark base.
      // fbq=low keeps the legacy flat look exactly.
      const pal = Q === 0 ? WALLS_LEGACY : WALLS;
      const wall0 = pal[Math.floor(rnd() * pal.length)];
      const jit = Q === 0 ? 1 : 0.92 + rnd() * 0.16;
      const wall = [wall0[0] * jit, wall0[1] * jit, wall0[2] * jit];
      const base = Q === 0 ? null : [wall[0] * 0.5, wall[1] * 0.5, wall[2] * 0.55];
      boxes.push({ min: [px, 0.3, pz], max: [px + w, 0.3 + h, pz + d] });
      pushBox(P, C, I, V, px, 0.3, pz, px + w, 0.3 + h, pz + d, wall, ROOF, base, 6);
      if (!tall && rnd() < 0.4) { // setback crown
        const cw = w * 0.55, cd = d * 0.55, ch = 6 + rnd() * 10;
        const cx = px + (w - cw) / 2, cz = pz + (d - cd) / 2;
        boxes.push({ min: [cx, 0.3 + h, cz], max: [cx + cw, 0.3 + h + ch, cz + cd] });
        pushBox(P, C, I, V, cx, 0.3 + h, cz, cx + cw, 0.3 + h + ch, cz + cd, wall, ROOF, null, 0);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fallbackCity';
  mesh.castShadow = true; mesh.receiveShadow = true;
  root.add(mesh);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2 + 800, half * 2 + 800),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(GROUND[0], GROUND[1], GROUND[2]), roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  ground.receiveShadow = true;
  root.add(ground);

  // Stage 2: cheap windows — merged unlit quads, zero textures. Glass mesh is
  // always drawn (+1 draw); glow mesh holds only lit quads and is visible at
  // night only (+1 draw at night, toneMapped:false for punch without bloom).
  let winGlass = null, winGlow = null, winQuads = 0;
  if (Q > 0) {
    const WG = [], WC = [], WI = [], WV = { n: 0 };
    const GG = [], GC = [], GI = [], GV = { n: 0 };
    const CAP = 7000; // quad cap: 14k quads worst case = 28k tris, well inside budget
    const wrnd = mulberry32(777);
    const winOn = b => (b.max[1] - b.min[1]) >= 20 && (b.max[0] - b.min[0]) >= 8 && (b.max[2] - b.min[2]) >= 8;
    await onStage?.('city/fallback-windows');
    for (const b of boxes) {
      if (!winOn(b)) continue;
      const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
      // faces: [fixed axis, fixed value, u0, u1, v0, v1, outward sign]
      const faces = [
        [0, x1 + 0.07, z0, z1, y0, y1], [0, x0 - 0.07, z0, z1, y0, y1],
        [2, z1 + 0.07, x0, x1, y0, y1], [2, z0 - 0.07, x0, x1, y0, y1],
      ];
      for (const [ax, fx, u0, u1, v0, v1] of faces) {
        for (let fy = v0 + 4; fy + 2.4 < v1; fy += 3) {
          for (let cu = u0 + 1.6; cu + 2.0 < u1; cu += 2.6) {
            if (wrnd() < 0.35) continue; // dark units
            if (winQuads >= CAP) break;
            const lit = wrnd() < 0.45;
            const q = (u, v) => ax === 0 ? [fx, v, u] : [u, v, fx];
            const c = [cu, cu + 1.4];
            const f = [fy, fy + 1.8];
            pushQuad(WG, WC, WI, WV, q(c[0], f[0]), q(c[1], f[0]), q(c[1], f[1]), q(c[0], f[1]),
              lit ? [0.62, 0.66, 0.70] : [0.16, 0.19, 0.24]);
            if (lit) {
              const w = 0.9 + wrnd() * 0.25;
              pushQuad(GG, GC, GI, GV, q(c[0], f[0]), q(c[1], f[0]), q(c[1], f[1]), q(c[0], f[1]),
                [1.0 * w, 0.72 * w, 0.42 * w]);
            }
            winQuads++;
          }
          if (winQuads >= CAP) break;
        }
        if (winQuads >= CAP) break;
      }
      if (winQuads >= CAP) break;
    }
    const mkWin = (G, Cc, II, glow) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(G, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
      g.setIndex(II); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: !glow }));
      m.frustumCulled = false;
      return m;
    };
    if (WV.n) { winGlass = mkWin(WG, WC, WI, false); winGlass.name = 'fallbackWindows'; root.add(winGlass); }
    if (GV.n) { winGlow = mkWin(GG, GC, GI, true); winGlow.name = 'fallbackWindowsNight'; winGlow.visible = false; root.add(winGlow); }
  }

  const buildings = boxes.filter(b => b.max[1] > 2).map(b => ({ min: b.min, max: b.max }));
  const footprints = buildings.map(b => ({ x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] }));
  const spawn = new THREE.Vector3(-38.5, 0.5, -38.5); // street crossing (cell offsets 0..13 are street)
  const _p = new THREE.Vector3(), _n = new THREE.Vector3();

  function raycast(o, dir, max = 1000) {
    let best = null;
    for (let i = 0; i < boxes.length; i++) {
      const r = rayBox(o.x, o.y, o.z, dir.x, dir.y, dir.z, boxes[i], max);
      if (r && (!best || r.t < best.distance)) {
        _p.copy(o).addScaledVector(dir, r.t);
        _n.set(r.normal[0], r.normal[1], r.normal[2]);
        best = { point: _p.clone(), normal: _n.clone(), distance: r.t };
      }
    }
    if (dir.y < -1e-6) { // ground plane y=0 fallback
      const t = -o.y / dir.y;
      if (t > 0 && t < max && (!best || t < best.distance)) {
        _p.copy(o).addScaledVector(dir, t);
        best = { point: _p.clone(), normal: _n.set(0, 1, 0).clone(), distance: t };
      }
    }
    return best;
  }
  function groundHeight(x, z, y = Infinity) {
    let g = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] && b.max[1] <= y + 0.3 && b.max[1] > g) g = b.max[1];
    }
    return g;
  }

  const world = {
    raycast, groundHeight,
    surfaceAt: () => null,
    spawn, viewpoints: {}, streetsAt: () => ({ type: 'block' }),
    buildings, footprints, isFallback: true,
    getMapFeatures: () => ({
      bounds: { x0: -half - 100, z0: -half - 100, x1: half + 100, z1: half + 100 },
      blocks: [], buildings: footprints, streets: [], water: [], parks: [],
    }),
    update() {
      // night glow: one visibility flag per frame, no per-frame allocation.
      if (winGlow) winGlow.visible = nightK.value > 0.02;
    },
  };
  console.log(`[city] fallback mobile city built in ${(performance.now() - t0).toFixed(0)} ms: ${boxes.length} boxes, ${(I.length / 3).toFixed(0)} tris, 0 textures` +
    (Q > 0 ? `, ${winQuads} window quads` : ', fbq=low legacy look'));
  await onStage?.('city/fallback');
  return world;
}
