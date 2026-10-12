# Code Review Report (step 3: review-and-report-only)

**Branch:** none — not a git repository (adaptation: the whole of `audio-quality.js`, treated as one new file, is the "diff")
**Base:** n/a
**Files reviewed:** `audio-quality.js` (2039 lines, 1298 code lines); tests/tools read for duplication only
**Stack detected:** typescript (plain `.js` + JSDoc, `// @ts-check`); no framework in `package.json`
**Profiles run:** quality, stack-typescript, performance (reporting) · documentation, dependencies (writing profiles, run here as findings only, nothing written)
**Adaptations:** no `Agent` tool in this environment, so profiles were run one after another by the same reviewer instead of in parallel sub-agents. `security` is run separately as step 4 with the Spicetify threat model; `testing` was step 2.

---

## Critical & High Findings

None.

## Medium Findings

### [MEDIUM] [REDUNDANT] Q1 — `createExtension` is one 786-line closure
**File:** audio-quality.js:996
**Rule:** Size Thresholds — no function over 30 lines
**Issue:** Pill DOM, scheduling, the probe state machine and lifecycle share ~25 `let` variables in one function. Every test needs the whole fake world; no part can be tested or reasoned about alone.
**Root cause:** shared mutable state is held by closure instead of being owned by small units. The single-file constraint does not force this: factories can live in the same file.
**Fix:** `createPill(ctx)`, `createScheduler(ctx)`, `createProbe(ctx)` each own their state and expose a small interface; `createExtension` only composes them.

### [MEDIUM] [DEAD] Q3 — probe state that is written but never read
**File:** audio-quality.js:1042, 1423 (`id` / `nextProbeId`), 1425 (`kind`), 1429 + 1547 (`row`)
**Rule:** Dead Code — no unused variables
**Issue:** `p.id`, `p.kind`, `p.row` have no readers; `nextProbeId` exists only to feed `id`.
**Root cause:** fields were added while designing the state machine and never pruned.
**Fix:** delete the three fields, the counter and the `p.row = row` assignment.

### [MEDIUM] [REDUNDANT] Q4 — two near-identical enum parsers
**File:** audio-quality.js:386 (`parseBitrateLevel`), 404 (`parseHifiStatus`)
**Rule:** Redundancy — repeated blocks >5 lines
**Issue:** both are the same 12 lines (number → code table, digit string → recurse, token → name map with a prefix strip); only the tables and prefix differ.
**Root cause:** the "numeric code or enum name" decoding rule is encoded twice instead of once.
**Fix:** `parseEnum(raw, byCode, byToken, prefixRe)`; each parser becomes one call.

### [MEDIUM] T1 — type laundering through a double cast
**File:** audio-quality.js:1842 (`hook()`)
**Language/Framework:** TypeScript
**Rule:** Type Safety — define a proper type instead of bypassing it
**Issue:** `/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (win))` discards all type information to read and write `audioQualityCleanup`.
**Root cause:** `ExtensionEnv.win` is typed `Window & typeof globalThis`, which does not know about the hook.
**Fix:** `@typedef {Window & typeof globalThis & { audioQualityCleanup?: () => void }} HostWindow`, use it for `win`, delete `hook()` and the cast.

### [MEDIUM] T3 — phase-dependent state modelled as nullable fields
**File:** audio-quality.js:~150–190 (`ActiveProbe`), checks at 1537–1560, 1606–1625, 1738
**Language/Framework:** TypeScript
**Rule:** Discriminated unions preferred over optional fields for variant types
**Issue:** `panel`, `row`, `clickedAt`, `outcome` are `null` or set depending on `phase`; every step re-checks them (`p.panel === null`, `p.panel?.contains`).
**Root cause:** one flat object describes three different states (opening / reading / closing).
**Fix:** `type Probe = Opening | Reading | Closing` discriminated on `phase`; `panel: HTMLElement` is non-null in `Reading` and `Closing`.

## Low Findings

