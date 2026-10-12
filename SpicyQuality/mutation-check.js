"use strict";

/**
 * Mutation check: applies one deliberate defect at a time to a COPY of audio-quality.js and runs the
 * whole test suite against it. A mutation is "killed" if at least one test fails. Survivors mean a gap.
 * Usage: node tools/mutation-check.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "audio-quality.js"), "utf8");

const mutations = [
  ["M01", "hide class applied AFTER the trigger click (panel could paint)", "applyHide(); // BEFORE the click: the panel must never be painted visible", "", [["trigger.click();\n        schedulePoll(p);", "trigger.click();\n        applyHide();\n        schedulePoll(p);"]]],
  ["M02", "depth committed without the live-URI check", "if (liveUri === p.uri) {", "if (true) {"],
  ["M03", "synchronous close no longer undoes a pending open", "if (p.clickedAt !== null) undoPendingOpen(p);\n        return;", "return;"],
  ["M04", "hide class not removed when a probe ends", "removeHide();\n        if (probe === p) probe = null;", "if (probe === p) probe = null;"],
  ["M05", "no 700 ms settle after a track change", "trackChangeSettleMs: 700,", "trackChangeSettleMs: 0,"],
  ["M06", "synthetic input treated as user input", "!env.isUserEvent(event)", "false"],
  ["M07", "cleanup forgets to cancel timers", '["cancel timers", () => lifetime.abort()],', '["cancel timers", () => {}],'],
  ["M08", "cleanup forgets DOM listeners", '["dom listeners", () => listeners.removeAll()],', '["dom listeners", () => {}],'],
  ["M09", "reconcile no longer re-mounts a removed pill (first mount still works)", "ensureStyle();\n      ensurePillMounted();\n      if (needsReposition) positionPill();", "ensureStyle();\n      if (needsReposition) positionPill();"],
  ["M10", "no cap on automatic probes (both layers: planProbe and the gate)", "if ((record?.autoAttempts ?? 0) < limits.maxAutoProbesPerTrack) return", "if (true) return", [["if (input.kind === \"auto\" && input.autoAttempts >= limits.maxAutoProbesPerTrack) {", "if (false) {"]]],
  ["M11", "no 5 s same-track gap", "const sameTrack = remainingWait(input.now, input.lastTrackProbeEndedAt, limits.minGapSameTrackMs);", "const sameTrack = 0;"],
  ["M12", "'token' keys no longer redacted", "/token|secret|passw|", "/secret|passw|"],
  ["M13", "panel-wide text used while polling (wrong-device hazard)", "const own = extractDepthFromText(row.textContent);", "const own = extractDepthFromText(panel.textContent);"],
  ["M14", "probe not aborted on track change", "if (probe !== null && probe.uri !== newUri) abortProbe(\"track-changed\");", ""],
  ["M15", "user taking over the panel is not recognised", "const onProbeSurface = isNodeLike(target) && (p.trigger.contains(target) || (p.panel?.contains(target) ?? false));", "const onProbeSurface = false;"],
  ["M16", "minimizing does not abort the probe", 'if (doc.hidden) abortProbe("hidden");', "if (false) abortProbe(\"hidden\");"],
  ["M17", "stale hide class never healed", "if (probe === null && doc.documentElement.classList.contains(IDS.hideClass)) {", "if (false) {"],
  ["M18", "watchdog removed", "p.watchdogTimer = timers.after(() => onWatchdog(p), limits.probeWatchdogMs);", "p.watchdogTimer = 0;"],
  ["M19", "stylesheet not re-ensured before probing", "ensureStyle(); // Spotify (or anything else) may have removed it since mount", ""],
  ["M20", "active-device check removed", "const active = row !== null && isRowMarkedActive(row);", "const active = row !== null;"],
  ["M21", "LRU never evicts", "while (this.#map.size > this.#capacity) {", "while (false) {"],
  ["M22", "global cleanup hook left behind", 'if (win.audioQualityCleanup === cleanup) Reflect.deleteProperty(win, GLOBAL_CLEANUP_KEY);', ""],
  ["M23", "probe runs even when a modal is open", "if (isModalOpen()) throw new ProbeError", "if (false) throw new ProbeError"],
  ["M24", "trigger is clicked again right after the close button (could re-open a slowly closing panel)", "control.click(); // never followed by a trigger click: that could re-open a slowly closing panel", "control.click();\n      p.trigger.click();"],
  // ---- targeted at the step-5 fixes ----
  ["M25", "redaction scans unbounded input with the unbounded e-mail pattern (S1)", "const clipped = value.length > REDACT_LIMITS.maxScan;", "const clipped = false;", [["/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\\.[A-Za-z]{2,24}/g,", "/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g,"]]],
  ["M26", "allow-list removed: unknown keys printed by value (S3)", "if (QUALITY_KEYS_PRINTED.has(key) && isPrintableScalar(value)) {", "if (true) {"],
  ["M27", "own __proto__ key swaps the output prototype (S2)", "Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });", "target[key] = value;"],
  ["M28", "no <html class> watcher during a probe (S4)", "        watchHideClass(p);\n        installGuards(p);", "        installGuards(p);"],
  ["M29", "poll no longer re-asserts the hide class (S4)", "if (!doc.documentElement.classList.contains(IDS.hideClass)) applyHide(); // backs up watchHideClass()", ""],
  ["M30", "panel visibility not re-verified on each poll (S4)", "if (!verifyHidden(p, panel)) return;", ""],
  ["M31", "typing guard removed (S5)", 'if (input.typing === true) return { ok: false, reason: "user-typing", retryAfterMs: limits.typingRetryMs };', ""],
  ["M32", "focus is not restored after a probe (S5)", "if (options.leavePanel !== true) restoreFocus(p);", ""],
  ["M33", "visibility:hidden missing from the hide rule (S5)", "visibility: hidden !important;\\n  ", ""],
  ["M34", "heartbeat keeps working while the window is hidden (P2)", "if (doc.hidden) return; // nothing is visible; visibilitychange refreshes on restore", ""],
  ["M35", "logger no longer says it is suppressing (T5)", "seen + 1 === 3 ?", "false ?"],
  ["M36", "isPanelHidden always answers yes", 'return computed.opacity === "0" || computed.visibility === "hidden" || computed.display === "none";', "return true;"],
  ["M37", "track id logged in full (S6)", "return `${match[1]}:...${match[2].slice(-4)}`;", "return uri;"],
  ["M38", "timeout no longer undoes our own click (T7)", "undoPendingOpen(p); // the trigger may say something opened that our selectors cannot see", ""],
];

function run(dir) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "test/**/*.test.js"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
  const out = `${result.stdout}\n${result.stderr}`;
  const fail = Number((/ℹ fail (\d+)/.exec(out) || [0, "-1"])[1]);
  const pass = Number((/ℹ pass (\d+)/.exec(out) || [0, "0"])[1]);
  const failing = [...out.matchAll(/^\s+✖ (.+?) \(/gm)].map((m) => m[1]);
  return { fail, pass, failing, crashed: fail < 0 };
}

