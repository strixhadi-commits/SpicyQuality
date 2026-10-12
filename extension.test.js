"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../audio-quality.js");
const { createWorld, track, QUALITY, HIDE_CLASS, STYLE_ID, assertNoPlaybackSideEffects } = require("./helpers/world");

/** Creates a fake Spotify page and starts the extension in it (shared setup for the cases below). */
function bootWorld(config = {}, worldOptions = {}) {
  const world = createWorld(worldOptions);
  world.boot(config);
  return world;
}

const LOSSLESS_COLOR = "var(--spice-button, #1db954)";
const OTHER_COLOR = "var(--spice-button-disabled, #535353)";

function counts(world) {
  return {
    pills: world.pills(),
    styles: world.styles(),
    songchange: world.playerListenerCount("songchange"),
    onplaypause: world.playerListenerCount("onplaypause"),
    domListeners: world.listenerCount(),
    activeObservers: world.observers.filter((o) => o.active).length,
    pendingTimers: world.clock.pending(),
  };
}

describe("pill display rules", () => {
  const lossy = [
    ["veryHigh", "Very High (~320 kbps)"],
    ["high", "High (~160 kbps)"],
    ["normal", "Normal (~96 kbps)"],
    ["low", "Low (~24 kbps)"],
  ];
  for (const [key, text] of lossy) {
    it(`shows "${text}" in the non-lossless colour at full opacity`, () => {
      const world = createWorld();
      world.setTrack(track(1), QUALITY[key]);
      world.boot();
      const pill = world.pill();
      assert.equal(pill.textContent, text);
      assert.equal(world.styleValue(pill, "background-color"), OTHER_COLOR);
      assert.equal(world.styleValue(pill, "opacity"), "1");
    });
  }

  it("lossless with the probe disabled shows plain Lossless in the accent colour", () => {
    const world = bootWorld({ probeEnabled: false });
    assert.equal(world.pillText(), "Lossless");
    assert.equal(world.styleValue(world.pill(), "background-color"), LOSSLESS_COLOR);
    assert.equal(world.styleValue(world.pill(), "opacity"), "1");
    assert.equal(world.eventsOf("trigger-click").length, 0);
  });

  it("treats hifiStatus ON with no level as lossless", () => {
    const world = createWorld();
    world.playerDataOverride = { item: { uri: track(1) }, playbackQuality: { hifiStatus: 2 } };
    world.boot({ probeEnabled: false });
    assert.equal(world.pillText(), "Lossless");
  });

  it("unknown quality shows the neutral placeholder, semi-transparent, in the neutral colour", () => {
    const world = createWorld();
    world.playerDataOverride = { item: { uri: track(1) } };
    world.platformStateOverride = { item: { uri: track(1) } };
    world.boot();
    const pill = world.pill();
    assert.equal(pill.textContent, "Quality unknown");
    assert.equal(world.styleValue(pill, "opacity"), "0.5");
    assert.equal(world.styleValue(pill, "background-color"), OTHER_COLOR);
  });

  it("reads snake_case enum strings from Player.data", () => {
    const world = createWorld();
    world.playerDataOverride = { item: { uri: track(1) }, playback_quality: { bitrate_level: "very_high", hifi_status: "off" } };
    world.boot();
    assert.equal(world.pillText(), "Very High (~320 kbps)");
  });

  it("falls back to PlayerAPI._state when Player.data has no quality", () => {
    const world = createWorld();
    world.playerDataOverride = { item: { uri: track(1) } };
    world.platformStateOverride = { item: { uri: track(1) }, playbackQuality: { bitrateLevel: 3, hifiStatus: 1 } };
    world.boot();
    assert.equal(world.pillText(), "High (~160 kbps)");
  });

  it("falls back to _state when Player.data throws, warning a bounded number of times", () => {
    const world = createWorld();
    world.failures.playerData = true;
    world.setTrack(track(1), QUALITY.normal);
    world.boot();
    assert.equal(world.pillText(), "Normal (~96 kbps)");
    world.advance(60_000);
    assert.ok(world.warns.length >= 1 && world.warns.length <= 3, `warnings: ${world.warns.length}`);
    assert.ok(String(world.warns.at(-1)[0]).includes("further identical warnings suppressed"), "the last allowed warning says it is the last");
  });

  it("does not wake up for the heartbeat while the window is hidden", () => {
    const world = bootWorld({ probeEnabled: false });
    world.hidden = true; // silent: no event, only the heartbeat could notice
    const reads = world.dataReads;
    world.advance(60_000);
    assert.equal(world.dataReads, reads);
    world.hidden = false;
    world.advance(5_100);
    assert.ok(world.dataReads > reads, "and it resumes once visible");
  });

  it("shows 'Quality unknown' when every state source throws", () => {
    const world = createWorld();
    world.failures.playerData = true;
    world.failures.platformState = true;
    world.boot();
    assert.equal(world.pillText(), "Quality unknown");
    assert.doesNotThrow(() => world.advance(10_000));
  });

  it("is centred with left: 50% and translateX(-50%), fixed to the viewport", () => {
    const world = bootWorld();
    const pill = world.pill();
    assert.equal(world.styleValue(pill, "position"), "fixed");
    assert.equal(world.styleValue(pill, "left"), "50%");
    assert.equal(world.styleValue(pill, "transform"), "translateX(-50%)");
  });

  it("is attached to <body> and builds its text with textContent (no markup)", () => {
    const world = bootWorld();
    assert.equal(world.pill().parentNode, world.doc.body);
    assert.equal(world.pill().children.length, 0);
  });
});

