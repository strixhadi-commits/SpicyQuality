"use strict";

// Rarely-hit branches and defensive paths: each test forces a specific failure and checks the extension
// degrades safely (no throw, state restored, other work continues).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const lib = require("../audio-quality.js");
const { createWorld, track, QUALITY, STYLE_ID } = require("./helpers/world");

/** Creates a fake Spotify page and starts the extension in it (shared setup for the cases below). */
function bootWorld(config = {}, worldOptions = {}) {
  const world = createWorld(worldOptions);
  world.boot(config);
  return world;
}

const A = track(1);
const B = track(2);
const clicks = (world) => world.eventsOf("trigger-click");

function fragment(html) {
  const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window;
  return document.body.firstElementChild;
}

describe("device-row helpers", () => {
  it("isRowMarkedActive: own attribute, descendant attribute, active text, and negatives", () => {
    assert.equal(lib.isRowMarkedActive(fragment('<li aria-current="true">This computer</li>')), true);
    assert.equal(lib.isRowMarkedActive(fragment('<li aria-selected="true">x</li>')), true);
    assert.equal(lib.isRowMarkedActive(fragment('<li data-active="true">x</li>')), true);
    assert.equal(lib.isRowMarkedActive(fragment('<li><div><span aria-current="page">This computer</span></div></li>')), true);
    assert.equal(lib.isRowMarkedActive(fragment("<li>Listening on This computer</li>")), true);
    assert.equal(lib.isRowMarkedActive(fragment("<li>Current device</li>")), true);
    assert.equal(lib.isRowMarkedActive(fragment('<li aria-current="false">This computer</li>')), false);
    assert.equal(lib.isRowMarkedActive(fragment("<li><span>This computer</span></li>")), false);
  });

  it("findThisComputerRow picks the innermost matching row and tolerates glued text", () => {
    const panel = fragment('<div><ul><li id="outer"><div><li id="inner">This computerLossless 24-bit</li></div>Other</li></ul><button>x</button></div>');
    assert.equal(lib.findThisComputerRow(panel).id, "inner");
    assert.equal(lib.findThisComputerRow(fragment("<div><li>Phone</li></div>")), null);
  });
});

describe("probe timer re-validates the world when it fires", () => {
  it("re-arms instead of probing if the window became hidden after the timer was armed", () => {
    const world = bootWorld();
    world.advance(300);
    world.setHidden(true);
    world.advance(30_000);
    assert.equal(clicks(world).length, 0, "armed timer fired while hidden and must not probe");
    world.setHidden(false);
    world.advance(3_000);
    assert.equal(world.pillText(), "Lossless 24-bit");
  });

  it("drops the armed probe if the track silently became lossy before it fired", () => {
    const world = bootWorld();
    world.advance(300);
    world.setTrack(A, QUALITY.high);
    world.advance(30_000);
    assert.equal(clicks(world).length, 0);
    assert.equal(world.pillText(), "High (~160 kbps)");
  });

  it("drops the armed probe if the track silently changed before it fired, and probes the new one", () => {
    const world = bootWorld();
    world.advance(300);
    world.setTrack(B, QUALITY.lossless16, 16);
    world.advance(10_000);
    assert.equal(world.pillText(), "Lossless 16-bit");
    assert.equal(clicks(world).length, 1);
  });
});

describe("reading-phase edge cases", () => {
  it("a panel that vanishes while being read ends the probe cleanly", () => {
    const world = createWorld({ panel: { depthTextDelayMs: 1_000 } });
    const ext = world.boot();
    world.advance(820);
    world.panelEl().remove();
    world.advance(300);
    assert.equal(ext.peekRecord(A).lastResult, "panel-vanished");
    assert.equal(world.hideActive(), false);
    assert.equal(ext.getState().probeRunning, false);
  });

  it("a row whose own text shows two different depths is reported as ambiguous", () => {
    const world = createWorld({ panel: { devices: [{ name: "This computer", active: true, staticQuality: "Lossless 16-bit then Lossless 24-bit" }] } });
    const ext = world.boot();
    world.advance(3_000);
    assert.equal(ext.peekRecord(A).lastResult, "ambiguous-depth");
    assert.equal(ext.peekRecord(A).depth, null);
  });

  it("an active-marker that only appears on a child element is honoured", () => {
    const world = createWorld({ panel: { activeMarker: "none", devices: [{ name: "This computer", active: false, showsCurrentQuality: true }] } });
    const ext = world.boot();
    world.advance(820);
    world.panelEl().querySelector("li").insertAdjacentHTML("afterbegin", '<i aria-current="true"></i>');
    world.advance(2_000);
    assert.equal(ext.peekRecord(A).depth, 24);
  });
});

