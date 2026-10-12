"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../audio-quality.js");

const unknown = { kind: "unknown" };
const depthOf = (text) => {
  const result = lib.extractDepthFromText(text);
  return result.kind === "depth" ? result.bits : null;
};

describe("parseBitrateLevel", () => {
  const numeric = [
    [1, "LOW"],
    [2, "NORMAL"],
    [3, "HIGH"],
    [4, "VERY_HIGH"],
    [5, "HIFI"],
    [6, "HIFI24"],
  ];
  for (const [code, name] of numeric) {
    it(`maps numeric ${code} to ${name}`, () => assert.equal(lib.parseBitrateLevel(code), name));
  }

  const named = [
    ["LOW", "LOW"], ["low", "LOW"], ["very_high", "VERY_HIGH"], ["VERY_HIGH", "VERY_HIGH"],
    ["Very High", "VERY_HIGH"], ["veryHigh", "VERY_HIGH"], ["BITRATE_LEVEL_HIGH", "HIGH"],
    ["hifi", "HIFI"], ["HIFI24", "HIFI24"], ["hifi_24", "HIFI24"], [" 5 ", "HIFI"], ["6", "HIFI24"],
  ];
  for (const [raw, name] of named) {
    it(`maps ${JSON.stringify(raw)} to ${name}`, () => assert.equal(lib.parseBitrateLevel(raw), name));
  }

  const rejected = [
    0, 7, -1, 1.5, Number.NaN, Infinity, "0", "7", "-1", "unknown_bitrate_level", "UNKNOWN", "", "   ",
    "banana", "constructor", "__proto__", "a".repeat(100), null, undefined, true, {}, [], Symbol("x"), 10n,
  ];
  for (const raw of rejected) {
    it(`rejects ${typeof raw === "symbol" || typeof raw === "bigint" ? String(raw) : JSON.stringify(raw)}`, () =>
      assert.equal(lib.parseBitrateLevel(raw), null));
  }
});

describe("parseHifiStatus", () => {
  const valid = [[0, "NONE"], [1, "OFF"], [2, "ON"], ["none", "NONE"], ["OFF", "OFF"], ["On", "ON"], ["HIFI_STATUS_ON", "ON"], ["2", "ON"]];
  for (const [raw, name] of valid) {
    it(`maps ${JSON.stringify(raw)} to ${name}`, () => assert.equal(lib.parseHifiStatus(raw), name));
  }
  for (const raw of [3, -1, 1.2, "3", "maybe", "", null, undefined, {}, "constructor"]) {
    it(`rejects ${JSON.stringify(raw)}`, () => assert.equal(lib.parseHifiStatus(raw), null));
  }
});

describe("classifyQuality (level is authoritative; hifiStatus only fills a missing level)", () => {
  const cases = [
    ["HIFI", "ON", { kind: "lossless", level: "HIFI" }],
    ["HIFI", "OFF", { kind: "lossless", level: "HIFI" }],
    ["HIFI24", "NONE", { kind: "lossless", level: "HIFI24" }],
    ["HIFI24", null, { kind: "lossless", level: "HIFI24" }],
    ["VERY_HIGH", "ON", { kind: "lossy", tier: "VERY_HIGH" }],
    ["LOW", null, { kind: "lossy", tier: "LOW" }],
    ["NORMAL", "OFF", { kind: "lossy", tier: "NORMAL" }],
    [null, "ON", { kind: "lossless", level: null }],
    [null, "OFF", unknown],
    [null, "NONE", unknown],
    [null, null, unknown],
  ];
  for (const [level, hifi, expected] of cases) {
    it(`level=${level} hifi=${hifi}`, () => assert.deepEqual(lib.classifyQuality(level, hifi), expected));
  }
});

