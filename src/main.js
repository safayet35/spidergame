// Integration entry. OWNER: orchestrator. Module contracts:
//  render/pipeline.js  createPipeline({renderer, scene, camera}) -> {render(dt), setSize(w,h), setFocus?(dist)}
//  render/lighting.js  createLighting({renderer, scene}) -> {sun, update(camera), timeOfDay}
//  world/city.js       buildCity({scene, renderer}) -> Promise<world>
//                      world = {raycast(origin:Vector3, dir:Vector3, max):{point,normal,distance}|null,
//                               groundHeight(x,z):number, spawn:Vector3, update(dt, camera)}
//  player/player.js    createPlayer({scene, world, camera, input, renderer}) -> Promise<player>
//                      player = {update(dt), object:Object3D, applyShot(name)->boolean}
//  ui/hud.js           createHud({player, world}) -> {update(dt), setVisible(b)}
//  shots.js            SHOTS[name] = {time?, apply(ctx)}  deterministic poses for screenshot/critique
import * as THREE from 'three';
import { createPipeline } from './render/pipeline.js';
import { createLighting } from './render/lighting.js';
import { buildCity } from './world/city.js';
import { buildFallbackCity } from './world/fallbackCity.js';
import { createPlayer } from './player/player.js';
import { createInput } from './player/input.js';
import { createHud } from './ui/hud.js';
import { SHOTS } from './shots.js';
import { createWarmup } from './render/warmup.js'; // (perf r3)
import { isMobileDevice, isPotatoDevice, isPotato, getQuality } from './render/quality.js';
import { REFL_LAYER } from './world/water.js';
import { BIG_CASTER_LAYER } from './render/csm.js';

const params = new URLSearchParams(location.search);
const shotName = params.get('shot');

