# Pocket Greens — specification

Pocket Greens is turn-based miniature golf in a whimsical garden: aim, set power and hole out in as few
strokes as possible across short courses with walls, stone planters, sand, water and moving keepers. It is a
StarHermit engine **script game** (TypeScript on the host API 1.30), pinned to engine **1.28.0** with
`engine.minor=30`, played natively by the StarHermit client and in browsers by the engine's web runtime.

## Files

| Path | What it is |
| --- | --- |
| `starhermit.txt` | Manifest: entry `native/main.ts`, engine 1.28.0 / minor 30, capabilities `platform,storage,clipboard`, actions and gamepad defaults, `server=score-script.js`. |
| `js/rules.js` | Deterministic rules and physics (fixed 1/120 s steps, quantized state), legality, scoring, seeded streams. Shared with `server.js` and the node tests. |
| `js/content.js` | Themes, 12 authored holes, 32 seeded procedural stages (Journey = 44), lessons, challenges, the daily course, validators. |
| `js/session.js` | Rounds of holes, totals, practice undo, replay envelope, the deterministic practice AI. |
| `js/strings.js` | Player-facing strings keyed by the en-US text, nine locales. |
| `js/progress.js` | The progression save document, merge, round recording, achievements, the old settings migration. |
| `native/main.ts` | State machine (title → mode-select → countdown → active ⇄ paused → resolving → results), rounds, input, trace playback, results and progression. |
| `native/screens.ts` | All UI on `starhermit:ui`. |
| `native/render.ts` | The course on `starhermit:scene`. |
| `native/quality.ts` | Looks per graphics tier/level. |
| `native/audio.ts` | Clips and ambience on `starhermit:audio`, sound captions. |
| `native/platform.ts` | Save, game settings, account, clock, leaderboard posting. |
| `native/rooms.ts` | Hosted (host-routed) two-player tables. |
| `native/i18n.ts`, `native/style.ts`, `native/classic.ts` | Localization, UI styles (`assets/ui-style.json` from `tools/ui-style.css`), the classic-script loader. |
| `score-script.js` | Platform server script: range-checks the `vs-par` score and posts it. |
| `server.js` | Development-only static/rules server (not packaged). |
| `sfx/` | Authored Opus clips (`manifest.json` lists them). |
| `index.html`, `starhermit-files.json` | The web loader and file index written by `npm run package` (never edit by hand). |

## Rules

- A hole is a rectangle (18 × 10 units) with a start and a cup. A stroke sets an angle and a power (1–100 %,
  quantized to 1 mrad and 0.5 %); the ball rolls with green friction (sand: heavy friction), banks off rails,
  walls, planters and keepers (restitution 0.72), and stops below 0.05 units/s.
- The cup captures a ball inside its radius moving at most 2.5 units/s — fast balls lip out.
- Water: +1 penalty stroke, the ball returns to where it was struck.
- A hole is capped at double par plus one (the cap counts as the score).
- Keepers move as a pure function of the simulation tick, so every stroke is replayable.
- Every stroke resolves synchronously in `js/rules.js` (at most 25 simulated seconds); its trace is then
  played back. Ties: total, holes completed, fewer invalid actions, elapsed time, id.

## Modes

- **Play** opens Journey at the furthest unlocked stage.
- **Learn**: five lessons (Aim and Strike, Bank Shots, Water Hazards, Carry the Gap, Moving Obstacles), each
  on its authored hole with step text in the status bar; Learn starts the first not yet completed one and
  Next lesson follows. Completing all unlocks *Course Mechanic*.
- **Journey**: 44 stages (12 authored, 32 seeded on `journey-v2`, four difficulty tiers), picked from a stage
  list (locked stages disabled, best strokes shown with ★). Holing a stage unlocks the next.