describe("describePill", () => {
  it("shows bit depth when known, with lossless tone", () => {
    assert.deepEqual(lib.describePill({ kind: "lossless", level: "HIFI24" }, { kind: "known", bits: 24 }), { text: "Lossless 24-bit", tone: "lossless" });
    assert.deepEqual(lib.describePill({ kind: "lossless", level: "HIFI" }, { kind: "known", bits: 16 }), { text: "Lossless 16-bit", tone: "lossless" });
  });
  it("shows (checking...) while the depth is being read", () => {
    assert.equal(lib.describePill({ kind: "lossless", level: null }, { kind: "checking" }).text, "Lossless (checking...)");
  });
  it("shows plain Lossless when the depth is unreadable", () => {
    assert.equal(lib.describePill({ kind: "lossless", level: null }, { kind: "unreadable" }).text, "Lossless");
  });
  const tiers = [
    ["VERY_HIGH", "Very High (~320 kbps)"], ["HIGH", "High (~160 kbps)"], ["NORMAL", "Normal (~96 kbps)"], ["LOW", "Low (~24 kbps)"],
  ];
  for (const [tier, text] of tiers) {
    it(`labels ${tier}`, () => assert.deepEqual(lib.describePill({ kind: "lossy", tier }, { kind: "unreadable" }), { text, tone: "lossy" }));
  }
  it("ignores depth state for lossy and unknown qualities", () => {
    assert.equal(lib.describePill({ kind: "lossy", tier: "HIGH" }, { kind: "known", bits: 24 }).text, "High (~160 kbps)");
    assert.deepEqual(lib.describePill(unknown, { kind: "known", bits: 24 }), { text: "Quality unknown", tone: "unknown" });
  });
});

describe("extractTrackUri", () => {
  const uri = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
  it("reads state.item.uri", () => assert.equal(lib.extractTrackUri({ item: { uri } }), uri));
  it("reads state.track.uri", () => assert.equal(lib.extractTrackUri({ track: { uri } }), uri));
  it("prefers item over track", () => {
    assert.equal(lib.extractTrackUri({ item: { uri }, track: { uri: "spotify:track:other" } }), uri);
  });
  it("falls through to track when item has no valid uri", () => {
    assert.equal(lib.extractTrackUri({ item: { uri: 42 }, track: { uri } }), uri);
  });
  it("accepts episode and local-file URIs", () => {
    assert.equal(lib.extractTrackUri({ item: { uri: "spotify:episode:abc" } }), "spotify:episode:abc");
    assert.equal(lib.extractTrackUri({ item: { uri: "spotify:local:Artist:Album:Title:123" } }), "spotify:local:Artist:Album:Title:123");
  });
  const bad = [null, undefined, 5, "x", [], {}, { item: null }, { item: {} }, { item: { uri: "" } }, { item: { uri: "https://x" } },
    { item: { uri: "spotify:track:has space" } }, { item: { uri: `spotify:track:${"a".repeat(300)}` } }];
  for (const state of bad) {
    it(`returns null for ${JSON.stringify(state)?.slice(0, 40)}`, () => assert.equal(lib.extractTrackUri(state), null));
  }
});

describe("extractQualityFields", () => {
  it("reads camelCase numbers", () => {
    const f = lib.extractQualityFields({ playbackQuality: { bitrateLevel: 5, hifiStatus: 2 } });
    assert.equal(f.level, "HIFI");
    assert.equal(f.hifi, "ON");
  });
  it("reads snake_case strings", () => {
    const f = lib.extractQualityFields({ playback_quality: { bitrate_level: "very_high", hifi_status: "off" } });
    assert.equal(f.level, "VERY_HIGH");
    assert.equal(f.hifi, "OFF");
  });
  it("prefers camelCase over snake_case at both levels", () => {
    const f = lib.extractQualityFields({ playbackQuality: { bitrateLevel: 3, bitrate_level: 6 }, playback_quality: { bitrate_level: 1 } });
    assert.equal(f.level, "HIGH");
  });
  it("keeps the raw object for diagnostics", () => {
    const raw = { bitrateLevel: 2, extra: true };
    assert.equal(lib.extractQualityFields({ playbackQuality: raw }).raw, raw);
  });
  for (const state of [null, "s", {}, { playbackQuality: null }, { playbackQuality: "high" }, { playback_quality: 3 }]) {
    it(`returns null for ${JSON.stringify(state)}`, () => assert.equal(lib.extractQualityFields(state), null));
  }
  it("returns nulls (not a throw) for unrecognised field values", () => {
    const f = lib.extractQualityFields({ playbackQuality: { bitrateLevel: "??", hifiStatus: 99 } });
    assert.equal(f.level, null);
    assert.equal(f.hifi, null);
  });
});

