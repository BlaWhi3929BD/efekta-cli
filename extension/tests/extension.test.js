"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_DIR = path.resolve(__dirname, "..");
const CONTENT_SRC = fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8");
const INJECTED_SRC = fs.readFileSync(path.join(EXT_DIR, "injected.js"), "utf8");

function matchesSimpleSelector(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  const s = sel.trim();
  if (!s) return false;
  if (s === "*") return true;

  // Support basic compound parts: tag, .class, #id, [attr], [attr='v'], [attr^='v'], [attr*='v'], [attr$='v']
  let rem = s;
  const tagMatch = rem.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rem = rem.slice(tagMatch[0].length);
  }
  while (rem.length > 0) {
    if (rem.startsWith(".")) {
      const m = rem.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rem = rem.slice(m[0].length);
    } else if (rem.startsWith("#")) {
      const m = rem.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m || el.id !== m[1]) return false;
      rem = rem.slice(m[0].length);
    } else if (rem.startsWith("[")) {
      const m = rem.match(/^\[([a-zA-Z0-9_-]+)(?:(\^=|\*=|\$=|=)["']?([^"'\]]*)["']?)?\]/);
      if (!m) return false;
      const attrVal = el.getAttribute(m[1]);
      if (attrVal === null) return false;
      if (m[2] === "=") {
        if (attrVal !== m[3]) return false;
      } else if (m[2] === "^=") {
        if (!attrVal.startsWith(m[3])) return false;
      } else if (m[2] === "*=") {
        if (!attrVal.includes(m[3])) return false;
      } else if (m[2] === "$=") {
        if (!attrVal.endsWith(m[3])) return false;
      }
      rem = rem.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelectorList(el, selector) {
  const parts = selector.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.some((part) => {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) return matchesSimpleSelector(el, tokens[0]);
    if (tokens.length >= 2) {
      if (!matchesSimpleSelector(el, tokens[tokens.length - 1])) return false;
      let p = el.parentElement;
      const ancestorSel = tokens[tokens.length - 2];
      if (ancestorSel === ">") {
        return el.parentElement ? matchesSimpleSelector(el.parentElement, tokens[tokens.length - 3]) : false;
      }
      while (p) {
        if (matchesSimpleSelector(p, ancestorSel)) return true;
        p = p.parentElement;
      }
      return false;
    }
    return false;
  });
}

class FakeTextNode {
  constructor(value, parent) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentElement = parent;
    this.ownerDocument = parent ? parent.ownerDocument : null;
  }
}

class FakeElement {
  constructor(tag, opts = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = opts.id || "";
    this.className = opts.className || "";
    this._attrs = Object.assign({}, opts.attrs || {});
    if (this.id) this._attrs.id = this.id;
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.ownerDocument = opts.ownerDocument || null;
    this._computedStyle = opts.computedStyle || {
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      cursor: opts.cursor || "default"
    };
    this._rect = opts.rect || { left: 10, top: 10, width: 120, height: 36, right: 130, bottom: 46 };
    this.disabled = !!opts.disabled;
    this.value = opts.value;
    this.scrollTop = 0;
    this.scrollHeight = opts.scrollHeight || 100;
    this.clientHeight = opts.clientHeight || 100;
    this._onclick = opts.onclick || null;
    this._listeners = new Map();
    if (opts.text) {
      this.appendText(opts.text);
    }
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (...cs) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const c of cs) set.add(c);
        this.className = Array.from(set).join(" ");
      },
      remove: (...cs) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const c of cs) set.delete(c);
        this.className = Array.from(set).join(" ");
      }
    };
  }

  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur.tagName === "BODY" || cur.tagName === "HTML") return true;
      cur = cur.parentElement;
    }
    return false;
  }

  get innerText() {
    return this.textContent;
  }

  get textContent() {
    let out = "";
    for (const ch of this.childNodes) {
      out += ch.nodeType === 3 ? ch.nodeValue : ch.textContent;
    }
    return out;
  }

  set ownerDocument(doc) {
    this._doc = doc;
    if (this.childNodes) {
      for (const ch of this.childNodes) ch.ownerDocument = doc;
    }
  }

  get ownerDocument() {
    return this._doc;
  }

  appendText(text) {
    const t = new FakeTextNode(text, this);
    t.ownerDocument = this.ownerDocument;
    this.childNodes.push(t);
    return t;
  }

  appendChild(el) {
    if (el instanceof FakeElement) {
      el.parentElement = this;
      el.ownerDocument = this.ownerDocument;
      this.children.push(el);
      this.childNodes.push(el);
    }
    return el;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
      this.parentElement = null;
    }
  }

  getAttribute(name) {
    if (name === "class") return this.className || null;
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? String(this._attrs[name]) : null;
  }

  setAttribute(name, val) {
    this._attrs[name] = String(val);
    if (name === "class") this.className = String(val);
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name);
  }

  getBoundingClientRect() {
    return this._rect;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelectorList(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (matchesSelectorList(ch, selector)) results.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }

  dispatchEvent(ev) {
    const set = this._listeners.get(ev.type);
    if (set) {
      for (const fn of Array.from(set)) fn(ev);
    }
    return true;
  }

  click() {
    if (this._onclick) this._onclick(this);
  }

  focus() {}
  scrollIntoView() {}
}

