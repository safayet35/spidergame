// OWNER: render agent. Quality presets selected with ?q=low|med|high|mobile|potato (default high, auto mobile/potato on phones).
const PRESETS = {
  potato: {
    name: 'potato',
    cascades: 1, shadowMapSize: 512, shadowFar: 250, splits: [0.1, 250], shadowTaps: 3,
    ao: false, aoHalfRes: true, aoQuality: 'Performance',
    cloudSteps: 4, cloudLightSteps: 1, envSize: 32,
    taa: false, bloomLevels: 2, dofTaps: 0, mbSamples: 0, sharpen: 0.15,
    charShadow: 0, ssr: false, shafts: false, shaftSteps: 0,
    ssgi: false, wet: false,
    texScale: 0.5, renderScale: 0.75,
  },
  mobile: {
    name: 'mobile',
    cascades: 2, shadowMapSize: 1024, shadowFar: 400, splits: [0.1, 25, 400], shadowTaps: 5,
    ao: false, aoHalfRes: true, aoQuality: 'Performance',
    cloudSteps: 8, cloudLightSteps: 2, envSize: 64,
    taa: false, bloomLevels: 4, dofTaps: 12, mbSamples: 4, sharpen: 0.2,
    charShadow: 0, ssr: false, shafts: false, shaftSteps: 0,
    ssgi: false, wet: false,
  },
  low: {
    name: 'low',
    cascades: 2, shadowMapSize: 1024, shadowFar: 500, splits: [0.1, 30, 500], shadowTaps: 5,
    ao: false, aoHalfRes: true, aoQuality: 'Performance',
    cloudSteps: 10, cloudLightSteps: 2, envSize: 64,
    taa: true, bloomLevels: 5, dofTaps: 16, mbSamples: 6, sharpen: 0.25,
    charShadow: 0, ssr: false, shafts: false, shaftSteps: 0,
    ssgi: false, wet: false, // (lighting2 r1)
  },
  med: {
    name: 'med',
    cascades: 3, shadowMapSize: 2048, shadowFar: 900, splits: [0.1, 18, 90, 900], shadowTaps: 8,
    ao: true, aoHalfRes: true, aoQuality: 'Low',
    cloudSteps: 16, cloudLightSteps: 3, envSize: 128,
    taa: true, bloomLevels: 6, dofTaps: 22, mbSamples: 8, sharpen: 0.3,
    charShadow: 1024, ssr: true, ssrSteps: 20, shafts: true, shaftSteps: 12,
    ssgi: true, ssgiDirs: 4, ssgiSteps: 4, wet: true, // (lighting2 r1)
  },
  high: {
    name: 'high',
    // (foundation agent: a 5th, half-res cascade reaches 3 km so aerial views keep building / street-canyon shadows)
    cascades: 5, shadowMapSize: 2048, shadowFar: 3000, splits: [0.1, 14, 50, 200, 800, 3000], shadowTaps: 10,
    ao: true, aoHalfRes: false, aoQuality: 'Medium',
    cloudSteps: 22, cloudLightSteps: 3, envSize: 128,
    taa: true, bloomLevels: 6, dofTaps: 43, mbSamples: 10, sharpen: 0.35,
    charShadow: 2048, ssr: true, ssrSteps: 28, shafts: true, shaftSteps: 16,
    ssgi: true, ssgiDirs: 6, ssgiSteps: 4, wet: true, // (lighting2 r1) SSGI + wet-patch roughness
  },
};

let _q = null;
export function isMobileDevice() {
  try {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820) return true;
    if (navigator.maxTouchPoints > 0 && (navigator.hardwareConcurrency || 8) <= 4) return true;
  } catch { /* non-browser */ }
  return false;
}
export function isPotatoDevice() {
  try {
    if (new URLSearchParams(location.search).get('q') === 'potato') return true;
    if (!isMobileDevice()) return false;
    if ((navigator.hardwareConcurrency || 8) <= 4) return true;
    if (Math.min(screen.width, screen.height) < 700) return true;
    if ((navigator.deviceMemory || 8) <= 3) return true;
  } catch { /* non-browser */ }
  return false;
}
export function isPotato() {
  try { return getQuality().name === 'potato'; } catch { return false; }
}
export function getQuality() {
  if (_q) return _q;
  let name = 'high';
  try {
    const p = new URLSearchParams(location.search).get('q');
    if (p && PRESETS[p]) name = p;
    else if (!p) name = isPotatoDevice() ? 'potato' : (isMobileDevice() ? 'mobile' : 'high'); // auto tier on phones
    if (p === 'medium') name = 'med';
  } catch (e) { /* non-browser */ }
  _q = { ...PRESETS[name] };
  // (perf) ?perfoff disables the perf agent's culling / batching changes (A/B measurements with tools/perf_probe.mjs)
  try { _q.perf = !new URLSearchParams(location.search).has('perfoff'); } catch (e) { _q.perf = true; }
  // (perf r2) ?qset=ao:0,ssr:0,shadowMapSize:1024 overrides single preset fields (GPU ablation with tools/perf_probe.mjs)
  try {
    const qs = new URLSearchParams(location.search).get('qset');
    if (qs) for (const kv of qs.split(',')) { const [k, v] = kv.split(':'); if (k in _q) _q[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v; }
  } catch (e) { /* non-browser */ }
  return _q;
}