describe("readSnapshot", () => {
  const uriA = "spotify:track:AAAA";
  const uriB = "spotify:track:BBBB";
  const good = (uri, level = 6) => ({ item: { uri }, playbackQuality: { bitrateLevel: level, hifiStatus: 2 } });

  it("uses the first source that yields a known quality", () => {
    const snap = lib.readSnapshot([{ name: "a", read: () => good(uriA) }, { name: "b", read: () => good(uriB, 2) }]);
    assert.equal(snap.uri, uriA);
    assert.equal(snap.source, "a");
    assert.equal(snap.quality.kind, "lossless");
  });
  it("falls back to the second source when the first has no quality object", () => {
    const snap = lib.readSnapshot([{ name: "a", read: () => ({ item: { uri: uriA } }) }, { name: "b", read: () => good(uriB, 3) }]);
    assert.deepEqual(snap.quality, { kind: "lossy", tier: "HIGH" });
    assert.equal(snap.uri, uriB);
    assert.equal(snap.source, "b");
  });
  it("reports a throwing source and still uses the next one", () => {
    const errors = [];
    const snap = lib.readSnapshot(
      [{ name: "a", read: () => { throw new Error("nope"); } }, { name: "b", read: () => good(uriB) }],
      (name, error) => errors.push([name, error.message]),
    );
    assert.deepEqual(errors, [["a", "nope"]]);
    assert.equal(snap.uri, uriB);
  });
  it("returns unknown when every source throws", () => {
    const snap = lib.readSnapshot([{ name: "a", read: () => { throw new Error("1"); } }, { name: "b", read: () => { throw new Error("2"); } }]);
    assert.deepEqual(snap, { uri: null, quality: unknown, source: null, rawQuality: undefined });
  });
  it("does not require an onError callback", () => {
    assert.doesNotThrow(() => lib.readSnapshot([{ name: "a", read: () => { throw new Error("x"); } }]));
  });
  it("keeps a uri-bearing candidate with unknown quality when nothing better exists", () => {
    const snap = lib.readSnapshot([{ name: "a", read: () => ({ item: { uri: uriA } }) }, { name: "b", read: () => ({}) }]);
    assert.equal(snap.uri, uriA);
    assert.deepEqual(snap.quality, unknown);
  });
  it("treats a quality object with unrecognised values as unknown and keeps looking", () => {
    const snap = lib.readSnapshot([
      { name: "a", read: () => ({ item: { uri: uriA }, playbackQuality: { bitrateLevel: 0, hifiStatus: 1 } }) },
      { name: "b", read: () => good(uriA, 4) },
    ]);
    assert.deepEqual(snap.quality, { kind: "lossy", tier: "VERY_HIGH" });
  });
  it("survives hostile state objects", () => {
    const hostile = new Proxy({}, { get() { throw new Error("trap"); } });
    const snap = lib.readSnapshot([{ name: "a", read: () => hostile }]);
    assert.deepEqual(snap.quality, unknown);
  });
});

describe("extractDepthFromText / parseDepthFromText", () => {
  const ok = [
    ["Lossless 24-bit/44.1 kHz", 24], ["Lossless 16-bit", 16], ["Lossless\u00a024-bit", 24], ["Lossless\n  16-bit/44.1", 16],
    ["Lossless 24-bits", 24], ["Now playing: Lossless 24-bit/96 kHz on This computer", 24], ["Lossless 16-bit … Lossless 16-bit", 16],
  ];
  for (const [text, bits] of ok) {
    it(`reads ${bits} from ${JSON.stringify(text)}`, () => {
      assert.equal(depthOf(text), bits);
      assert.deepEqual(lib.extractDepthFromText(text), { kind: "depth", bits });
    });
  }
  const none = ["", "Lossless", "Lossless 32-bit", "Lossless 124-bit", "Lossless 160-bit", "lossless 24-bit", "Lossless24-bit", "Lossless 24 bit", "Very High 24-bit", null, undefined, 24, {}];
  for (const text of none) {
    it(`finds nothing in ${JSON.stringify(text)}`, () => {
      assert.equal(depthOf(text), null);
      assert.deepEqual(lib.extractDepthFromText(text), { kind: "none" });
    });
  }
  it("reports conflicting depths as ambiguous instead of guessing", () => {
    assert.deepEqual(lib.extractDepthFromText("Lossless 16-bit and Lossless 24-bit"), { kind: "ambiguous" });
    assert.equal(depthOf("Lossless 16-bit and Lossless 24-bit"), null);
  });
  it("only scans a bounded prefix of very large text", () => {
    const filler = "x".repeat(100_001);
    assert.deepEqual(lib.extractDepthFromText(`${filler}Lossless 24-bit`), { kind: "none" });
    assert.deepEqual(lib.extractDepthFromText(`Lossless 24-bit${filler}`), { kind: "depth", bits: 24 });
  });
  it("does not blow up on pathological whitespace runs", () => {
    const evil = `${"Lossless ".repeat(5000)}${" ".repeat(50_000)}x`;
    const started = performance.now();
    assert.deepEqual(lib.extractDepthFromText(evil), { kind: "none" });
    assert.ok(performance.now() - started < 1000, "regex scan took too long");
  });
});

