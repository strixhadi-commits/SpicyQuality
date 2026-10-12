"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createWorld, track, QUALITY, STYLE_ID, HIDE_CLASS, assertNoPlaybackSideEffects, assertPanelNeverVisible } = require("./helpers/world");

const A = track(1);
const B = track(2);

function setup({ panel, config, quality = QUALITY.lossless24, depth = 24, ready } = {}) {
  const world = createWorld({ panel, ready });
  world.setTrack(A, quality, depth);
  const ext = world.boot(config);
  return { world, ext };
}
const clicks = (world) => world.eventsOf("trigger-click");
const extensionClicks = (world) => clicks(world).filter((event) => !event.trusted);

function assertRestored(world, ext) {
  assert.equal(world.hideActive(), false, "the hide class must be gone");
  assert.equal(ext.getState().probeRunning, false, "no probe may be left running");
  assert.equal(world.panelEl(), null, "the device panel must be closed");
  assert.equal(world.trigger.getAttribute("aria-expanded"), "false");
}

describe("probe: happy path", () => {
  it("reads 24-bit without the panel ever being visible, then restores everything", () => {
    const { world, ext } = setup();
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.equal(world.eventsOf("panel-insert").length, 1);
    assertPanelNeverVisible(world, assert);
    for (const event of [...clicks(world), ...world.eventsOf("close-click"), ...world.eventsOf("panel-remove")]) {
      assert.equal(event.hide, true, `${event.type} at t=${event.t} happened without the hide class`);
    }
    assert.equal(clicks(world).length, 1, "exactly one trigger click");
    assert.ok(clicks(world)[0].t >= 700, "never within 700 ms of the track change");
    assert.equal(clicks(world)[0].trusted, false);
    assert.equal(world.hideAdds, 1);
    assertRestored(world, ext);
    assertNoPlaybackSideEffects(world, assert);
    const record = ext.peekRecord(A);
    assert.deepEqual([record.depth, record.autoAttempts, record.lastResult], [24, 1, "depth"]);
  });

  it("reads 16-bit", () => {
    const { world } = setup({ quality: QUALITY.lossless16, depth: 16 });
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 16-bit");
  });

  it("shows (checking...) from load until the depth is known", () => {
    const { world } = setup();
    world.advance(100);
    assert.equal(world.pillText(), "Lossless (checking...)");
    world.advance(500); // t=600: still inside the 700 ms settle window
    assert.equal(world.pillText(), "Lossless (checking...)");
    world.advance(250); // t=850: the probe is running (the depth is read at the t=900 poll)
    assert.equal(world.pillText(), "Lossless (checking...)");
    world.advance(600);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("tolerates a depth text that renders late but inside the 2 s window", () => {
    const { world } = setup({ panel: { depthTextDelayMs: 1_500 } });
    world.advance(4_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("gives up cleanly, showing plain Lossless, when the depth text never arrives in time", () => {
    const { world, ext } = setup({ panel: { depthTextDelayMs: 2_500 } });
    world.advance(4_000);
    assert.equal(world.pillText(), "Lossless");
    assert.equal(ext.peekRecord(A).lastResult, "depth-timeout");
    assert.equal(ext.peekRecord(A).depth, null);
    assertRestored(world, ext);
  });

  it("accepts a slow panel (1.2 s)", () => {
    const { world } = setup({ panel: { renderDelayMs: 1_200 } });
    world.advance(4_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assertPanelNeverVisible(world, assert);
  });

  it("on a panel slower than 1.5 s, undoes its own click so the panel never opens", () => {
    const { world, ext } = setup({ panel: { renderDelayMs: 1_600 } });
    world.advance(4_000);
    assert.equal(world.eventsOf("panel-insert").length, 0, "the pending open must have been cancelled");
    assert.equal(clicks(world).length, 2, "one click to open, one to undo");
    assert.equal(ext.peekRecord(A).lastResult, "panel-timeout");
    assert.equal(world.pillText(), "Lossless");
    assertRestored(world, ext);
    assert.equal(ext.getState().probeDisabledReason, null, "a single miss must not disable the probe");
  });
});

describe("probe: slow close", () => {
  it("never touches the trigger again while a slowly closing panel finishes closing (a second click could re-open it)", () => {
    const { world, ext } = setup({ panel: { closeDelayMs: 700 } });
    world.advance(4_000);
    assert.equal(clicks(world).length, 1, "only the opening click");
    assert.equal(world.eventsOf("close-click").length, 1);
    assert.equal(world.eventsOf("panel-insert").length, 1);
    assert.equal(ext.peekRecord(A).depth, 24);
    assertRestored(world, ext);
    assertPanelNeverVisible(world, assert);
  });
});

describe("probe: device and text checks", () => {
  const phone = { name: "Phone", active: true, staticQuality: "Lossless 16-bit/44.1 kHz" };

  it("never reads depth when 'This computer' is not the active device, even if another device shows one", () => {
    const { world, ext } = setup({ panel: { devices: [{ name: "This computer", active: false, showsCurrentQuality: true }, phone] } });
    world.advance(5_000);
    assert.equal(ext.peekRecord(A).depth, null);
    assert.equal(ext.peekRecord(A).lastResult, "device-not-active");
    assert.equal(world.pillText(), "Lossless");
    assertRestored(world, ext);
    assertNoPlaybackSideEffects(world, assert);
  });

  it("skips when there is no 'This computer' row", () => {
    const { world, ext } = setup({ panel: { devices: [phone] } });
    world.advance(5_000);
    assert.equal(ext.peekRecord(A).lastResult, "no-device-row");
    assertRestored(world, ext);
  });

  it("skips when no row carries an active marker", () => {
    const { world, ext } = setup({ panel: { activeMarker: "none" } });
    world.advance(5_000);
    assert.equal(ext.peekRecord(A).lastResult, "device-not-active");
    assert.equal(ext.peekRecord(A).depth, null);
  });

  it("prefers the active row's own text over another device's", () => {
    const { world } = setup({
      panel: { devices: [{ name: "This computer", active: true, showsCurrentQuality: true }, { name: "Kitchen speaker", active: false, staticQuality: "Lossless 16-bit/44.1 kHz" }] },
    });
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("refuses to guess when the panel shows conflicting depths and the active row shows none", () => {
    const { world, ext } = setup({
      depth: undefined,
      panel: { devices: [
        { name: "This computer", active: true, staticQuality: "" },
        { name: "Kitchen", active: false, staticQuality: "Lossless 16-bit/44.1 kHz" },
        { name: "Bedroom", active: false, staticQuality: "Lossless 24-bit/48 kHz" },
      ] },
    });
    world.depthByUri.delete(A);
    world.advance(3_000);
    assert.equal(ext.peekRecord(A).lastResult, "ambiguous-depth");
    assert.equal(ext.peekRecord(A).depth, null);
  });

  it("falls back to an unambiguous panel-wide match (documented limitation: could be another device)", () => {
    const { world } = setup({
      panel: { devices: [{ name: "This computer", active: true, staticQuality: "" }, { name: "Kitchen", active: false, staticQuality: "Lossless 16-bit/44.1 kHz" }] },
    });
    world.depthByUri.delete(A);
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 16-bit");
  });

  it("never clicks any device row by default", () => {
    const { world } = setup();
    world.advance(3_000);
    assert.deepEqual(world.eventsOf("row-click"), []);
  });

  it("with clickActiveDeviceRow on, clicks only a row already marked active, exactly once, and never transfers playback", () => {
    const { world } = setup({ config: { clickActiveDeviceRow: true } });
    world.advance(3_000);
    const rowClicks = world.eventsOf("row-click");
    assert.equal(rowClicks.length, 1);
    assert.deepEqual([rowClicks[0].device, rowClicks[0].active], ["This computer", true]);
    assert.deepEqual(world.playbackCalls, []);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("with clickActiveDeviceRow on, still never clicks an inactive row", () => {
    const { world } = setup({ config: { clickActiveDeviceRow: true }, panel: { devices: [{ name: "This computer", active: false, showsCurrentQuality: true }, phone] } });
    world.advance(12_000);
    assert.deepEqual(world.eventsOf("row-click"), []);
    assert.deepEqual(world.playbackCalls, []);
  });
});

describe("probe: selector failure fails safe", () => {
  function settle(world) {
    world.advance(60_000);
  }

  it("missing trigger: shows Lossless, performs no action at all, stops after 3 attempts", () => {
    const { world, ext } = setup();
    world.trigger.remove();
    settle(world);
    assert.equal(world.pillText(), "Lossless");
    assert.equal(world.hideAdds, 0, "the hide class must never even be added");
    assert.equal(clicks(world).length, 0);
    assert.equal(ext.peekRecord(A).lastResult, "no-trigger");
    assert.equal(ext.peekRecord(A).autoAttempts, 3);
  });

  it("ambiguous trigger (two matching buttons): no action", () => {
    const { world, ext } = setup();
    world.trigger.after(world.trigger.cloneNode(true));
    settle(world);
    assert.equal(world.hideAdds, 0);
    assert.equal(clicks(world).length, 0);
    assert.equal(ext.peekRecord(A).lastResult, "no-trigger");
  });

  it("a trigger that only exists inside a modal dialog (e.g. Settings) is ignored", () => {
    const { world, ext } = setup();
    const modal = world.doc.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    world.doc.body.appendChild(modal);
    modal.appendChild(world.trigger);
    settle(world);
    assert.equal(world.hideAdds, 0);
    assert.equal(clicks(world).length, 0);
    assert.equal(ext.peekRecord(A).lastResult, "no-trigger");
  });

  it("an open modal dialog suppresses the probe", () => {
    const { world, ext } = setup();
    const modal = world.doc.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    world.doc.body.appendChild(modal);
    settle(world);
    assert.equal(world.hideAdds, 0);
    assert.equal(clicks(world).length, 0);
    assert.equal(ext.peekRecord(A).lastResult, "modal-open");
  });

  it("panel selector mismatch: recovers, undoes its click, and disables the probe after two misses", () => {
    const { world, ext } = setup({ panel: { markup: "unknown" } });
    settle(world);
    assert.equal(world.pillText(), "Lossless");
    assert.match(String(ext.getState().probeDisabledReason), /never appeared/);
    assert.equal(clicks(world).length, 4, "two probes, each: one click to open and one to undo");
    assert.ok(world.eventsOf("panel-insert").length <= 2, "at most two visible flashes before the probe disables itself");
    assertRestored(world, ext);
    // Honest limitation: with a wrong selector the real panel IS visible until the probe notices.
    assert.ok(world.eventsOf("panel-insert").every((event) => event.opacity === "1"));
  });

  it("blocked stylesheet: never clicks, because it cannot guarantee the panel stays hidden", () => {
    const { world, ext } = setup();
    Object.defineProperty(world.doc.getElementById(STYLE_ID), "sheet", { value: null });
    settle(world);
    assert.equal(world.hideAdds, 0);
    assert.equal(clicks(world).length, 0);
    assert.match(String(ext.getState().probeDisabledReason), /hide rule not active/);
    assert.equal(world.pillText(), "Lossless");
  });

  it("a stylesheet that was removed is re-created before the probe, which then proceeds", () => {
    const { world } = setup();
    world.doc.getElementById(STYLE_ID).remove();
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assertPanelNeverVisible(world, assert);
  });

  it("overriding only the opacity does not expose the panel: visibility: hidden still hides it", () => {
    const { world, ext } = setup({ panel: { inlineStyle: "opacity: 1 !important" } });
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.equal(ext.getState().probeDisabledReason, null);
    assert.ok(world.eventsOf("panel-insert").every((e) => e.visibility === "hidden"));
  });

  it("hide rule that is fully overridden (inline !important wins): closes the panel at once and disables the probe", () => {
    const { world, ext } = setup({ panel: { inlineStyle: "opacity: 1 !important; visibility: visible !important" } });
    settle(world);
    assert.equal(ext.peekRecord(A).lastResult, "hide-ineffective");
    assert.match(String(ext.getState().probeDisabledReason), /did not apply/);
    assert.equal(clicks(world).length, 1, "no second attempt once the probe is disabled");
    assert.equal(world.eventsOf("panel-insert").length, 1);
    assertRestored(world, ext);
  });

  it("a panel with no close control is closed by re-clicking the trigger", () => {
    const { world, ext } = setup({ panel: { closeButton: false } });
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.equal(clicks(world).length, 2, "open + one re-click to close");
    assertRestored(world, ext);
  });

  it("with no close control and re-click disabled, leaves the panel for the user but makes it visible again", () => {
    const { world, ext } = setup({ panel: { closeButton: false }, config: { reclickTriggerToClose: false } });
    world.advance(3_000);
    assert.equal(world.hideActive(), false, "a panel must never be left invisible");
    assert.notEqual(world.panelEl(), null);
    assert.equal(ext.getState().probeRunning, false);
    assert.ok(world.warns.length >= 1);
  });
});

describe("probe: exceptions cannot strand the UI", () => {
  it("a throwing trigger.click() restores the page", () => {
    const { world, ext } = setup();
    world.trigger.click = () => { throw new Error("click exploded"); };
    world.advance(3_000);
    assertRestored(world, ext);
    assert.ok(world.warns.length >= 1);
    assert.equal(world.eventsOf("panel-insert").length, 0);
  });

  it("a throwing document query while waiting for the panel restores the hide class and clears the probe", () => {
    const { world, ext } = setup();
    world.advance(720); // clicked, panel not rendered yet
    assert.equal(world.hideActive(), true);
    world.queryHook = () => { throw new Error("querySelectorAll exploded"); };
    world.advance(300);
    world.queryHook = null;
    assert.equal(world.hideActive(), false);
    assert.equal(ext.getState().probeRunning, false);
    assert.ok(world.warns.length >= 1);
  });

  it("a throwing panel query while reading restores the hide class and clears the probe", () => {
    const { world, ext } = setup({ panel: { depthTextDelayMs: 1_000 } });
    world.advance(820); // panel found, reading
    assert.equal(ext.getState().probePhase, "reading");
    world.panelEl().querySelectorAll = () => { throw new Error("panel query exploded"); };
    world.advance(300);
    assert.equal(world.hideActive(), false);
    assert.equal(ext.getState().probeRunning, false);
    assert.ok(world.warns.length >= 1);
    assert.equal(world.pills(), 1, "the pill itself must survive");
  });

  it("the watchdog force-restores a probe whose polling has wedged", () => {
    const { world, ext } = setup({ config: { limits: { pollIntervalMs: 1_000_000 } } });
    world.advance(7_000);
    assert.equal(world.hideActive(), true, "still probing before the watchdog fires");
    world.advance(800);
    assertRestored(world, ext);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:watchdog");
  });
});

describe("probe: races", () => {
  it("never stores a depth under another track's URI when the state moved before the songchange event arrived", () => {
    const { world, ext } = setup();
    world.advance(820); // probing A
    world.setTrack(B, QUALITY.lossless16, 16); // panel text now describes B; no songchange yet
    world.advance(150);
    assert.equal(ext.peekRecord(A).depth, null, "A must not receive B's depth");
    assert.equal(ext.peekRecord(A).lastResult, "discarded-stale");
    world.dispatchPlayer("songchange");
    world.advance(30_000);
    assert.equal(ext.peekRecord(A).depth, null);
    assert.equal(ext.peekRecord(B).depth, 16, "B earns its own depth from its own probe");
    assert.equal(world.pillText(), "Lossless 16-bit");
  });

  it("keeps one track's cached depth away from another and serves it again without re-probing", () => {
    const { world, ext } = setup();
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    world.skipTo(B, QUALITY.lossless16, 16);
    world.advance(100);
    assert.equal(world.pillText(), "Lossless (checking...)", "A's 24-bit must not be shown for B");
    world.advance(10_000);
    assert.equal(world.pillText(), "Lossless 16-bit");
    const probesSoFar = clicks(world).length;
    world.skipTo(A, QUALITY.lossless24, 24);
    world.advance(200);
    assert.equal(world.pillText(), "Lossless 24-bit");
    world.advance(20_000);
    assert.equal(clicks(world).length, probesSoFar, "returning to A must not trigger another probe");
    assert.equal(ext.peekRecord(A).depth, 24);
    assert.equal(ext.peekRecord(B).depth, 16);
  });

  it("rapid skipping starts no probe until things settle, then probes only the last track", () => {
    const { world, ext } = setup();
    for (let i = 2; i <= 30; i++) {
      world.skipTo(track(i), QUALITY.lossless24, 24);
      world.advance(100);
      assert.ok(ext.getState().pendingTimers <= 6, `${ext.getState().pendingTimers} pending timers while skipping`);
    }
    assert.equal(clicks(world).length, 0, "no probe may start while the user is skipping");
    world.advance(5_000);
    assert.equal(clicks(world).length, 1);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.equal(ext.peekRecord(track(30)).depth, 24);
    assert.equal(ext.peekRecord(track(29)), undefined, "skipped tracks are never probed");
    assertPanelNeverVisible(world, assert);
  });

  it("notices a track change from the player state alone (no songchange event) and aborts the probe", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.setTrack(B, QUALITY.lossless16, 16); // silent change
    world.dispatchPlayer("onplaypause"); // any event that makes update() re-read the state
    world.advance(150);
    assertRestored(world, ext);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:track-changed");
  });

  it("a skip during the probe aborts it, closes the panel immediately and stores nothing", () => {
    const { world, ext } = setup();
    world.advance(820);
    assert.equal(world.panelEl() !== null, true);
    world.skipTo(B, QUALITY.lossless16, 16);
    assertRestored(world, ext); // synchronous: no waiting
    assert.equal(ext.peekRecord(A).depth, null);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:track-changed");
    const lastEnd = world.clock.now();
    world.advance(10_000);
    const next = extensionClicks(world).at(-1);
    assert.ok(next.t - lastEnd >= 1_500, "global 1.5 s gap");
    assert.equal(world.pillText(), "Lossless 16-bit");
    assertPanelNeverVisible(world, assert);
  });

  it("play/pause during the probe does not disturb it and never starts a second one", () => {
    const { world, ext } = setup();
    world.advance(820);
    for (let i = 0; i < 20; i++) world.dispatchPlayer("onplaypause");
    world.advance(2_000);
    assert.equal(clicks(world).length, 1);
    assert.equal(world.hideAdds, 1);
    assert.equal(ext.peekRecord(A).depth, 24);
    assertRestored(world, ext);
  });

  it("minimizing mid-probe aborts and restores; nothing probes while hidden; restoring resumes", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.setHidden(true);
    assertRestored(world, ext);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:hidden");
    const clicksWhileHidden = clicks(world).length;
    world.advance(30_000);
    assert.equal(clicks(world).length, clicksWhileHidden, "no probe while the window is hidden");
    world.setHidden(false);
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assertPanelNeverVisible(world, assert);
  });

  it("does not start probing while the window is hidden at load, and starts once it is shown", () => {
    const world = createWorld();
    world.hidden = true;
    world.boot();
    world.advance(20_000);
    assert.equal(clicks(world).length, 0);
    world.setHidden(false);
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("a fullscreen change mid-probe aborts and restores", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.setFullscreen(world.doc.body.appendChild(world.doc.createElement("div")));
    assertRestored(world, ext);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:fullscreen-change");
    assert.equal(world.pills(), 1);
  });

  it("a resize mid-probe re-positions the pill and does not disturb the probe", () => {
    const { world, ext } = setup();
    world.barHeight = 88;
    world.advance(820);
    world.resize();
    world.advance(2_000);
    assert.equal(world.styleValue(world.pill(), "bottom"), "100px");
    assert.equal(ext.peekRecord(A).depth, 24);
    assert.equal(clicks(world).length, 1);
  });

  for (const [label, when, closeDelayMs] of [["before the panel renders", 720, 0], ["while reading", 820, 0], ["while the panel is closing", 1_000, 500]]) {
    it(`cleanup ${label} leaves nothing behind`, () => {
      const { world, ext } = setup({ panel: { closeDelayMs } });
      world.advance(when);
      assert.equal(world.hideActive(), true, "precondition: a probe is in flight");
      ext.cleanup();
      assert.equal(world.hideActive(), false);
      assert.equal(world.clock.pending() <= 1, true, "only the fake panel's own timers may remain");
      assert.equal(world.listenerCount(), 0);
      assert.equal(world.pills(), 0);
      assert.equal(world.styles(), 0);
      const extensionOpened = extensionClicks(world).length;
      world.advance(20_000);
      assert.equal(world.panelEl(), null, "the panel must not be left open");
      assert.equal(world.hideActive(), false);
      assert.equal(extensionClicks(world).length, extensionOpened, "no activity after cleanup");
      assert.equal(world.trigger.getAttribute("aria-expanded"), "false");
    });
  }

  it("a user who opens the device panel before the probe is left alone entirely", () => {
    const world = createWorld();
    world.boot();
    world.userOpensPanel();
    world.advance(20_000);
    assert.equal(world.hideAdds, 0);
    assert.equal(extensionClicks(world).length, 0);
    assert.notEqual(world.panelEl(), null, "the user's panel stays open");
    assert.equal(world.eventsOf("close-click").length, 0);
  });

  it("a user who takes over the panel during the probe is never fought: no close, panel un-hidden at once", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.userEvent(world.trigger, "pointerdown");
    assert.equal(world.hideActive(), false, "the user must see their panel immediately");
    assert.notEqual(world.panelEl(), null);
    assert.equal(world.eventsOf("close-click").length, 0, "the extension must not close the user's panel");
    assert.equal(ext.getState().probeRunning, false);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:user-input");
    assert.equal(world.listenerCount(), 3, "probe listeners removed");
  });

  it("an outside click during the probe aborts it and the page ends up clean", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.userEvent(world.doc.body, "pointerdown");
    assertRestored(world, ext);
  });

  it("typing during the probe aborts it and closes the panel the extension opened", () => {
    const { world, ext } = setup();
    world.advance(820);
    world.userEvent(world.doc.body, "keydown");
    assertRestored(world, ext);
    assert.equal(ext.peekRecord(A).lastResult, "aborted:user-input");
  });

  it("synthetic (untrusted) input does not abort the probe", () => {
    const { world } = setup();
    world.advance(820);
    world.doc.body.dispatchEvent(new world.window.Event("keydown", { bubbles: true }));
    world.doc.body.dispatchEvent(new world.window.Event("pointerdown", { bubbles: true }));
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });
});

describe("probe: limits", () => {
  it("makes at most 3 automatic probes per track, 5 s apart, then only probes on a pill click", () => {
    const { world, ext } = setup({ depth: undefined });
    world.depthByUri.delete(A);
    world.advance(120_000);
    const probes = clicks(world);
    assert.equal(probes.length, 3);
    for (let i = 1; i < probes.length; i++) assert.ok(probes[i].t - probes[i - 1].t >= 5_000, `probes ${i - 1}->${i} only ${probes[i].t - probes[i - 1].t} ms apart`);
    assert.equal(ext.peekRecord(A).autoAttempts, 3);
    assert.equal(world.pillText(), "Lossless");

    world.pill().click();
    world.advance(30_000);
    assert.equal(clicks(world).length, 4, "the click allows exactly one more probe");
    assert.equal(ext.peekRecord(A).autoAttempts, 3, "a manual probe does not reset the automatic budget");
    world.advance(120_000);
    assert.equal(clicks(world).length, 4, "and no automatic probes resume afterwards");
  });

  it("keeps 1.5 s between probes of different tracks and 700 ms after a track change", () => {
    const { world, ext } = setup();
    world.advance(2_000);
    const firstEnd = ext.peekRecord(A).lastProbeEndedAt;
    world.skipTo(B, QUALITY.lossless16, 16);
    const skipAt = world.clock.now();
    world.advance(10_000);
    const second = extensionClicks(world)[1];
    assert.ok(second.t - firstEnd >= 1_500, `gap after previous probe: ${second.t - firstEnd}`);
    assert.ok(second.t - skipAt >= 700, `gap after track change: ${second.t - skipAt}`);
  });

  it("runs one probe at a time however many events arrive", () => {
    const { world, ext } = setup();
    world.advance(820);
    for (let i = 0; i < 50; i++) {
      world.dispatchPlayer("onplaypause");
      world.pill().click();
      world.advance(5);
    }
    assert.equal(world.hideAdds <= 2, true);
    world.advance(30_000);
    assert.equal(ext.getState().probeRunning, false);
    for (let i = 1; i < world.eventsOf("trigger-click").length; i++) {
      assert.ok(world.eventsOf("trigger-click")[i].t - world.eventsOf("trigger-click")[i - 1].t >= 1_500);
    }
  });

  it("does not render from inside the probe: the pill updates on a later timer tick", () => {
    const { world, ext } = setup();
    let guard = 0;
    while (ext.peekRecord(A)?.lastResult !== "depth" && guard++ < 5_000) world.clock.step(Infinity);
    assert.equal(ext.getState().probeRunning, false);
    assert.equal(world.pillText(), "Lossless (checking...)", "update() must not run synchronously from the probe");
    let ticks = 0;
    while (world.pillText() !== "Lossless 24-bit" && ticks++ < 10) world.clock.step(Infinity);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.ok(ticks >= 1 && ticks <= 3, `took ${ticks} timer ticks`);
  });

  it("skips probing entirely when disabled by configuration", () => {
    const { world } = setup({ config: { probeEnabled: false } });
    world.advance(60_000);
    assert.equal(clicks(world).length, 0);
    assert.equal(world.hideAdds, 0);
    assert.equal(world.pillText(), "Lossless");
  });
});

describe("probe: hide class and panel visibility are re-verified while it runs (security fix S4)", () => {
  it("puts the hide class back immediately, before any timer runs, if page code drops it", async () => {
    const { world } = setup();
    world.advance(820);
    world.doc.documentElement.classList.remove(HIDE_CLASS); // e.g. Spotify rewrites <html class>
    assert.equal(world.hideActive(), false);
    await world.flush(); // MutationObserver callbacks are microtasks: no timer has run yet
    assert.equal(world.hideActive(), true);
    world.advance(2_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assert.equal(world.hideActive(), false, "and it is removed again when the probe ends");
  });

  it("the poll re-asserts the class even where MutationObserver is unavailable", () => {
    const { world } = setup({ panel: { depthTextDelayMs: 1_000 } }); // keeps the probe running past the check
    world.advance(820);
    world.window.MutationObserver = undefined; // the probe's watcher cannot be created from now on
    world.doc.documentElement.classList.remove(HIDE_CLASS);
    world.advance(100);
    assert.equal(world.hideActive(), true);
  });

  it("the class watcher is gone after every probe, so it cannot revive the class", async () => {
    const { world } = setup();
    world.advance(2_000);
    assert.equal(world.hideActive(), false);
    assert.equal(world.observers.filter((o) => o.active).length, 1, "only the body observer remains");
    world.doc.documentElement.classList.add(HIDE_CLASS);
    await world.flush();
    world.advance(0);
    assert.equal(world.hideActive(), true, "nothing watches the class once the probe is over (the heartbeat heals it)");
    world.advance(5_500);
    assert.equal(world.hideActive(), false);
  });

  it("a panel that becomes visible mid-read is closed on the next poll and the probe is disabled", () => {
    const { world, ext } = setup({ panel: { depthTextDelayMs: 1_000 } });
    world.advance(820);
    assert.equal(ext.getState().probePhase, "reading");
    world.panelEl().setAttribute("style", "opacity: 1 !important; visibility: visible !important");
    world.advance(150);
    assert.equal(ext.peekRecord(A).lastResult, "hide-ineffective");
    assert.match(String(ext.getState().probeDisabledReason), /did not apply/);
    assertRestored(world, ext);
  });
});

describe("probe: keyboard focus (security fix S5)", () => {
  function withFocusedButton(world) {
    const button = world.doc.createElement("button");
    button.id = "play";
    world.doc.body.appendChild(button);
    button.focus();
    assert.equal(world.doc.activeElement, button);
    return button;
  }

  it("a hidden panel cannot take focus, so focus never moves", () => {
    const world = createWorld({ panel: { grabsFocus: true } });
    const button = withFocusedButton(world);
    const ext = world.boot();
    world.advance(2_000);
    assert.equal(world.eventsOf("focus-grab").length, 0);
    assert.equal(world.doc.activeElement, button);
    assert.equal(ext.peekRecord(A).depth, 24);
  });

  it("restores focus when a popover forces it into itself anyway", () => {
    const world = createWorld({ panel: { grabsFocus: "always" } });
    const button = withFocusedButton(world);
    const ext = world.boot();
    world.advance(2_000);
    assert.equal(world.eventsOf("focus-grab").length, 1);
    assert.equal(world.doc.activeElement, button, "focus is back where the user had it");
    assert.equal(ext.peekRecord(A).depth, 24);
  });

  it("never overrides a focus choice the user made while the probe ran", () => {
    const world = createWorld({ panel: { grabsFocus: "always" } });
    withFocusedButton(world);
    const other = world.doc.createElement("button");
    world.doc.body.appendChild(other);
    world.boot();
    world.advance(820);
    other.focus(); // the user moved focus on their own
    world.advance(2_000);
    assert.equal(world.doc.activeElement, other);
  });

  it("does not touch focus when the probe is skipped", () => {
    const world = createWorld({ panel: { grabsFocus: "always" } });
    const button = withFocusedButton(world);
    world.trigger.remove();
    world.boot();
    world.advance(30_000);
    assert.equal(world.doc.activeElement, button);
  });

  it("never opens the panel under a typing user, consumes no attempts, and probes once they stop", () => {
    const world = createWorld();
    const input = world.doc.createElement("input");
    input.type = "text";
    world.doc.body.appendChild(input);
    input.focus();
    const ext = world.boot();
    world.advance(30_000);
    assert.equal(clicks(world).length, 0);
    assert.equal(world.hideAdds, 0);
    assert.equal(ext.peekRecord(A)?.autoAttempts ?? 0, 0, "waiting for the user does not use up the attempt budget");
    input.blur();
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  for (const [label, make] of [
    ["textarea", (doc) => doc.createElement("textarea")],
    ["contenteditable", (doc) => { const el = doc.createElement("div"); el.setAttribute("contenteditable", "true"); el.setAttribute("tabindex", "0"); return el; }],
    ["search input", (doc) => { const el = doc.createElement("input"); el.type = "search"; return el; }],
  ]) {
    it(`treats a focused ${label} as typing`, () => {
      const world = createWorld();
      const el = make(world.doc);
      world.doc.body.appendChild(el);
      el.focus();
      world.boot();
      world.advance(10_000);
      assert.equal(clicks(world).length, 0);
    });
  }

  for (const type of ["range", "checkbox", "button"]) {
    it(`does not treat a focused ${type} control as typing`, () => {
      const world = createWorld();
      const el = world.doc.createElement("input");
      el.type = type;
      world.doc.body.appendChild(el);
      el.focus();
      world.boot();
      world.advance(3_000);
      assert.equal(world.pillText(), "Lossless 24-bit");
    });
  }
});