describe("update triggers", () => {
  it("re-renders after songchange", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.high);
    world.boot({ probeEnabled: false });
    assert.equal(world.pillText(), "High (~160 kbps)");
    world.skipTo(track(2), QUALITY.low);
    world.advance(150);
    assert.equal(world.pillText(), "Low (~24 kbps)");
  });

  it("re-renders after onplaypause", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.high);
    world.boot({ probeEnabled: false });
    world.setTrack(track(1), QUALITY.veryHigh);
    world.dispatchPlayer("onplaypause");
    world.advance(150);
    assert.equal(world.pillText(), "Very High (~320 kbps)");
  });

  it("picks up silent quality changes through the heartbeat", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.high);
    world.boot({ probeEnabled: false });
    world.setTrack(track(1), QUALITY.low);
    world.advance(5_200);
    assert.equal(world.pillText(), "Low (~24 kbps)");
  });

  it("coalesces a burst of events into one state read", () => {
    const world = bootWorld({ probeEnabled: false });
    world.advance(200);
    const before = world.dataReads;
    for (let i = 0; i < 100; i++) world.dispatchPlayer("songchange");
    world.advance(300);
    assert.ok(world.dataReads - before <= 2, `Player.data read ${world.dataReads - before} times for one burst`);
  });

  it("does not rewrite the pill when nothing changed", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.high);
    world.boot();
    const writes = world.styleCalls.length;
    world.advance(60_000);
    assert.equal(world.styleCalls.length, writes);
  });
});