describe("synchronous close fallbacks", () => {
  it("cleanup mid-probe on a panel with no close control re-clicks the trigger to close it", () => {
    const world = createWorld({ panel: { closeButton: false } });
    const ext = world.boot();
    world.advance(820);
    assert.notEqual(world.panelEl(), null);
    ext.cleanup();
    assert.equal(world.panelEl(), null);
    assert.equal(clicks(world).length, 2);
    assert.equal(world.hideActive(), false);
  });
});

describe("defensive error paths", () => {
  it("a stylesheet whose rules cannot be inspected disables the probe instead of throwing", () => {
    const world = bootWorld();
    const ext = world.ext;
    Object.defineProperty(world.doc.getElementById(STYLE_ID), "sheet", { value: { get cssRules() { throw new Error("SecurityError"); } } });
    world.advance(10_000);
    assert.match(String(ext.getState().probeDisabledReason), /hide rule not active/);
    assert.equal(clicks(world).length, 0);
    assert.ok(world.warns.length >= 1);
  });

  it("the click report survives selector lookups that throw", () => {
    const world = bootWorld({ probeEnabled: false });
    world.queryHook = () => { throw new Error("qsa exploded"); };
    world.pill().click();
    world.queryHook = null;
    assert.equal(world.logs.length, 1);
    assert.ok(JSON.stringify(world.logs[0]).includes("qsa exploded"));
  });

  it("an exception inside a timer callback is logged and later timers still run", () => {
    const world = createWorld();
    world.setTrack(A, QUALITY.high);
    world.boot({ probeEnabled: false });
    const pill = world.pill();
    const original = pill.setAttribute.bind(pill);
    pill.setAttribute = () => { throw new Error("render exploded"); };
    world.setTrack(A, QUALITY.low);
    world.dispatchPlayer("songchange");
    assert.doesNotThrow(() => world.advance(200));
    assert.ok(world.warns.some((w) => String(w[0]).includes("timer callback failed")));
    pill.setAttribute = original;
    world.setTrack(A, QUALITY.veryHigh);
    world.dispatchPlayer("songchange");
    world.advance(200);
    assert.equal(world.pillText(), "Very High (~320 kbps)");
  });

  it("a console that throws cannot break the extension", () => {
    const world = createWorld();
    world.console.warn = () => { throw new Error("console broken"); };
    world.failures.playerData = true;
    assert.doesNotThrow(() => world.boot());
    assert.doesNotThrow(() => world.advance(10_000));
    assert.equal(world.pills(), 1);
  });

  it("a cleanup step that throws is logged and the remaining steps still run", () => {
    const world = bootWorld();
    const ext = world.ext;
    world.pill().remove = () => { throw new Error("remove exploded"); };
    assert.doesNotThrow(() => ext.cleanup());
    assert.equal(world.window.audioQualityCleanup, undefined, "later steps must still run");
    assert.equal(ext.getState().cacheSize, 0);
    assert.equal(world.clock.pending(), 0);
    assert.ok(world.warns.some((w) => String(w[0]).includes("cleanup step")));
  });

  it("a listener whose removal throws is reported without blocking the rest of cleanup", () => {
    const world = bootWorld();
    const ext = world.ext;
    world.doc.removeEventListener = () => { throw new Error("removeEventListener exploded"); };
    assert.doesNotThrow(() => ext.cleanup());
    assert.equal(world.pills(), 0);
    assert.ok(world.warns.some((w) => String(w[0]).includes("removeEventListener failed")));
  });
});
