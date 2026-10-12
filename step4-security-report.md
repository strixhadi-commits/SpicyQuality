# Security review (step 4) — Spicetify threat model

**Trust boundary.** A Spicetify extension runs in Spotify's renderer with full access to the client, exactly like Spotify's own code and every other extension. So there is no privilege boundary for *this file* to defend; the realistic risks are (a) this file doing something it should not (leaking data, acting on the wrong element, leaving the UI broken) and (b) other code in the same realm feeding it hostile data or reading what it prints. Findings below require a concrete scenario; "an attacker with code execution in the renderer" is not counted as a scenario because that attacker already owns the client.

Scope reviewed: `audio-quality.js` (all 2039 lines). Evidence: AST scan (`test/static-scan.test.js`), measurements run for this report, `npm audit`.

## Findings

### [MEDIUM] S1 — quadratic regex cost in `redactString` freezes the UI on a long string
**File:** audio-quality.js:~690 (`SENSITIVE_VALUE_PATTERNS` e-mail pattern) and `redactString`
**Rule:** Input Validation — all input validated/bounded at system boundaries; Data Exposure — logging path must not be a DoS vector
**Issue:** patterns run over the *whole* string and the 200-character truncation happens afterwards. Measured: `redactString("a".repeat(n))` takes 267 ms (n=20k), 949 ms (40k), **4015 ms (80k)**; `"a.".repeat(40000)` takes 4259 ms. Cost grows with n².
**Exploit scenario:** any other extension (or a buggy Spotify field) puts a 100 KB+ string into `playbackQuality`; the user clicks the pill; the renderer's UI thread hangs for seconds to minutes (≈6 s at 100 k, ≈25 s at 200 k).
**Fix:** cut the input to 2 048 characters *before* running any pattern, and bound the e-mail local part/domain (`{1,64}` / `{1,255}`) so backtracking is linear.

### [MEDIUM] S3 — denylist-only redaction prints values under unrecognised keys
**File:** audio-quality.js:~1811 (`buildReport`, `quality: snap.rawQuality`) and `SENSITIVE_KEY_RE`
**Rule:** Data Exposure — logs must not contain PII; Authentication — no token leakage
**Issue:** demonstrated: `redact({ bitrateLevel: 5, hostLabel: "Alices-Gaming-PC", note: "Alice iPhone 15" })` returns all three fields unchanged. The quality object's real shape is unverified, so unknown fields are likely.
**Exploit scenario:** a Spotify update adds a quality field carrying a device label; the user pastes the click log into a public bug report; the hostname leaks.
**Fix:** allow-list. Print only known quality keys (`bitrateLevel`, `bitrate_level`, `hifiStatus`, `hifi_status`, `strategy`, `targetBitrateLevel`, `target_bitrate_level`, `targetBitrateAvailable`, `target_bitrate_available`) and only primitive values that look like enums/numbers. Report unknown keys by *name and type only*, never by value. Keep the denylist as a second layer.

### [MEDIUM] S4 — nothing re-asserts the hide class or re-verifies invisibility during a probe
**File:** audio-quality.js:1537–1560 (`stepReading`), 1606–1640 (`closeStep`), `stepOpening` (single `isPanelHidden` check)
**Rule:** Leftover state / "the panel must never appear" (stated scope)
**Issue:** the class is added once; `isPanelHidden` is evaluated once, when the panel is first found.
**Exploit/failure scenario:** Spotify rewrites `documentElement.className` (theme or sidebar toggle) while the probe runs, or the panel's own fade-in is at opacity 0 at the first check. The class is lost / the panel fades in, and the real device picker is visible for the rest of the probe (up to ~3 s).
**Fix:** while a probe is active, observe `<html>` for class changes (`attributes`, `attributeFilter: ["class"]`; microtask callback runs before the next paint) and re-apply at once; also re-assert and re-check `isPanelHidden` on every poll, aborting and disabling the probe if the panel ever becomes visible.

### [MEDIUM] S5 — hidden panel stays in the accessibility tree, may take keyboard focus, and focus is never restored
**File:** audio-quality.js:1401–1460 (`beginProbe`), 1660–1680 (`endProbe`), `buildHideCss` (769)
**Rule:** Leftover state after a probe
**Issue:** `opacity: 0` / `clip-path` do not remove the popover from the accessibility tree or from focus order. No code records or restores `document.activeElement` (0 references to `activeElement`/`.focus(`), and the probe can start while the user is typing.
**Exploit/failure scenario:** the user is typing in the search box; a probe fires; the popover's focus trap moves focus into the invisible panel; the next keystrokes go nowhere (or press "Close"), and a screen reader announces a dialog the user never opened. After the probe, focus is on `<body>`.
**Fix:** add `visibility: hidden !important` to the hide rule (removes it from the accessibility tree and focus order; `element.click()` and `textContent` are unaffected); do not start a probe while an editable element has focus (retry later, no attempt consumed); remember `activeElement` before the click and restore it after the panel is gone if focus moved into the panel/trigger/body.

