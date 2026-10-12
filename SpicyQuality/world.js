"use strict";

/**
 * A fake Spotify page: jsdom DOM + mocked Spicetify globals + a device panel that behaves like a
 * React popover (asynchronous render, toggle on trigger click, close button, click-outside close,
 * quality text that appears late and follows the *currently playing* track).
 *
 * Nothing here is verified against the real client; it encodes the assumptions listed in the report.
 */

const { JSDOM } = require("jsdom");
const lib = require("../../audio-quality.js");
const { FakeClock } = require("./fake-clock");

const HIDE_CLASS = lib.IDS.hideClass;
const PILL_ID = lib.IDS.pill;
const STYLE_ID = lib.IDS.style;

const BASE_HTML = `<!doctype html><html><head></head><body>
<div id="app"></div>
<footer class="Root__now-playing-bar" data-testid="now-playing-bar">
  <button data-testid="device-picker-icon-button" aria-label="Connect to a device" aria-expanded="false"></button>
</footer>
</body></html>`;

const track = (n) => `spotify:track:${String(n).padStart(22, "0")}`;

const QUALITY = Object.freeze({
  lossless16: Object.freeze({ bitrateLevel: 5, hifiStatus: 2 }),
  lossless24: Object.freeze({ bitrateLevel: 6, hifiStatus: 2 }),
  veryHigh: Object.freeze({ bitrateLevel: 4, hifiStatus: 1 }),
  high: Object.freeze({ bitrateLevel: 3, hifiStatus: 1 }),
  normal: Object.freeze({ bitrateLevel: 2, hifiStatus: 1 }),
  low: Object.freeze({ bitrateLevel: 1, hifiStatus: 1 }),
});

const DEFAULT_PANEL = {
  renderDelayMs: 50, // trigger click -> panel in DOM
  depthTextDelayMs: 100, // panel in DOM -> quality text rendered
  closeDelayMs: 0, // close click -> panel removed
  markup: "standard", // "standard" | "unknown" (our selectors will not match)
  closeButton: true,
  neverOpens: false,
  closeOnOutsideClick: true,
  activeMarker: "aria-current", // "aria-current" | "none"
  devices: [
    { name: "This computer", active: true, showsCurrentQuality: true },
    { name: "Kitchen speaker", active: false, staticQuality: "" },
  ],
};

function captureOf(options) {
  return typeof options === "boolean" ? options : Boolean(options && options.capture);
}