describe("LruCache", () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, Infinity, "3", null, undefined]) {
    it(`rejects capacity ${String(capacity)}`, () => assert.throws(() => new lib.LruCache(capacity), RangeError));
  }
  it("stores, reads, deletes and clears", () => {
    const cache = new lib.LruCache(3);
    cache.set("a", { n: 1 }).set("b", { n: 2 });
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.get("a"), { n: 1 });
    assert.equal(cache.has("b"), true);
    assert.equal(cache.get("missing"), undefined);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.delete("a"), false);
    cache.clear();
    assert.equal(cache.size, 0);
  });
  it("evicts the least recently used entry", () => {
    const cache = new lib.LruCache(2);
    cache.set("a", {}).set("b", {}).set("c", {});
    assert.deepEqual(cache.keys(), ["b", "c"]);
  });
  it("get() refreshes recency but peek() does not", () => {
    const cache = new lib.LruCache(2);
    cache.set("a", {}).set("b", {});
    cache.peek("a");
    cache.set("c", {});
    assert.deepEqual(cache.keys(), ["b", "c"], "peek must not protect a from eviction");
    const cache2 = new lib.LruCache(2);
    cache2.set("a", {}).set("b", {});
    cache2.get("a");
    cache2.set("c", {});
    assert.deepEqual(cache2.keys(), ["a", "c"], "get must protect a from eviction");
  });
  it("re-setting an existing key refreshes it without growing", () => {
    const cache = new lib.LruCache(2);
    cache.set("a", { v: 1 }).set("b", {}).set("a", { v: 2 });
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.keys(), ["b", "a"]);
    assert.deepEqual(cache.get("a"), { v: 2 });
  });
  it("works at capacity 1", () => {
    const cache = new lib.LruCache(1);
    cache.set("a", {}).set("b", {});
    assert.deepEqual(cache.keys(), ["b"]);
  });
  it("stays bounded under a long stream of distinct keys", () => {
    const cache = new lib.LruCache(100);
    for (let i = 0; i < 5000; i++) cache.set(`spotify:track:${i}`, { i });
    assert.equal(cache.size, 100);
    assert.equal(cache.keys()[0], "spotify:track:4900");
    assert.equal(cache.peek("spotify:track:0"), undefined);
  });
});