describe("click behaviour", () => {
  function leakyWorld() {
    const world = createWorld();
    world.state = {
      item: { uri: track(1) },
      user: { id: "alice", email: "alice@example.com" },
      playbackQuality: {
        bitrateLevel: 6, hifiStatus: 2, strategy: "BEST", accessToken: "SECRET-TOKEN-123", userId: "alice-the-user",
        deviceName: "Alice's iPhone", note: "Bearer abc.def.ghi", ownerUri: "spotify:user:alice123",
      },
    };
    world.depthByUri.set(track(1), 24);
    return world;
  }

  it("logs the quality data once, with every sensitive field redacted", () => {
    const world = leakyWorld();
    world.boot({ probeEnabled: false });
    world.pill().click();
    assert.equal(world.logs.length, 1);
    const text = JSON.stringify(world.logs[0]);
    for (const secret of ["SECRET-TOKEN-123", "alice", "Alice's iPhone", "abc.def.ghi", "example.com"]) {
      assert.ok(!text.includes(secret), `console output leaked ${secret}: ${text}`);
    }
    assert.ok(text.includes('"bitrateLevel":6') && text.includes('"strategy":"BEST"'), "known quality fields are printed by value");
    assert.ok(text.includes("track:...0001"), "only the type and last 4 characters of the track id");
    assert.ok(!text.includes(track(1)), "the full track uri must not be logged");
    assert.ok(text.includes('"key":"accessToken"') && text.includes('"key":"deviceName"'), "unknown keys are listed by name");
    assert.ok(text.includes('"triggerFound":1'), "selector diagnostics are included");
  });

  it("logs, then clears the cached depth, then notifies, then re-checks (in that order)", () => {
    const world = bootWorld();
    const ext = world.ext;
    world.advance(2_000);
    assert.equal(ext.peekRecord(track(1)).depth, 24);
    const order = [];
    world.console.log = () => order.push(["log", ext.peekRecord(track(1)).depth]);
    world.spicetify.showNotification = (message) => order.push(["notify", ext.peekRecord(track(1)).depth, message]);
    world.pill().click();
    assert.deepEqual(order, [["log", 24], ["notify", null, "Audio quality: re-checking..."]]);
    world.advance(150);
    assert.equal(world.pillText(), "Lossless (checking...)", "the re-check is scheduled immediately");
  });

  it("re-probes the current track (respecting the 5 s same-track gap) and restores the depth", () => {
    const world = bootWorld();
    world.advance(2_000);
    const firstClicks = world.eventsOf("trigger-click").length;
    world.pill().click();
    world.advance(10_000);
    const clicks = world.eventsOf("trigger-click");
    assert.equal(clicks.length, firstClicks + 1, "exactly one more probe (opened via the trigger, closed via the panel's own button)");
    const [first, second] = world.eventsOf("trigger-click").filter((e) => e.t >= 0);
    assert.ok(second.t - first.t >= 5_000, `same-track probes only ${second.t - first.t} ms apart`);
    assert.equal(world.pillText(), "Lossless 24-bit");
    assertNoPlaybackSideEffects(world, assert);
  });

  it("works when nothing is playing", () => {
    const world = createWorld();
    world.state = null;
    world.boot();
    assert.doesNotThrow(() => world.pill().click());
    assert.equal(world.logs.length, 1);
    assert.equal(world.notifications.length, 1);
    assert.equal(world.eventsOf("trigger-click").length, 0);
  });

  it("works for lossy playback and does not start a probe", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.high);
    world.boot();
    world.pill().click();
    world.advance(10_000);
    assert.equal(world.logs.length, 1);
    assert.equal(world.eventsOf("trigger-click").length, 0);
  });

  it("survives a missing showNotification", () => {
    const world = createWorld({ noNotification: true });
    world.boot({ probeEnabled: false });
    assert.doesNotThrow(() => world.pill().click());
    assert.equal(world.logs.length, 1);
  });

  it("survives a throwing showNotification and a throwing console.log, still re-checking", () => {
    const world = bootWorld();
    world.advance(2_000);
    world.spicetify.showNotification = () => { throw new Error("toast failed"); };
    world.console.log = () => { throw new Error("console failed"); };
    assert.doesNotThrow(() => world.pill().click());
    world.advance(150);
    assert.equal(world.pillText(), "Lossless (checking...)");
    assert.ok(world.warns.length >= 1);
  });
});

