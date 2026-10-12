"use strict";

// Exercises the PRODUCTION path: the file is evaluated as a classic script inside a jsdom window
// (no `module`, a real `document`), exactly the way Spicetify loads it. Mocked Spicetify, fake timers.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { FakeClock } = require("./helpers/fake-clock");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "audio-quality.js"), "utf8");
const PILL_ID = "spicetify-audio-quality-pill";
const STYLE_ID = "spicetify-audio-quality-style";
const URI = "spotify:track:0000000000000000000001";

function makePage({ withSpicetify = true, quality = { bitrateLevel: 3, hifiStatus: 1 } } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><footer class="Root__now-playing-bar"></footer></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const { window } = dom;
  const clock = new FakeClock();
  const api = clock.api();
  window.setTimeout = (fn, ms) => api.setTimeout(fn, ms);
  window.clearTimeout = (id) => api.clearTimeout(id);
  window.setInterval = (fn, ms) => api.setInterval(fn, ms);
  window.clearInterval = (id) => api.clearInterval(id);
  const listeners = { songchange: new Set(), onplaypause: new Set() };
  const spicetify = {
    Player: {
      data: { item: { uri: URI }, playbackQuality: quality },
      addEventListener: (type, cb) => listeners[type].add(cb),
      removeEventListener: (type, cb) => listeners[type].delete(cb),
    },
    Platform: {},
  };
  if (withSpicetify) window.Spicetify = spicetify;
  const warns = [];
  window.console.warn = (...args) => warns.push(args);
  return {
    window, clock, listeners, spicetify, warns,
    load: () => window.eval(SOURCE),
    pills: () => window.document.querySelectorAll(`#${PILL_ID}`).length,
    styles: () => [...window.document.getElementsByTagName("style")].filter((el) => el.id === STYLE_ID).length,
  };
}

describe("production bootstrap (classic script, no module system)", () => {
  it("starts by itself, mounts the pill and exposes the cleanup hook", () => {
    const page = makePage();
    page.load();
    assert.equal(page.pills(), 1);
    assert.equal(page.window.document.getElementById(PILL_ID).textContent, "High (~160 kbps)");
    assert.equal(typeof page.window.audioQualityCleanup, "function");
    assert.equal(page.listeners.songchange.size, 1);
    assert.equal(page.listeners.onplaypause.size, 1);
  });

  it("evaluating the file again replaces the previous instance instead of stacking a second one", () => {
    const page = makePage();
    page.load();
    page.load();
    page.load();
    assert.equal(page.pills(), 1);
    assert.equal(page.styles(), 1);
    assert.equal(page.listeners.songchange.size, 1);
    assert.equal(page.listeners.onplaypause.size, 1);
    page.clock.advance(60_000);
    assert.equal(page.pills(), 1);
  });

  it("globalThis.audioQualityCleanup removes everything it added", () => {
    const page = makePage();
    const baselineHtml = page.window.document.documentElement.outerHTML;
    page.load();
    page.window.audioQualityCleanup();
    assert.equal(page.pills(), 0);
    assert.equal(page.styles(), 0);
    assert.equal(page.listeners.songchange.size, 0);
    assert.equal(page.listeners.onplaypause.size, 0);
    assert.equal(page.clock.pending(), 0);
    assert.equal(page.window.audioQualityCleanup, undefined);
    assert.equal(page.window.document.documentElement.outerHTML, baselineHtml, "the page is byte-for-byte what it was");
  });

  it("waits for Spicetify to appear, then mounts", () => {
    const page = makePage({ withSpicetify: false });
    page.load();
    assert.equal(page.pills(), 0);
    page.window.Spicetify = page.spicetify;
    page.clock.advance(250);
    assert.equal(page.pills(), 1);
  });

  it("never throws into the page when Spicetify misbehaves while mounting", () => {
    const page = makePage({ withSpicetify: false });
    page.window.Spicetify = { Player: { addEventListener() { throw new Error("boom"); } } };
    assert.doesNotThrow(() => page.load());
    page.clock.advance(1_000);
    assert.equal(page.pills(), 0);
    assert.equal(page.styles(), 0);
    assert.equal(page.window.audioQualityCleanup, undefined);
    assert.ok(page.warns.length >= 1);
  });

  it("a startup failure is reported on the console and never thrown into the page", () => {
    const page = makePage();
    delete page.window.AbortController; // makes createExtension itself fail
    assert.doesNotThrow(() => page.load());
    assert.equal(page.pills(), 0);
    assert.ok(page.warns.some((w) => String(w[0]).includes("failed to start")));
  });

  it("when a module system is also present it exports the internals AND still starts", () => {
    const page = makePage();
    page.window.module = { exports: {} };
    page.load();
    assert.equal(typeof page.window.module.exports.createExtension, "function");
    assert.equal(page.pills(), 1);
  });
});

describe("module path (plain Node, no DOM)", () => {
  it("requiring the file has no side effects", () => {
    const lib = require("../audio-quality.js");
    assert.equal(typeof lib.createExtension, "function");
    assert.equal(globalThis.audioQualityCleanup, undefined);
    assert.equal(typeof globalThis.document, "undefined");
  });
});