// Diagnostic boot overlay: staged progress + timings + heap, so a crash/hang
// points at the exact stage instead of a bare black screen. Bisect flags:
//   ?nocity    skip the whole city (flat-ground stub world: isolates city build)
//   ?city=full|fallback force full or fallback city (default: fallback on phones, full on desktop)
//   ?notex     city geometry with 1x1 placeholder textures (isolates texture decode/upload)
//   ?stopafter=city/<stage> halt city build after stage, boot partial scene
//     (tex|gen|rooftops|signage|tiles|ground|far|bridges|hinterland|vehicles|props|peds|life|coll)
//   ?nodetail  skip detail tiles (any preset: isolates the worst build heap)
//   ?nosys     skip systems+combat init (isolates post-load game code)
//   ?noshadow  disable shadow maps (isolates CSM + shadow shaders)
//   ?nowarm    skip shader warmup flush (exists; isolates compile storm)
//   ?q=mobile|low|med|high  pipeline preset (isolates post/FX memory)
//   ?dpr=0.75  pixel-ratio cap override (isolates full-res RT memory)
//   ?diag      keep the overlay + per-second stats after boot
const DIAG = params.has('diag');
let PRESET = 'high';
try { PRESET = getQuality().name || 'high'; } catch { /* ignore */ }
const bootEl = document.createElement('div');
bootEl.id = 'boot';
bootEl.style.cssText = 'position:fixed;left:8px;top:8px;max-width:92vw;z-index:99;background:rgba(5,10,25,.85);color:#cfe;font:12px/1.5 monospace;padding:10px 12px;border-radius:6px;white-space:pre-wrap;pointer-events:none';
document.body.appendChild(bootEl);
const bootT0 = performance.now();
const bootRows = [];
let bootDone = 0;
const BOOT_TOTAL = 10; // top-level stages: lighting, city, input, player, hud, pipeline, warmup x2, systems, combat
function memMB() {
  try {
    const m = performance.memory;
    if (m) return (m.usedJSHeapSize / 1048576).toFixed(0) + 'MB heap';
  } catch { /* non-Chromium */ }
  return 'heap n/a';
}
function bootBar() {
  const p = Math.min(1, bootDone / BOOT_TOTAL), n = Math.round(p * 20);
  return '[' + '#'.repeat(n) + '-'.repeat(20 - n) + '] ' + Math.round(p * 100) + '%';
}
function paintBoot(cur) {
  try {
    const flags = ['nocity', 'notex', 'nodetail', 'nosys', 'noshadow', 'nowarm', 'diag'].filter(f => params.has(f)).map(f => '?' + f);
    const q = params.get('q'), dpr = params.get('dpr'), fbq = params.get('fbq');
    if (q) flags.push('?q=' + q);
    if (dpr) flags.push('?dpr=' + dpr);
    if (fbq) flags.push('?fbq=' + fbq);
    bootEl.textContent = 'Loading Spider-Man... ' + bootBar() + ' (' + ((performance.now() - bootT0) / 1000).toFixed(1) + 's ' + memMB() + ' [' + PRESET + ']' + (flags.length ? ' ' + flags.join(' ') : '') + ')\n'
      + bootRows.join('\n') + (cur ? '\n… ' + cur : '');
  } catch { /* ignore */ }
}
// Fatal fallback screen: never leave a permanent black screen. Used for
// WebGL creation failure and other unrecoverable boot errors.
function bootFatal(title, msg) {
  try {
    bootEl.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:#05070f;color:#fff;font:15px/1.6 system-ui,sans-serif;padding:24px;pointer-events:auto;white-space:pre-wrap';
    bootEl.textContent = title + '\n\n' + msg;
  } catch { /* ignore */ }
}
function bootError(msg) {
  try {
    if (!bootEl.isConnected) document.body.appendChild(bootEl);
    bootEl.style.background = 'rgba(120,10,10,.92)';
    bootEl.style.color = '#fff';
    bootEl.textContent += '\nBOOT ERROR: ' + msg;
  } catch { /* ignore */ }
}
window.addEventListener('error', e => bootError(e.message || e.error));
window.addEventListener('unhandledrejection', e => bootError('promise: ' + (e.reason?.message || e.reason)));
// Single-boot guard: the entry module must never initialize twice (double
// city loads = double GPU memory = instant renderer kill).
if (window.__booted) throw new Error('duplicate boot blocked (entry executed twice)');
window.__booted = true;
const yieldPaint = () => new Promise(r => setTimeout(r, 30));
async function stage(name, fn) {
  console.log('[LOAD] start ' + name);
  paintBoot(name);
  await yieldPaint();
  const t = performance.now();
  const r = await fn();
  bootDone++;
  const ms = (performance.now() - t).toFixed(0);
  console.log('[LOAD] ok ' + name + ' +' + ms + 'ms heap=' + memMB());
  bootRows.push('ok ' + name + ' +' + ms + 'ms');
  paintBoot();
  return r;
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, reversedDepthBuffer: true });
} catch (e) {
  console.error('[boot] WebGL creation failed', e);
  bootFatal('WebGL unavailable', 'This browser or device cannot create a WebGL2 context, so the game cannot start.\n\nTry the latest Chrome on Android with hardware acceleration enabled.\n\nTechnical detail: ' + (e?.message || e));
  throw e;
}
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  bootError('GPU context lost (driver killed WebGL: OOM or device reset). Try ?nocity then ?q=low.');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  bootError('GPU context restored — reloading to rebuild GL resources.');
  setTimeout(() => location.reload(), 1500);
});
const MOBILE = isMobileDevice();
const dprCap = parseFloat(params.get('dpr')) || (MOBILE ? 1 : 1.5);
renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !params.has('noshadow');
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // tone mapping done in pipeline
// (zfix) three r186 negates only polygonOffsetFactor for the reversed depth buffer, so every decal's negative
// polygonOffsetUnits ("pull toward the camera") pushed it AWAY: face-on (no depth slope, the factor term ~0) coplanar
// decals lost / flickered against the surface below. Re-issue the offset with both terms negated.
if (renderer.capabilities.reversedDepthBuffer && !params.has('nozfix')) {
  const gl = renderer.getContext(), st = renderer.state, setMat = st.setMaterial;
  st.setMaterial = function (material, frontFaceCW, clip) {
    setMat.call(this, material, frontFaceCW, clip);
    if (material.polygonOffset) gl.polygonOffset(-material.polygonOffsetFactor, -material.polygonOffsetUnits);
  };
}
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// far plane 150 km (foundation agent): the harbour, far shores and distant hinterland run out to the (fogged) true
// horizon instead of being clipped into a hard band at 6 km (reversed float depth keeps precision at this range)
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 150000);

