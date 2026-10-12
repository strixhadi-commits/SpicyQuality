# Spicetify audio-quality pill

A single plain-JavaScript Spicetify extension (`audio-quality.js`, no dependencies, no React) that shows a
small pill at the bottom centre of the Spotify window with the current playback quality.

| Playback | Pill text |
|---|---|
| Lossless, bit depth known | `Lossless 24-bit` / `Lossless 16-bit` |
| Lossless, depth being read | `Lossless (checking...)` |
| Lossless, depth unreadable | `Lossless` |
| Not lossless | `Very High (~320 kbps)`, `High (~160 kbps)`, `Normal (~96 kbps)`, `Low (~24 kbps)` |
| Unknown | `Quality unknown` (half transparent) |

Lossless uses `var(--spice-button, #1db954)`, everything else `var(--spice-button-disabled, #535353)`.
Clicking the pill logs a redacted quality report to the console, clears the cached depth for the current
track, shows a notification and re-checks.

> **Status.** Written and tested against **mocked Spicetify globals and a jsdom DOM only**. It has not been run
> inside Spotify. Every Spotify-internal assumption is listed in `REPORT.md`; the bit-depth probe in
> particular depends on DOM selectors that are guesses until a human has checked them (see the manual checklist).

## Install

Copy `audio-quality.js` into Spicetify's `Extensions` folder, then:

```
spicetify config extensions audio-quality.js
spicetify apply
```

Reloading or re-evaluating the file tears the previous instance down first. To remove everything it added
(pill, style element, listeners, observers, timers) without restarting, run in DevTools:

```js
globalThis.audioQualityCleanup()
```

## Switches (constants at the top of the file)

| Constant | Default | Meaning |
|---|---|---|
| `PROBE_ENABLED` | `true` | `false` = never touch the device panel; lossless shows plain `Lossless`. Use this first on a new Spotify build. |
| `CLICK_ACTIVE_DEVICE_ROW` | `false` | Also click the "This computer" row, only when it is already marked active. Leave off unless manual testing shows the depth appears only after that click. |
| `RECLICK_TRIGGER_TO_CLOSE` | `true` | If the panel has no close control, click the trigger once more to close it. |
| `SELECTORS` | guesses | Every DOM selector, in one table. Adjust after inspecting the real client. |

## How the bit-depth probe stays safe

Bit depth is only shown in Spotify's device panel, so the probe opens that panel with the panel hidden
(`opacity`, `visibility`, `pointer-events`, `clip-path`, scoped by a class on `<html>` that is added *before* the
click). It never pauses, skips, seeks or changes device, never sends key events, and gives up cleanly:

- Needs: window visible, no probe running, >=700 ms since the last track change, >=1.5 s since any probe,
  >=5 s since the last probe of the same track, <=3 automatic probes per track, no modal open, nobody typing.
- Only reads when "This computer" is the active device; one probe at a time; the hide class is re-asserted
  while it runs and removed in a `finally`, with a 7 s watchdog behind it.
- Yields to the user: genuine input aborts it; a panel the user opened is never closed or hidden.
- Fails safe: wrong trigger/close/row selectors do nothing; a wrong *panel* selector can show the real panel
  for ~1.5 s at most twice before the probe disables itself for the session.

## Troubleshooting

Click the pill and read the console report. `selectors.triggerFound` should be `1`, `selectors.hideRuleActive`
`true`, `probe.disabledReason` `null`. Unknown fields of the quality object are listed by name and type only.

## Development (Node >= 22)

```
npm install
npm test                       # 473 tests, node:test + jsdom, fake clock
npm run coverage               # built-in V8 coverage for audio-quality.js
npm run typecheck              # tsc --strict over the JSDoc types
node tools/mutation-check.js   # 38 deliberate defects; every one must make the suite fail
```

`test/helpers/world.js` is the fake Spotify (device panel with asynchronous rendering, click-outside close,
late-rendering quality text). It encodes assumptions, not facts about the real client.
