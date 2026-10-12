// @ts-check
/**
 * Spicetify extension: playback-quality pill.
 *
 * A small pill at the bottom centre of the Spotify window shows the current quality:
 *   "Lossless 24-bit" | "Lossless 16-bit" | "Lossless (checking...)" | "Lossless"
 *   "Very High (~320 kbps)" | "High (~160 kbps)" | "Normal (~96 kbps)" | "Low (~24 kbps)"
 *   "Quality unknown"
 *
 * Install: copy to Spicetify's Extensions folder, then
 *   spicetify config extensions audio-quality.js && spicetify apply
 * Reloading (re-evaluating this file) tears the previous instance down first.
 * Manual teardown from DevTools: globalThis.audioQualityCleanup()
 *
 * STATUS: exercised only against MOCKED Spicetify globals and a jsdom DOM. Anything marked
 * UNVERIFIED depends on the live Spotify client and has not been run against it.
 * One-switch fallbacks: set PROBE_ENABLED to false to turn the device-panel probe off entirely
 * (the pill then shows plain "Lossless" for lossless playback and never touches the panel).
 *
 * No network access, no eval / new Function, no innerHTML, no localStorage, no synthetic key events.
 * The file creates two DOM elements (the pill and one <style> element). It touches Spotify's own DOM in
 * exactly two ways: one class on <html> (added and removed with classList), and synthetic clicks
 * (HTMLElement.click(), never key events) on the device-panel trigger and on the panel's own close
 * control - plus, only if CLICK_ACTIVE_DEVICE_ROW is switched on, on the device row already marked
 * active. Spotify's own code reacts to those clicks (it mounts/unmounts the panel and updates
 * aria-expanded). Inline styles on Spotify's elements are never written.
 */

/** @typedef {16 | 24} BitDepth */
/** @typedef {"LOW" | "NORMAL" | "HIGH" | "VERY_HIGH"} LossyTier */
/** @typedef {LossyTier | "HIFI" | "HIFI24"} BitrateLevelName */
/** @typedef {"NONE" | "OFF" | "ON"} HifiStatusName */

/**
 * Discriminated union describing what the player state says about quality.
 * @typedef {{ kind: "unknown" }
 *   | { kind: "lossy", tier: LossyTier }
 *   | { kind: "lossless", level: "HIFI" | "HIFI24" | null }} Quality
 */

/**
 * @typedef {{ kind: "known", bits: BitDepth }
 *   | { kind: "checking" }
 *   | { kind: "unreadable" }} DepthState
 */

/** @typedef {{ text: string, tone: "lossless" | "lossy" | "unknown" }} PillView */

/**
 * @typedef {object} Snapshot
 * @property {string | null} uri            Current track URI, if one could be read.
 * @property {Quality} quality
 * @property {string | null} source         Which state source supplied the quality ("Player.data" ...).
 * @property {unknown} rawQuality           The raw quality object (only ever logged after redaction).
 */

/**
 * @typedef {object} TrackRecord
 * @property {BitDepth | null} depth
 * @property {number} autoAttempts          Automatic probes STARTED for this track.
 * @property {number | null} lastProbeEndedAt
 * @property {string | null} lastResult
 */

/** @typedef {"auto" | "manual"} ProbeKind */
/** @typedef {"no-trigger" | "panel-already-open" | "modal-open" | "hide-ineffective" | "panel-timeout"
 *   | "panel-vanished" | "no-device-row" | "device-not-active" | "ambiguous-depth" | "depth-timeout"
 *   | "exception"} ProbeReason */
/** @typedef {"track-changed" | "hidden" | "user-input" | "cleanup" | "fullscreen-change" | "watchdog"} AbortReason */
/** @typedef {{ status: "depth", bits: BitDepth }
 *   | { status: "unreadable", reason: ProbeReason }
 *   | { status: "aborted", reason: AbortReason }} ProbeOutcome */

/**
 * @typedef {object} Limits
 * @property {number} cacheCapacity
 * @property {number} maxAutoProbesPerTrack
 * @property {number} minGapSameTrackMs
 * @property {number} minGapAnyMs
 * @property {number} trackChangeSettleMs
 * @property {number} pollIntervalMs
 * @property {number} panelWaitMs
 * @property {number} depthSearchMs
 * @property {number} closeWaitMs
 * @property {number} probeWatchdogMs
 * @property {number} updateMinIntervalMs
 * @property {number} observerThrottleMs
 * @property {number} heartbeatMs
 * @property {number} typingRetryMs
 * @property {number} spicetifyWaitMs
 * @property {number} spicetifyMaxWaits
 */

/**
 * @typedef {object} RuntimeConfig
 * @property {boolean} probeEnabled
 * @property {boolean} clickActiveDeviceRow
 * @property {boolean} reclickTriggerToClose
 * @property {Partial<Limits>} limits
 */

/**
 * @typedef {object} SpicetifyLike
 * @property {{ addEventListener: (type: string, cb: () => void) => void,
 *              removeEventListener?: (type: string, cb: () => void) => void,
 *              data?: unknown }} Player
 * @property {{ PlayerAPI?: { _state?: unknown } }} [Platform]
 * @property {(message: string, isError?: boolean, msTimeout?: number) => void} [showNotification]
 */

/**
 * @typedef {object} TimerApi
 * @property {(callback: () => void, delayMs: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {(callback: () => void, periodMs: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 */

/** @typedef {Pick<Console, "log" | "warn" | "debug">} ConsoleLike */

/** @typedef {Window & typeof globalThis & { audioQualityCleanup?: () => void }} HostWindow */

/**
 * @typedef {object} ExtensionEnv
 * @property {Document} doc
 * @property {HostWindow} win
 * @property {() => SpicetifyLike | undefined} getSpicetify
 * @property {() => number} now                 Monotonic milliseconds.
 * @property {TimerApi} timers
 * @property {ConsoleLike} console
 * @property {(event: Event) => boolean} isUserEvent
 * @property {Partial<RuntimeConfig>} [config]
 */

/**
 * @typedef {object} ExtensionState
 * @property {boolean} started
 * @property {boolean} disposed
 * @property {boolean} probeRunning
 * @property {string | null} probePhase
 * @property {number} pendingTimers
 * @property {number} domListeners
 * @property {number} playerListeners
 * @property {number} cacheSize
 * @property {string | null} probeDisabledReason
 * @property {boolean} pillMounted
 */

/**
 * @typedef {object} Extension
 * @property {() => void} start
 * @property {() => void} cleanup
 * @property {() => ExtensionState} getState
 * @property {(uri: string) => TrackRecord | undefined} peekRecord
 */

/**
 * @typedef {object} TimerSet
 * @property {(fn: () => void, delayMs: number) => number} after
 * @property {(fn: () => void, periodMs: number) => number} every
 * @property {(id: number) => void} cancel
 * @property {() => void} cancelAll
 * @property {() => number} pendingCount
 */

/**
 * @typedef {object} ListenerSet
 * @property {(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => void} add
 * @property {() => void} removeAll
 * @property {() => number} size
 */

/**
 * @typedef {object} ActiveProbe
 * @property {string} uri
 * @property {"opening" | "reading" | "closing"} phase
 * @property {HTMLElement} trigger
 * @property {HTMLElement | null} panel
 * @property {number} startedAt
 * @property {number} phaseStartedAt
 * @property {number | null} clickedAt
 * @property {number} pollTimer
 * @property {number} watchdogTimer
 * @property {ProbeOutcome | null} outcome
 * @property {boolean} rowClicked
 * @property {boolean} triggerReclicked
 * @property {boolean} closeAttempted
 * @property {boolean} ended
 * @property {HTMLElement | null} previousFocus  Element that had focus before the probe's click.
 * @property {MutationObserver | null} classWatcher  Re-applies the hide class if page code drops it.
 */

/**
 * @typedef {object} GateInput
 * @property {number} now
 * @property {boolean} hidden
 * @property {boolean} probeRunning
 * @property {number | null} lastTrackChangeAt
 * @property {number | null} lastAnyProbeEndedAt
 * @property {number | null} lastTrackProbeEndedAt
 * @property {number} autoAttempts
 * @property {ProbeKind} kind
 * @property {boolean} [typing]  An editable control has focus.
 * @property {Limits} [limits]
 */

/**
 * @typedef {{ ok: true }
 *   | { ok: false,
 *       reason: "probe-running" | "attempts-exhausted" | "hidden" | "user-typing" | "settling" | "rate-limited-global" | "rate-limited-track",
 *       retryAfterMs: number | null }} GateResult
 */