function loadContentHarness(url = "https://learn.better.efekta.com/gap/ui/self-study/lesson-view") {
  const listeners = new Map();
  const runtimeSent = [];
  let messageHandler = null;
  const windowScrolls = [];

  const doc = {
    title: "Efekta Lesson",
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = listeners.get(ev.type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
      return true;
    },
    createElement(tag) {
      return new FakeElement(tag, { ownerDocument: doc });
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    elementFromPoint() {
      return null;
    },
    createTreeWalker(root, whatToShow, filter) {
      const flat = [];
      const traverse = (n) => {
        for (const ch of n.childNodes || []) {
          if (ch.nodeType === 1 && (whatToShow & 1)) flat.push(ch);
          if (ch.nodeType === 3 && (whatToShow & 4)) flat.push(ch);
          if (ch.nodeType === 1) traverse(ch);
        }
      };
      traverse(root);
      let idx = 0;
      return {
        nextNode() {
          while (idx < flat.length) {
            const candidate = flat[idx++];
            if (!filter || !filter.acceptNode) return candidate;
            const decision = filter.acceptNode(candidate);
            if (decision === 1) return candidate;
          }
          return null;
        }
      };
    }
  };

  doc.documentElement = new FakeElement("html", { ownerDocument: doc });
  doc.head = new FakeElement("head", { ownerDocument: doc });
  doc.body = new FakeElement("body", { ownerDocument: doc });
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.defaultView = null;

  const parsedUrl = new URL(url);
  const win = {
    location: {
      href: parsedUrl.href,
      pathname: parsedUrl.pathname,
      host: parsedUrl.host
    },
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle(el) {
      return (
        (el && el._computedStyle) || {
          display: "block",
          visibility: "visible",
          opacity: "1",
          pointerEvents: "auto",
          cursor: "default"
        }
      );
    },
    scrollBy(opts) {
      windowScrolls.push(opts && opts.top);
    },
    addEventListener() {},
    removeEventListener() {}
  };
  win.top = win;
  win.window = win;
  doc.defaultView = win;

  class CustomEventPolyfill {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  class EventPolyfill {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
    }
  }

  let speakTtsCalls = 0;
  let onMessageHook = null;
  const sandbox = {
    window: win,
    document: doc,
    location: win.location,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    CustomEvent: CustomEventPolyfill,
    Event: EventPolyfill,
    MouseEvent: EventPolyfill,
    PointerEvent: EventPolyfill,
    KeyboardEvent: EventPolyfill,
    InputEvent: EventPolyfill,
    FocusEvent: EventPolyfill,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
        sendMessage(msg, cb) {
          runtimeSent.push(msg);
          if (msg && msg.type === "SYNTH_TTS_B64") {
            speakTtsCalls++;
            if (cb) cb({ ok: true, b64: "QQ==", mime: "audio/mpeg", source: "tts" });
            return;
          }
          if (onMessageHook) {
            const custom = onMessageHook(msg);
            if (custom !== undefined) {
              if (cb) cb(custom);
              return;
            }
          }
          if (cb) cb({ ok: true });
        },
        onMessage: {
          addListener(fn) {
            messageHandler = fn;
          }
        }
      }
    }
  };
  win.document = doc;
  win.Event = EventPolyfill;

  vm.runInNewContext(CONTENT_SRC, sandbox, { filename: "content.js" });

  function dispatchCommand(req) {
    return new Promise((resolve) => {
      messageHandler(req, {}, resolve);
    });
  }

  return {
    doc,
    win,
    FakeElement,
    runtimeSent,
    windowScrolls,
    getSpeakTtsCalls: () => speakTtsCalls,
    setRuntimeHook(fn) {
      onMessageHook = fn;
    },
    dispatchCommand
  };
}

