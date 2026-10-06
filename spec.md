# Pocket Greens — Product and Game Specification

**Document status:** design specification only; no implementation is included.  
**Game index:** 93  
**Genre:** Turn-based precision sport  
**Players:** 2–4 players depending on ruleset, plus practice AI  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering direction:** Three.js-first presentation with a fully usable semantic HTML interface layer

## 1. Product vision

Pocket Greens is a game in which players aim and set stroke power across short obstacle courses; lowest total strokes wins. Its signature setting is a whimsical garden of miniature courses, water, and moving obstacles. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Aim and set stroke power across short obstacle courses; lowest total strokes wins.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **inspect the hole, aim and set power, strike, wait for rest, and pass**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Lowest strokes across the course wins; apply a per-hole stroke cap. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Hosted play:** private invitations and appropriate public matching, with reconnect and authoritative results.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The Three.js canvas fills the game region but is never the only UI. Menus, text, forms, chat, settings, and assistive descriptions use semantic HTML over or beside the canvas. Maintain a single shared layout model so DOM labels align with projected Three.js targets.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation.
- **Large screens (above 1600×1000 CSS px):** `ui-scale.js` sets `--ui-scale` (the smaller of width/1600 and height/1000, capped at 2.5) and each DOM UI layer — status bar, rails, action tray, captions, toast, menu screens and overlays — is CSS-`zoom`ed by it; the course canvas stays unzoomed and fills the playfield.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Lobby, roster, readiness, invitation, reconnect, result, and report states are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; DOM equivalents for canvas controls; headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a whimsical garden of miniature courses, water, and moving obstacles. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence
- `threejs-procedural-vegetation` for rooted growth, distance tiers, and wind that preserves silhouettes
- `threejs-water-optics` for shared wave normals, bounded reflections, refraction, absorption, and interaction ripples

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

### Graphics

**Graphics.** The scene uses ACES filmic tone mapping with sRGB output, a warm key light whose PCF shadow box is fitted to the current course and its surround, a hemisphere sky fill, and (with reflections on) image-based lighting from a procedural room environment so the clear-coated balls, flag pole and water pick up soft reflections. Garden detail adds mowing-stripe and grain textures on the green, rough, sand, wooden rails (with lighter caps) and stone planters, rippled reflective water, a white cup liner, a waving flag, painted bands on the keepers, and a garden surround outside the rails: a lawn fading into distance fog, a hedge ring, flower borders, grass tufts, stepping stones, corner trees and drifting pollen. Post-processing (EffectComposer, same three.js revision as the core) chains GTAO contact shading, bloom limited to highlights (threshold 0.9: water glints, the selection ring, specular highlights), a colour grade with S-curve contrast and vignette (no vignette in high contrast), and FXAA/SMAA or multisampled targets. Flag, water and pollen motion stop under reduced motion. The title menu sits over a live garden hole. Settings → **Graphics** offers Quality (Auto, detected from the GPU: software renderers get Low, discrete/Apple M GPUs High, others Balanced, touch devices at most Balanced; Low; Balanced; High; Ultra), Render scale (50–200%), a per-category override for shadows, ambient occlusion, bloom, colour grade, anti-aliasing, reflections, water, particles and garden detail ("From preset (…)" by default; choosing a preset clears overrides), Adaptive resolution (averages 90 frames; steps down to 60% when frames exceed 26 ms and back up below 14 ms) and Show frame rate (a readout in the lower left), plus a line with the GPU name, cost summary and pixel size. Pixel ratio is min(device ratio, preset cap: Low 1, Balanced 1.5, High/Ultra 2) × preset scale × render scale × adaptive scale; Low renders without post-processing and is no more expensive than the original low tier. Changes apply immediately (also while paused), are saved with the other settings (`graphics.gfx`; the old single quality tier migrates to a preset) and the panel strings are localized for en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT from the browser language. If post-processing cannot be built, the game renders without it and the panel says so.

## 5. Technical architecture

### Client modules