function prepare(mutatedSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-mut-"));
  fs.writeFileSync(path.join(dir, "audio-quality.js"), mutatedSource);
  fs.cpSync(path.join(root, "test"), path.join(dir, "test"), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

// Optional filters: `node tools/mutation-check.js M25 M26` runs only those; `--no-baseline` skips the clean run.
const only = process.argv.slice(2).filter((arg) => /^M\d+$/.test(arg));
const selected = only.length > 0 ? mutations.filter(([id]) => only.includes(id)) : mutations;
if (!process.argv.includes("--no-baseline")) {
  const baseline = run(prepare(source));
  console.log(`baseline: ${baseline.pass} pass / ${baseline.fail} fail`);
  if (baseline.fail !== 0) process.exit(2);
}

let survivors = 0;
for (const [id, description, from, to, extra = []] of selected) {
  let mutated = source;
  const edits = [[from, to], ...extra];
  let applicable = true;
  for (const [a, b] of edits) {
    if (mutated.split(a).length !== 2) { applicable = false; console.log(`${id} SKIPPED (pattern not found exactly once): ${a.slice(0, 60)}`); break; }
    mutated = mutated.replace(a, () => b);
  }
  if (!applicable) { survivors++; continue; }
  const dir = prepare(mutated);
  const outcome = run(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const killed = outcome.fail > 0 || outcome.crashed;
  if (!killed) survivors++;
  console.log(`${id} ${killed ? "killed  " : "SURVIVED"} (${outcome.fail} failing)  ${description}${killed && outcome.failing[0] ? `  <- ${outcome.failing[0]}` : ""}`);
}
console.log(`\n${selected.length - survivors}/${selected.length} mutations killed, ${survivors} survived`);
process.exit(survivors === 0 ? 0 : 1);