describe("checkProbeGate (rate limiter and preconditions)", () => {
  const base = { now: 10_000, hidden: false, probeRunning: false, lastTrackChangeAt: null, lastAnyProbeEndedAt: null, lastTrackProbeEndedAt: null, autoAttempts: 0, kind: "auto" };
  const gate = (over) => lib.checkProbeGate({ ...base, ...over });

  it("allows a first probe with no history", () => assert.deepEqual(gate({}), { ok: true }));
  it("refuses while another probe runs, with no timer hint", () => assert.deepEqual(gate({ probeRunning: true }), { ok: false, reason: "probe-running", retryAfterMs: null }));
  it("refuses while the window is hidden, with no timer hint", () => assert.deepEqual(gate({ hidden: true }), { ok: false, reason: "hidden", retryAfterMs: null }));

  it("caps automatic probes at 3 per track but never caps manual ones", () => {
    assert.equal(gate({ autoAttempts: 2 }).ok, true);
    assert.deepEqual(gate({ autoAttempts: 3 }), { ok: false, reason: "attempts-exhausted", retryAfterMs: null });
    assert.deepEqual(gate({ autoAttempts: 50, kind: "manual" }), { ok: true });
  });

  it("waits 700 ms after a track change", () => {
    assert.deepEqual(gate({ lastTrackChangeAt: 9_301 }), { ok: false, reason: "settling", retryAfterMs: 1 });
    assert.deepEqual(gate({ lastTrackChangeAt: 9_300 }), { ok: true });
    assert.deepEqual(gate({ lastTrackChangeAt: 10_000 }), { ok: false, reason: "settling", retryAfterMs: 700 });
  });
  it("keeps 1.5 s between any two probes", () => {
    assert.deepEqual(gate({ lastAnyProbeEndedAt: 9_000 }), { ok: false, reason: "rate-limited-global", retryAfterMs: 500 });
    assert.deepEqual(gate({ lastAnyProbeEndedAt: 8_500 }), { ok: true });
  });
  it("keeps 5 s between probes of the same track", () => {
    assert.deepEqual(gate({ lastTrackProbeEndedAt: 7_000 }), { ok: false, reason: "rate-limited-track", retryAfterMs: 2000 });
    assert.deepEqual(gate({ lastTrackProbeEndedAt: 5_000 }), { ok: true });
  });
  it("reports the longest of several waits", () => {
    const result = gate({ lastTrackChangeAt: 9_900, lastAnyProbeEndedAt: 9_500, lastTrackProbeEndedAt: 9_000 });
    assert.deepEqual(result, { ok: false, reason: "rate-limited-track", retryAfterMs: 4000 });
  });
  it("applies the same limits to manual probes", () => {
    assert.equal(gate({ kind: "manual", lastTrackProbeEndedAt: 9_000 }).ok, false);
  });
  it("cannot be stalled by a clock that moved backwards", () => {
    assert.deepEqual(gate({ lastTrackProbeEndedAt: 90_000 }), { ok: false, reason: "rate-limited-track", retryAfterMs: 5000 });
  });
  it("honours custom limits", () => {
    const limits = { ...lib.DEFAULT_LIMITS, trackChangeSettleMs: 50, maxAutoProbesPerTrack: 1 };
    assert.equal(lib.checkProbeGate({ ...base, limits, lastTrackChangeAt: 9_950 }).ok, true);
    assert.equal(lib.checkProbeGate({ ...base, limits, lastTrackChangeAt: 9_960 }).ok, false);
    assert.equal(lib.checkProbeGate({ ...base, limits, autoAttempts: 1 }).ok, false);
  });
  it("holds off while an editable control has focus, retrying every second without consuming an attempt", () => {
    assert.deepEqual(gate({ typing: true }), { ok: false, reason: "user-typing", retryAfterMs: 1000 });
    assert.equal(gate({ typing: false }).ok, true);
    assert.equal(gate({ typing: true, hidden: true }).reason, "hidden", "hidden outranks typing");
    const limits = { ...lib.DEFAULT_LIMITS, typingRetryMs: 250 };
    assert.equal(lib.checkProbeGate({ ...base, limits, typing: true }).retryAfterMs, 250);
  });
  it("precedence: running beats exhausted beats hidden", () => {
    assert.equal(gate({ probeRunning: true, autoAttempts: 9, hidden: true }).reason, "probe-running");
    assert.equal(gate({ autoAttempts: 9, hidden: true }).reason, "attempts-exhausted");
  });
});