- `bootstrap`: host handshake, capability detection, asset manifest, lifecycle.
- `rules`: pure deterministic state transitions, legality, scoring, seeded random stream.
- `session`: local or hosted commands, snapshots, prediction policy, reconnect, replay.
- `render`: Three.js scene graph, semantic entity views, camera, lighting, VFX, quality.
- `gfx` (`gfx.js`): pure graphics quality model — presets, category overrides, GPU detection, `resolve()`, `describe()`; `gfx-i18n.js` holds the Graphics panel strings. Post-processing and environment addons are vendored under `vendor/addons/` (three r185, matching `vendor/three.*.min.js`) and mapped by the import map as `three/addons/`.
- Tests: `test.js` (rules, content, server smoke) and `tests/gfx.test.js` (`node --test`) run via `npm test`; `tests/e2e.mjs` drives the UI in headless Chrome, including a Graphics pass (presets, an override, reload persistence) at desktop and mobile sizes.
- `ui`: responsive DOM shell, focus, localization, settings, overlays, accessibility mirror.
- `audio`: buses, event mapping, focus/background behavior, decode and memory policy.
- `content`: versioned levels, themes, tutorials, validation metadata.
- `platform`: adapter over the shared StarHermit SDK (launch token and renewal, sign-in, profile, cloud save, settings KV, bindings, invite link, read-only boards). It never calls the game's own server routes (`/api`, `/ws`).

No module may mutate rules state except through a validated command. Rendering consumes immutable snapshots plus interpolation data. UI state and simulation state are separate so closing a drawer cannot affect a match.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Recover WebGL context by rebuilding GPU resources from retained CPU descriptors. If 3D is unavailable, present a clear compatibility message and preserve account/session state.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- The distribution has `starhermit.txt` at its root (`name=Pocket Greens`, `launch=index.html`, `server=server.js`, `control.*` lines). `index.html` loads the shared SDK `starhermit-sdk.js` (an unchanged copy of `tools/starhermit-sdk.js`) and calls `StarHermit.init()` before the game scripts; `platform.js` is the game's adapter over `window.StarHermit`.
- The SDK reads `#game_token=` (library launch) or `#access_token=` (direct sign-in return), strips the launch fragment, takes the slug from the `game_scope` claim and renews the token via `POST /api/v1/games/{slug}/launch-token`. Tokens are never persisted. When renewal is refused the game toasts that it is signed out and keeps playing locally.
- Without a token no StarHermit request is made. On `<id>.starhermit.com` without a token the title shows **Sign in with StarHermit**, which redirects through the platform sign-in.
- The client never calls the bundled `server.js` routes (time, REST sessions, presence, telemetry, leaderboard); the device clock is used. Without a launch token the game makes no network request beyond its static files.

### Identity, saves, preferences, controls
- The title's account line shows "Playing as <nickname>" (profile nickname, fallback `Player <id prefix>`) and the cloud-sync state; hosted opponents are labelled by nickname.
- Cloud save: the versioned, checksummed progress doc is mirrored to the `game:<slug>` slot (debounced 2 s, flushed with keepalive on `pagehide`/backgrounding). On start a valid remote doc wins; localStorage stays the offline cache.
- Settings KV: the `audio`, `graphics`, `controls` (handedness, hold-to-aim, timing assist, haptics, camera), and `tutorial` groups are mirrored with `PATCH /settings` on change (never before the platform values were read); on start the platform values override local ones.
- Controls: every keyboard action (aim, power, strike, cancel, pause, undo, hint, camera, fast-forward) is declared as `control.*` in `starhermit.txt`; keydown is routed by `event.code` through `StarHermit.loadBindings()` (Shift stays the fine-aim modifier), and Help lists the effective keys. There is no rebinding UI.
- **Invite a friend** (title, signed in only) copies `StarHermit.inviteLink()` with a confirmation toast. Account strings are localized in all nine locales (`platform-i18n.js`).

### Hosted play (realtime rooms)
- Hosted play uses StarHermit realtime rooms, host-routed: quick-join an open table or create and open one via the rooms REST API (through the SDK's authenticated `api`), then carry the session JSON and strike commands over the realtime WebSocket (`StarHermit.realtime.socketUrl`, 16-byte sender-prefixed binary frames, 8 KB cap). Roster pushes drive the lobby and the host posts the room result. The host runs the same deterministic rules engine; outcomes are host-authoritative.
- Without a launch token Hosted Play is hidden (there are no own-server REST sessions).

### Achievements and leaderboards
- Achievements are local and part of the cloud-saved progress doc; the platform has no server-declared achievements for this game. Platform boards are never written by the client; nothing is submitted standalone.

### Not used
- Session chat, the friends picker, matchmaking queues and replays need a platform game script (rooms have no chat conversation); voice is not used.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, friends-only filtering, cloud-save conflict handling, activity start/end pairing, and server-time countdown accuracy.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