const cityStage = async n => { paintBoot('loading ' + n); await yieldPaint(); };
function stubWorld() {
  // ?nocity: flat-ground stub matching the world contract traversal/hud need
  // (raycast/groundHeight/spawn/update/buildings). Isolates the city build.
  return {
    raycast: () => null,
    groundHeight: () => 0,
    surfaceAt: () => null,
    spawn: new THREE.Vector3(0, 0.5, 0),
    viewpoints: {},
    streetsAt: () => ({ type: 'block' }),
    buildings: [],
    update() {},
  };
}
let lighting, world, input, player, hud, pipeline;
try {
  lighting = await stage('renderer+lighting', async () => createLighting({ renderer, scene }));
  // MOBILE CITY MODE: the full procedural city exceeds Android tab budgets
  // (Aw, Snap! during build on normal/mobile/potato/notex alike). Phones get
  // the lightweight fallback city (same world contract, same gameplay);
  // desktop keeps the full city. Override: ?city=full | ?city=fallback.
  const cityFlag = params.get('city');
  const fallback = params.has('nocity')
    ? 'stub'
    : cityFlag === 'full' ? 'full'
    : cityFlag === 'fallback' ? 'fallback'
    : isMobileDevice() ? 'fallback' : 'full';
  console.log('[LOAD] city mode: ' + fallback);
  if (fallback === 'fallback') { bootRows.push('city mode: fallback (light mobile city)'); paintBoot(); }
  world = fallback === 'stub'
    ? await stage('stub-world (?nocity)', async () => stubWorld())
    : fallback === 'fallback'
    ? await stage('city-fallback', async () => buildFallbackCity({ scene, renderer }, { onStage: cityStage, fbq: params.get('fbq') || 'med' }))
    : await stage('city', async () => buildCity({ scene, renderer }, { onStage: cityStage, nodetail: params.has('nodetail') || isPotato() }));
  input = await stage('input', async () => createInput(renderer.domElement));
  player = await stage('player', async () => createPlayer({ scene, world, camera, input, renderer }));
  hud = await stage('hud', async () => createHud({ player, world, camera }));
  pipeline = await stage('pipeline', async () => createPipeline({ renderer, scene, camera, lighting }));
} catch (e) {
  console.error('[boot]', e);
  bootError((e?.message || e) + ' — try ?nocity to isolate the city.');
  throw e;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); pipeline.setSize(innerWidth, innerHeight);
});
if (typeof visualViewport !== 'undefined' && visualViewport) visualViewport.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); pipeline.setSize(innerWidth, innerHeight);
});