describe("lifecycle: clean load, reload and unload", () => {
  it("mounts exactly one pill, one style element, one listener per Spicetify event, one observer", () => {
    const world = bootWorld();
    assert.deepEqual(
      { ...counts(world), pendingTimers: undefined },
      { pills: 1, styles: 1, songchange: 1, onplaypause: 1, domListeners: 3, activeObservers: 1, pendingTimers: undefined },
    );
    assert.equal(typeof world.window.audioQualityCleanup, "function");
  });

  it("start() is idempotent on one instance", () => {
    const world = bootWorld();
    const ext = world.ext;
    const before = counts(world);
    ext.start();
    ext.start();
    assert.deepEqual(counts(world), before);
  });

  it("reloading repeatedly never duplicates the pill, style, observers, intervals or listeners", () => {
    const baselineWorld = createWorld();
    baselineWorld.boot();
    const baseline = counts(baselineWorld);

    const world = createWorld();
    const instances = [];
    for (let i = 0; i < 6; i++) instances.push(world.boot());
    assert.deepEqual(counts(world), baseline);
    assert.equal(world.observers.length, 6);
    assert.deepEqual(instances.map((ext) => ext.getState().disposed), [true, true, true, true, true, false]);
    world.advance(30_000);
    assert.equal(world.pills(), 1);
    assert.equal(world.styles(), 1);
  });

  it("reloading while a probe is in progress leaves exactly one pill and no stuck state", () => {
    const world = bootWorld();
    world.advance(820); // mid-probe: panel open and hidden
    assert.equal(world.hideActive(), true);
    world.boot();
    assert.equal(world.pills(), 1);
    assert.equal(world.panelEl(), null, "the old instance must close the panel it opened");
    assert.equal(world.hideActive(), false);
    world.advance(10_000);
    assert.equal(world.pills(), 1);
  });

  it("an old cleanup hook that throws cannot stop the new instance from starting", () => {
    const world = createWorld();
    world.window.audioQualityCleanup = () => { throw new Error("stale hook"); };
    world.boot();
    assert.equal(world.pills(), 1);
    assert.ok(world.warns.length >= 1);
  });

  it("cleanup removes everything and is idempotent", () => {
    const world = bootWorld();
    const ext = world.ext;
    world.advance(2_000);
    ext.cleanup();
    assert.equal(world.pills(), 0);
    assert.equal(world.styles(), 0);
    assert.equal(world.hideActive(), false);
    assert.equal(world.playerListenerCount("songchange"), 0);
    assert.equal(world.playerListenerCount("onplaypause"), 0);
    assert.equal(world.listenerCount(), 0);
    assert.equal(world.clock.pending(), 0);
    assert.ok(world.observers.every((o) => !o.active), "every observer is disconnected");
    assert.equal(world.window.audioQualityCleanup, undefined);
    assert.equal(ext.getState().cacheSize, 0);
    assert.doesNotThrow(() => ext.cleanup());
  });

  it("nothing happens after cleanup: events create no timers and nothing re-mounts", () => {
    const world = bootWorld();
    const ext = world.ext;
    ext.cleanup();
    const created = world.clock.created;
    world.dispatchPlayer("songchange");
    world.dispatchPlayer("onplaypause");
    world.setHidden(true);
    world.setHidden(false);
    world.resize();
    world.advance(60_000);
    assert.equal(world.clock.created, created);
    assert.equal(world.pills(), 0);
    assert.equal(world.eventsOf("trigger-click").length, 0);
  });

  it("an old instance's cleanup never deletes a newer instance's hook", () => {
    const world = createWorld();
    const first = world.boot();
    const second = world.boot();
    const hook = world.window.audioQualityCleanup;
    first.cleanup();
    assert.equal(world.window.audioQualityCleanup, hook);
    second.cleanup();
    assert.equal(world.window.audioQualityCleanup, undefined);
  });

  it("without Player.removeEventListener, callbacks become inert after cleanup", () => {
    const world = createWorld({ noRemoveListener: true });
    const ext = world.boot();
    ext.cleanup();
    const created = world.clock.created;
    world.dispatchPlayer("songchange");
    world.advance(5_000);
    assert.equal(world.clock.created, created);
    assert.equal(world.pills(), 0);
  });

  it("a throwing removeEventListener does not stop the remaining cleanup steps", () => {
    const world = bootWorld();
    const ext = world.ext;
    world.failures.removeListener = true;
    assert.doesNotThrow(() => ext.cleanup());
    assert.equal(world.pills(), 0);
    assert.equal(world.styles(), 0);
    assert.equal(world.window.audioQualityCleanup, undefined);
    assert.equal(world.clock.pending(), 0);
    assert.ok(world.warns.length >= 1);
  });

  it("leaves <html> exactly as it found it after a full probe and cleanup", () => {
    const world = createWorld();
    const html = world.doc.documentElement;
    html.className = "theme-dark sidebar-open";
    html.setAttribute("style", "--spice-main: #000000; color-scheme: dark");
    const before = { cls: html.className, style: html.getAttribute("style"), attrs: [...html.attributes].map((a) => `${a.name}=${a.value}`).sort() };
    const ext = world.boot();
    world.advance(2_000);
    assert.equal(world.eventsOf("panel-insert").length, 1);
    ext.cleanup();
    assert.deepEqual(
      { cls: html.className, style: html.getAttribute("style"), attrs: [...html.attributes].map((a) => `${a.name}=${a.value}`).sort() },
      before,
    );
  });

  it("waits for Spicetify, then mounts", () => {
    const world = createWorld({ ready: false });
    world.boot();
    assert.equal(world.pills(), 0);
    assert.equal(world.clock.pending(), 1);
    world.ready = true;
    world.advance(150);
    assert.equal(world.pills(), 1);
  });

  it("cleanup before Spicetify is ready cancels the wait", () => {
    const world = createWorld({ ready: false });
    const ext = world.boot();
    ext.cleanup();
    assert.equal(world.clock.pending(), 0);
    world.ready = true;
    world.advance(5_000);
    assert.equal(world.pills(), 0);
  });

  it("gives up after a bounded number of waits, with one warning and no timers left", () => {
    const world = createWorld({ ready: false });
    world.boot({ limits: { spicetifyMaxWaits: 3 } });
    world.advance(2_000);
    assert.equal(world.pills(), 0);
    assert.equal(world.clock.pending(), 0);
    assert.equal(world.warns.length, 1);
  });

  it("a throwing getSpicetify is treated as 'not ready yet', not as a crash", () => {
    const world = createWorld();
    let calls = 0;
    const env = world.env({ getSpicetify: () => { if (++calls < 3) throw new Error("not yet"); return lib.getSpicetify({ Spicetify: world.spicetify }); } });
    const ext = lib.createExtension(env);
    assert.doesNotThrow(() => ext.start());
    world.advance(1_000);
    assert.equal(world.pills(), 1);
  });

  it("a failure while mounting cleans up fully instead of leaving a half-mounted extension", () => {
    const world = createWorld();
    world.createHook = (tag) => { if (tag === "style") throw new Error("style creation blocked"); };
    const ext = world.boot();
    assert.equal(ext.getState().disposed, true);
    assert.equal(world.pills(), 0);
    assert.equal(world.window.audioQualityCleanup, undefined);
    assert.equal(world.clock.pending(), 0);
    assert.ok(world.warns.length >= 1);
  });
});