test("scroll up scrolls upward instead of ignoring direction when amount=400", async () => {
  const h = loadContentHarness();
  const panel = new h.FakeElement("div", {
    className: "scrollable-panel",
    scrollHeight: 1200,
    clientHeight: 400
  });
  panel.scrollTop = 600;
  h.doc.body.appendChild(panel);

  const upRes = await h.dispatchCommand({ action: "scroll", direction: "up", amount: 400 });
  assert.equal(upRes.success, true);
  assert.equal(panel.scrollTop, 200);
  assert.equal(h.windowScrolls[0], -400);

  const downRes = await h.dispatchCommand({ action: "scroll", direction: "down", amount: 250 });
  assert.equal(downRes.success, true);
  assert.equal(panel.scrollTop, 450);
  assert.equal(h.windowScrolls[1], 250);

  const negRes = await h.dispatchCommand({ action: "scroll", direction: "down", amount: -150 });
  assert.equal(negRes.success, true);
  assert.equal(panel.scrollTop, 300);
  assert.equal(h.windowScrolls[2], -150);
});

test("skip_speaking skips pronunciation drill instead of speaking via TTS", async () => {
  const h = loadContentHarness();
  let skipClicks = 0;

  const task = new h.FakeElement("ef-speaking-practice-task");
  const targetSpan = new h.FakeElement("span", { className: "target" });
  const ol = new h.FakeElement("ol");
  const li = new h.FakeElement("li");
  li.appendChild(new h.FakeElement("label", { className: "word", text: "Hello world" }));
  ol.appendChild(li);
  targetSpan.appendChild(ol);
  task.appendChild(targetSpan);

  const micBtn = new h.FakeElement("button", { className: "audio-recorder-btn", text: "Record" });
  task.appendChild(micBtn);

  const skipBtn = new h.FakeElement("button", {
    className: "skip-button",
    text: "Skip",
    onclick() {
      skipClicks++;
      task.remove();
    }
  });
  task.appendChild(skipBtn);
  h.doc.body.appendChild(task);

  const res = await h.dispatchCommand({ action: "skip_speaking" });
  assert.equal(res.success, true);
  assert.equal(skipClicks, 1);
  assert.equal(h.getSpeakTtsCalls(), 0);
  assert.match(res.message, /Skipped 1 pronunciation drill/);
});

test("contextText walker filters hidden elements without throwing ReferenceError on doc", async () => {
  const h = loadContentHarness();
  const p = new h.FakeElement("p");
  const visibleSpan = new h.FakeElement("span", {
    text: "Visible question sentence.",
    computedStyle: { display: "inline", visibility: "visible", opacity: "1" }
  });
  const hiddenSpan = new h.FakeElement("span", {
    text: "SECRET_HIDDEN_TEXT",
    computedStyle: { display: "none", visibility: "visible", opacity: "1" }
  });
  const invisibleOpacity = new h.FakeElement("span", {
    text: "OPACITY_ZERO_TEXT",
    computedStyle: { display: "inline", visibility: "visible", opacity: "0" }
  });
  p.appendChild(visibleSpan);
  p.appendChild(hiddenSpan);
  p.appendChild(invisibleOpacity);
  h.doc.body.appendChild(p);

  const res = await h.dispatchCommand({ action: "status" });
  assert.equal(res.success, true);
  const ctx = (res.data && res.data.contextText) || [];
  assert.ok(ctx.some((line) => line.includes("Visible question sentence.")));
  assert.equal(ctx.some((line) => line.includes("SECRET_HIDDEN_TEXT")), false);
  assert.equal(ctx.some((line) => line.includes("OPACITY_ZERO_TEXT")), false);
});

