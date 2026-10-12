"use strict";

/**
 * Deterministic virtual clock. Timers only run when a test calls advance()/step(),
 * so every race in the extension can be replayed exactly.
 */
class FakeClock {
  constructor() {
    this.t = 0;
    this.seq = 0;
    this.nextId = 1;
    /** @type {Map<number, {at: number, fn: () => void, period: number | null, seq: number}>} */
    this.timers = new Map();
    this.created = 0;
    this.fired = 0;
  }

  now() {
    return this.t;
  }

  api() {
    return {
      setTimeout: (fn, ms) => this.#add(fn, ms, null),
      clearTimeout: (id) => {
        this.timers.delete(id);
      },
      setInterval: (fn, ms) => this.#add(fn, ms, Math.max(1, Number(ms) || 1)),
      clearInterval: (id) => {
        this.timers.delete(id);
      },
    };
  }

  #add(fn, ms, period) {
    const id = this.nextId++;
    this.created++;
    this.timers.set(id, { at: this.t + Math.max(0, Number(ms) || 0), fn, period, seq: this.seq++ });
    return id;
  }

  pending() {
    return this.timers.size;
  }

  #next(limit) {
    let best = null;
    let bestId = 0;
    for (const [id, entry] of this.timers) {
      if (entry.at > limit) continue;
      if (best === null || entry.at < best.at || (entry.at === best.at && entry.seq < best.seq)) {
        best = entry;
        bestId = id;
      }
    }
    return best === null ? null : { id: bestId, entry: best };
  }

  #run({ id, entry }) {
    this.t = Math.max(this.t, entry.at);
    if (entry.period === null) {
      this.timers.delete(id);
    } else {
      entry.at = this.t + entry.period;
      entry.seq = this.seq++;
    }
    this.fired++;
    entry.fn();
  }

  /** Runs exactly one timer that is due at or before `limit`. Returns false if none was due. */
  step(limit = this.t) {
    const next = this.#next(limit);
    if (next === null) return false;
    this.#run(next);
    return true;
  }

  advance(ms) {
    const target = this.t + ms;
    let guard = 0;
    for (;;) {
      const next = this.#next(target);
      if (next === null) break;
      if (++guard > 200000) throw new Error("FakeClock: runaway timers (possible hot loop)");
      this.#run(next);
    }
    this.t = target;
  }
}

module.exports = { FakeClock };
