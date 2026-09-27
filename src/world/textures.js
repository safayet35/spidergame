// OWNER: citygeo. Loads the baked city textures (tools/blender/city_textures.py) and builds array textures.
// Colour maps are sRGB, every data map (normal/roughness, height/AO/weathering, noise) is linear; max anisotropy.
import * as THREE from 'three';
import { getQuality, isMobileDevice } from '../render/quality.js';

const BASE = '/assets/city/tex/';

// Retries with back-off: under load Chromium can refuse a request (net::ERR_INSUFFICIENT_RESOURCES), which must not
// abort the whole city build.
export function loadImageRetry(src, tries = 5) {
  return new Promise((res, rej) => {
    let n = 0;
    const attempt = () => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => (++n < tries ? setTimeout(attempt, 250 * 2 ** n) : rej(new Error('texture failed to load: ' + src)));
      im.src = src;
    };
    attempt();
  });
}

function loadImage(name) { return loadImageRetry(BASE + name); }

// Diagnostic counters: per-texture GPU estimates (?notex isolation + crash attribution).
let TEX_N = 0, TEX_MB = 0;
function vramMB(w, h, layers = 1) { return w * h * 4 * layers * 1.33 / 1048576; }
function logTex(phase, name, w, h, layers, extra = '') {
  const mb = vramMB(w, h, layers);
  if (phase === 'uploaded') { TEX_N++; TEX_MB += mb; }
  console.log('[city] texture ' + phase + ': ' + name + ' ' + w + 'x' + h + (layers > 1 ? 'x' + layers : '') +
    ' (' + mb.toFixed(1) + 'MB GPU' + (phase === 'uploaded' ? ', total ~' + TEX_MB.toFixed(0) + 'MB #' + TEX_N : '') + ')' + extra);
}

function tex(im, { srgb = false, repeat = true, aniso = 8 } = {}, name = '?') {
  // (potato) halve source pixels on upload: 2048 -> 1024 = 1/4 VRAM per map.
  const TS = getQuality().texScale || 1;
  let src = im;
  if (TS < 1) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(64, Math.floor(im.width * TS)); cv.height = Math.max(64, Math.floor(im.height * TS));
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    src = cv;
  }
  const t = new THREE.Texture(src);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  logTex('uploaded', name, src.width, src.height, 1,
    ' fmt=RGBA8 cs=' + (srgb ? 'sRGB' : 'linear') + ' mips=on aniso=' + aniso);
  return t;
}

// Stack square images vertically in one tall image -> DataArrayTexture (layer i = i-th square)
function arrayFromImages(images, size, { srgb, aniso }, name = '?') {
  const TS = getQuality().texScale || 1;
  size = Math.max(64, Math.floor(size * TS)); // (potato) 1024 -> 512 = 1/4 VRAM
  const layers = images.reduce((n, im) => n + Math.round(im.height / im.width), 0);
  const data = new Uint8Array(size * size * 4 * layers);
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let L = 0;
  for (const im of images) {
    const n = Math.round(im.height / im.width);
    for (let i = 0; i < n; i++) {
      cx.clearRect(0, 0, size, size);
      cx.drawImage(im, 0, i * im.width, im.width, im.width, 0, 0, size, size);
      const d = cx.getImageData(0, 0, size, size).data;
      // flip Y so that v=0 is the bottom of the image (matches Texture.flipY behaviour)
      for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * size * 4;
        data.set(d.subarray(src, src + size * 4), (L * size * size + y * size) * 4);
      }
      L++;
    }
  }
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  logTex('uploaded', name, size, size, layers,
    ' fmt=RGBA8-array cs=' + (srgb ? 'sRGB' : 'linear') + ' mips=on aniso=' + aniso);
  return t;
}