describe("observer cost, re-mounting, resize and fullscreen", () => {
  it("scopes one MutationObserver to <body> children only (no subtree, no attributes)", () => {
    const world = bootWorld();
    assert.equal(world.observers.length, 1);
    assert.equal(world.observers[0].observes.length, 1);
    const { target, options } = world.observers[0].observes[0];
    assert.equal(target, world.doc.body);
    assert.deepEqual(options, { childList: true });
  });

  it("re-mounts the same pill element whenever Spotify removes it", async () => {
    const world = bootWorld();
    const original = world.pill();
    for (let i = 0; i < 5; i++) {
      world.pill().remove();
      await world.flush();
      world.advance(300);
      assert.equal(world.pills(), 1);
      assert.equal(world.pill(), original);
    }
  });

  it("re-mounts after Spotify wipes <body>", async () => {
    const world = bootWorld();
    world.doc.body.replaceChildren();
    await world.flush();
    world.advance(300);
    assert.equal(world.pills(), 1);
    assert.equal(world.pill().parentNode, world.doc.body);
  });

  it("self-heals a leftover hide class: with no probe running it is removed and reported", () => {
    const world = bootWorld({ probeEnabled: false });
    world.doc.documentElement.classList.add(HIDE_CLASS);
    world.advance(5_500);
    assert.equal(world.hideActive(), false);
    assert.ok(world.warns.length >= 1);
  });

  it("re-adds the style element if it is removed (via the heartbeat)", () => {
    const world = bootWorld();
    world.doc.getElementById(STYLE_ID).remove();
    assert.equal(world.styles(), 0);
    world.advance(5_500);
    assert.equal(world.styles(), 1);
  });

  it("a storm of 1000 body mutations costs one timer and no layout reads", async () => {
    const world = bootWorld();
    world.advance(1_000);
    const baselinePending = world.clock.pending();
    const created = world.clock.created;
    const rects = world.rectCalls;
    for (let i = 0; i < 1000; i++) {
      const el = world.doc.createElement("div");
      world.doc.body.appendChild(el);
      el.remove();
    }
    await world.flush();
    assert.ok(world.clock.created - created <= 1, `created ${world.clock.created - created} timers`);
    world.advance(300);
    assert.equal(world.rectCalls, rects, "body mutations must not trigger layout reads");
    assert.equal(world.clock.pending(), baselinePending);
  });

  it("does not loop after re-mounting (its own append is absorbed)", async () => {
    const world = bootWorld({ probeEnabled: false });
    world.pill().remove();
    await world.flush();
    world.advance(300);
    await world.flush();
    const created = world.clock.created;
    world.advance(2_000);
    await world.flush();
    assert.ok(world.clock.created - created <= 1, "only the 5 s heartbeat may add timers");
  });

  it("positions the pill above the now-playing bar and re-measures on resize, coalescing bursts", () => {
    const world = createWorld();
    world.barHeight = 90;
    world.boot({ probeEnabled: false });
    assert.equal(world.styleValue(world.pill(), "bottom"), "102px");
    world.barHeight = 72;
    const rects = world.rectCalls;
    for (let i = 0; i < 50; i++) world.resize();
    world.advance(300);
    assert.equal(world.styleValue(world.pill(), "bottom"), "84px");
    assert.equal(world.rectCalls - rects, 1, "50 resize events must produce one measurement");
  });

  it("ignores nonsensical bar heights", () => {
    for (const height of [0, -5, 4000, Number.NaN]) {
      const world = createWorld();
      world.barHeight = height;
      world.boot({ probeEnabled: false });
      assert.equal(world.styleValue(world.pill(), "bottom"), "104px", `height ${height}`);
    }
  });

  it("moves into the fullscreen element and back, re-targeting its observer", async () => {
    const world = bootWorld({ probeEnabled: false });
    const container = world.doc.createElement("div");
    world.doc.body.appendChild(container);
    world.setFullscreen(container);
    world.advance(300);
    assert.equal(world.pill().parentNode, container);
    assert.equal(world.observers[0].observes.at(-1).target, container);
    world.setFullscreen(null);
    world.advance(300);
    assert.equal(world.pill().parentNode, world.doc.body);
    assert.equal(world.pills(), 1);
  });

  it("stays in <body> when the fullscreen element cannot host children", () => {
    for (const tag of ["video", "canvas", "iframe"]) {
      const world = bootWorld({ probeEnabled: false });
      const el = world.doc.createElement(tag);
      world.doc.body.appendChild(el);
      world.setFullscreen(el);
      world.advance(300);
      assert.equal(world.pill().parentNode, world.doc.body, tag);
    }
    const world = bootWorld({ probeEnabled: false });
    world.setFullscreen(world.doc.documentElement);
    world.advance(300);
    assert.equal(world.pill().parentNode, world.doc.body);
  });
});

