// OWNER: traversal engineer. Touch controls for mobile (MVP traversal set).
// Single fixed left stick (move) + right-half swipe (look) + 4 hold buttons
// (SWING / JUMP / ZIP / DIVE). No dependencies; feeds the same contract as
// player/input.js poll(): move {x,y}, look {dx,dy}, swing/jump/zip/drop/sprint.
export function isTouchDevice() {
  try {
    if (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches) return true;
    if ('ontouchstart' in window) return true;
  } catch { /* non-browser */ }
  return false;
}

export function isMobilePreset() {
  try {
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820) return true;
  } catch { /* ignore */ }
  return false;
}

const STICK_R = 56; // px stick travel radius

function css() {
  if (document.getElementById('touch-css')) return;
  const s = document.createElement('style'); s.id = 'touch-css';
  s.textContent = `
  #touch-ui{position:fixed;inset:0;z-index:20;pointer-events:none;touch-action:none;
    padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
  #touch-ui.hidden{display:none}
  .t-stick{position:absolute;left:4vw;bottom:calc(4vh + env(safe-area-inset-bottom));width:128px;height:128px;border-radius:50%;
    background:rgba(10,18,44,.35);border:1.5px solid rgba(170,195,255,.4);pointer-events:auto;touch-action:none}
  .t-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;border-radius:50%;transform:translate(-50%,-50%);
    background:rgba(200,215,255,.55);box-shadow:0 2px 10px rgba(0,0,20,.4)}
  .t-btns{position:absolute;right:3vw;bottom:calc(3.5vh + env(safe-area-inset-bottom));display:grid;gap:10px;pointer-events:auto;
    grid-template-columns:repeat(2,68px);grid-template-rows:repeat(2,68px)}
  .t-btn{border-radius:50%;border:1.5px solid rgba(200,215,255,.55);background:rgba(10,18,44,.5);color:#fff;
    font:700 11px/1.1 Rajdhani,sans-serif;letter-spacing:.08em;touch-action:none;user-select:none;-webkit-user-select:none;min-width:44px;min-height:44px}
  .t-btn.on{background:rgba(240,150,40,.65);border-color:#ffd35a}
  .t-btn.swing{width:76px;height:76px;justify-self:end}
  .t-pause{position:absolute;left:50%;top:calc(1.5vh + env(safe-area-inset-top));transform:translateX(-50%);
    width:44px;height:44px;border-radius:50%;border:1.5px solid rgba(200,215,255,.55);background:rgba(10,18,44,.5);
    color:#fff;font:700 16px Rajdhani,sans-serif;pointer-events:auto;touch-action:none}
  @media (orientation:portrait){
    .t-stick{left:5vw;bottom:calc(9vh + env(safe-area-inset-bottom))}
    .t-btns{right:4vw;bottom:calc(9vh + env(safe-area-inset-bottom));grid-template-columns:repeat(2,64px);grid-template-rows:repeat(2,64px)}
  }
  body.touch .help{display:none!important}
  @media (pointer:coarse){
    .mm-wrap{width:34vw!important;min-width:140px!important;right:3vw!important;bottom:auto!important;top:calc(2vh + env(safe-area-inset-top))!important}
  }`;
  document.head.appendChild(s);
}

export function createTouch() {
  const t = {
    move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 },
    swing: false, jump: false, zip: false, drop: false, sprint: false,
    active: false,
  };
  if (typeof window === 'undefined') return t;
  if (!isTouchDevice() && !isMobilePreset()) return t;
  t.active = true;
  try { document.body.classList.add('touch'); } catch { /* ignore */ }
  css();

  const root = document.createElement('div');
  root.id = 'touch-ui';
  root.innerHTML = `
    <div class="t-stick"><div class="t-knob"></div></div>
    <button class="t-pause" aria-label="Pause">II</button>
    <div class="t-btns">
      <button class="t-btn zip" data-k="zip">ZIP</button>
      <button class="t-btn dive" data-k="drop">DIVE</button>
      <button class="t-btn jump" data-k="jump">JUMP</button>
      <button class="t-btn swing" data-k="swing">SWING</button>
    </div>`;
  document.body.appendChild(root);
  t.root = root;
  const setVisible = b => root.classList.toggle('hidden', !b);
  t.setVisible = setVisible;

  // --- left stick ---
  const base = root.querySelector('.t-stick'), knob = root.querySelector('.t-knob');
  let stickId = null; const sc = { x: 0, y: 0 };
  const setKnob = (dx, dy) => { knob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`; };
  base.addEventListener('pointerdown', e => {
    stickId = e.pointerId; base.setPointerCapture?.(e.pointerId);
    const r = base.getBoundingClientRect(); sc.x = r.left + r.width / 2; sc.y = r.top + r.height / 2;
    e.preventDefault();
  });
  base.addEventListener('pointermove', e => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - sc.x, dy = e.clientY - sc.y;
    const l = Math.hypot(dx, dy);
    if (l > STICK_R) { dx *= STICK_R / l; dy *= STICK_R / l; }
    setKnob(dx, dy);
    t.move.x = dx / STICK_R; t.move.y = -dy / STICK_R;
    const mag = Math.hypot(t.move.x, t.move.y);
    t.sprint = mag > 0.92; // full tilt = sprint/parkour (replaces Shift)
    e.preventDefault();
  });
  const stickUp = e => {
    if (e.pointerId !== stickId) return;
    stickId = null; t.move.x = t.move.y = 0; t.sprint = false; setKnob(0, 0);
  };
  base.addEventListener('pointerup', stickUp);
  base.addEventListener('pointercancel', stickUp);

  // --- right-half swipe look (anywhere except sticks/buttons) ---
  let lookId = null, lx = 0, ly = 0;
  const LOOK_GAIN = 2.4;
  addEventListener('pointerdown', e => {
    if (!t.active || e.pointerType === 'mouse') return;
    if (e.target.closest?.('#touch-ui .t-stick,#touch-ui .t-btn,.sys-menu,.sys-photo,.interactive')) return;
    if (e.clientX < innerWidth * 0.35) return; // left 35% reserved for stick hand
    if (lookId !== null) return;
    lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
  }, { passive: true });
  addEventListener('pointermove', e => {
    if (e.pointerId !== lookId) return;
    t.look.dx += (e.clientX - lx) * LOOK_GAIN;
    t.look.dy += (e.clientY - ly) * LOOK_GAIN;
    lx = e.clientX; ly = e.clientY;
  }, { passive: true });
  const lookUp = e => { if (e.pointerId === lookId) lookId = null; };
  addEventListener('pointerup', lookUp);
  addEventListener('pointercancel', lookUp);

  // --- buttons (hold semantics) ---
  for (const b of root.querySelectorAll('.t-btn')) {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', e => {
      b.setPointerCapture?.(e.pointerId);
      t[k] = true; b.classList.add('on');
      e.preventDefault(); e.stopPropagation();
    });
    const off = e => { t[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  // prevent double-tap zoom / scroll while playing (menus must still scroll)
  document.addEventListener('touchmove', e => {
    if (!t.active) return;
    if (e.target.closest?.('.sys-menu,.sys-photo,.interactive,.sys-scroll')) return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
  // pause button: synthesize Esc so the existing pause menu opens (no menu changes needed)
  root.querySelector('.t-pause')?.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
  });

  t.consumeLook = () => { const r = { dx: t.look.dx, dy: t.look.dy }; t.look.dx = t.look.dy = 0; return r; };
  return t;
}