- **Daily Challenge**: one seeded course per UTC day (the date from the platform's clock, `serverNow()`, else
  the device's), par 4.
- **Practice**: any authored hole, undo (U) and hints, optional deterministic AI opponent.
- **Challenges**: Putter Only (power ≤ 40 %), Two Moves, Speed Green, Thread the Needle (no water), Iron
  Bounce (every stroke touches a wall); judged from the event stream.
- **Hosted Play** (signed in only): see below.

## Controls

| Action | Keys | Gamepad |
| --- | --- | --- |
| Aim left / right (Shift: fine) | ← / → | D-pad / left stick left, right |
| Power up / down (Shift: 1 %) | ↑ / ↓ | D-pad / left stick up, down |
| Strike | Space, Enter, Numpad Enter | A (South) |
| Cancel aim / close / pause | Esc | B (East) |
| Pause / resume | P | Start |
| Undo (practice) | U | X (West) |
| Hint | H | Y (North) |
| Reset camera | C | Left shoulder |
| Fast-forward the roll | F | Right shoulder |

Held aim and power keys repeat (after 0.4 s, 30 a second) on fixed steps. Pointer and touch: drag back from
anywhere on the course (slingshot: the ball goes the opposite way, the drag length sets the power, mapped
through the camera's tilt and turn); releasing strikes, Esc during the drag cancels. The Power slider and the
Strike / Undo / Hint buttons work by pointer, touch, keyboard and gamepad focus. Players rebind keys and pads
in the runtime's Options (the Help card lists the current bindings).

## Screens

- **Title**: over a live, dimmed garden hole: the menu with subtitles, progress (stages done, holes
  completed, best daily), the account line when signed in, Sign in with StarHermit (guest) or Invite a friend
  (copies the invite link), Hosted Play when signed in.
- **Setup**: description, duration, players, assists, ranking note, and the mode's choices; Start / Back.
- **Game**: status bar (objective, hole, par, strokes, total, cloud-save status, ⏸ Pause), Progress rail
  (mode, seed, totals per player), Status rail (what to do, the online notice, Help, Settings), the stroke tray
  (Power slider and value, Strike, Undo, Hint), sound captions above the tray, a toast below the status bar.
  A round starts with a 0.9 s countdown (0.1 s under reduced motion).
- **Pause**: Resume, Settings, Help, Restart hole, Leave round. **Help**: goal, controls, hazards.
  **Settings**: Captions for sounds, Color-vision palette, Reset lessons, and Open Options (the runtime's).
- **Results**: headline with total vs par, the score table, challenge status, new achievements, the
  leaderboard line; Next stage / Next lesson, Retry, Main menu.
- Layouts by logical window size: phone (≤ 700 px wide: rails at the top, each under half the width and at
  most 38 % of the course's height, scrolling; the tray wraps), short landscape (≤ 500 px tall: slim status
  bar, rails up to 60 %, the title menu two across), ≤ 1023 px narrower rails.
- On portrait views the camera turns a quarter so the course's long axis runs down the screen.

## Graphics

The runtime's Options choose the graphics level; `native/quality.ts` maps its tier and level to the old
presets: Low (Lambert materials, half-size textures, no shadows, no post, MSAA, flat colours), Balanced
(standard materials, 1024 shadows, bloom, grade, FXAA, reflections from a RoomEnvironment, animated water,
mowing stripes, wood grain, planter crowns, cup liner, waving flag, the garden: lawn into fog, hedges,
flowers, tufts, trees, stepping stones, pollen), High (clear-coated balls, 2048 shadows, GTAO, SMAA) and
Ultra (4096 shadows, full-resolution GTAO and bloom, double-size textures, MSAA). Particle and pollen budgets
grow with the level within a tier (at most 2×). Light intensities are the r185 values ÷ π. High contrast or a
colour-vision palette paints the flag yellow and the aim arrow white and drops the vignette; reduced motion
stills water, flag and pollen and plays rolls 6× faster.

## Audio

Authored clips per event (strike soft/hard, bounce by material, splash, holed, capped, round and session
complete, undo, invalid, UI click, aim tick) on the runtime's buses (effects; UI on interface), and the
theme's quiet ambience bed rendered into a looping clip on the music bus (the runtime has no ambience bus),
stopped while the window is hidden. Bounce and splash sounds fire where the roll's trace reaches them.
Volumes and mute are the runtime's Options.

## Platform

- **Save**: the progression document (`js/progress.js`, version 2, checksummed) is the engine save, on the
  device and in the account; conflicting copies merge (furthest unlock, best strokes, earliest achievements,
  larger counters, best daily). The browser build's cloud save (slot `game:<slug>`) is adopted once as a
  foreign save, merged and replaced. Guests' old browser localStorage progress cannot migrate.
- **Game settings** (`settings` storage, synced): captions, palette, completed lessons. The browser build's
  per-player settings (`audio`, `graphics`, `controls`, `tutorial`) carry these over once and are removed.
- **Leaderboard**: signed in, each finished solo round (Journey, Daily, Practice, Challenge; not Learn or
  hosted) posts strokes minus par to the `vs-par` board through `score-script.js` (a practice session whose
  socket sends `{type:'result', scores}`); the results card shows the rank.
- **Achievements** (in the save): First Cup, Course Mechanic, On a Roll, Half the Garden, Century of Putts.
- **Language**: the runtime's interface language picks one of en-US, en-GB, es-419, es-ES, de-DE, fr-FR,
  fr-CA, pt-BR, it-IT.

## Hosted play

Signed-in players quick-join an open two-seat room of the game or host one (metadata: today's daily seed);
the host starts the match on today's daily course. The host runs `js/rules.js`: guests send strike commands,
the host validates seat (the frame's participant id), turn and legality (idempotent by command id) and
broadcasts state, events and the roll trace (without the trace above the 8 KB frame cap). A stopped socket
shows the reason (terms, session expired, table unavailable). Practice vs AI is always offered.

## Determinism and checks

The session clock (countdown, AI pacing, trace playback) runs on the runtime's 60 fixed steps a second; play
scripts are exact. `npm test`: rules/content/session/server unit tests (`tests/run-tests.js`), progress and
i18n tests, then `tests/native.mjs` (web index up to date, `tsc`, `starhermit check` with no warnings, and the
native play scripts in `tests/native/` plus today's daily, planned at test time). The scripts are generated by
`npm run plays` (`tools/gen-plays.mjs`, strokes planned on the rules by `tools/plan.mjs`). `npm run
test:browser` (`tools/browser-play.mjs`) plays the packaged loader in GPU Chrome at desktop, phone and phone
landscape (DPR 3).

## Known limitations

- Hosted tables are host-routed with no server referee, so they are not recorded (no leaderboard, no room
  result: the runtime has no client room-result call). The hosted client path is not live-tested here.
- The browser build's Graphics panel overrides, render-scale and FPS readout are the runtime's Options now;
  its dead settings (left-handed, hold-to-aim, timing assistance) and the haptics toggle (the runtime's
  vibration option) are gone.
- The old synthesized fallback sounds while a clip loads are not ported (a clip not yet loaded is silent).
- Practice undo also undoes the AI's last stroke (as before: undo restores the state before the last command).