### [LOW] S2 — own `__proto__` key swaps the prototype of the redacted copy
**File:** audio-quality.js:~740 (`redact`, `out[key] = …`)
**Rule:** Deserialization of untrusted data uses safe handling — no prototype tricks
**Issue:** demonstrated: `redact(JSON.parse('{"__proto__":{"polluted":true},"bitrateLevel":5}'))` returns an object whose prototype is the attacker-supplied object (`out.polluted === true`). The global `Object.prototype` stays clean, so impact is limited to the logged copy.
**Exploit scenario:** hostile state supplies getters/`toString` on that prototype; inspecting the logged object in DevTools evaluates attacker code in the console context.
**Fix:** build the copy with `Object.create(null)` (or `Object.defineProperty` per key) and treat `__proto__`, `constructor`, `prototype` as sensitive keys.

### [LOW] S6 — the click log includes the current track id (listening history)
**File:** audio-quality.js:~1810 (`track: redactUri(snap.uri)`)
**Rule:** Logs do not contain PII
**Issue:** a track id plus the time a log was shared is a record of what the user was listening to.
**Exploit scenario:** log pasted into a public issue.
**Fix:** log only the URI *type* (`track`) and a 4-character suffix by default.

## Threat-model checklist (your scope list) — result

| Scope item | Result |
|---|---|
| No network, eval, `new Function`, remote code, innerHTML from untrusted data | **Pass**, verified on the syntax tree: no `fetch`/XHR/WebSocket/EventSource/`sendBeacon`/`eval`/`Function`/`import()`/`innerHTML`/`insertAdjacentHTML`/`document.write`/remote URL literal. Text is set with `textContent`; the one `<style>` text is built from constants, with the class name and selectors validated (`buildHideCss`); notifications use a constant string. |
| Click-handler output free of tokens/IDs/PII | **Fail → S1, S2, S3, S6** (denylist, unbounded cost, prototype swap, track id). |
| Selectors matching the wrong element (Settings / other dialogs) | **Pass with residual risk.** Trigger must be unique and outside any modal; probe refuses if any panel-selector match or modal exists before the click; close control and rows are looked up *inside* the panel only. Residual: a broad container matched as "panel" could hold another dialog's Close button — mitigated only by selector specificity (unverified selectors). |
| Synthetic key events triggering shortcuts | **Pass**: no `dispatchEvent`, no `*Event` construction, no `"Escape"`, no `key`/`keyCode` (AST scan). The only synthetic input is `HTMLElement.click()` (a click, never a key). |
| Leftover state after cleanup/error mid-probe | **Mostly pass, two gaps → S4, S5.** Tested: `finally`-restore, 7 s watchdog, stale-class self-heal, cleanup in all three phases, throwing DOM calls, undo of a pending open. Not changed: Spotify's inline styles (we never write them; class attribute whitespace may be normalised by `classList`). |
| Unbounded growth of listeners/timers/observers/caches | **Pass** (one-hour simulation: ≤5 pending timers, constant listeners, 1 observer, cache ≤100, logger ≤64 keys). Accepted residual: if `Player.removeEventListener` were missing, every reload would leak one inert closure (the API is documented; flagged as an assumption). |

## Considered and not reported
- `globalThis.audioQualityCleanup` can be replaced or invoked by any script: same privilege domain, no new capability.
- `isUserEvent` relies on `isTrusted`: unforgeable by page scripts.
- Dependencies: `npm audit` 0 vulnerabilities; the extension has no runtime dependencies; no secrets (no keys, tokens, `Math.random`).
- Side effect that cannot be checked here: opening the device panel may refresh Spotify Connect's device list or emit telemetry; probes are rate-limited (≤3/track, ≥5 s same track, ≥1.5 s overall) — see manual checklist.

## Summary

| Profile | Critical | High | Medium | Low |
|---|---|---|---|---|
| security | 0 | 0 | 4 | 2 |

Review complete: 0 critical, 0 high, 4 medium, 2 low findings. Fix S1, S3, S4, S5 before relying on the click log or the "never visible" claim.