const ctx = { THREE, renderer, scene, camera, lighting, world, player, hud, pipeline, input };
ctx.systems = ctx.systems || []; // C5: game systems (src/game/**) push {update(dt)} here
window.__ctx = ctx;
// (perf r3) queue every shader program the game can draw (main pass + the river mirror's unshadowed variant + the
// post passes) before the first frame: they link in parallel on the driver's threads during the loading frame instead
// of one by one later, each freezing the game for 0.2-6 s the first time its material came into view
// (render/warmup.js). ?nowarm = old behaviour (A/B)
const warmup = !shotName && !params.has('nowarm') ? createWarmup(renderer, scene, camera, { mirrorLayers: [REFL_LAYER, BIG_CASTER_LAYER] }) : null;
// first the state the first frame would set that is part of the program keys: the sky IBL (scene.environment, from the
// first lighting update) and the pipeline's NO_SSR material defines
if (warmup) {
  await stage('warmup-rescan', async () => { lighting.update(camera); pipeline.prepareMaterials?.(); warmup.rescan(); });
  // (potato) skip the flush: 50-80 programs linking up front stalls low-end
  // drivers for tens of seconds (watchdog kill). Trickle via warmup.step().
  if (!isPotatoDevice()) await stage('warmup-flush', async () => warmup.flush());
  else { bootRows.push('skip warmup-flush (potato)'); paintBoot(); }
}
ctx.timeScale = 1; // global game-time scale (combat hit-stop / slow-mo); ctx.realDt = unscaled frame time
// (potato) systems+combat init runs AFTER the loop starts, so the world renders
// first frames even on phones where init is slow; a failure here can no longer
// masquerade as a city-build crash. Overlay is removed once init settles.
function settleBootLater() { if (!DIAG) setTimeout(() => bootEl.remove(), 4000); }
if (!shotName && !params.has('nosys')) {
  (async () => {
    try {
      await stage('systems', async () => (await import('./game/systems/index.js')).initSystems(ctx)); // open-world systems (C5)
    } catch (e) { console.error('[systems] init failed', e); bootRows.push('systems FAILED: ' + (e?.message || e)); paintBoot(); }
    try {
      await stage('combat', async () => (await import('./game/combat/index.js')).initCombat(ctx)); // combat (C5)
    } catch (e) { console.error('[combat] init failed', e); bootRows.push('combat FAILED: ' + (e?.message || e)); paintBoot(); }
    await stage('warmup-rescan2', async () => warmup?.rescan()); // (perf r3) + the meshes the systems / combat added (trickled by warmup.step)
    settleBootLater();
  })();
} else if (params.has('nosys')) {
  bootRows.push('skip systems+combat (?nosys)'); paintBoot();
  settleBootLater();
} else {
  settleBootLater();
}

if (shotName) {
  const shot = SHOTS[shotName];
  if (!shot) throw new Error('unknown shot ' + shotName);
  shot.apply(ctx);
  // Warm up: let shadows, TAA/accumulation, streaming settle.
  const dt = 1 / 60;
  for (let i = 0; i < (shot.frames ?? 90); i++) {
    shot.tick?.(ctx, dt, i);
    world.update(dt, camera); lighting.update(camera); hud.update(dt);
    pipeline.render(dt);
    await new Promise(r => requestAnimationFrame(r));
  }
  window.__shotInfo = `${renderer.info.render.calls} calls, ${renderer.info.render.triangles} tris`;
  window.__shotReady = true;
} else {
  const clock = new THREE.Clock();
  let frames = 0, fpsT = performance.now(), firstFrame = true;
  const tick = () => {
    ctx.realDt = Math.min(clock.getDelta(), 1 / 20);
    const dt = ctx.realDt * (ctx.timeScale ?? 1);
    player.update(dt); world.update(dt, camera); lighting.update(camera); hud.update(dt);
    for (const s of ctx.systems) s.update?.(dt);
    pipeline.render(dt);
    warmup?.step(); // (perf r3)
    frames++;
    if (firstFrame) {
      firstFrame = false;
      const r = renderer.info;
      bootRows.push('first-frame +' + ((performance.now() - bootT0) / 1000).toFixed(1) + 's calls=' + r.render.calls + ' tris=' + r.render.triangles + ' geo=' + r.memory.geometries + ' tex=' + r.memory.textures);
      paintBoot('running (systems init in background)');
      // overlay removal is handled by settleBootLater() once systems/combat settle.
    }
    if (DIAG && performance.now() - fpsT > 1000) {
      const fps = (frames * 1000 / (performance.now() - fpsT)).toFixed(0);
      frames = 0; fpsT = performance.now();
      const r = renderer.info;
      bootEl.textContent = '[run ' + fps + 'fps ' + memMB() + ' calls=' + r.render.calls + ' tris=' + r.render.triangles + ' geo=' + r.memory.geometries + ' tex=' + r.memory.textures + ']\n' + bootRows.join('\n');
    }
  };
  renderer.setAnimationLoop(tick);
  // Pause rendering when the tab is hidden: saves battery/GPU and avoids a
  // huge clamped delta plus a shader-recompile storm on return. Desktop-safe.
  let loopOn = true;
  document.addEventListener('visibilitychange', () => {
    if (shotName) return;
    if (document.hidden && loopOn) { loopOn = false; renderer.setAnimationLoop(null); }
    else if (!document.hidden && !loopOn) { clock.getDelta(); loopOn = true; renderer.setAnimationLoop(tick); }
  });
}
