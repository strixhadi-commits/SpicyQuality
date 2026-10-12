# Spicetify audio-quality pill — report

**Spotify desktop with Spicetify could not be run in this environment, so nothing below has been exercised
against the live client.** Everything was verified in Node against mocked Spicetify globals and a jsdom DOM.
Anything that depends on the live Spotify client (section 5) is **unverified until a human completes the
manual checklist (section 6)**. Nothing here claims the extension works in Spotify.

## 1. Files

| File | What |
|---|---|
| `audio-quality.js` | The extension: one plain JS file, JSDoc types, no dependencies (2216 lines, 1369 of code) |
| `test/*.test.js`, `test/helpers/` | 473 tests, fake clock, fake Spotify page |
| `tools/mutation-check.js` | 38 deliberate defects; each must make the suite fail |
| `review/step3-review-report.md`, `review/step4-security-report.md` | The two review reports exactly as produced before the fixes |
| `README.md` | Install, switches, how the probe stays safe, development |

## 2. What was verified, and what was not

| Check | Result |
|---|---|
| `tsc --strict`, `noUnusedLocals/Parameters` over the JSDoc types | clean |
| Tests (`npm test`) | **473 pass, 0 fail**: pure logic 254, probe/races 70, static scan 70, extension 56, branch paths 15, production bootstrap 8 |
| Coverage of `audio-quality.js` | lines 99.41 %, branches 92.87 %, functions 98.25 %. Uncovered: 1828-1829, 1885-1886, 1988-1989, 2173-2179 (defensive logging; the bootstrap `catch`, which *is* tested but in a separate jsdom realm Node's coverage cannot see) |
| Mutation check | **38 of 38** deliberate defects detected (each made at least one test fail) |
| Static scan (syntax tree) | no `fetch`/XHR/WebSocket/`eval`/`Function`/`innerHTML`/`localStorage`/key events/promise chains; no playback-API member names |
| `npm audit` | 0 vulnerabilities; the extension has zero runtime dependencies |
| **Not verified** | every item in section 5; that the panel is never painted, not even for one frame (jsdom has no paint, only computed style); CPU use; behaviour of throttled timers in a hidden window; real MutationObserver/paint ordering |

The first run of each suite failed in places; those failures are the bugs below, not hidden.

## 3. Bug list

### 3a. Found by running the tests (fixed in the same step)

| ID | Severity | Location | Description | Fix |
|---|---|---|---|---|
| B1 | High | `THIS_COMPUTER_RE`, `ACTIVE_TEXT_RE` (l.283) | Trailing `\b` can never match because `textContent` joins sibling elements with no space (`"This computerLossless 24-bit"`). The device row was never found, so the depth was never read. | Dropped the trailing `\b`. |
| B2 | Medium | `waitForSpicetify` (l.2062) | `getSpicetify()` was unguarded; a throw escaped `start()` with the global hook already set and no cleanup. | `try/catch`: warn once, retry (bounded). |
| B3 | Medium | `preflight` (l.1496) | A removed `<style>` element was not re-created, so the probe disabled itself for the whole session. | `ensureStyle()` first; disable only if the rule is still inactive. |
| B4 | Low | `buildReport` (l.1973) | The already-sanitised track id was wiped again by the redactor's `uri` key rule. | Key renamed (later superseded by S6). |
| B5 | Low | heartbeat in `mount` (l.2053) | Two throwaway timers per 5 s tick (~24/min). | Heartbeat calls `update()`/`reconcile()` directly (27 to 3 timers/min measured). |
| B6 | Low (UX) | `deriveDepthState` (l.1356) | `Lossless (checking...)` stayed on through the 5 s retry gaps while nothing was being checked. | "Checking" only while a probe runs, before the first attempt, or during a user re-check. |
| B7 | High | `undoPendingOpen` (l.1640), `closeNow` (l.1795), `closeStep` | Aborting or cleaning up after the trigger click but before the panel rendered let the panel open visibly once the hide rule was gone. | Undo our own click (only when the trigger reports `aria-expanded`). |
| B8 | Medium | `closeStep` (l.1756) | A fallback trigger click after the close button was already clicked could re-open a slowly closing panel. | Trigger re-click only when there is no close control. |
| B9 | Medium | `stepReading` (l.1701), `outcomeAtDeadline` (l.1690) | The panel-wide depth fallback fired on the first poll, before the active row rendered, and returned another device's depth (observed 16-bit for a 24-bit track). | Active row's own text while polling; panel-wide text only at the deadline and only if unambiguous. |

### 3b. Step 3 review findings (0 critical, 0 high, 5 medium, 10 low) — status after step 5

| ID | Sev | Finding | Status |
|---|---|---|---|
| Q1 | Medium | `createExtension` is one 827-line closure | **Not fixed (deferred).** Splitting into `createPill`/`createScheduler`/`createProbe` factories is a behaviour-neutral rewrite of the whole state machine; before the live-client checklist is done I judged its regression risk higher than its maintainability gain. First follow-up once the checklist passes. |
| Q2 | Low | Functions over 30 lines | **Partly fixed.** `redact`, `beginProbe` split. Remaining and cohesive: `cleanup` 47 (a table of steps), `createTimerSet` 41, `closeStep` 36, `stepReading` 31. |
| Q3 | Medium | Dead probe fields (`id`, `kind`, `row`, counter) | Fixed |
| Q4 | Medium | Two near-identical enum parsers | Fixed (`parseEnum`, l.410) |
| Q5 | Low | `parseDepthFromText` test-only | Fixed (removed) |
| Q6 | Low | `endProbe` duplicated `cancelPoll` | Fixed |
| Q7 | Low | `closeStage` was a boolean | Fixed (`closeAttempted`) |
| Q8 | Low | Condition with 5 logical operators | Fixed (table-driven) |
| Q9 | Low | Repeated test setup | Fixed where identical (49 to 24 and 9 to 2 sites); the rest differ in setup |
| T1 | Medium | Double-cast type laundering (`hook()`) | Fixed (`HostWindow` typedef) |
| T2 | Low | Avoidable casts | **Mostly fixed**; the opaque timer-handle cast stays in `createDefaultEnv` on purpose (browser handles are numbers) |
| T3 | Medium | Probe phases as nullable fields, not a union | **Not fixed (deferred).** A real union needs immutable state transitions; JSDoc cannot type in-place phase changes without casts. |
| T5 | Low | Logger hid its own suppression | Fixed ("further identical warnings suppressed") |
| P1 | Low | Regex compiled per call | Fixed |
| P2 | Low | Heartbeat ran while minimised | Fixed |
| D1-D5 | — | Inaccurate header claim; over-promising selector comment; overstated `endProbe` comment; no README; manifest drift (`engines`, `@types/node`) | Fixed |

## 4. Security list (step 4: 0 critical, 0 high, 4 medium, 2 low — all fixed)

| ID | Sev | Finding (concrete scenario) | Change |
|---|---|---|---|
| S1 | Medium | Quadratic regex in `redactString`: 80 000 characters took **4 015 ms** (another extension or a buggy field makes the click freeze the UI). | Input clipped to 2 048 characters before any pattern; e-mail pattern bounded. Now under 100 ms for every hostile input tried. |
| S2 | Low | Own `__proto__` key swapped the prototype of the redacted copy. | Own properties via `defineProperty`; `__proto__`/`constructor`/`prototype` treated as sensitive. |
| S3 | Medium | Deny-list redaction printed unknown fields (`hostLabel: "Alices-Gaming-PC"` appeared verbatim). | Allow-list: known quality keys by value (primitives/enum-like only); every other key by name and type only; deny-list kept as a second layer. |
| S4 | Medium | Hide class could be dropped mid-probe by page code; invisibility was checked once. | `<html class>` watcher re-applies it in a microtask (before paint); every poll re-asserts the class and re-checks computed visibility; if the panel is ever visible: close and disable. |
| S5 | Medium | Hidden panel stayed in the accessibility tree/focus order; focus never restored; probe could start under a typing user. | `visibility: hidden` added to the hide rule; no probe while a text control has focus (no attempt consumed); focus restored if a popover took it and the user did not move it. |
| S6 | Low | Click log held the full track id (listening history). | Type plus last 4 characters only. |

**Could not be fixed or verified here (residual risk):**
- A wrong **panel** selector shows the real panel until the probe notices (~1.5 s), at most twice, then it disables itself. Cannot be avoided without the real DOM.
- Invisibility is verified by computed style; paint (the "not even one frame" requirement) cannot be shown in jsdom. Backdrops/scrims outside the panel selector are not hidden.
- Redaction covers the click report. Other console output is constant text or `name: message` of internal errors.
- Opening the panel may refresh Spotify Connect's device list or emit telemetry; rate-limited (<=3/track, >=5 s same track, >=1.5 s overall) but not measured.
- If `Player.removeEventListener` were missing, each reload would leak one inert closure (it is documented).
- Any script can call or replace `globalThis.audioQualityCleanup`; same privilege domain, not defended.

## 5. Assumptions (every Spotify/Spicetify internal the code relies on)

Legend: **doc** = found in public docs/typings or a third-party mirror (still not the live client); **UNVERIFIED** = no source found, a guess.

| # | Assumption | Status |
|---|---|---|
| A1 | `Spicetify.Player.data` is the player state; `item.uri` holds the track URI | doc (Spicetify docs use `Player.data?.item`); live shape UNVERIFIED |
| A2 | `Spicetify.Platform.PlayerAPI._state` exists and holds the same state (private API) | UNVERIFIED; wrapped in `try/catch`, falls back to "unknown" |
| A3 | The quality object is `playbackQuality` (camelCase, numeric `bitrateLevel`/`hifiStatus`) or `playback_quality` (snake_case, strings) at the top level of the state | doc (Spicetify `globals.d.ts` and PlayerState docs, which say the latter may be inaccurate); location in the live object UNVERIFIED |
| A4 | `bitrateLevel`: 0 unknown, 1 LOW, 2 NORMAL, 3 HIGH, 4 VERY_HIGH, 5 HIFI, 6 HIFI24; `hifiStatus`: 0 NONE, 1 OFF, 2 ON | doc: matches librespot-protocol 0.8.0 `BitrateLevel` and `HiFiStatus` (reverse-engineered mirror, not Spotify's source) |
| A5 | Enum strings arrive as `low`, `very_high`, `hifi24`... | doc (mirror uses lower case); tolerance for upper-case/camel/prefixed forms is my addition |
| A6 | Level wins over `hifiStatus`; `HIFI24` does not imply 24-bit (the probe decides) | design decision, UNVERIFIED semantics |
| A7 | `Player.addEventListener/removeEventListener`, events `songchange`, `onplaypause` | doc; runtime ordering (state updated before the event?) UNVERIFIED, mitigated by the 700 ms settle and the commit-time URI check |
| A8 | `Spicetify.showNotification(text)`; the text may be treated as HTML | doc; we only send a constant string |
| A9 | Trigger: `button[data-testid="device-picker-icon-button"]` or `button[aria-label="Connect to a device"]` | **UNVERIFIED** (the label text appears in public articles; the test id is a guess) |
| A10 | Panel: `[data-testid="device-picker"]` or `[role="dialog"][aria-label="Connect to a device"]`, a single element | **UNVERIFIED** |
| A11 | The panel has a close control `button[aria-label="Close"]` / `[data-testid="close-button"]` | **UNVERIFIED** (if absent, the trigger is re-clicked once) |
| A12 | English UI: a row containing "This computer"; active marked by `aria-current`/`aria-selected`/`aria-checked`/`data-active`/`data-is-active`, or text "current device"/"listening on" | **UNVERIFIED**; other languages fail safe (no probe result) |
| A13 | Text `Lossless 24-bit/44.1 kHz` appears in the active device's row, possibly late (<=2 s) | spec gives the text; its location UNVERIFIED |
| A14 | Trigger exposes `aria-expanded` (used to undo our own click and to detect "already open") | **UNVERIFIED** |
| A15 | A synthetic `click()` opens/closes the panel like a user click; hiding it (opacity/visibility/pointer-events/clip-path) does not make Spotify close or mis-position it | **UNVERIFIED** |
| A16 | `textContent` of a `visibility:hidden` panel is readable; `isTrusted` is true only for real input in Spotify's browser | standard behaviour; UNVERIFIED in this CEF build |
| A17 | `document.hidden` turns true when minimised; `fullscreenchange` fires for Spotify's fullscreen | **UNVERIFIED** |
| A18 | The now-playing bar matches `[data-testid="now-playing-bar"]`, `.Root__now-playing-bar` or `footer` (fallback: 104 px above the bottom) | **UNVERIFIED** |
| A19 | The page's CSP allows inserting a `<style>` element | checked at run time: if the rule is inactive the probe disables itself |
| A20 | Theme variables `--spice-button`, `--spice-button-disabled`, `--spice-main`, `--spice-text` exist | fallbacks given |

Sources consulted: `github.com/spicetify/cli` (`globals.d.ts`), `spicetify.app/docs/development/api-wrapper` (player-state, player methods), `docs.rs/librespot-protocol` (`BitrateLevel`, `HiFiStatus`). Searches for the device picker's DOM found nothing usable.

## 6. Manual test checklist (for a tester with Spotify desktop and Spicetify)

Do these in order; stop and fix selectors at step 1 before anything else.

1. **Selectors.** In DevTools inspect the "Connect to a device" button, the opened panel, its close control and the "This computer" row. Compare with `SELECTORS`; adjust. First run with `PROBE_ENABLED = false` and confirm the pill alone (all quality tiers, colours, position, `Quality unknown` at half opacity).
2. **Click diagnostics.** Click the pill: console shows one report with `selectors.triggerFound: 1`, `hideRuleActive: true`, `probe.disabledReason: null`, no tokens/ids/names; the toast appears; `Lossless (checking...)` then a depth.
3. **Never visible.** Play a lossless track with the probe on. The device panel must never appear, **not even for one frame**: record the screen at 60 fps (or DevTools Performance with screenshots) and step frame by frame across the probe. The pill must show the correct depth: afterwards open the panel yourself and compare. Fail means a wrong panel selector, a scrim outside the panel, or a hide rule that does not apply: the probe self-disables after two misses.
4. **Right device.** With a second device listed, confirm the depth shown is for This computer; play on the phone and confirm no probe runs (`device-not-active`) and playback is not interrupted.
5. **Rapid skipping.** Hold Next / click 20 times, then pause during a probe (~0.7-3 s after a track change). Expect no panel flash, no stuck state (`document.documentElement.className` has no `spicetify-audio-quality-probing`), correct pill for the last track.
6. **Window states.** Minimise and restore mid-probe, toggle F11 and Spotify's fullscreen, resize. Pill stays centred; the probe aborts and resumes.
7. **Devices.** Switch to another device and back; confirm no row was clicked and playback never paused (`CLICK_ACTIVE_DEVICE_ROW = false`).
8. **Manual panel.** Open the device panel yourself (a) before and (b) during a probe: your panel stays open and visible; nothing is closed or hidden.
9. **Typing and focus.** Type in the search box while a lossless track starts and while one is mid-probe: no keystrokes lost, focus stays, no screen-reader dialog announcement.
10. **Reload.** Reload/re-evaluate the extension 5+ times: one `#spicetify-audio-quality-pill`, one `#spicetify-audio-quality-style`, listener counts unchanged (DevTools `getEventListeners`), `globalThis.audioQualityCleanup()` removes the pill and style and leaves `<html>` as it was.
11. **Console.** Watch it for 10+ minutes of normal use: at most three warnings per kind, no errors.
12. **CPU.** Measure the Spotify renderer for 5 minutes idle and 5 minutes of normal use (skipping every ~30 s) with the extension on and off (Task Manager or the DevTools performance monitor); the difference should be within noise. Record the numbers.
13. **Network.** Confirm the extension makes no requests; note any Connect/device-list requests while probing.
14. **Odd media.** Local files, podcasts, remote-device playback, offline mode, private session: pill must not break.
15. **Themes.** A custom Spicetify theme: pill legible, colours from the variables.

## 7. Process notes

1. **stack-typescript** — read; extension written as one JSDoc-typed file; `tsc --strict` clean.
2. **testing** — read; 473 tests, coverage, mutation check (above).
3. **review-and-report-only** — read; no git repository and no sub-agent tool here, so the whole file was the "diff" and profiles (quality, stack-typescript, performance; documentation and dependencies as findings only) ran one after another. No code changed.
4. **security** — read; run against the Spicetify threat model with measured evidence.
5. **review-and-fix** (+ shared verification) — read; fixes applied; `tsc`, tests, coverage and mutation check re-run.
6. **ship** — **not run**: neither the working directory nor the delivery directory is inside a git repository (`git rev-parse --is-inside-work-tree` fails in both). No repository was created to satisfy the step.
