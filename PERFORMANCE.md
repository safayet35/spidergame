# PERFORMANCE.md — mobile stability baseline (fallback-v1-final)

Developer note. The game runs two city architectures behind one world
contract (`raycast`, `groundHeight`, `buildings`, `spawn`, `footprints`,
`getMapFeatures`, `update`). Gameplay (traversal, camera, HUD, combat) works
on either. Which one loads is chosen in `src/main.js`:

- phones (`isMobileDevice()`, `src/render/quality.js`) → fallback city
- desktop → full procedural city
- override: `?city=full` forces full, `?city=fallback` forces fallback

## 1. Original desktop city architecture

`src/world/city.js` `buildCity()` procedurally generates Manhattan at load:
layout grid → `generateBuildings` (GrowBuf number arrays) → Times Square /
Grand Central / rooftops / signage builders → per-tile conversion to typed
arrays → `batchTiles` merge → ground, park, far shores, bridges, hinterland,
boats, highways, props, trees, traffic, crowd/pigeons, flags → collision grid
+ zip points. Rendered through `src/render/pipeline.js` (HDR targets, TAA,
DoF, motion blur, bloom, SSR/SSGI/shafts, N8AO) with 5-cascade CSM shadows
(2048px) on `high`, plus a 50–80-program shader warmup flush before frame one.

## 2. Why Android Chrome crashed ("Aw, Snap!")

Build-time transient resource peak, not steady-state JS heap. The loading
overlay showed ~58 MB JS heap because `performance.memory` cannot see GPU and
native transient memory. Evidence from isolation runs (all crashed identically):

- base preset → crash during `city/*`
- `?q=potato` (features off) → crash (same city is still *built*)
- `?notex` (zero textures, geometry only) → crash

Contributors, measured from source:

| resource | desktop cost |
|---|---|
| city textures (walls 1024×16384 ≈ 89 MB GPU, 3× 2048² maps ≈ 22 MB each) | ~465 MB GPU |
| tile builders + conversion peak (all ~100 tiles resident) | GBs (desktop once OOM'd at ~3.3 GB here) |
| pipeline targets (scene/lit/hist/post/DoF/SSR/etc, full-res HalfFloat) | ~169 MB |
| warmup flush (50–80 programs, one upfront stall) | watchdog-kill freeze on Mali/Adreno |
| shadow maps (5× 2048 on high) | large + per-cascade passes |

`three` reversed-depth falls back gracefully (warn-only) and was ruled out.
The fix is architectural (Section 3), not a quality slider: lowering quality
cannot shrink a construction peak.

## 3. Mobile fallback architecture (`src/world/fallbackCity.js`)

Deterministic 9×9-block box city, same world contract, no async loads:

- 9×9 blocks (64 m lots + 26 m streets), 2–4 buildings each + setback crowns,
  sidewalk slabs, ground plane → ~430 collision AABBs
- ONE merged vertex-coloured mesh + ground plane + merged window glass +
  night-only window glow → 3 draws day / 4 night
- zero textures, zero downloads, zero GLB loads for the city
- analytic ray-vs-AABB `raycast`, box-top `groundHeight`, footprint minimap
- crimes sim stubbed off (needs Manhattan road graph); towers/collectibles/
  travel verified distance-guarded and inert

## 4. Measured budget (fallback, worst case)

| metric | fbq=low (rollback) | fbq=med (Batch 1) | fbq=high (Batch 2, default) |
|---|---|---|---|
| triangles | ~10k | ~38k max | ~58k max |
| draw calls | 2 | 3 / 4 night | 3 / 4 night |
| textures / downloads | 0 / 0 | 0 / 0 | 0 / 0 |
| materials | 2 | 4 | 4 |
| lights added | 0 | 0 | 0 |
| city build time | ms | ms | ms |

Caps enforced in code: 7000 window quads, merged paint/lamps/landmarks into
the main arrays (+0 draws). Budget targets: <100k tris, <20 draws.

Non-city mobile loads: `spiderman.glb` ~10 MB (procedural fallback on
failure), `thug.glb` ~3.7 MB if combat inits (failures caught, traversal
unaffected), local fonts only. `vehicles.glb`, `props.glb` and the texture
set are unreachable on the fallback path.

## 5. Mobile quality presets (`src/render/quality.js`)

Auto-selected when no `?q`: `potato` (≤4 cores / narrow screen / ≤3 GB RAM)
else `mobile` on phones, `high` on desktop.

| | potato | mobile |
|---|---|---|
| shadows | 1×512, 1 cascade | 2×1024, 2 cascades |
| TAA / AO / SSR / SSGI / shafts / DoF / motion blur | off | off |
| bloom levels | 2 | 4 |
| renderScale / DPR cap | 0.75 / 1.0 | 0.85 / 1.0 |
| city textures | halved (n/a on fallback) | full (n/a on fallback) |
| warmup flush | skipped (trickle) | full flush |

`fbq=low|med|high` (`?city=fallback&fbq=low` = guaranteed rollback to the
original stable boxes). Shown in the loading overlay + `?diag` live readout
(fps, calls, tris, geometries, textures).

## 6. Disabled on mobile vs desktop-only

Off on mobile: all post FX above, crowds/traffic/peds (fallback has none to
spawn), crimes sim (fallback), warmup flush (potato). Desktop-only: full
procedural city, 465 MB texture set, 5-cascade shadows, crimes/towers at real
coordinates, warmup flush. Untouched everywhere: traversal physics, camera,
HUD, combat mechanics, touch + keyboard/mouse input, audio (lazy,
post-gesture, never fatal).

## 7. Overrides and dev flags (developer-only, no production effect)

- `?city=full` — original city on any device (desktop default path)
- `?city=fallback[&fbq=low|med|high]` — preview fallback tiers on desktop
- `?q=mobile|potato|low|med|high`, `?dpr=`, `?diag` — tier/DPR/live stats
- `?nocity` (stub world), `?nosys`, `?noshadow`, `?nowarm`, `?notex`
  (geometry-only full city), `?nodetail`, `?stopafter=city/<stage>`
  (partial-scene bisect) — diagnosis only

## 8. Known limitations

- Fallback fidelity is grey-box: no Times Square/landmarks/bridges, no
  crowds/traffic, no random crimes, fast-travel stations reference old
  coordinates (avoid on mobile).
- `public/assets` (~139 MB, mostly desktop textures) still ships in `dist/`;
  unused on fallback but downloaded only if referenced (it isn't).
- No on-device long-session numbers yet; `?diag` is the instrument.
- Key discovery, restated: the Android killer was the city *construction*
  peak (transient native + GPU memory), invisible to the JS heap readout.
  Any future city work must preserve the bounded-peak property: chunked or
  trivially-small builds only, never all-at-once.

## 9. Rule going forward

Incremental visual work only, on the fallback architecture, one stage at a
time with before/after `?diag` numbers. Keep `?city=fallback&fbq=low`
byte-stable as the guaranteed rollback. Baselines: tag `fallback-stable`
(original boxes), commit `62118e2` (Batch 1), tag `fallback-v1-final` (this).