describe("idle cost and long-session growth", () => {
  it("an idle minute costs no DOM queries and no layout reads, and few timers", () => {
    const world = createWorld();
    world.setTrack(track(1), QUALITY.veryHigh);
    world.boot();
    world.advance(1_000);
    const queries = world.queryCalls;
    const rects = world.rectCalls;
    const fired = world.clock.fired;
    world.advance(60_000);
    assert.equal(world.queryCalls, queries);
    assert.equal(world.rectCalls, rects);
    assert.ok(world.clock.fired - fired <= 60, `${world.clock.fired - fired} timers fired in an idle minute`);
  });

  it("one simulated hour of listening keeps listeners, timers, observers and the cache bounded", () => {
    const world = bootWorld();
    const ext = world.ext;
    const startCounts = counts(world);
    for (let i = 1; i <= 20; i++) {
      world.skipTo(track(i), i % 2 ? QUALITY.lossless24 : QUALITY.lossless16, i % 2 ? 24 : 16);
      world.advance(180_000);
    }
    const state = ext.getState();
    assert.ok(state.pendingTimers <= 5, `pending timers: ${state.pendingTimers}`);
    assert.equal(counts(world).domListeners, startCounts.domListeners);
    assert.equal(counts(world).songchange, 1);
    assert.equal(counts(world).activeObservers, 1);
    assert.equal(world.observers.filter((o) => o.active).length, 1, "only the body observer stays active; every probe watcher is disconnected");
    assert.ok(world.observers.length <= 1 + 20, `${world.observers.length} observers created over 20 probes`);
    assert.equal(world.pills(), 1);
    assert.equal(state.cacheSize, 20);
    assert.ok(world.clock.created / 60 < 25, `${(world.clock.created / 60).toFixed(1)} timers created per minute`);
    assertNoPlaybackSideEffects(world, assert);
  });

  it("the cache never exceeds its capacity over a long stream of distinct tracks", () => {
    const world = createWorld();
    const ext = world.boot({ probeEnabled: false, limits: { cacheCapacity: 100 } });
    for (let i = 1; i <= 400; i++) {
      world.skipTo(track(i), QUALITY.lossless24, 24);
      world.advance(150);
    }
    assert.ok(ext.getState().cacheSize <= 100);
  });
});