export async function loadCityTextures(renderer, { onStage } = {}) {
  TEX_N = 0; TEX_MB = 0;
  const NO_TEX = new URLSearchParams(location.search).has('notex');
  if (NO_TEX) {
    // Isolation mode: geometry without textures. 1x1 placeholders of the
    // correct type (2D vs array) so every material/shader path still runs.
    console.log('[city] ?notex: bypassing ALL city image downloads (geometry-only boot)');
    const px = srgb => {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const t = new THREE.Texture(c);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true; return t;
    };
    const pa = srgb => {
      const t = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true; return t;
    };
    const markRects = await (await fetch(BASE + 'markings.json')).json(); // KBs, not the crasher; keeps decals working
    console.log('[city] textures done: 0 real textures (?notex placeholders), total ~0MB');
    return {
      asphaltCol: px(true), asphaltNrm: px(false), asphaltMacro: px(false),
      sidewalkCol: px(true), sidewalkNrm: px(false),
      interiors: px(true), signs: px(true), markings: px(true), leaves: px(false),
      grassCol: px(true), grassNrm: px(false), detailNrm: px(false),
      waterNrm: px(false), noise: px(false), markRects,
      wallsCol: pa(true), wallsNrm: pa(false),
      asphaltDecals: px(false), curbCol: px(true), wallsHao: pa(false),
    };
  }
  const TS = getQuality().texScale || 1;
  const SEQ = TS < 1 || isMobileDevice(); // phones: decode sequentially, never 19 parallel decodes
  const aniso = TS < 1 ? 1 : Math.min(16, renderer.capabilities.getMaxAnisotropy()); // (potato) aniso bandwidth cut
  const names = ['asphalt_col', 'asphalt_nrm', 'asphalt_macro', 'sidewalk_col', 'sidewalk_nrm', 'walls_col.jpg', 'walls_nrm.webp', 'walls_hao.jpg', 'curb_col.webp', 'asphalt_decals.webp', // (textures r2) nrm: lossless webp (was a 20 MB png); granite curb; (textures r3) road repair decals
    'interiors', 'signs', 'markings', 'leaves', 'grass_col', 'grass_nrm', 'water_nrm', 'noise', 'detail_nrm'];
  const key = n => n.replace(/\..*/, ''), url = n => n.includes('.') ? n : n + '.png';
  const ims = {};
  const got = (n, im) => {
    console.log('[city] texture loaded: ' + key(n) + ' ' + im.width + 'x' + im.height +
      ' (~' + (im.width * im.height * 4 / 1048576).toFixed(1) + 'MB decoded)');
    ims[key(n)] = im;
  };
  if (SEQ) {
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      console.log('[city] texture start: ' + key(n) + ' (' + (i + 1) + '/' + names.length + ')');
      if (onStage) await onStage('city/tex ' + (i + 1) + '/' + names.length + ' ' + key(n));
      got(n, await loadImage(url(n)));
    }
  } else {
    names.forEach(n => console.log('[city] texture start: ' + key(n)));
    for (const [k, im] of Object.entries(Object.fromEntries(await Promise.all(names.map(async n => [n, await loadImage(url(n))]))))) got(k, im);
  }
  const markRects = await (await fetch(BASE + 'markings.json')).json();
  const T = {
    asphaltCol: tex(ims.asphalt_col, { srgb: true, aniso }, 'asphalt_col'),
    asphaltNrm: tex(ims.asphalt_nrm, { aniso }, 'asphalt_nrm'),
    asphaltMacro: tex(ims.asphalt_macro, { aniso }, 'asphalt_macro'),
    sidewalkCol: tex(ims.sidewalk_col, { srgb: true, aniso }, 'sidewalk_col'),
    sidewalkNrm: tex(ims.sidewalk_nrm, { aniso }, 'sidewalk_nrm'),
    interiors: tex(ims.interiors, { srgb: true, repeat: false, aniso: 4 }, 'interiors'),
    signs: tex(ims.signs, { srgb: true, repeat: false, aniso }, 'signs'),
    markings: tex(ims.markings, { srgb: true, repeat: false, aniso }, 'markings'),
    leaves: tex(ims.leaves, { repeat: false, aniso: 4 }, 'leaves'),
    grassCol: tex(ims.grass_col, { srgb: true, aniso }, 'grass_col'),
    grassNrm: tex(ims.grass_nrm, { aniso }, 'grass_nrm'),
    detailNrm: tex(ims.detail_nrm, { aniso }, 'detail_nrm'),
    waterNrm: tex(ims.water_nrm, { aniso }, 'water_nrm'),
    noise: tex(ims.noise, { aniso: 4 }, 'noise'),
    markRects,
  };
  // facade layers 0..7 + roofs 8..12 + (textures r2) 13 terracotta, 14 stucco, 15 red brick 2; hao layer 16 = grime decals
  T.wallsCol = arrayFromImages([ims.walls_col], 1024, { srgb: true, aniso }, 'walls_col');
  T.wallsNrm = arrayFromImages([ims.walls_nrm], 512, { srgb: false, aniso }, 'walls_nrm'); // (textures r2) 512/layer (webp, half the VRAM)
  T.asphaltDecals = tex(ims.asphalt_decals, { repeat: false, aniso }, 'asphalt_decals'); // (textures r3) $imagegen asphalt repair decals (colour ratio x0.5, linear)
  T.curbCol = tex(ims.curb_col, { srgb: true, aniso }, 'curb_col'); // (textures r2) $imagegen granite curbstone (ground.js sidewalk material)
  T.wallsHao = arrayFromImages([ims.walls_hao], 512, { srgb: false, aniso }, 'walls_hao');
  console.log('[city] textures done: ' + TEX_N + ' city textures, total ~' + TEX_MB.toFixed(0) + 'MB GPU');
  return T;
}