describe("redaction", () => {
  const SENSITIVE = [
    "accessToken", "access_token", "refreshToken", "Authorization", "authorization", "password", "clientSecret", "cookie",
    "sessionId", "session_id", "userId", "user_id", "username", "email", "emailAddress", "displayName", "display_name",
    "accountId", "deviceId", "device_name", "deviceName", "clientId", "id", "ID", "playbackId", "trackUri", "context_uri",
    "country", "ip", "ipAddress", "uuid", "apiKey", "api_key", "signature", "phone", "owner", "premium", "product", "href", "referrer",
    "__proto__", "constructor", "prototype",
  ];
  const SAFE = ["bitrateLevel", "bitrate_level", "hifiStatus", "hifi_status", "strategy", "targetBitrateLevel", "target_bitrate_available", "targetBitrateAvailable", "valid", "paid", "grid", "identity", "width"];

  for (const key of SENSITIVE) it(`treats key ${key} as sensitive`, () => assert.equal(lib.isSensitiveKey(key), true));
  for (const key of SAFE) it(`keeps key ${key}`, () => assert.equal(lib.isSensitiveKey(key), false));

  it("passes a real-looking quality object through unchanged", () => {
    const quality = { bitrateLevel: 5, hifiStatus: 2, strategy: "BITRATE_STRATEGY_BEST_MATCHING", targetBitrateLevel: 5, targetBitrateAvailable: true };
    assert.deepEqual(lib.redact(quality), quality);
  });
  it("redacts sensitive keys at any depth and inside arrays, without mutating the input", () => {
    const input = Object.freeze({ bitrateLevel: 4, nested: Object.freeze({ accessToken: "t", ok: 1, list: Object.freeze([Object.freeze({ userId: "u1", n: 2 })]) }) });
    const out = lib.redact(input);
    assert.deepEqual(out, { bitrateLevel: 4, nested: { accessToken: "[REDACTED]", ok: 1, list: [{ userId: "[REDACTED]", n: 2 }] } });
    assert.equal(input.nested.accessToken, "t");
  });
  it("redacts token-like values stored under innocent keys", () => {
    const secrets = {
      bearer: "Bearer abc.def-ghi_123", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sigPart_123",
      email: "someone@example.com", user: "spotify:user:alice123", url: "https://open.spotify.com/user/alice123?si=1",
      hex: "0123456789abcdef0123456789abcdef01234567",
    };
    const out = lib.redact(Object.fromEntries(Object.entries(secrets).map(([k, v]) => [`note_${k}`, v])));
    const serialised = JSON.stringify(out);
    for (const needle of ["abc.def-ghi_123", "eyJzdWIi", "someone@example.com", "alice123", "0123456789abcdef0123456789abcdef"]) {
      assert.ok(!serialised.includes(needle), `${needle} leaked: ${serialised}`);
    }
  });
  it("truncates very long strings", () => {
    const out = lib.redactString("ab ".repeat(200));
    assert.ok(out.length < 260 && out.endsWith("...[truncated]"));
  });
  it("bounds arrays, keys and depth, and survives cycles", () => {
    assert.equal(lib.redact(Array.from({ length: 30 }, (_, i) => i)).length, 21);
    assert.deepEqual(lib.redact(Array.from({ length: 30 }, (_, i) => i)).at(-1), "[+10 more]");
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    const outWide = lib.redact(wide);
    assert.equal(Object.keys(outWide).length, 51);
    assert.equal(outWide["[truncated]"], true);
    let deep = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    assert.ok(JSON.stringify(lib.redact(deep)).includes("[MaxDepth]"));
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.deepEqual(lib.redact(cyclic), { a: 1, self: "[Circular]" });
  });
  it("does not mislabel repeated (non-cyclic) references as circular", () => {
    const shared = { n: 1 };
    assert.deepEqual(lib.redact({ x: shared, y: shared }), { x: { n: 1 }, y: { n: 1 } });
  });
  it("handles odd primitives", () => {
    assert.deepEqual(lib.redact({ big: 5n, sym: Symbol("s"), fn() {}, nan: Number.NaN, nothing: undefined, nil: null }),
      { big: "5n", sym: "[Symbol]", fn: "[Function]", nan: "NaN", nothing: undefined, nil: null });
  });
  it("never throws on hostile objects", () => {
    const throwingGetter = { ok: 1, get bad() { throw new Error("getter"); } };
    assert.equal(lib.redact(throwingGetter), "[Unreadable]");
    assert.deepEqual(lib.redact({ fine: 1, inner: throwingGetter }), { fine: 1, inner: "[Unreadable]" });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
    assert.equal(lib.redact(proxy), "[Unreadable]");
  });
  it("shortUri keeps only the type and the last 4 characters of a track/episode id", () => {
    assert.equal(lib.shortUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC"), "track:...KUQC");
    assert.equal(lib.shortUri("spotify:episode:abc123"), "episode:...c123");
    assert.equal(lib.shortUri("spotify:playlist:37i9dQZF1DX"), "playlist:[REDACTED]");
    assert.equal(lib.shortUri("spotify:user:alice:playlist:xyz"), "user:[REDACTED]");
    assert.equal(lib.shortUri("spotify:local:Artist:Album:Title:1"), "local:[REDACTED]");
    assert.equal(lib.shortUri("spotify:track:has space"), "track:[REDACTED]");
    assert.equal(lib.shortUri("spotify:track:abc"), "track:[REDACTED]");
    assert.equal(lib.shortUri("not a uri"), "unknown:[REDACTED]");
    for (const value of [null, undefined, 5, {}]) assert.equal(lib.shortUri(value), null);
  });
});

describe("buildHideCss", () => {
  it("scopes every selector under the probe class and hides without display:none", () => {
    const css = lib.buildHideCss("probing", ['[data-testid="a"]', '[role="dialog"]']);
    assert.ok(css.includes('html.probing [data-testid="a"],\nhtml.probing [role="dialog"] {'));
    for (const declaration of ["opacity: 0 !important", "visibility: hidden !important", "pointer-events: none !important", "clip-path: inset(100%) !important", "transition: none !important", "animation: none !important"]) {
      assert.ok(css.includes(declaration), declaration);
    }
    assert.ok(!css.includes("display"));
  });
  it("rejects invalid class names", () => {
    for (const name of ["", "1abc", "a b", "a{b}", "a;b", "a>b"]) assert.throws(() => lib.buildHideCss(name, ["x"]), lib.AudioQualityError);
  });
  it("rejects an empty selector list", () => assert.throws(() => lib.buildHideCss("ok", []), { code: "NO_SELECTORS" }));
  it("refuses selectors that could break out of the rule", () => {
    for (const selector of ["", "a{color:red}", "a}b", "<style>", "a>b<c"]) assert.throws(() => lib.buildHideCss("ok", [selector]), { code: "BAD_SELECTOR" });
  });
  it("only ever builds from the shipped panel selectors without throwing", () => {
    assert.doesNotThrow(() => lib.buildHideCss(lib.IDS.hideClass, lib.SELECTORS.panel));
  });
});

describe("getSpicetify", () => {
  const valid = { Player: { addEventListener() {} } };
  it("returns the object when the members this file needs exist", () => assert.equal(lib.getSpicetify({ Spicetify: valid }), valid));
  for (const [label, scope] of [
    ["non-object scope", 5], ["null scope", null], ["no Spicetify", {}], ["Spicetify not an object", { Spicetify: "x" }],
    ["no Player", { Spicetify: {} }], ["Player without addEventListener", { Spicetify: { Player: {} } }],
    ["addEventListener not a function", { Spicetify: { Player: { addEventListener: 1 } } }],
  ]) {
    it(`returns undefined for ${label}`, () => assert.equal(lib.getSpicetify(scope), undefined));
  }
});

describe("error classes", () => {
  it("AudioQualityError carries a code and a cause", () => {
    const cause = new Error("inner");
    const error = new lib.AudioQualityError("X", "outer", { cause });
    assert.equal(error.name, "AudioQualityError");
    assert.equal(error.code, "X");
    assert.equal(error.cause, cause);
    assert.ok(error instanceof Error);
  });
  it("ProbeError carries a reason and a cause", () => {
    const cause = new Error("inner");
    const error = new lib.ProbeError("no-trigger", "outer", { cause });
    assert.equal(error.name, "ProbeError");
    assert.equal(error.reason, "no-trigger");
    assert.equal(error.cause, cause);
  });
});

describe("createDefaultEnv", () => {
  it("builds a monotonic clock, working timers and a trusted-event check", () => {
    const env = lib.createDefaultEnv();
    const a = env.now();
    const b = env.now();
    assert.ok(typeof a === "number" && b >= a);
    assert.equal(env.isUserEvent({ isTrusted: true }), true);
    assert.equal(env.isUserEvent({ isTrusted: false }), false);
    return new Promise((resolve) => {
      const handle = env.timers.setTimeout(() => resolve(), 1);
      assert.ok(handle !== undefined);
    }).then(() => {
      const interval = env.timers.setInterval(() => {}, 1000);
      env.timers.clearInterval(interval);
      env.timers.clearTimeout(env.timers.setTimeout(() => {}, 1000));
    });
  });
});

describe("redaction hardening (security review fixes S1, S2, S3, S6)", () => {
  it("S1: a huge string cannot make redaction slow (was 4 s for 80 000 characters)", () => {
    for (const hostile of ["a".repeat(80_000), "a.".repeat(40_000), "a-".repeat(40_000), "eyJ".repeat(30_000), "Bearer ".repeat(10_000)]) {
      const started = performance.now();
      const out = lib.redactString(hostile);
      assert.ok(performance.now() - started < 100, `took ${(performance.now() - started).toFixed(0)} ms for ${hostile.slice(0, 8)}...`);
      assert.ok(out.endsWith("...[truncated]") && out.length < 260);
    }
  });
  it("S1: still redacts an e-mail address or token inside the scanned prefix of a long string", () => {
    const out = lib.redactString(`me@example.com ${"x ".repeat(5000)}`);
    assert.ok(!out.includes("me@example.com"));
    assert.ok(out.startsWith("[REDACTED]"));
  });
  it("S1: the e-mail pattern is bounded (no match on absurd local parts, no quadratic scan)", () => {
    const started = performance.now();
    lib.redactString("a".repeat(2_000) + "@" + "b".repeat(2_000));
    assert.ok(performance.now() - started < 50);
  });
  it("S2: an own __proto__ key cannot swap the prototype of the redacted copy", () => {
    const out = lib.redact(JSON.parse('{"__proto__": {"polluted": true}, "bitrateLevel": 5}'));
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.polluted, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__").value, "[REDACTED]");
    assert.equal(out.bitrateLevel, 5);
    assert.equal(({}).polluted, undefined);
  });
  it("S3: summarizeQuality prints known keys by value and everything else by name and type only", () => {
    const summary = lib.summarizeQuality({
      bitrateLevel: 5, hifi_status: "ON", strategy: "BITRATE_STRATEGY_BEST", targetBitrateAvailable: true,
      hostLabel: "Alices-Gaming-PC", note: "Alice iPhone 15", accessToken: "SECRET", nested: { a: 1 }, list: [1], nothing: null,
    });
    assert.deepEqual(summary.values, { bitrateLevel: 5, hifi_status: "ON", strategy: "BITRATE_STRATEGY_BEST", targetBitrateAvailable: true });
    assert.deepEqual(summary.otherKeys, [
      { key: "hostLabel", type: "string" }, { key: "note", type: "string" }, { key: "accessToken", type: "string" },
      { key: "nested", type: "object" }, { key: "list", type: "array" }, { key: "nothing", type: "null" },
    ]);
    assert.ok(!JSON.stringify(summary).match(/Alice|SECRET/));
  });
  it("S3: a known key never prints a value that looks like a secret, a sentence, or a structure", () => {
    const summary = lib.summarizeQuality({
      strategy: `sk_live_${"x".repeat(40)}`, hifiStatus: "two words", bitrateLevel: { nested: 1 }, targetBitrateLevel: "a@b.co", hifi_status: Number.NaN,
    });
    assert.deepEqual(summary.values, {});
    assert.equal(summary.otherKeys.length, 5);
  });
  it("S3: odd key names are not echoed and the key count is bounded", () => {
    const odd = lib.summarizeQuality({ "key with spaces & symbols!": 1, ["x".repeat(80)]: 2 });
    assert.deepEqual(odd.otherKeys.map((k) => k.key), ["[odd key]", "[odd key]"]);
    const wide = lib.summarizeQuality(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])));
    assert.equal(wide.otherKeys.length, 50);
  });
  it("S3: non-objects give null and hostile objects throw into the caller's guard, never hang", () => {
    for (const value of [null, undefined, 5, "x", true]) assert.equal(lib.summarizeQuality(value), null);
    const hostile = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
    assert.throws(() => lib.summarizeQuality(hostile), /trap/);
  });
});