- **Q2 [LOW] Other functions over 30 lines** — `beginProbe` 52 (1401), `redact` 48 (710), `cleanup` 47 (1922), `stepReading` 43 (1537), `createTimerSet` 41 (805), `closeStep` 36 (1606). Each is cohesive; split out `buildProbeState`, `redactArray`/`redactObject`, `readOwnDepth`/`readAtDeadline`.
- **Q5 [LOW] [DEAD] `parseDepthFromText` is test-only** (529). Production code uses `extractDepthFromText`. Delete it; tests call the real function.
- **Q6 [LOW] [REDUNDANT] `endProbe` re-implements `cancelPoll`** (1668–1670 vs 1469–1470). Call `cancelPoll(p)` (and add `cancelWatchdog`).
- **Q7 [LOW] [REDUNDANT] `closeStage: 0 | 1` is a boolean** (183, 1438, 1592, 1620–1621). Use `closeAttempted: boolean`.
- **Q8 [LOW] Condition with 5 logical operators** — `isRowMarkedActive`'s inner predicate (~930–935). Replace with a table `[attribute, value][]` and `some`.
- **Q9 [LOW] Test setup repeated 3+ times** — `const world = createWorld();` ×48 in `extension.test.js` (+9 in `branches.test.js`), `world.boot({ probeEnabled: false })` ×15, `const ext = world.boot()` ×10. Hoist into a `boot(config)` factory / `beforeEach` per `describe`.
- **T2 [LOW] Assertion casts that narrowing would remove** — 731 (`value` already narrowed), 1136 (return `Element`), 1347/1354 (`matches[0]` after length checks: destructure), 979/981 (opaque timer handle cast to `number`: make `TimerApi` generic over its handle type).
- **T5 [LOW] Logger hides its own suppression** — `warnOnce` drops a key's 4th+ occurrence silently (897), so a recurring failure looks like it stopped. Append "(further occurrences suppressed)" on the 3rd.
- **P1 [LOW] Regex compiled per call** — `new RegExp(DEPTH_RE_SOURCE, "g")` at 518 runs on every 100 ms poll. Hoist a module-level `/Lossless\s+(16|24)-bit/g`; `matchAll` clones it, so sharing is safe.
- **P2 [LOW] Heartbeat works while minimized** — 1876 runs `update()` + `reconcile()` every 5 s even when `document.hidden`. Return early when hidden; `visibilitychange` already refreshes on restore.

## Documentation Fixes Applied
(writing profile, report-only here: **nothing was written**; these are the fixes it would apply)

- **D1 — inaccurate safety claim, header, lines 19–21:** "the only state it touches on Spotify's DOM is one class on `<html>`". False: the probe calls `click()` on Spotify's device-panel trigger and the panel's close control (optionally an active device row), and Spotify's own code then mounts the panel and flips `aria-expanded`. Reword.
- **D2 — over-promise, line 258:** "A wrong selector must degrade to 'Lossless', never to a visible panel flash." Contradicted by the test `panel selector mismatch` (the real panel is visible for up to ~1.5 s, at most twice, before the probe disables itself). State the limitation.
- **D3 — overstated, line 1660:** `endProbe` "Always restores the page". If the panel refuses to close it stays open (visible). Say so.
- **D4 — no README:** install, kill switches and constants, how to run tests/typecheck/mutation check, manual checklist, known limitations.
- **D5 — manifest drift:** `package.json` has no `engines`; it declares `@types/node ^22.0.0` while 26.6.4 is installed.
- Checked and fine: no TODO/FIXME/HACK, no commented-out code, JSDoc agrees with signatures (`tsc --strict` clean).

## Dependencies (CLI evidence, nothing upgraded)

- `npm audit --json`: `{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}`.
- `npm outdated --json`: only `@types/node` — `current 26.6.4`, `wanted 22.20.5`, `latest 26.6.5` (devDependency; the drift is in my manifest, see D5). All other packages current.
- Runtime: `node --version` = v22.22.2. Latest-LTS lookup was not run, so no runtime finding (profile: skip rather than guess).
- The extension itself declares **zero runtime dependencies**.

## Verified clean (checklist items that passed, with evidence)

`var`: 0 · explicit `any`: 0 · `for…in`: 0 · string concatenation: 0 · `JSON.parse(JSON.stringify)`: 0 · async/await/Promise: 0 (by design) · `@returns` on every value-returning function (AST check): none missing · generics constrained (`LruCache<K extends string, V extends object>`) · `as const` on literal tables · custom errors extend `Error` with `cause` · `finally` used for restore · `AbortController` drives all timers · idle minute: 0 DOM queries, 0 layout reads, 3 timers created/min · cache bounded at 100 · one body-`childList` observer.

## Dropped after false-positive validation
- Repeated string literals `"unreadable"` ×13, `"depth"` ×8, `"lossless"` ×8…: discriminated-union tags, idiomatic.
- File size (1298 code lines): the single-file layout is a stated requirement; the real issue is Q1.
- Polling every 100 ms instead of a MutationObserver for the panel: the stated requirement is polling.
- `internals` export exposes implementation details: documented test seam, absent in production (no `module`).

## Summary

| Profile | Critical | High | Medium | Low |
|---|---|---|---|---|
| quality | 0 | 0 | 3 | 6 |
| stack-typescript | 0 | 0 | 2 | 2 |
| performance | 0 | 0 | 0 | 2 |
| **Total** | **0** | **0** | **5** | **10** |

(documentation and dependencies are writing profiles and are not in the table)

Review complete: 0 critical, 0 high, 5 medium, 10 low findings across 3 profiles.
No critical or high findings. Ready for PR.