(function audioQualityExtension() {
  "use strict";

  // ===========================================================================
  // 1. Constants
  // ===========================================================================

  const IDS = /** @type {const} */ ({
    pill: "spicetify-audio-quality-pill",
    style: "spicetify-audio-quality-style",
    hideClass: "spicetify-audio-quality-probing",
  });

  const GLOBAL_CLEANUP_KEY = "audioQualityCleanup";
  const LOG_PREFIX = "[AudioQuality]";
  const DEFAULT_BOTTOM_OFFSET_PX = 104;

  /** Kill switch: false = never touch the device panel. */
  const PROBE_ENABLED = true;

  /**
   * UNVERIFIED. If true, the probe also clicks the "This computer" row, but only when that row is
   * already marked active. Off by default: reading text from the open panel should not need a click,
   * and a click on a device row is the one probe action that could conceivably affect playback.
   */
  const CLICK_ACTIVE_DEVICE_ROW = false;

  /** If the panel has no close control, click the trigger (the control used to open it) once more. */
  const RECLICK_TRIGGER_TO_CLOSE = true;

  /** @type {Readonly<Limits>} */
  const DEFAULT_LIMITS = Object.freeze({
    cacheCapacity: 100,
    maxAutoProbesPerTrack: 3,
    minGapSameTrackMs: 5000,
    minGapAnyMs: 1500,
    trackChangeSettleMs: 700,
    pollIntervalMs: 100,
    panelWaitMs: 1500,
    depthSearchMs: 2000,
    closeWaitMs: 1000,
    probeWatchdogMs: 7000,
    updateMinIntervalMs: 100,
    observerThrottleMs: 250,
    heartbeatMs: 5000,
    typingRetryMs: 1000,
    spicetifyWaitMs: 100,
    spicetifyMaxWaits: 600,
  });

  /**
   * ALL SELECTORS BELOW ARE UNVERIFIED GUESSES against the live client. They are centralised so a
   * tester can adjust them in one place. A wrong TRIGGER, close, row or modal selector degrades to a
   * plain "Lossless" with no UI action. A wrong PANEL selector is the one case that can still show the
   * real panel: it stays visible until the probe notices it cannot see it (about 1.5 s), at most twice,
   * after which the probe disables itself for the session. Other self-checks: the hide rule must be
   * active before any click, and the panel must compute as hidden on every poll.
   */
  const SELECTORS = /** @type {const} */ ({
    trigger: ['button[data-testid="device-picker-icon-button"]', 'button[aria-label="Connect to a device"]'],
    panel: ['[data-testid="device-picker"]', '[role="dialog"][aria-label="Connect to a device"]'],
    close: ['button[aria-label="Close"]', 'button[data-testid="close-button"]'],
    row: ['[role="listitem"]', '[role="menuitem"]', '[role="option"]', "li", "button"],
    nowPlayingBar: ['[data-testid="now-playing-bar"]', ".Root__now-playing-bar", "footer"],
    modal: ['[role="dialog"][aria-modal="true"]', "dialog[open]"],
  });

  /** UNVERIFIED: English UI text of the device row. Non-English clients fail safe (no probe result). */
  // No trailing \b: textContent joins sibling elements without whitespace ("This computerLossless 24-bit").
  const THIS_COMPUTER_RE = /\bThis computer/i;
  /** UNVERIFIED: text that may mark the active row, in addition to ARIA/data attributes. */
  const ACTIVE_TEXT_RE = /\b(?:current device|listening on)/i;
  /** Attribute/value pairs that mark a device row as the active one (besides aria-current). UNVERIFIED. */
  const ACTIVE_ATTRIBUTE_VALUES = /** @type {const} */ ([
    ["aria-selected", "true"],
    ["aria-checked", "true"],
    ["data-active", "true"],
    ["data-is-active", "true"],
  ]);
  const ACTIVE_ATTRIBUTE_SELECTOR = "[aria-current],[aria-selected],[aria-checked],[data-active],[data-is-active]";
  /** Bit depth as shown in the device panel, e.g. "Lossless 24-bit/44.1 kHz". */
  const DEPTH_RE = /Lossless\s+(16|24)-bit/g;
  const MAX_TEXT_SCAN = 100_000;

  /** @type {Readonly<Record<LossyTier, { label: string, kbps: number }>>} */
  const LOSSY_TIERS = Object.freeze({
    LOW: { label: "Low", kbps: 24 },
    NORMAL: { label: "Normal", kbps: 96 },
    HIGH: { label: "High", kbps: 160 },
    VERY_HIGH: { label: "Very High", kbps: 320 },
  });

  /** Index = numeric BitrateLevel code. 0 (unknown) maps to null. */
  const LEVEL_BY_CODE = /** @type {const} */ ([null, "LOW", "NORMAL", "HIGH", "VERY_HIGH", "HIFI", "HIFI24"]);
  /** @type {Readonly<Record<string, BitrateLevelName>>} */
  const LEVEL_BY_TOKEN = Object.freeze({
    LOW: "LOW",
    NORMAL: "NORMAL",
    HIGH: "HIGH",
    VERYHIGH: "VERY_HIGH",
    HIFI: "HIFI",
    HIFI24: "HIFI24",
  });
  const HIFI_BY_CODE = /** @type {const} */ (["NONE", "OFF", "ON"]);
  /** @type {Readonly<Record<string, HifiStatusName>>} */
  const HIFI_BY_TOKEN = Object.freeze({ NONE: "NONE", OFF: "OFF", ON: "ON" });

  const NON_CONTAINER_TAGS = new Set(["VIDEO", "IFRAME", "CANVAS", "IMG", "AUDIO", "OBJECT", "EMBED"]);
  const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"]);
  const REDACTED = "[REDACTED]";

  // ===========================================================================
  // 2. Errors
  // ===========================================================================

  class AudioQualityError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(code, message, options) {
      super(message, options);
      this.name = "AudioQualityError";
      /** @type {string} */
      this.code = code;
    }
  }

  class ProbeError extends Error {
    /**
     * @param {ProbeReason} reason
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(reason, message, options) {
      super(message, options);
      this.name = "ProbeError";
      /** @type {ProbeReason} */
      this.reason = reason;
    }
  }

  // ===========================================================================
  // 3. Pure helpers (unit-tested; no DOM, no globals)
  // ===========================================================================

  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  /**
   * @param {unknown} value
   * @returns {value is Node}
   */
  function isNodeLike(value) {
    return isRecord(value) && typeof value.nodeType === "number";
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function describeError(error) {
    if (error instanceof Error) {
      const cause = error.cause instanceof Error ? ` (cause: ${error.cause.name}: ${error.cause.message})` : "";
      return `${error.name}: ${error.message}${cause}`;
    }
    return typeof error === "string" ? error : Object.prototype.toString.call(error);
  }

  /**
   * Upper-cases and strips separators so "very_high", "Very High", "VeryHigh" all become "VERYHIGH".
   * @param {unknown} raw
   * @returns {string | null}
   */
  function normalizeEnumToken(raw) {
    if (typeof raw !== "string") return null;
    const token = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return token.length > 0 && token.length <= 40 ? token : null;
  }

  /**
   * Decodes a numeric code (an index into `byCode`) or an enum name (looked up in `byToken` once separators
   * and `prefix` are stripped). Anything else, including code 0 and out-of-range numbers, is null.
   * @template {string} N
   * @param {unknown} raw
   * @param {ReadonlyArray<N | null>} byCode
   * @param {Readonly<Record<string, N>>} byToken
   * @param {RegExp} prefix
   * @returns {N | null}
   */
  function parseEnum(raw, byCode, byToken, prefix) {
    if (typeof raw === "number") return Number.isInteger(raw) ? (byCode[raw] ?? null) : null;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (/^\d{1,2}$/.test(trimmed)) return parseEnum(Number(trimmed), byCode, byToken, prefix);
    const token = normalizeEnumToken(trimmed)?.replace(prefix, "") ?? null;
    return token !== null && Object.hasOwn(byToken, token) ? (byToken[token] ?? null) : null;
  }

  /**
   * Maps a numeric code (1..6) or enum string to a level name. 0 / unknown / garbage -> null.
   * @param {unknown} raw
   * @returns {BitrateLevelName | null}
   */
  function parseBitrateLevel(raw) {
    return parseEnum(raw, LEVEL_BY_CODE, LEVEL_BY_TOKEN, /^BITRATELEVEL/);
  }

  /**
   * Maps a numeric code (0..2) or enum string to a status name.
   * @param {unknown} raw
   * @returns {HifiStatusName | null}
   */
  function parseHifiStatus(raw) {
    return parseEnum(raw, HIFI_BY_CODE, HIFI_BY_TOKEN, /^HIFISTATUS/);
  }

  /**
   * Rule: the bitrate level is authoritative for what is playing now. hifiStatus ON only fills in
   * when the level is absent/unrecognised. Rationale: a false "Lossless" is worse than a false lossy
   * label for a tool whose purpose is to report quality.
   * @param {BitrateLevelName | null} level
   * @param {HifiStatusName | null} hifi
   * @returns {Quality}
   */
  function classifyQuality(level, hifi) {
    if (level === "HIFI" || level === "HIFI24") return { kind: "lossless", level };
    if (level !== null) return { kind: "lossy", tier: level };
    if (hifi === "ON") return { kind: "lossless", level: null };
    return { kind: "unknown" };
  }

  /**
   * @param {Quality} quality
   * @param {DepthState} depth
   * @returns {PillView}
   */
  function describePill(quality, depth) {
    switch (quality.kind) {
      case "lossless":
        if (depth.kind === "known") return { text: `Lossless ${depth.bits}-bit`, tone: "lossless" };
        if (depth.kind === "checking") return { text: "Lossless (checking...)", tone: "lossless" };
        return { text: "Lossless", tone: "lossless" };
      case "lossy": {
        const tier = LOSSY_TIERS[quality.tier];
        return { text: `${tier.label} (~${tier.kbps} kbps)`, tone: "lossy" };
      }
      default:
        return { text: "Quality unknown", tone: "unknown" };
    }
  }

  const URI_RE = /^spotify:[a-z_]+:\S{1,190}$/;

  /**
   * state.item.uri, then state.track.uri.
   * @param {unknown} state
   * @returns {string | null}
   */
  function extractTrackUri(state) {
    if (!isRecord(state)) return null;
    for (const key of /** @type {const} */ (["item", "track"])) {
      const holder = state[key];
      if (isRecord(holder) && typeof holder.uri === "string" && URI_RE.test(holder.uri)) return holder.uri;
    }
    return null;
  }

  /**
   * Reads playbackQuality / playback_quality and the level / status fields in either spelling.
   * @param {unknown} state
   * @returns {{ level: BitrateLevelName | null, hifi: HifiStatusName | null, raw: unknown } | null}
   */
  function extractQualityFields(state) {
    if (!isRecord(state)) return null;
    const raw = state.playbackQuality ?? state.playback_quality;
    if (!isRecord(raw)) return null;
    return {
      level: parseBitrateLevel(raw.bitrateLevel ?? raw.bitrate_level),
      hifi: parseHifiStatus(raw.hifiStatus ?? raw.hifi_status),
      raw,
    };
  }

  /**
   * Reads each state source in order; every access is guarded. Falls back to "unknown".
   * @param {ReadonlyArray<{ name: string, read: () => unknown }>} sources
   * @param {(name: string, error: unknown) => void} [onError]
   * @returns {Snapshot}
   */
  function readSnapshot(sources, onError) {
    /** @type {Snapshot | null} */
    let firstWithUri = null;
    for (const { name, read } of sources) {
      try {
        const state = read();
        const uri = extractTrackUri(state);
        const fields = extractQualityFields(state);
        const quality = fields ? classifyQuality(fields.level, fields.hifi) : /** @type {Quality} */ ({ kind: "unknown" });
        /** @type {Snapshot} */
        const candidate = { uri, quality, source: name, rawQuality: fields?.raw };
        if (quality.kind !== "unknown") return candidate;
        if (uri !== null && firstWithUri === null) firstWithUri = candidate;
      } catch (error) {
        onError?.(name, error);
      }
    }
    return firstWithUri ?? { uri: null, quality: { kind: "unknown" }, source: null, rawQuality: undefined };
  }

  /**
   * @param {unknown} text
   * @returns {{ kind: "none" } | { kind: "depth", bits: BitDepth } | { kind: "ambiguous" }}
   */
  function extractDepthFromText(text) {
    if (typeof text !== "string" || text.length === 0) return { kind: "none" };
    const bounded = text.length > MAX_TEXT_SCAN ? text.slice(0, MAX_TEXT_SCAN) : text;
    const found = new Set();
    for (const match of bounded.matchAll(DEPTH_RE)) found.add(match[1]);
    if (found.size === 0) return { kind: "none" };
    if (found.size > 1) return { kind: "ambiguous" };
    return { kind: "depth", bits: found.has("24") ? 24 : 16 };
  }

  /**
   * Bounded least-recently-used cache keyed by track URI.
   * @template {string} K
   * @template {object} V
   */
  class LruCache {
    #map = /** @type {Map<K, V>} */ (new Map());
    #capacity;

    /** @param {number} capacity */
    constructor(capacity) {
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new RangeError(`LruCache capacity must be a positive integer, got ${String(capacity)}`);
      }
      this.#capacity = capacity;
    }

    /** @returns {number} */
    get size() {
      return this.#map.size;
    }

    /**
     * Returns the value and marks it most recently used.
     * @param {K} key
     * @returns {V | undefined}
     */
    get(key) {
      const value = this.#map.get(key);
      if (value === undefined) return undefined;
      this.#map.delete(key);
      this.#map.set(key, value);
      return value;
    }

    /**
     * Returns the value without changing recency.
     * @param {K} key
     * @returns {V | undefined}
     */
    peek(key) {
      return this.#map.get(key);
    }

    /**
     * @param {K} key
     * @param {V} value
     * @returns {this}
     */
    set(key, value) {
      this.#map.delete(key);
      this.#map.set(key, value);
      while (this.#map.size > this.#capacity) {
        const oldest = this.#map.keys().next();
        if (oldest.done) break;
        this.#map.delete(oldest.value);
      }
      return this;
    }

    /**
     * @param {K} key
     * @returns {boolean}
     */
    has(key) {
      return this.#map.has(key);
    }

    /**
     * @param {K} key
     * @returns {boolean}
     */
    delete(key) {
      return this.#map.delete(key);
    }

    /** @returns {void} */
    clear() {
      this.#map.clear();
    }

    /** @returns {K[]} Oldest first. */
    keys() {
      return [...this.#map.keys()];
    }
  }

  /**
   * @param {number} now
   * @param {number | null} since
   * @param {number} windowMs
   * @returns {number} Milliseconds still to wait, clamped to [0, windowMs] so a backwards clock cannot stall.
   */
  function remainingWait(now, since, windowMs) {
    if (since === null) return 0;
    return Math.min(windowMs, Math.max(0, windowMs - (now - since)));
  }

  /**
   * Pure rate limiter / precondition gate for starting a probe.
   * retryAfterMs === null means "no timer will help; wait for an event" (hidden, busy, exhausted).
   * @param {GateInput} input
   * @returns {GateResult}
   */
  function checkProbeGate(input) {
    const limits = input.limits ?? DEFAULT_LIMITS;
    if (input.probeRunning) return { ok: false, reason: "probe-running", retryAfterMs: null };
    if (input.kind === "auto" && input.autoAttempts >= limits.maxAutoProbesPerTrack) {
      return { ok: false, reason: "attempts-exhausted", retryAfterMs: null };
    }
    if (input.hidden) return { ok: false, reason: "hidden", retryAfterMs: null };
    if (input.typing === true) return { ok: false, reason: "user-typing", retryAfterMs: limits.typingRetryMs };
    const settle = remainingWait(input.now, input.lastTrackChangeAt, limits.trackChangeSettleMs);
    const global = remainingWait(input.now, input.lastAnyProbeEndedAt, limits.minGapAnyMs);
    const sameTrack = remainingWait(input.now, input.lastTrackProbeEndedAt, limits.minGapSameTrackMs);
    const wait = Math.max(settle, global, sameTrack);
    if (wait <= 0) return { ok: true };
    const reason = wait === sameTrack ? "rate-limited-track" : wait === global ? "rate-limited-global" : "settling";
    return { ok: false, reason, retryAfterMs: Math.ceil(wait) };
  }

  // ---- redaction ------------------------------------------------------------

  const SENSITIVE_KEY_RE =
    /token|secret|passw|auth|bearer|cookie|session|credential|api[-_]?key|private|signature|e[-_]?mail|phone|user|owner|account|display[-_]?name|device|uuid|guid|(?:^|[-_])ids?$|^ip$|ip[-_]?addr|country|market|locale|birth|geo|location|premium|product|subscription|uri|url|href|referrer|origin|context/i;
  const CAMEL_ID_KEY_RE = /[a-z0-9]Ids?$/;

  /** @type {ReadonlyArray<RegExp>} */
  const SENSITIVE_VALUE_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
    /spotify:(?:user|collection):[^\s:]+/gi,
    /(?:open\.spotify\.com)?\/user\/[A-Za-z0-9_.~%-]+/gi,
    /\b[A-Za-z0-9_+/=-]{32,}\b/g,
  ];

  const REDACT_LIMITS = Object.freeze({ maxDepth: 6, maxKeys: 50, maxItems: 20, maxString: 200, maxScan: 2048 });
  const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  /** Keys of the quality object that are logged by value; every other key is logged by name and type only. */
  const QUALITY_KEYS_PRINTED = new Set([
    "bitrateLevel", "bitrate_level", "hifiStatus", "hifi_status", "strategy",
    "targetBitrateLevel", "target_bitrate_level", "targetBitrateAvailable", "target_bitrate_available",
  ]);
  const SAFE_ENUM_VALUE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
  const SAFE_KEY_NAME_RE = /^[A-Za-z0-9_]{1,40}$/;

  /**
   * @param {string} key
   * @returns {boolean}
   */
  function isSensitiveKey(key) {
    return SENSITIVE_KEY_RE.test(key) || CAMEL_ID_KEY_RE.test(key) || key.toLowerCase() === "id" || PROTO_KEYS.has(key);
  }

  /**
   * Bounded first (a long string must not make the regexes below do quadratic work), then redacted.
   * @param {string} value
   * @returns {string}
   */
  function redactString(value) {
    const clipped = value.length > REDACT_LIMITS.maxScan;
    let result = clipped ? value.slice(0, REDACT_LIMITS.maxScan) : value;
    for (const pattern of SENSITIVE_VALUE_PATTERNS) result = result.replace(pattern, REDACTED);
    return clipped || result.length > REDACT_LIMITS.maxString ? `${result.slice(0, REDACT_LIMITS.maxString)}...[truncated]` : result;
  }

  /**
   * Log-safe description of a URI: its type plus the last 4 characters of a track/episode id.
   * @param {unknown} uri
   * @returns {string | null}
   */
  function shortUri(uri) {
    if (typeof uri !== "string") return null;
    const match = /^spotify:(track|episode):([A-Za-z0-9]{4,64})$/.exec(uri);
    if (match) return `${match[1]}:...${match[2].slice(-4)}`;
    return `${/^spotify:([a-z_]+):/.exec(uri)?.[1] ?? "unknown"}:${REDACTED}`;
  }

  /**
   * @param {unknown} value
   * @returns {boolean} True for numbers, booleans and short enum-like strings that match no sensitive pattern.
   */
  function isPrintableScalar(value) {
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    return typeof value === "string" && SAFE_ENUM_VALUE_RE.test(value) && redactString(value) === value;
  }

  /**
   * Allow-list projection of a (possibly hostile) quality object for logging: known keys by value (numbers,
   * booleans, short enum-like strings only); every other key by name and type, never by value.
   * @param {unknown} raw
   * @returns {{ values: Record<string, unknown>, otherKeys: Array<{ key: string, type: string }> } | null}
   */
  function summarizeQuality(raw) {
    if (!isRecord(raw)) return null;
    /** @type {Record<string, unknown>} */
    const values = {};
    /** @type {Array<{ key: string, type: string }>} */
    const otherKeys = [];
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (count++ >= REDACT_LIMITS.maxKeys) break;
      if (QUALITY_KEYS_PRINTED.has(key) && isPrintableScalar(value)) {
        setOwn(values, key, value);
      } else {
        otherKeys.push({ key: SAFE_KEY_NAME_RE.test(key) ? key : "[odd key]", type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value });
      }
    }
    return { values, otherKeys };
  }

  /**
   * Defines an own enumerable data property without ever invoking a `__proto__` setter.
   * @param {object} target
   * @param {string} key
   * @param {unknown} value
   * @returns {void}
   */
  function setOwn(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }

  /**
   * @param {unknown} value A non-object value (or null).
   * @returns {unknown}
   */
  function redactScalar(value) {
    switch (typeof value) {
      case "string":
        return redactString(value);
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
        return value;
      case "undefined":
        return undefined;
      case "bigint":
        return `${value}n`;
      case "symbol":
        return "[Symbol]";
      case "function":
        return "[Function]";
      default:
        return null; // only reachable for null
    }
  }

  /**
   * @param {unknown[]} items
   * @param {number} depth
   * @param {Set<object>} path
   * @returns {unknown[]}
   */
  function redactArray(items, depth, path) {
    const out = items.slice(0, REDACT_LIMITS.maxItems).map((item) => redact(item, depth + 1, path));
    if (items.length > REDACT_LIMITS.maxItems) out.push(`[+${items.length - REDACT_LIMITS.maxItems} more]`);
    return out;
  }

  /**
   * @param {object} obj
   * @param {number} depth
   * @param {Set<object>} path
   * @returns {Record<string, unknown>}
   */
  function redactObject(obj, depth, path) {
    /** @type {Record<string, unknown>} */
    const out = {};
    let count = 0;
    for (const [key, child] of Object.entries(obj)) {
      if (count++ >= REDACT_LIMITS.maxKeys) {
        setOwn(out, "[truncated]", true);
        break;
      }
      setOwn(out, key, isSensitiveKey(key) ? REDACTED : redact(child, depth + 1, path));
    }
    return out;
  }

  /**
   * Returns a JSON-safe, bounded copy with sensitive keys and token-like values removed.
   * Never mutates or throws on hostile input (getters, proxies, cycles, own `__proto__` keys).
   * @param {unknown} value
   * @param {number} [depth]
   * @param {Set<object>} [path]
   * @returns {unknown}
   */
  function redact(value, depth = 0, path = new Set()) {
    try {
      if (typeof value !== "object" || value === null) return redactScalar(value);
      if (depth >= REDACT_LIMITS.maxDepth) return "[MaxDepth]";
      if (path.has(value)) return "[Circular]";
      path.add(value);
      try {
        return Array.isArray(value) ? redactArray(value, depth, path) : redactObject(value, depth, path);
      } finally {
        path.delete(value);
      }
    } catch {
      // A throwing getter or proxy trap must not break the click handler; report it as opaque.
      return "[Unreadable]";
    }
  }

  // ---- css ------------------------------------------------------------------

  /**
   * CSS that hides the device panel, active only while <html> carries the probe class. `visibility: hidden`
   * also removes it from the accessibility tree and the focus order; layout is kept (no display:none).
   * @param {string} hideClass
   * @param {ReadonlyArray<string>} panelSelectors
   * @returns {string}
   */
  function buildHideCss(hideClass, panelSelectors) {
    if (!/^[A-Za-z][\w-]*$/.test(hideClass)) {
      throw new AudioQualityError("BAD_CLASS", `Invalid class name: ${hideClass}`);
    }
    if (panelSelectors.length === 0) throw new AudioQualityError("NO_SELECTORS", "No panel selectors configured");
    const scoped = panelSelectors.map((selector) => {
      if (selector.length === 0 || /[{}<>]/.test(selector)) {
        throw new AudioQualityError("BAD_SELECTOR", `Refusing to put selector in a stylesheet: ${selector}`);
      }
      return `html.${hideClass} ${selector}`;
    });
    return `${scoped.join(",\n")} {\n  opacity: 0 !important;\n  visibility: hidden !important;\n  pointer-events: none !important;\n  clip-path: inset(100%) !important;\n  transition: none !important;\n  animation: none !important;\n}\n`;
  }

  // ---- environment-facing helpers -------------------------------------------

  /**
   * Validates only the members this file uses, then narrows.
   * @param {unknown} scope
   * @returns {SpicetifyLike | undefined}
   */
  function getSpicetify(scope) {
    if (!isRecord(scope)) return undefined;
    const spicetify = scope.Spicetify;
    if (!isRecord(spicetify)) return undefined;
    const player = spicetify.Player;
    if (!isRecord(player) || typeof player.addEventListener !== "function") return undefined;
    return /** @type {SpicetifyLike} */ (/** @type {unknown} */ (spicetify));
  }

  /**
   * @param {TimerApi} api
   * @param {AbortSignal} signal
   * @param {(error: unknown) => void} onError
   * @returns {TimerSet}
   */
  function createTimerSet(api, signal, onError) {
    /** @type {Map<number, { handle: unknown, interval: boolean }>} */
    const active = new Map();
    let nextId = 1;

    /**
     * @param {() => void} fn
     * @returns {() => void}
     */
    const guarded = (fn) => () => {
      if (signal.aborted) return;
      try {
        fn();
      } catch (error) {
        onError(error);
      }
    };

    /** @type {TimerSet["after"]} */
    function after(fn, delayMs) {
      if (signal.aborted) return 0;
      const id = nextId++;
      const run = guarded(fn);
      const handle = api.setTimeout(() => {
        active.delete(id);
        run();
      }, Math.max(0, delayMs));
      active.set(id, { handle, interval: false });
      return id;
    }

    /** @type {TimerSet["every"]} */
    function every(fn, periodMs) {
      if (signal.aborted) return 0;
      const id = nextId++;
      active.set(id, { handle: api.setInterval(guarded(fn), periodMs), interval: true });
      return id;
    }

    /** @type {TimerSet["cancel"]} */
    function cancel(id) {
      const entry = active.get(id);
      if (entry === undefined) return;
      active.delete(id);
      if (entry.interval) api.clearInterval(entry.handle);
      else api.clearTimeout(entry.handle);
    }

    function cancelAll() {
      for (const id of [...active.keys()]) cancel(id);
    }

    signal.addEventListener("abort", cancelAll, { once: true });
    return { after, every, cancel, cancelAll, pendingCount: () => active.size };
  }

  /**
   * @param {(error: unknown) => void} onError
   * @returns {ListenerSet}
   */
  function createListenerSet(onError) {
    /** @type {Array<{ target: EventTarget, type: string, handler: EventListener, options: AddEventListenerOptions | undefined }>} */
    const entries = [];
    return {
      add(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        entries.push({ target, type, handler, options });
      },
      removeAll() {
        for (const entry of entries.splice(0)) {
          try {
            entry.target.removeEventListener(entry.type, entry.handler, entry.options);
          } catch (error) {
            onError(error);
          }
        }
      },
      size: () => entries.length,
    };
  }

  /**
   * Console output is bounded: each key warns at most 3 times (the third says so) and at most 64 keys are tracked.
   * @param {ConsoleLike} sink
   * @returns {{ warnOnce: (key: string, message: string, error?: unknown) => void }}
   */
  function createLogger(sink) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    return {
      warnOnce(key, message, error) {
        const seen = counts.get(key) ?? 0;
        if (seen >= 3 || (seen === 0 && counts.size >= 64)) return;
        counts.set(key, seen + 1);
        const text = `${LOG_PREFIX} ${message}${seen + 1 === 3 ? " (further identical warnings suppressed)" : ""}`;
        try {
          if (error === undefined) sink.warn(text);
          else sink.warn(text, describeError(error));
        } catch {
          // The console itself failed; there is nowhere left to report to.
        }
      },
    };
  }

  /**
   * @param {Element | null} el
   * @returns {el is HTMLElement}
   */
  function isHtmlElement(el) {
    return el !== null && typeof (/** @type {Partial<HTMLElement>} */ (el)).click === "function";
  }

  /**
   * @param {ParentNode} root
   * @param {ReadonlyArray<string>} selectors
   * @returns {HTMLElement[]}
   */
  function queryAllElements(root, selectors) {
    /** @type {HTMLElement[]} */
    const result = [];
    for (const el of root.querySelectorAll(selectors.join(","))) {
      if (isHtmlElement(el)) result.push(el);
    }
    return result;
  }

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  function hasActiveAttribute(el) {
    const current = el.getAttribute("aria-current");
    if (current !== null && current !== "false") return true;
    return ACTIVE_ATTRIBUTE_VALUES.some(([name, value]) => el.getAttribute(name) === value);
  }

  /**
   * @param {HTMLElement} row
   * @returns {boolean}
   */
  function isRowMarkedActive(row) {
    if (hasActiveAttribute(row)) return true;
    for (const el of row.querySelectorAll(ACTIVE_ATTRIBUTE_SELECTOR)) {
      if (hasActiveAttribute(el)) return true;
    }
    return ACTIVE_TEXT_RE.test(row.textContent ?? "");
  }

  /**
   * @param {HTMLElement} panel
   * @returns {HTMLElement | null} The innermost row-like element mentioning "This computer".
   */
  function findThisComputerRow(panel) {
    const candidates = queryAllElements(panel, SELECTORS.row).filter((el) => THIS_COMPUTER_RE.test(el.textContent ?? ""));
    let best = null;
    for (const el of candidates) {
      if (best === null || (el.textContent?.length ?? Infinity) < (best.textContent?.length ?? Infinity)) best = el;
    }
    return best;
  }

  /**
   * @param {ExtensionEnv} env
   * @returns {ExtensionEnv}
   */
  function withDefaults(env) {
    return { ...env, config: { ...env.config } };
  }

  /**
   * @returns {ExtensionEnv}
   */
  function createDefaultEnv() {
    const g = /** @type {HostWindow} */ (globalThis);
    return {
      doc: g.document,
      win: g,
      getSpicetify: () => getSpicetify(g),
      now: () => (typeof g.performance?.now === "function" ? g.performance.now() : Date.now()),
      timers: {
        setTimeout: (fn, ms) => g.setTimeout(fn, ms),
        clearTimeout: (handle) => g.clearTimeout(/** @type {number} */ (handle)),
        setInterval: (fn, ms) => g.setInterval(fn, ms),
        clearInterval: (handle) => g.clearInterval(/** @type {number} */ (handle)),
      },
      console: g.console,
      isUserEvent: (event) => event.isTrusted === true,
    };
  }

  // ===========================================================================
  // 4. The extension instance
  // ===========================================================================

  /**
   * @param {ExtensionEnv} rawEnv
   * @returns {Extension}
   */
  function createExtension(rawEnv) {
    const env = withDefaults(rawEnv);
    const { doc, win } = env;
    /** @type {Limits} */
    const limits = { ...DEFAULT_LIMITS, ...env.config?.limits };
    const probeEnabledByConfig = env.config?.probeEnabled ?? PROBE_ENABLED;
    const clickActiveRow = env.config?.clickActiveDeviceRow ?? CLICK_ACTIVE_DEVICE_ROW;
    const reclickTriggerToClose = env.config?.reclickTriggerToClose ?? RECLICK_TRIGGER_TO_CLOSE;

    const log = createLogger(env.console);
    const lifetime = new AbortController();
    const timers = createTimerSet(env.timers, lifetime.signal, (error) => log.warnOnce("timer-callback", "timer callback failed", error));
    const listeners = createListenerSet((error) => log.warnOnce("remove-listener", "removeEventListener failed", error));
    const probeListeners = createListenerSet((error) => log.warnOnce("remove-probe-listener", "removeEventListener failed", error));
    /** @type {LruCache<string, TrackRecord>} */
    const cache = new LruCache(limits.cacheCapacity);

    let started = false;
    let disposed = false;
    /** @type {SpicetifyLike | undefined} */
    let spicetify;
    /** @type {HTMLElement | null} */
    let pill = null;
    /** @type {HTMLStyleElement | null} */
    let styleEl = null;
    /** @type {MutationObserver | null} */
    let observer = null;
    /** @type {Node | null} */
    let observedParent = null;
    /** @type {string | null} */
    let currentUri = null;
    /** @type {number | null} */
    let lastTrackChangeAt = null;
    /** @type {number | null} */
    let lastAnyProbeEndedAt = null;
    /** @type {string | null} */
    let manualRecheckUri = null;
    /** @type {string | null} */
    let probeDisabledReason = null;
    let panelMisses = 0;
    let lastUpdateAt = Number.NEGATIVE_INFINITY;
    let lastRenderKey = "";
    let needsReposition = false;
    let updateTimer = 0;
    let reconcileTimer = 0;
    let probeTimer = 0;
    /** @type {{ uri: string, kind: ProbeKind } | null} */
    let armedTarget = null;
    /** @type {ActiveProbe | null} */
    let probe = null;
    /** @type {Array<{ type: string, callback: () => void }>} */
    const playerListeners = [];

    // ---- state access -------------------------------------------------------

    /** @returns {Snapshot} */
    function takeSnapshot() {
      const sp = spicetify;
      if (sp === undefined) return { uri: null, quality: { kind: "unknown" }, source: null, rawQuality: undefined };
      return readSnapshot(
        [
          { name: "Player.data", read: () => sp.Player.data },
          { name: "PlayerAPI._state", read: () => sp.Platform?.PlayerAPI?._state },
        ],
        (name, error) => log.warnOnce(`state-${name}`, `could not read ${name}; treating quality as unknown`, error),
      );
    }

    /**
     * @param {string} uri
     * @returns {TrackRecord}
     */
    function getOrCreateRecord(uri) {
      const existing = cache.get(uri);
      if (existing !== undefined) return existing;
      /** @type {TrackRecord} */
      const created = { depth: null, autoAttempts: 0, lastProbeEndedAt: null, lastResult: null };
      cache.set(uri, created);
      return created;
    }

    // ---- DOM: style, pill, mounting ------------------------------------------

    function removeStaleDom() {
      for (const el of doc.querySelectorAll(`#${IDS.pill}, #${IDS.style}`)) el.remove();
      doc.documentElement.classList.remove(IDS.hideClass);
    }

    function ensureStyle() {
      if (styleEl?.isConnected) return;
      const el = doc.createElement("style");
      el.id = IDS.style;
      el.textContent = buildHideCss(IDS.hideClass, SELECTORS.panel);
      (doc.head ?? doc.documentElement).appendChild(el);
      styleEl = el;
    }

    /** @returns {boolean} True only if the browser actually parsed our hide rule (CSP can block <style>). */
    function isHideRuleActive() {
      try {
        const rules = styleEl?.sheet?.cssRules;
        return rules !== undefined && rules.length > 0;
      } catch (error) {
        log.warnOnce("hide-rule-check", "could not inspect the hide rule", error);
        return false;
      }
    }

    /** @returns {HTMLElement} */
    function createPillElement() {
      const el = doc.createElement("div");
      el.id = IDS.pill;
      el.setAttribute("role", "status");
      el.setAttribute("title", "Playback quality - click to re-check");
      const style = el.style;
      style.setProperty("position", "fixed");
      style.setProperty("left", "50%");
      style.setProperty("transform", "translateX(-50%)");
      style.setProperty("bottom", `${DEFAULT_BOTTOM_OFFSET_PX}px`);
      style.setProperty("z-index", "9999");
      style.setProperty("padding", "4px 12px");
      style.setProperty("border-radius", "999px");
      style.setProperty("font-size", "12px");
      style.setProperty("font-weight", "600");
      style.setProperty("line-height", "1.4");
      style.setProperty("white-space", "nowrap");
      style.setProperty("cursor", "pointer");
      style.setProperty("user-select", "none");
      style.setProperty("pointer-events", "auto");
      style.setProperty("box-shadow", "0 2px 8px rgba(0, 0, 0, 0.4)");
      style.setProperty("transition", "background-color 0.2s, opacity 0.2s");
      el.textContent = "Quality unknown";
      return el;
    }

    /** @returns {Element} */
    function getMountParent() {
      const fullscreen = doc.fullscreenElement;
      if (fullscreen && fullscreen !== doc.documentElement && fullscreen !== doc.body && !NON_CONTAINER_TAGS.has(fullscreen.tagName)) {
        return fullscreen;
      }
      return doc.body ?? doc.documentElement;
    }

    /** @param {Node} parent */
    function observeParent(parent) {
      if (observer === null || observedParent === parent) return;
      observer.disconnect();
      observer.observe(parent, { childList: true });
      observedParent = parent;
    }

    function ensurePillMounted() {
      if (pill === null) return;
      const parent = getMountParent();
      if (pill.parentNode !== parent) parent.appendChild(pill);
      observeParent(parent);
    }

    function positionPill() {
      if (pill === null) return;
      let offset = DEFAULT_BOTTOM_OFFSET_PX;
      const bar = queryAllElements(doc, SELECTORS.nowPlayingBar)[0];
      if (bar !== undefined) {
        const height = bar.getBoundingClientRect().height;
        if (Number.isFinite(height) && height > 0 && height < 400) offset = Math.round(height) + 12;
      }
      pill.style.setProperty("bottom", `${offset}px`);
      needsReposition = false;
    }

    /** @param {PillView} view */
    function render(view) {
      if (pill === null) return;
      const key = `${view.tone}|${view.text}`;
      if (key === lastRenderKey) return;
      lastRenderKey = key;
      pill.textContent = view.text;
      pill.setAttribute("data-tone", view.tone);
      const lossless = view.tone === "lossless";
      pill.style.setProperty("background-color", lossless ? "var(--spice-button, #1db954)" : "var(--spice-button-disabled, #535353)");
      pill.style.setProperty("color", lossless ? "var(--spice-main, #121212)" : "var(--spice-text, #ffffff)");
      pill.style.setProperty("opacity", view.tone === "unknown" ? "0.5" : "1");
    }

    function applyHide() {
      doc.documentElement.classList.add(IDS.hideClass);
    }

    function removeHide() {
      doc.documentElement.classList.remove(IDS.hideClass);
    }

    // ---- scheduling -----------------------------------------------------------

    /** @param {number} [delayMs] */
    function scheduleUpdate(delayMs = 0) {
      if (disposed || updateTimer !== 0) return;
      const wait = Math.max(delayMs, limits.updateMinIntervalMs - (env.now() - lastUpdateAt), 0);
      updateTimer = timers.after(() => {
        updateTimer = 0;
        update();
      }, wait);
    }

    /** @param {boolean} [reposition] */
    function requestReconcile(reposition = false) {
      if (disposed) return;
      if (reposition) needsReposition = true;
      if (reconcileTimer !== 0) return;
      reconcileTimer = timers.after(() => {
        reconcileTimer = 0;
        reconcile();
      }, limits.observerThrottleMs);
    }

    function reconcile() {
      if (disposed) return;
      ensureStyle();
      ensurePillMounted();
      if (needsReposition) positionPill();
      healHideClass();
    }

    /** Invariant: the hide class exists only while a probe is active. */
    function healHideClass() {
      if (probe === null && doc.documentElement.classList.contains(IDS.hideClass)) {
        removeHide();
        log.warnOnce("stale-hide-class", "removed a leftover probe class from <html>");
      }
    }

    // ---- update ---------------------------------------------------------------

    /** @param {string | null} newUri */
    function onTrackIdentityChanged(newUri) {
      currentUri = newUri;
      lastTrackChangeAt = env.now();
      if (manualRecheckUri !== null && manualRecheckUri !== newUri) manualRecheckUri = null;
      if (probe !== null && probe.uri !== newUri) abortProbe("track-changed");
      if (armedTarget !== null && armedTarget.uri !== newUri) disarmProbeTimer();
    }

    /**
     * @param {Snapshot} snap
     * @returns {{ uri: string, kind: ProbeKind } | null}
     */
    function planProbe(snap) {
      if (!probeEnabledByConfig || probeDisabledReason !== null) return null;
      if (snap.quality.kind !== "lossless" || snap.uri === null) return null;
      const record = cache.peek(snap.uri);
      if (record?.depth) return null;
      if (manualRecheckUri === snap.uri) return { uri: snap.uri, kind: "manual" };
      if ((record?.autoAttempts ?? 0) < limits.maxAutoProbesPerTrack) return { uri: snap.uri, kind: "auto" };
      return null;
    }

    /**
     * @param {Snapshot} snap
     * @param {{ uri: string, kind: ProbeKind } | null} want
     * @returns {DepthState}
     */
    function deriveDepthState(snap, want) {
      if (snap.uri === null) return { kind: "unreadable" };
      const record = cache.get(snap.uri);
      if (record?.depth) return { kind: "known", bits: record.depth };
      if (probe !== null && probe.uri === snap.uri) return { kind: "checking" };
      // Before the first attempt, or while a user-requested re-check is pending, the depth is "being read".
      // After a failed attempt we show plain "Lossless" and retry silently in the background.
      if (want !== null && (want.kind === "manual" || (record?.autoAttempts ?? 0) === 0)) return { kind: "checking" };
      return { kind: "unreadable" };
    }

    function update() {
      if (disposed) return;
      lastUpdateAt = env.now();
      const snap = takeSnapshot();
      if (snap.uri !== currentUri) onTrackIdentityChanged(snap.uri);
      const want = planProbe(snap);
      render(describePill(snap.quality, deriveDepthState(snap, want)));
      armProbeIfWanted(want);
      healHideClass();
    }

    // ---- probe: scheduling ----------------------------------------------------

    /**
     * @returns {boolean} True while an editable control has focus: never open a popover under a typing user.
     */
    function isUserTyping() {
      const el = doc.activeElement;
      if (el === null) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT") return true;
      if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "text").toLowerCase());
      const editable = el.getAttribute("contenteditable");
      return editable !== null && editable.toLowerCase() !== "false";
    }

    /**
     * @param {{ uri: string, kind: ProbeKind }} want
     * @returns {GateResult}
     */
    function evaluateGate(want) {
      const record = cache.peek(want.uri);
      return checkProbeGate({
        now: env.now(),
        hidden: doc.hidden,
        typing: isUserTyping(),
        probeRunning: probe !== null,
        lastTrackChangeAt,
        lastAnyProbeEndedAt,
        lastTrackProbeEndedAt: record?.lastProbeEndedAt ?? null,
        autoAttempts: record?.autoAttempts ?? 0,
        kind: want.kind,
        limits,
      });
    }

    function disarmProbeTimer() {
      if (probeTimer !== 0) timers.cancel(probeTimer);
      probeTimer = 0;
      armedTarget = null;
    }

    /** @param {{ uri: string, kind: ProbeKind } | null} want */
    function armProbeIfWanted(want) {
      if (want === null) {
        disarmProbeTimer();
        return;
      }
      if (probe !== null) return; // the probe's completion schedules the next update
      if (probeTimer !== 0 && armedTarget?.uri === want.uri && armedTarget.kind === want.kind) return;
      disarmProbeTimer();
      const gate = evaluateGate(want);
      const delay = gate.ok ? 0 : gate.retryAfterMs === null ? null : Math.max(gate.retryAfterMs, 50);
      if (delay === null) return; // hidden / busy / exhausted: an event will re-run update()
      armedTarget = want;
      probeTimer = timers.after(runProbeTimer, delay);
    }

    function runProbeTimer() {
      probeTimer = 0;
      const target = armedTarget;
      armedTarget = null;
      if (disposed || target === null) return;
      const want = planProbe(takeSnapshot());
      if (want === null || want.uri !== target.uri) {
        scheduleUpdate(0);
        return;
      }
      if (evaluateGate(want).ok) beginProbe(want);
      else armProbeIfWanted(want);
    }

    // ---- probe: element lookup ------------------------------------------------

    /** @returns {HTMLElement} */
    function findTrigger() {
      const [first, ...others] = queryAllElements(doc, SELECTORS.trigger).filter(
        (el) => el.isConnected && el.closest(SELECTORS.modal.join(",")) === null,
      );
      if (first === undefined) throw new ProbeError("no-trigger", "device-panel trigger not found");
      if (others.length > 0) throw new ProbeError("no-trigger", `device-panel trigger is ambiguous (${others.length + 1} matches)`);
      return first;
    }

    /** @returns {HTMLElement | null} Exactly one open panel, otherwise null. */
    function findPanel() {
      const matches = queryAllElements(doc, SELECTORS.panel);
      if (matches.length > 1) log.warnOnce("panel-ambiguous", `device panel selector matched ${matches.length} elements; ignoring`);
      return matches.length === 1 ? (matches[0] ?? null) : null;
    }

    /** @returns {boolean} */
    function isModalOpen() {
      return doc.querySelector(SELECTORS.modal.join(",")) !== null;
    }

    /**
     * @param {HTMLElement} panel
     * @returns {boolean}
     */
    function isPanelHidden(panel) {
      const computed = win.getComputedStyle(panel);
      return computed.opacity === "0" || computed.visibility === "hidden" || computed.display === "none";
    }

    /** @param {string} reason */
    function disableProbe(reason) {
      if (probeDisabledReason === null) {
        probeDisabledReason = reason;
        log.warnOnce("probe-disabled", `bit-depth probe disabled for this session: ${reason}`);
      }
    }

    // ---- probe: lifecycle -----------------------------------------------------

    /**
     * Runs every pre-click check. Throws ProbeError; has no side effects on the page.
     * @returns {HTMLElement}
     */
    function preflight() {
      ensureStyle(); // Spotify (or anything else) may have removed it since mount
      if (!isHideRuleActive()) {
        disableProbe("hide rule not active (stylesheet blocked?)");
        throw new ProbeError("hide-ineffective", "the stylesheet that hides the panel is not active");
      }
      const trigger = findTrigger();
      if (queryAllElements(doc, SELECTORS.panel).length > 0) throw new ProbeError("panel-already-open", "a device panel is already open");
      if (trigger.getAttribute("aria-expanded") === "true") throw new ProbeError("panel-already-open", "trigger reports expanded");
      if (isModalOpen()) throw new ProbeError("modal-open", "a modal dialog is open");
      return trigger;
    }

    /**
     * @param {{ uri: string, kind: ProbeKind }} target
     * @param {HTMLElement} trigger
     * @param {number} now
     * @returns {ActiveProbe}
     */
    function createProbeState(target, trigger, now) {
      return {
        uri: target.uri,
        phase: "opening",
        trigger,
        panel: null,
        startedAt: now,
        phaseStartedAt: now,
        clickedAt: null,
        pollTimer: 0,
        watchdogTimer: 0,
        outcome: null,
        rowClicked: false,
        triggerReclicked: false,
        closeAttempted: false,
        ended: false,
        previousFocus: null,
        classWatcher: null,
      };
    }

    /**
     * While a probe runs, put the hide class back at once if page code rewrites <html class>.
     * MutationObserver callbacks run as microtasks, i.e. before the next paint.
     * @param {ActiveProbe} p
     */
    function watchHideClass(p) {
      if (typeof win.MutationObserver !== "function") return;
      const watcher = new win.MutationObserver(() => {
        if (probe === p && !p.ended && !doc.documentElement.classList.contains(IDS.hideClass)) applyHide();
      });
      watcher.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });
      p.classWatcher = watcher;
    }

    /**
     * @param {{ uri: string, kind: ProbeKind }} target
     */
    function beginProbe(target) {
      const now = env.now();
      const record = getOrCreateRecord(target.uri);
      if (target.kind === "auto") record.autoAttempts += 1;
      else if (manualRecheckUri === target.uri) manualRecheckUri = null;

      /** @type {HTMLElement} */
      let trigger;
      try {
        trigger = preflight();
      } catch (error) {
        const reason = error instanceof ProbeError ? error.reason : "exception";
        if (!(error instanceof ProbeError)) log.warnOnce("preflight", "probe preflight failed", error);
        record.lastResult = reason;
        record.lastProbeEndedAt = now;
        lastAnyProbeEndedAt = now;
        scheduleUpdate(0);
        return;
      }

      const p = createProbeState(target, trigger, now);
      probe = p;
      try {
        const active = doc.activeElement;
        p.previousFocus = active !== doc.body && isHtmlElement(active) ? active : null;
        applyHide(); // BEFORE the click: the panel must never be painted visible
        watchHideClass(p);
        installGuards(p);
        p.watchdogTimer = timers.after(() => onWatchdog(p), limits.probeWatchdogMs);
        p.clickedAt = env.now();
        trigger.click();
        schedulePoll(p);
      } catch (error) {
        log.warnOnce("probe-start", "probe failed to start; restoring UI", error);
        p.outcome = { status: "unreadable", reason: "exception" };
        endProbe(p, { closeSynchronously: true });
        return;
      }
      scheduleUpdate(0);
    }

    /** @param {ActiveProbe} p */
    function schedulePoll(p) {
      if (p.ended) return;
      p.pollTimer = timers.after(() => {
        p.pollTimer = 0;
        runStep(p, () => pollProbe(p));
      }, limits.pollIntervalMs);
    }

    /** @param {ActiveProbe} p */
    function cancelPoll(p) {
      if (p.pollTimer !== 0) timers.cancel(p.pollTimer);
      p.pollTimer = 0;
    }

    /**
     * Every timer-driven probe step goes through here so an exception can never strand the panel.
     * @param {ActiveProbe} p
     * @param {() => void} step
     */
    function runStep(p, step) {
      try {
        step();
      } catch (error) {
        log.warnOnce("probe-step", "probe step failed; restoring UI", error);
        if (!p.ended) {
          p.outcome = { status: "unreadable", reason: "exception" };
          endProbe(p, { closeSynchronously: true });
        }
      }
    }

    /** @param {ActiveProbe} p */
    function pollProbe(p) {
      if (p.ended || disposed) return;
      if (!doc.documentElement.classList.contains(IDS.hideClass)) applyHide(); // backs up watchHideClass()
      if (p.phase === "opening") stepOpening(p);
      else if (p.phase === "reading") stepReading(p);
      else closeStep(p);
    }

    /**
     * Collapses a panel that our trigger click asked for but that we cannot see (not rendered yet, or
     * not matched by our selector). Only acts if the trigger itself reports "expanded"; at most once.
     * @param {ActiveProbe} p
     */
    function undoPendingOpen(p) {
      if (p.triggerReclicked || !p.trigger.isConnected || p.trigger.getAttribute("aria-expanded") !== "true") return;
      p.triggerReclicked = true;
      p.trigger.click();
    }

    /** @param {ActiveProbe} p */
    function stepOpening(p) {
      const panel = findPanel();
      if (panel !== null) {
        p.panel = panel;
        p.phase = "reading";
        p.phaseStartedAt = env.now();
        panelMisses = 0;
        stepReading(p);
        return;
      }
      if (env.now() - (p.clickedAt ?? p.startedAt) >= limits.panelWaitMs) {
        panelMisses += 1;
        if (panelMisses >= 2) disableProbe("device panel never appeared twice in a row (selector mismatch?)");
        undoPendingOpen(p); // the trigger may say something opened that our selectors cannot see
        p.outcome = { status: "unreadable", reason: "panel-timeout" };
        endProbe(p);
        return;
      }
      schedulePoll(p);
    }

    /**
     * Checked on every poll: the panel must still compute as hidden. If not (the hide rule did not apply, or
     * was overridden), close it at once and switch the probe off for this session.
     * @param {ActiveProbe} p
     * @param {HTMLElement} panel
     * @returns {boolean} false if the panel is visible (the probe has then been told to close)
     */
    function verifyHidden(p, panel) {
      if (isPanelHidden(panel)) return true;
      disableProbe("hide rule did not apply to the panel");
      beginClose(p, { status: "unreadable", reason: "hide-ineffective" });
      return false;
    }

    /**
     * Result once the search window has elapsed without the active row showing a depth. The panel-wide text is
     * a last resort, accepted only if unambiguous (UNVERIFIED RISK: it could describe another device's row).
     * @param {HTMLElement} panel
     * @param {HTMLElement | null} row
     * @param {boolean} active
     * @returns {ProbeOutcome}
     */
    function outcomeAtDeadline(panel, row, active) {
      if (row !== null && active) {
        const wide = extractDepthFromText(panel.textContent);
        if (wide.kind === "depth") return { status: "depth", bits: wide.bits };
        if (wide.kind === "ambiguous") return { status: "unreadable", reason: "ambiguous-depth" };
        return { status: "unreadable", reason: "depth-timeout" };
      }
      return { status: "unreadable", reason: row === null ? "no-device-row" : "device-not-active" };
    }

    /** @param {ActiveProbe} p */
    function stepReading(p) {
      const panel = p.panel;
      if (panel === null || !panel.isConnected) {
        p.outcome = { status: "unreadable", reason: "panel-vanished" };
        endProbe(p);
        return;
      }
      if (!verifyHidden(p, panel)) return;
      const row = findThisComputerRow(panel);
      const active = row !== null && isRowMarkedActive(row);
      if (row !== null && active) {
        if (clickActiveRow && !p.rowClicked) {
          p.rowClicked = true;
          row.click(); // only ever reached for a row already marked active
        }
        const own = extractDepthFromText(row.textContent);
        if (own.kind === "depth") {
          beginClose(p, { status: "depth", bits: own.bits });
          return;
        }
        if (own.kind === "ambiguous") {
          beginClose(p, { status: "unreadable", reason: "ambiguous-depth" });
          return;
        }
      }
      if (env.now() - p.phaseStartedAt >= limits.depthSearchMs) {
        beginClose(p, outcomeAtDeadline(panel, row, active));
        return;
      }
      schedulePoll(p);
    }

    /**
     * @param {ActiveProbe} p
     * @param {ProbeOutcome} outcome
     */
    function beginClose(p, outcome) {
      if (p.ended || p.phase === "closing") return;
      p.outcome = outcome;
      p.phase = "closing";
      p.phaseStartedAt = env.now();
      p.closeAttempted = false;
      cancelPoll(p);
      closeStep(p);
    }

    /**
     * @param {HTMLElement} panel
     * @returns {HTMLElement | null} A close control inside the panel, never a global one.
     */
    function findCloseControl(panel) {
      return queryAllElements(panel, SELECTORS.close)[0] ?? null;
    }

    /** @param {ActiveProbe} p */
    function closeStep(p) {
      const panel = p.panel ?? findPanel();
      if (panel !== null) p.panel = panel;
      if (panel === null || !panel.isConnected) {
        // The panel may still be rendering after our click; give it the remainder of the wait window.
        if (panel === null && p.clickedAt !== null && env.now() - p.clickedAt < limits.panelWaitMs) {
          schedulePoll(p);
          return;
        }
        if (panel === null) undoPendingOpen(p);
        endProbe(p);
        return;
      }
      const elapsed = env.now() - p.phaseStartedAt;
      if (!p.closeAttempted) {
        p.closeAttempted = true;
        const control = findCloseControl(panel);
        if (control !== null) {
          control.click(); // never followed by a trigger click: that could re-open a slowly closing panel
        } else if (reclickTriggerToClose && p.trigger.isConnected && !p.triggerReclicked) {
          p.triggerReclicked = true;
          p.trigger.click();
        } else {
          log.warnOnce("no-close-control", "device panel has no close control; leaving it for the user");
        }
      }
      if (!panel.isConnected) {
        endProbe(p);
        return;
      }
      if (elapsed >= limits.closeWaitMs) {
        log.warnOnce("close-failed", "device panel did not close; making it visible again");
        endProbe(p);
        return;
      }
      schedulePoll(p);
    }

    /** Best-effort synchronous close, used on abort paths that cannot wait. @param {ActiveProbe} p */
    function closeNow(p) {
      const panel = p.panel ?? findPanel();
      if (panel === null || !panel.isConnected) {
        if (p.clickedAt !== null) undoPendingOpen(p);
        return;
      }
      const control = findCloseControl(panel);
      if (control !== null) control.click();
      else if (reclickTriggerToClose && p.trigger.isConnected && !p.triggerReclicked && p.clickedAt !== null) {
        p.triggerReclicked = true;
        p.trigger.click();
      }
    }

    /** @param {ActiveProbe} p */
    function cancelWatchdog(p) {
      if (p.watchdogTimer !== 0) timers.cancel(p.watchdogTimer);
      p.watchdogTimer = 0;
    }

    /**
     * A popover opened by a click may move focus into itself. Put focus back where the user had it, but never
     * override a focus choice the user made in the meantime.
     * @param {ActiveProbe} p
     */
    function restoreFocus(p) {
      try {
        const previous = p.previousFocus;
        if (previous === null || !previous.isConnected) return;
        const current = doc.activeElement;
        const displaced = current === null || current === doc.body || p.trigger.contains(current) || (p.panel?.contains(current) ?? false);
        if (displaced && current !== previous) previous.focus({ preventScroll: true });
      } catch (error) {
        log.warnOnce("restore-focus", "could not restore focus", error);
      }
    }

    /**
     * Single exit for every probe. Always removes the hide class and releases the probe; the panel is closed
     * on a best-effort basis (if it will not close it is left open and visible). Idempotent.
     * @param {ActiveProbe} p
     * @param {{ closeSynchronously?: boolean, leavePanel?: boolean }} [options]
     */
    function endProbe(p, options = {}) {
      if (p.ended) return;
      p.ended = true;
      try {
        cancelPoll(p);
        cancelWatchdog(p);
        p.classWatcher?.disconnect(); // before removeHide(), so the watcher cannot put the class back
        p.classWatcher = null;
        probeListeners.removeAll();
        if (options.closeSynchronously === true && options.leavePanel !== true) closeNow(p);
      } catch (error) {
        log.warnOnce("probe-end", "error while ending probe; continuing restore", error);
      } finally {
        removeHide();
        if (probe === p) probe = null;
        if (options.leavePanel !== true) restoreFocus(p);
        commitOutcome(p);
        scheduleUpdate(0);
      }
    }

    /**
     * Records the result. Never throws. A depth is stored only if the live URI still equals the probed URI.
     * @param {ActiveProbe} p
     */
    function commitOutcome(p) {
      try {
        const outcome = p.outcome ?? /** @type {ProbeOutcome} */ ({ status: "unreadable", reason: "exception" });
        const now = env.now();
        lastAnyProbeEndedAt = now;
        const record = getOrCreateRecord(p.uri);
        record.lastProbeEndedAt = now;
        if (outcome.status === "depth") {
          const liveUri = disposed ? null : takeSnapshot().uri;
          if (liveUri === p.uri) {
            record.depth = outcome.bits;
            record.lastResult = "depth";
            if (manualRecheckUri === p.uri) manualRecheckUri = null;
          } else {
            record.lastResult = "discarded-stale";
          }
        } else if (outcome.status === "unreadable") {
          record.lastResult = outcome.reason;
        } else {
          record.lastResult = `aborted:${outcome.reason}`;
        }
      } catch (error) {
        log.warnOnce("commit", "could not record probe outcome", error);
      }
    }

    /** @param {AbortReason} reason */
    function abortProbe(reason) {
      const p = probe;
      if (p === null || p.ended || p.phase === "closing") return;
      beginClose(p, { status: "aborted", reason });
    }

    /** @param {ActiveProbe} p */
    function onWatchdog(p) {
      if (p.ended) return;
      p.watchdogTimer = 0;
      log.warnOnce("watchdog", "probe watchdog fired; forcing restore");
      p.outcome = { status: "aborted", reason: "watchdog" };
      endProbe(p, { closeSynchronously: true });
    }

    /**
     * While a probe runs, genuine user input wins: stop, never fight the user for the panel.
     * @param {ActiveProbe} p
     */
    function installGuards(p) {
      /** @param {Event} event */
      const onInput = (event) => {
        if (probe !== p || p.ended || !env.isUserEvent(event)) return;
        const target = event.target;
        const onProbeSurface = isNodeLike(target) && (p.trigger.contains(target) || (p.panel?.contains(target) ?? false));
        if (onProbeSurface) {
          p.outcome = { status: "aborted", reason: "user-input" };
          endProbe(p, { leavePanel: true }); // the user took over the panel: un-hide it and leave it alone
        } else {
          abortProbe("user-input");
        }
      };
      for (const type of ["pointerdown", "mousedown", "keydown"]) {
        probeListeners.add(doc, type, onInput, { capture: true, passive: true });
      }
    }

    // ---- events ---------------------------------------------------------------

    function onSongChange() {
      if (disposed) return;
      lastTrackChangeAt = env.now();
      abortProbe("track-changed");
      disarmProbeTimer();
      scheduleUpdate(0);
    }

    function onPlayPause() {
      if (disposed) return;
      scheduleUpdate(0);
    }

    function onVisibilityChange() {
      if (disposed) return;
      if (doc.hidden) abortProbe("hidden");
      else scheduleUpdate(0);
      requestReconcile(true);
    }

    function onFullscreenChange() {
      if (disposed) return;
      abortProbe("fullscreen-change");
      requestReconcile(true);
    }

    function onResize() {
      requestReconcile(true);
    }

    /** @param {string} text */
    function notify(text) {
      try {
        spicetify?.showNotification?.(text);
      } catch (error) {
        log.warnOnce("notify", "showNotification failed", error);
      }
    }

    /**
     * @param {Snapshot} snap
     * @param {TrackRecord | undefined} record
     * @returns {unknown}
     */
    function buildReport(snap, record) {
      /** @type {Record<string, unknown>} */
      const selectors = {};
      try {
        selectors.triggerFound = queryAllElements(doc, SELECTORS.trigger).length;
        selectors.panelOpen = queryAllElements(doc, SELECTORS.panel).length;
        selectors.hideRuleActive = isHideRuleActive();
      } catch (error) {
        selectors.error = describeError(error);
      }
      /** @type {unknown} */
      let quality;
      try {
        quality = summarizeQuality(snap.rawQuality);
      } catch (error) {
        quality = `[Unreadable: ${describeError(error)}]`;
      }
      return redact({
        source: snap.source,
        track: shortUri(snap.uri),
        quality,
        parsed: snap.quality,
        pill: describePill(snap.quality, record?.depth ? { kind: "known", bits: record.depth } : { kind: "unreadable" }).text,
        cache: record ? { depth: record.depth, autoAttempts: record.autoAttempts, lastResult: record.lastResult } : null,
        probe: { enabled: probeEnabledByConfig, disabledReason: probeDisabledReason, running: probe !== null },
        selectors,
      });
    }

    function onPillClick() {
      if (disposed) return;
      const snap = takeSnapshot();
      const record = snap.uri === null ? undefined : cache.peek(snap.uri);
      try {
        env.console.log(`${LOG_PREFIX} playback quality (redacted):`, buildReport(snap, record));
      } catch (error) {
        log.warnOnce("click-log", "could not log playback quality", error);
      }
      if (snap.uri !== null) {
        const target = getOrCreateRecord(snap.uri);
        target.depth = null;
        target.lastResult = null;
        manualRecheckUri = snap.uri;
      }
      notify("Audio quality: re-checking...");
      scheduleUpdate(0);
    }

    // ---- lifecycle ------------------------------------------------------------

    function runPreviousCleanup() {
      const previous = win.audioQualityCleanup;
      if (typeof previous !== "function") return;
      try {
        previous();
      } catch (error) {
        log.warnOnce("previous-cleanup", "previous instance cleanup failed", error);
      }
    }

    function mount() {
      ensureStyle();
      pill = createPillElement();
      listeners.add(pill, "click", onPillClick);
      if (typeof win.MutationObserver === "function") {
        observer = new win.MutationObserver(() => requestReconcile(false));
      }
      ensurePillMounted();
      positionPill();
      listeners.add(win, "resize", onResize);
      listeners.add(doc, "fullscreenchange", onFullscreenChange);
      listeners.add(doc, "visibilitychange", onVisibilityChange);
      const sp = spicetify;
      if (sp !== undefined) {
        for (const [type, callback] of /** @type {const} */ ([["songchange", onSongChange], ["onplaypause", onPlayPause]])) {
          sp.Player.addEventListener(type, callback);
          playerListeners.push({ type, callback });
        }
      }
      // Not the probe, so calling update() directly is allowed; avoids ~24 throwaway timers a minute.
      timers.every(() => {
        if (doc.hidden) return; // nothing is visible; visibilitychange refreshes on restore
        update();
        reconcile();
      }, limits.heartbeatMs);
      update();
    }

    /** @param {number} attempt */
    function waitForSpicetify(attempt) {
      if (disposed) return;
      /** @type {SpicetifyLike | undefined} */
      let found;
      try {
        found = env.getSpicetify();
      } catch (error) {
        log.warnOnce("spicetify-lookup", "looking up Spicetify failed; will retry", error);
      }
      if (found !== undefined && doc.body) {
        spicetify = found;
        try {
          mount();
        } catch (error) {
          log.warnOnce("mount", "failed to mount; cleaning up", error);
          cleanup();
        }
        return;
      }
      if (attempt >= limits.spicetifyMaxWaits) {
        log.warnOnce("no-spicetify", "Spicetify did not become ready; giving up");
        return;
      }
      timers.after(() => waitForSpicetify(attempt + 1), limits.spicetifyWaitMs);
    }

    function start() {
      if (started || disposed) return;
      started = true;
      runPreviousCleanup();
      win.audioQualityCleanup = cleanup;
      removeStaleDom();
      waitForSpicetify(0);
    }

    /**
     * Tears everything down. Idempotent. Each step is isolated so one failure cannot skip the rest.
     */
    function cleanup() {
      if (disposed) return;
      disposed = true;
      /** @type {Array<[string, () => void]>} */
      const steps = [
        ["end probe", () => {
          if (probe !== null) {
            probe.outcome ??= { status: "aborted", reason: "cleanup" };
            endProbe(probe, { closeSynchronously: true });
          }
        }],
        ["cancel timers", () => lifetime.abort()],
        ["dom listeners", () => listeners.removeAll()],
        ["probe listeners", () => probeListeners.removeAll()],
        ["observer", () => {
          observer?.disconnect();
          observer = null;
          observedParent = null;
        }],
        ["player listeners", () => {
          for (const { type, callback } of playerListeners.splice(0)) {
            try {
              spicetify?.Player.removeEventListener?.(type, callback);
            } catch (error) {
              log.warnOnce("player-remove", "Player.removeEventListener failed; callback is inert", error);
            }
          }
        }],
        ["remove dom", () => {
          pill?.remove();
          styleEl?.remove();
          pill = null;
          styleEl = null;
          removeStaleDom();
        }],
        ["global hook", () => {
          if (win.audioQualityCleanup === cleanup) Reflect.deleteProperty(win, GLOBAL_CLEANUP_KEY);
        }],
        ["cache", () => cache.clear()],
      ];
      for (const [label, step] of steps) {
        try {
          step();
        } catch (error) {
          log.warnOnce(`cleanup-${label}`, `cleanup step "${label}" failed`, error);
        }
      }
    }

    return {
      start,
      cleanup,
      getState: () => ({
        started,
        disposed,
        probeRunning: probe !== null,
        probePhase: probe?.phase ?? null,
        pendingTimers: timers.pendingCount(),
        domListeners: listeners.size() + probeListeners.size(),
        playerListeners: playerListeners.length,
        cacheSize: cache.size,
        probeDisabledReason,
        pillMounted: pill?.isConnected ?? false,
      }),
      peekRecord: (uri) => cache.peek(uri),
    };
  }

  // ===========================================================================
  // 5. Bootstrap
  // ===========================================================================

  function bootstrap() {
    try {
      createExtension(createDefaultEnv()).start();
    } catch (error) {
      // Never throw into Spotify's script loader.
      console.warn(`${LOG_PREFIX} failed to start`, describeError(error));
    }
  }

  const internals = Object.freeze({
    AudioQualityError,
    ProbeError,
    LruCache,
    DEFAULT_LIMITS,
    SELECTORS,
    IDS,
    parseBitrateLevel,
    parseHifiStatus,
    classifyQuality,
    describePill,
    extractTrackUri,
    extractQualityFields,
    readSnapshot,
    extractDepthFromText,
    checkProbeGate,
    redact,
    redactString,
    shortUri,
    summarizeQuality,
    isSensitiveKey,
    buildHideCss,
    getSpicetify,
    isRowMarkedActive,
    findThisComputerRow,
    createExtension,
    createDefaultEnv,
  });

  // Test seam: when loaded as a CommonJS module, export the internals. Spotify's page has no `module`.
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = internals;
  }
  // Start whenever there is a DOM to attach to (always true inside Spotify; false in plain Node tests).
  if (typeof document !== "undefined") bootstrap();
})();