test("autopilot treats order_dialogue as interactive and recognizes draggable matching_pairs", async () => {
  const h = loadContentHarness();
  const seq = new h.FakeElement("ef-sequencing-task");
  seq.appendChild(
    new h.FakeElement("div", {
      className: "cdk-drag",
      attrs: { draggable: "true" },
      text: "Hello there, how can I help?"
    })
  );
  seq.appendChild(
    new h.FakeElement("div", {
      className: "cdk-drag",
      attrs: { draggable: "true" },
      text: "I would like to book a room."
    })
  );
  h.doc.body.appendChild(seq);

  const res = await h.dispatchCommand({ action: "autopilot", target: "2" });
  assert.equal(res.success, true);
  assert.equal(res.needsAgent, true);
  assert.equal(res.stoppedAt, "order_dialogue");
});

test("executeLesson does not emit NAVIGATE_TAB while closing inside lesson view", async () => {
  const h = loadContentHarness("https://learn.better.efekta.com/gap/ui/self-study/lesson-view");
  let closeClicked = false;

  const unitSection = new h.FakeElement("div", {
    attrs: { "data-id": "selfStudy-level-view-list-section-unit-1" }
  });
  unitSection.appendChild(new h.FakeElement("h2", { attrs: { "data-id": "unit-1" }, text: "Unit 1" }));
  const card = new h.FakeElement("div", { attrs: { role: "link", "aria-label": "Lesson 1 of 4, Greetings" } });
  card.appendChild(new h.FakeElement("h3", { attrs: { "data-id": "u1l1-title" }, text: "Greetings" }));
  unitSection.appendChild(card);

  const player = new h.FakeElement("ef-lesson-player");
  const closeBtn = new h.FakeElement("button", {
    className: "close-button",
    text: "Close",
    onclick() {
      closeClicked = true;
      player.remove();
      h.win.location.pathname = "/gap/ui/self-study";
      h.doc.body.appendChild(unitSection);
    }
  });
  player.appendChild(closeBtn);
  h.doc.body.appendChild(player);

  const res = await h.dispatchCommand({ action: "lesson", target: "close" });
  assert.equal(res.success, true);
  assert.equal(closeClicked, true);
  assert.equal(h.runtimeSent.some((m) => m && m.type === "NAVIGATE_TAB"), false);
});

test("eval rejects arbitrary page:/js: JavaScript execution", async () => {
  const h = loadContentHarness();
  const res = await h.dispatchCommand({ action: "eval", target: "js: return 1 + 1;" });
  assert.equal(res.success, false);
  assert.match(res.error, /disabled/i);

  const resPage = await h.dispatchCommand({ action: "eval", target: "page: alert(1)" });
  assert.equal(resPage.success, false);
  assert.match(resPage.error, /disabled/i);
});

test("executeSpeak('all') continues beyond phrase 4 on 6-phrase drills", async () => {
  const h = loadContentHarness();
  let phraseIdx = 1;
  const totalPhrases = 6;
  const spokenHistory = [];

  const task = new h.FakeElement("ef-speaking-practice-task");
  const targetSpan = new h.FakeElement("span", { className: "target" });
  const ol = new h.FakeElement("ol");
  const wordLabel = new h.FakeElement("label", { className: "word", text: "Phrase 1" });
  ol.appendChild(new h.FakeElement("li")).appendChild(wordLabel);
  targetSpan.appendChild(ol);
  task.appendChild(targetSpan);

  const progressEl = new h.FakeElement("span", { className: "question-options-heading", text: "1 / 6" });
  task.appendChild(progressEl);
  const micBtn = new h.FakeElement("button", { className: "audio-recorder-btn speech-action-control", text: "Record" });
  task.appendChild(micBtn);
  const nextBtn = new h.FakeElement("button", {
    className: "next-task-button",
    text: "Next",
    disabled: true,
    onclick() {
      if (phraseIdx < totalPhrases) {
        phraseIdx++;
        wordLabel.childNodes[0].nodeValue = `Phrase ${phraseIdx}`;
        progressEl.childNodes[0].nodeValue = `${phraseIdx} / ${totalPhrases}`;
        micBtn.classList.remove("correct");
        nextBtn.disabled = true;
      }
    }
  });
  task.appendChild(nextBtn);
  h.doc.body.appendChild(task);

  // Wire bridge listener inside the same harness to emulate injected.js completing voice injection
  h.doc.addEventListener("efekta:in", (ev) => {
    const req = JSON.parse(ev.detail);
    const reply = { reqId: req.reqId, ok: true };
    if (req.type === "prepareAudio") {
      reply.durationMs = 50;
      reply.source = "tts";
    } else if (req.type === "arm") {
      reply.id = phraseIdx;
    } else if (req.type === "click") {
      spokenHistory.push(wordLabel.textContent);
      micBtn.classList.add("correct");
      nextBtn.disabled = false;
    } else if (req.type === "status") {
      reply.session = { id: phraseIdx, stoppedByPage: true, playEndedAt: Date.now() };
    }
    h.doc.dispatchEvent({ type: "efekta:out", detail: JSON.stringify(reply) });
  });

  const res = await h.dispatchCommand({ action: "speak", target: "all" });
  assert.equal(res.success, true);
  assert.equal(spokenHistory.length, 6);
  assert.deepEqual(spokenHistory, [
    "Phrase 1",
    "Phrase 2",
    "Phrase 3",
    "Phrase 4",
    "Phrase 5",
    "Phrase 6"
  ]);
});