function createWorld(options = {}) {
  const dom = new JSDOM(BASE_HTML, { pretendToBeVisual: true, url: "https://xpui.app.spotify.com/" });
  const { window } = dom;
  const doc = window.document;
  const clock = new FakeClock();
  const clockApi = clock.api();
  const trigger = doc.querySelector('[data-testid="device-picker-icon-button"]');

  const world = {
    dom,
    window,
    doc,
    clock,
    trigger,
    events: [],
    playbackCalls: [],
    notifications: [],
    logs: [],
    warns: [],
    hidden: false,
    fullscreenEl: null,
    barHeight: null,
    rectCalls: 0,
    queryCalls: 0,
    queryHook: null,
    ready: options.ready !== false,
    panel: { ...DEFAULT_PANEL, ...options.panel },
    depthByUri: new Map(),
    state: null,
    playerDataOverride: undefined,
    platformStateOverride: undefined,
    failures: { playerData: false, platformState: false, removeListener: false },
    observers: [],
    domListeners: [],
    playerAdds: 0,
    dataReads: 0,
    playerRemoves: 0,
    ext: null,
  };

  const hideActive = () => doc.documentElement.classList.contains(HIDE_CLASS);
  const record = (type, extra = {}) => world.events.push({ type, t: clock.now(), ...extra });
  world.eventsOf = (type) => world.events.filter((event) => event.type === type);
  world.hideActive = hideActive;

  // ---- player state -----------------------------------------------------------------------

  world.currentUri = () => (world.state && world.state.item ? world.state.item.uri : null);

  world.setTrack = (uri, quality = QUALITY.lossless24, depth) => {
    world.state = { item: { uri }, playbackQuality: { ...quality } };
    if (depth !== undefined) world.depthByUri.set(uri, depth);
    renderPanelQuality();
  };
  world.skipTo = (uri, quality, depth) => {
    world.setTrack(uri, quality, depth);
    world.dispatchPlayer("songchange");
  };

  const playerListeners = { songchange: new Set(), onplaypause: new Set() };
  world.playerListenerCount = (type) => (playerListeners[type] ? playerListeners[type].size : 0);
  world.dispatchPlayer = (type) => {
    for (const callback of [...(playerListeners[type] ?? [])]) callback({ type });
  };

  const spy = (name) => () => {
    world.playbackCalls.push(name);
  };
  const spicetify = {
    Player: {
      get data() {
        world.dataReads++;
        if (world.failures.playerData) throw new Error("Player.data unavailable");
        return world.playerDataOverride !== undefined ? world.playerDataOverride : world.state;
      },
      addEventListener(type, callback) {
        (playerListeners[type] ??= new Set()).add(callback);
        world.playerAdds++;
      },
      removeEventListener(type, callback) {
        if (world.failures.removeListener) throw new Error("removeEventListener exploded");
        if (playerListeners[type]) playerListeners[type].delete(callback);
        world.playerRemoves++;
      },
      pause: spy("Player.pause"),
      play: spy("Player.play"),
      next: spy("Player.next"),
      back: spy("Player.back"),
      seek: spy("Player.seek"),
      togglePlay: spy("Player.togglePlay"),
    },
    Platform: {
      PlayerAPI: {
        get _state() {
          if (world.failures.platformState) throw new Error("_state unavailable");
          return world.platformStateOverride !== undefined ? world.platformStateOverride : world.state;
        },
        pause: spy("PlayerAPI.pause"),
        resume: spy("PlayerAPI.resume"),
        skipToNext: spy("PlayerAPI.skipToNext"),
        skipToPrevious: spy("PlayerAPI.skipToPrevious"),
        seekTo: spy("PlayerAPI.seekTo"),
      },
      ConnectAPI: { transfer: spy("ConnectAPI.transfer") },
    },
    showNotification(message, isError) {
      world.notifications.push({ message, isError });
    },
  };
  if (options.noRemoveListener) delete spicetify.Player.removeEventListener;
  if (options.noNotification) delete spicetify.showNotification;
  world.spicetify = spicetify;

  world.console = {
    log: (...args) => world.logs.push(args),
    warn: (...args) => world.warns.push(args),
    debug: () => {},
  };

  // ---- fake device panel ------------------------------------------------------------------

  let panelEl = null;
  let pendingOpen = 0;
  let closeTimer = 0;
  let qualitySpans = [];
  let qualityRendered = false;
  let expanded = false;

  const depthText = () => {
    const bits = world.depthByUri.get(world.currentUri());
    return bits ? `Lossless ${bits}-bit/44.1 kHz` : "";
  };

  function renderPanelQuality() {
    if (panelEl === null || !qualityRendered) return;
    for (const span of qualitySpans) span.textContent = depthText();
  }

  function buildPanel() {
    const config = world.panel;
    const el = doc.createElement("div");
    if (config.markup === "standard") {
      el.setAttribute("data-testid", "device-picker");
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "Connect to a device");
    } else {
      el.setAttribute("data-testid", "totally-different-panel");
    }
    if (config.inlineStyle) el.setAttribute("style", config.inlineStyle);
    if (config.closeButton) {
      const button = doc.createElement("button");
      button.setAttribute("aria-label", "Close");
      button.textContent = "x";
      button.addEventListener("click", () => {
        record("close-click", { hide: hideActive() });
        scheduleClose();
      });
      el.appendChild(button);
    }
    const list = doc.createElement("ul");
    qualitySpans = [];
    for (const device of config.devices) {
      const row = doc.createElement("li");
      row.setAttribute("role", "listitem");
      if (device.active && config.activeMarker !== "none") row.setAttribute("aria-current", "true");
      const name = doc.createElement("span");
      name.textContent = device.name;
      row.appendChild(name);
      const quality = doc.createElement("span");
      if (device.showsCurrentQuality) qualitySpans.push(quality);
      else quality.textContent = device.staticQuality ?? "";
      row.appendChild(quality);
      row.addEventListener("click", () => {
        record("row-click", { device: device.name, active: Boolean(device.active) });
        if (!device.active) world.playbackCalls.push("transfer");
      });
      list.appendChild(row);
    }
    el.appendChild(list);
    return el;
  }

  function openPanel() {
    pendingOpen = 0;
    const el = buildPanel();
    panelEl = el;
    qualityRendered = false;
    doc.body.appendChild(el);
    const computed = window.getComputedStyle(el);
    record("panel-insert", { hide: hideActive(), opacity: computed.opacity, visibility: computed.visibility });
    if (world.panel.grabsFocus) {
      // "if-visible" mimics a browser refusing to focus a visibility:hidden element; "always" mimics a
      // popover that forces focus into itself regardless.
      const hidden = computed.visibility === "hidden";
      if (world.panel.grabsFocus === "always" || !hidden) {
        const target = el.querySelector("button") ?? el;
        if (target === el) el.setAttribute("tabindex", "-1");
        target.focus();
        record("focus-grab", { hidden });
      }
    }
    clockApi.setTimeout(() => {
      if (panelEl !== el) return;
      qualityRendered = true;
      renderPanelQuality();
    }, world.panel.depthTextDelayMs);
  }

  function closePanel() {
    closeTimer = 0;
    if (panelEl === null) return;
    const el = panelEl;
    panelEl = null;
    el.remove();
    expanded = false;
    trigger.setAttribute("aria-expanded", "false");
    record("panel-remove", { hide: hideActive() });
  }

  function scheduleClose() {
    if (closeTimer !== 0) return;
    if (world.panel.closeDelayMs <= 0) closePanel();
    else closeTimer = clockApi.setTimeout(closePanel, world.panel.closeDelayMs);
  }

  trigger.addEventListener("click", (event) => {
    record("trigger-click", { trusted: event.__trusted === true, hide: hideActive(), expandedBefore: expanded });
    if (pendingOpen !== 0) {
      clockApi.clearTimeout(pendingOpen);
      pendingOpen = 0;
      expanded = false;
      trigger.setAttribute("aria-expanded", "false");
      return;
    }
    if (panelEl !== null) {
      scheduleClose();
      return;
    }
    if (expanded) {
      expanded = false;
      trigger.setAttribute("aria-expanded", "false");
      return;
    }
    expanded = true;
    trigger.setAttribute("aria-expanded", "true");
    if (world.panel.neverOpens) return;
    pendingOpen = clockApi.setTimeout(openPanel, world.panel.renderDelayMs);
  });

  // Spotify closes popovers on outside clicks. Registered before listener accounting is installed.
  doc.addEventListener(
    "pointerdown",
    (event) => {
      if (panelEl === null || !world.panel.closeOnOutsideClick || event.__trusted !== true) return;
      if (panelEl.contains(event.target) || trigger.contains(event.target)) return;
      scheduleClose();
    },
    true,
  );

  world.panelEl = () => panelEl;
  world.panelPending = () => pendingOpen !== 0;

  // ---- user input -------------------------------------------------------------------------

  world.userEvent = (target, type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.__trusted = true;
    target.dispatchEvent(event);
    return event;
  };
  world.userClick = (target) => {
    for (const type of ["pointerdown", "mousedown", "click"]) world.userEvent(target, type);
  };
  world.userOpensPanel = () => {
    world.userClick(trigger);
    clock.advance(world.panel.renderDelayMs + 1);
  };

  // ---- window state -----------------------------------------------------------------------

  Object.defineProperty(doc, "hidden", { configurable: true, get: () => world.hidden });
  Object.defineProperty(doc, "fullscreenElement", { configurable: true, get: () => world.fullscreenEl });
  world.setHidden = (value) => {
    world.hidden = value;
    doc.dispatchEvent(new window.Event("visibilitychange"));
  };
  world.setFullscreen = (element) => {
    world.fullscreenEl = element;
    doc.dispatchEvent(new window.Event("fullscreenchange"));
  };
  world.resize = () => window.dispatchEvent(new window.Event("resize"));

  // ---- instrumentation --------------------------------------------------------------------

  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    world.rectCalls++;
    const base = originalRect.call(this);
    if (world.barHeight !== null && this.matches(".Root__now-playing-bar")) {
      return { x: 0, y: 0, top: 0, left: 0, right: base.right, bottom: world.barHeight, width: base.width, height: world.barHeight };
    }
    return base;
  };

  const originalQuerySelectorAll = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (selector) => {
    world.queryCalls++;
    if (world.queryHook) world.queryHook(selector);
    return originalQuerySelectorAll(selector);
  };

  // Count how often the hide class is added to <html> (proves "never added" in fail-safe tests).
  world.hideAdds = 0;
  const classList = doc.documentElement.classList;
  const originalAdd = classList.add.bind(classList);
  classList.add = (...tokens) => {
    if (tokens.includes(HIDE_CLASS)) world.hideAdds++;
    return originalAdd(...tokens);
  };

  // Record the raw values assigned to element styles (jsdom's CSS parser may drop var() values).
  world.styleCalls = [];
  world.createHook = null;
  const originalCreateElement = doc.createElement.bind(doc);
  doc.createElement = (tag, createOptions) => {
    if (world.createHook) world.createHook(tag);
    const el = originalCreateElement(tag, createOptions);
    if (String(tag).toLowerCase() === "div") {
      const setProperty = el.style.setProperty.bind(el.style);
      el.style.setProperty = (name, value, priority) => {
        world.styleCalls.push({ el, name, value });
        return setProperty(name, value, priority);
      };
    }
    return el;
  };
  world.styleValue = (el, name) => {
    for (let i = world.styleCalls.length - 1; i >= 0; i--) {
      const call = world.styleCalls[i];
      if (call.el === el && call.name === name) return call.value;
    }
    return undefined;
  };

  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class SpyObserver extends NativeObserver {
    constructor(callback) {
      super(callback);
      const entry = { observes: [], disconnects: 0, active: false };
      world.observers.push(entry);
      const observe = this.observe.bind(this);
      const disconnect = this.disconnect.bind(this);
      this.observe = (target, observeOptions) => {
        entry.observes.push({ target, options: observeOptions });
        entry.active = true;
        return observe(target, observeOptions);
      };
      this.disconnect = () => {
        entry.disconnects++;
        entry.active = false;
        return disconnect();
      };
    }
  };

  for (const target of [window, doc]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, handler, opts) => {
      world.domListeners.push({ target, type, handler, capture: captureOf(opts) });
      return add(type, handler, opts);
    };
    target.removeEventListener = (type, handler, opts) => {
      const index = world.domListeners.findIndex(
        (entry) => entry.target === target && entry.type === type && entry.handler === handler && entry.capture === captureOf(opts),
      );
      if (index >= 0) world.domListeners.splice(index, 1);
      return remove(type, handler, opts);
    };
  }
  world.listenerCount = () => world.domListeners.length;

  // ---- convenience ------------------------------------------------------------------------

  world.pill = () => doc.getElementById(PILL_ID);
  world.pillText = () => (world.pill() ? world.pill().textContent : null);
  world.pills = () => doc.querySelectorAll(`#${PILL_ID}`).length;
  world.styles = () => [...doc.getElementsByTagName("style")].filter((el) => el.id === STYLE_ID).length;
  world.advance = (ms) => clock.advance(ms);
  world.flush = () => new Promise((resolve) => setImmediate(resolve));
  world.advanceUntil = (predicate, maxMs = 20000, stepMs = 10) => {
    let waited = 0;
    while (!predicate()) {
      if (waited >= maxMs) throw new Error(`advanceUntil: condition not met within ${maxMs} ms`);
      clock.advance(stepMs);
      waited += stepMs;
    }
    return waited;
  };

  world.env = ({ config, ...rest } = {}) => ({
    doc,
    win: window,
    getSpicetify: () => (world.ready ? lib.getSpicetify({ Spicetify: spicetify }) : undefined),
    now: () => clock.now(),
    timers: clockApi,
    console: world.console,
    isUserEvent: (event) => event.__trusted === true,
    ...rest,
    config: { ...config },
  });

  world.boot = (config = {}, rest = {}) => {
    const ext = lib.createExtension(world.env({ config, ...rest }));
    ext.start();
    world.ext = ext;
    return ext;
  };

  // default scenario: track 1, lossless, 24-bit
  world.setTrack(track(1), QUALITY.lossless24, 24);
  return world;
}

/** Asserts that nothing the probe did could have paused, skipped, sought or transferred playback. */
function assertNoPlaybackSideEffects(world, assert) {
  assert.deepEqual(world.playbackCalls, [], "no playback API may be called");
  assert.deepEqual(world.eventsOf("row-click"), [], "no device row may be clicked");
}

/** Asserts the "never visible" invariant: every panel insertion happened while hidden by our rule. */
function assertPanelNeverVisible(world, assert) {
  for (const event of world.eventsOf("panel-insert")) {
    assert.equal(event.hide, true, `panel inserted at t=${event.t} without the hide class`);
    assert.equal(event.opacity, "0", `panel inserted at t=${event.t} but computed opacity was ${event.opacity}`);
    assert.equal(event.visibility, "hidden", `panel inserted at t=${event.t} but computed visibility was ${event.visibility}`);
  }
}

module.exports = { createWorld, assertNoPlaybackSideEffects, assertPanelNeverVisible, track, QUALITY, HIDE_CLASS, PILL_ID, STYLE_ID };
