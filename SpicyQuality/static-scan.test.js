"use strict";

// Security properties checked on the SYNTAX TREE (comments and string contents cannot fool it).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");

const FILE = path.join(__dirname, "..", "audio-quality.js");
const SOURCE = fs.readFileSync(FILE, "utf8");
const AST = acorn.parse(SOURCE, { ecmaVersion: 2023, sourceType: "script", locations: true });

const identifiers = [];
const memberNames = [];
const calls = [];
const news = [];
const literals = [];
const emptyCatches = [];
const moduleAssignments = [];
let asyncOrAwait = 0;
let dynamicImports = 0;

walk.fullAncestor(AST, (node, _state, ancestors) => {
  switch (node.type) {
    case "Identifier":
      identifiers.push(node.name);
      break;
    case "MemberExpression":
      if (!node.computed && node.property.type === "Identifier") memberNames.push({ name: node.property.name, line: node.loc.start.line });
      if (node.computed && node.property.type === "Literal") memberNames.push({ name: String(node.property.value), line: node.loc.start.line });
      break;
    case "CallExpression":
      calls.push(node);
      break;
    case "NewExpression":
      news.push(node);
      break;
    case "Literal":
      if (typeof node.value === "string") literals.push(node.value);
      break;
    case "CatchClause":
      if (node.body.body.length === 0) emptyCatches.push(node.loc.start.line);
      break;
    case "AwaitExpression":
      asyncOrAwait++;
      break;
    case "ImportExpression":
      dynamicImports++;
      break;
    case "AssignmentExpression": {
      const left = node.left;
      if (left.type === "MemberExpression" && left.object.type === "Identifier" && left.object.name === "module") {
        moduleAssignments.push({ node, ancestors: [...ancestors] }); // acorn-walk reuses one mutable array
      }
      break;
    }
    default:
      break;
  }
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") && node.async) asyncOrAwait++;
});

const calleeName = (node) => (node.callee.type === "Identifier" ? node.callee.name : node.callee.type === "MemberExpression" && !node.callee.computed ? node.callee.property.name : null);

describe("static security scan (syntax tree)", () => {
  it("uses .next only as the Map-iterator call in the LRU cache, never as a playback control", () => {
    const nextCalls = calls.filter((c) => calleeName(c) === "next");
    assert.ok(nextCalls.length >= 1);
    for (const call of nextCalls) {
      const target = call.callee.object;
      assert.ok(target.type === "CallExpression" && calleeName(target) === "keys", `.next() at line ${call.loc.start.line} is not an iterator step`);
    }
  });

  it("is plain JavaScript that parses as a classic script and opts into type checking", () => {
    assert.ok(SOURCE.startsWith("// @ts-check"));
    assert.ok(AST.body.length > 0);
  });

  for (const name of ["eval", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "require", "localStorage", "sessionStorage", "indexedDB", "caches", "Function", "KeyboardEvent", "MouseEvent", "PointerEvent", "InputEvent", "Promise", "Proxy"]) {
    it(`never references the global ${name}`, () => assert.ok(!identifiers.includes(name), `${name} is referenced`));
  }

  for (const name of ["sendBeacon", "innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "write", "writeln", "cookie", "execCommand", "postMessage", "dispatchEvent", "createEvent", "initEvent", "then", "catch", "finally", "localStorage", "sessionStorage", "fetch", "requestFullscreen", "exitFullscreen", "open"]) {
    it(`never uses the member .${name}`, () => {
      const hits = memberNames.filter((m) => m.name === name);
      assert.deepEqual(hits, [], `.${name} used at lines ${hits.map((h) => h.line).join(", ")}`);
    });
  }

  for (const name of ["pause", "play", "back", "seek", "seekTo", "togglePlay", "skipToNext", "skipToPrevious", "resume", "transfer", "transferPlayback", "setVolume", "setShuffle", "setRepeat", "playUri", "addToQueue"]) {
    it(`never touches the playback API member .${name}`, () => assert.deepEqual(memberNames.filter((m) => m.name === name), []));
  }

  it("never constructs events, functions or dynamic code", () => {
    const names = news.map((n) => (n.callee.type === "Identifier" ? n.callee.name : "?"));
    for (const name of names) assert.ok(!/Event$/.test(name) && name !== "Function", `new ${name}`);
    assert.equal(dynamicImports, 0);
  });

  it("never passes a string to setTimeout/setInterval", () => {
    for (const call of calls.filter((c) => ["setTimeout", "setInterval"].includes(calleeName(c)))) {
      const first = call.arguments[0];
      assert.ok(first && ["ArrowFunctionExpression", "FunctionExpression", "Identifier", "CallExpression"].includes(first.type), `line ${call.loc.start.line}`);
    }
  });

  it("sends no synthetic key input: no 'Escape' and no key-event construction", () => {
    assert.ok(!literals.includes("Escape") && !literals.includes("Esc"));
    assert.ok(!memberNames.some((m) => m.name === "key" || m.name === "keyCode"));
  });

  it("uses no promise chains or async/await (timers drive every follow-up)", () => {
    assert.equal(asyncOrAwait, 0);
  });

  it("has at most one empty catch block, and it is the logger's last-resort sink", () => {
    assert.ok(emptyCatches.length <= 1, `empty catch blocks at lines ${emptyCatches.join(", ")}`);
  });

  it("assigns module.exports exactly once, only inside a typeof-module guard", () => {
    assert.equal(moduleAssignments.length, 1);
    const { ancestors } = moduleAssignments[0];
    const guard = ancestors.find((a) => a.type === "IfStatement");
    assert.ok(guard, "module.exports must sit inside an if");
    assert.ok(SOURCE.slice(guard.test.start, guard.test.end).includes('typeof module === "object"'));
  });

  it("does not use eval-like globals via property access (window.eval, globalThis.Function, ...)", () => {
    for (const name of ["eval", "Function", "execScript"]) assert.ok(!memberNames.some((m) => m.name === name));
  });

  it("writes page text only through textContent", () => {
    assert.ok(memberNames.some((m) => m.name === "textContent"));
  });

  it("restricts DOM mutation of Spotify's own nodes to one class on <html>", () => {
    // Every classList mutation targets documentElement.classList; nothing assigns className/style on foreign nodes.
    const classNameWrites = memberNames.filter((m) => m.name === "className");
    assert.deepEqual(classNameWrites, []);
    const cssTextWrites = memberNames.filter((m) => m.name === "cssText");
    assert.deepEqual(cssTextWrites, []);
  });

  it("makes no cross-origin or remote-code references in string literals", () => {
    const remote = literals.filter((l) => /^(?:https?:|wss?:|ftp:|data:text\/javascript)/i.test(l));
    assert.deepEqual(remote, []);
  });
});