test("Voice Engine injected.js closes AudioContext and stops tracks cleanly on disarm", async () => {
  const docListeners = new Map();
  const closedCtxCount = { closed: 0, tracksStopped: 0 };

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = "running";
      this.currentTime = 0;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
      closedCtxCount.closed++;
      return Promise.resolve();
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1.5, sampleRate: 48000 });
    }
    createMediaStreamDestination() {
      return {
        stream: {
          getTracks: () => [
            {
              stop() {
                closedCtxCount.tracksStopped++;
              }
            }
          ],
          getAudioTracks: () => [{}]
        }
      };
    }
    createBufferSource() {
      return {
        connect() {},
        start() {}
      };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
  }

  const fakeDoc = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    dispatchEvent(ev) {
      const set = docListeners.get(ev.type);
      if (set) {
        for (const fn of Array.from(set)) fn(ev);
      }
      return true;
    },
    querySelectorAll: () => [],
    querySelector: () => null
  };

  const fakeWin = {
    location: { href: "https://learn.better.efekta.com/" },
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    addEventListener() {},
    fetch: () => Promise.reject(new Error("no network in unit test"))
  };
  fakeWin.window = fakeWin;

  const sandbox = {
    window: fakeWin,
    document: fakeDoc,
    location: fakeWin.location,
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [] })
      }
    },
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL() {}
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    XMLHttpRequest: undefined,
    HTMLMediaElement: undefined,
    AudioBufferSourceNode: undefined,
    MediaRecorder: undefined,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    WeakMap,
    WeakSet,
    setTimeout,
    clearTimeout,
    Date,
    Math
  };

  vm.runInNewContext(INJECTED_SRC, sandbox, { filename: "injected.js" });

  function sendBridge(msg) {
    return new Promise((resolve) => {
      const reqId = `req-${Math.random()}`;
      const onOut = (ev) => {
        const d = JSON.parse(ev.detail);
        if (d.reqId === reqId) {
          docListeners.get("efekta:out").delete(onOut);
          resolve(d);
        }
      };
      fakeDoc.addEventListener("efekta:out", onOut);
      fakeDoc.dispatchEvent({
        type: "efekta:in",
        detail: JSON.stringify(Object.assign({}, msg, { reqId }))
      });
    });
  }

  const prepRes = await sendBridge({ type: "prepareAudio", b64: "QQ==", source: "tts" });
  assert.equal(prepRes.ok, true);

  const armRes = await sendBridge({ type: "arm", leadMs: 50, tailMs: 500, timeoutMs: 5000 });
  assert.equal(armRes.ok, true);

  // Simulate Efekta calling getUserMedia while armed
  await fakeWin.window === fakeWin;
  await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });

  // Disarm must close the AudioContext immediately without returning early on s.closed
  const disarmRes = await sendBridge({ type: "disarm" });
  assert.equal(disarmRes.ok, true);
  assert.equal(closedCtxCount.closed, 1);

  // eval message type must no longer be supported in injected.js
  const evalRes = await sendBridge({ type: "eval", code: "return 42" });
  assert.equal(evalRes.ok, false);
  assert.match(evalRes.error, /Unknown voice bridge message/);
});
