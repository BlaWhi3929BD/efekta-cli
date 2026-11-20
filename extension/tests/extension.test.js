"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_DIR = path.resolve(__dirname, "..");
const BACKGROUND_SRC = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
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
    } else if (rem.startsWith(":not(")) {
      const endIdx = rem.indexOf(")");
      if (endIdx === -1) return false;
      const inner = rem.slice(5, endIdx);
      if (matchesSimpleSelector(el, inner)) return false;
      rem = rem.slice(endIdx + 1);
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

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
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

  // Disarm must close the AudioContext and stop synthetic stream tracks immediately
  const disarmRes = await sendBridge({ type: "disarm" });
  assert.equal(disarmRes.ok, true);
  assert.equal(closedCtxCount.closed, 1);
  assert.equal(closedCtxCount.tracksStopped, 1);

  // eval message type must no longer be supported in injected.js
  const evalRes = await sendBridge({ type: "eval", code: "return 42" });
  assert.equal(evalRes.ok, false);
  assert.match(evalRes.error, /Unknown voice bridge message/);
});

test("Voice Engine injected.js tracks MediaRecorder.stop, isolates own nodes, cleans prior session on re-arm, and validates cdkSort IDs", async () => {
  const docListeners = new Map();
  let closedCtxs = 0;

  class FakeAudioBufferSourceNode {
    constructor() {
      this.buffer = null;
    }
    addEventListener() {}
    connect() {}
    start() {}
  }

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
      closedCtxs++;
      return Promise.resolve();
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1.2, sampleRate: 48000 });
    }
    createMediaStreamDestination() {
      return {
        stream: {
          getTracks: () => [{ stop() {} }],
          getAudioTracks: () => [{ stop() {} }]
        }
      };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createBufferSource() {
      return new FakeAudioBufferSourceNode();
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
  }

  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
    }
  }

  const fakeDoc = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    dispatchEvent(ev) {
      const set = docListeners.get(ev.type);
      if (set) for (const fn of Array.from(set)) fn(ev);
      return true;
    },
    querySelectorAll: () => [
      { getAttribute: () => "item-1", focus() {} },
      { getAttribute: () => "item-2", focus() {} }
    ],
    querySelector: () => null
  };

  const fakeWin = {
    location: { href: "https://learn.better.efekta.com/" },
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    AudioBufferSourceNode: FakeAudioBufferSourceNode,
    MediaRecorder: FakeMediaRecorder,
    addEventListener() {},
    fetch: () => Promise.reject(new Error("no network"))
  };
  fakeWin.window = fakeWin;

  const sandbox = {
    window: fakeWin,
    document: fakeDoc,
    location: fakeWin.location,
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [], getAudioTracks: () => [{}] })
      }
    },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    XMLHttpRequest: undefined,
    HTMLMediaElement: undefined,
    AudioBufferSourceNode: FakeAudioBufferSourceNode,
    MediaRecorder: FakeMediaRecorder,
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

  await sendBridge({ type: "prepareAudio", b64: "QQ==", source: "tts" });
  await sendBridge({ type: "arm", leadMs: 20, tailMs: 200, timeoutMs: 5000 });

  const stream = await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new fakeWin.AudioContext();
  ctx.createMediaStreamSource(stream);

  // Own injected pageSrc must NOT pollute lastAudioPlayback
  const st1 = await sendBridge({ type: "status" });
  assert.equal(st1.lastAudioPlayback, null);

  // MediaRecorder.stop() must mark session.stoppedByPage = true
  const rec = new fakeWin.MediaRecorder(stream);
  rec.start();
  rec.stop();
  const st2 = await sendBridge({ type: "status" });
  assert.equal(st2.session.stoppedByPage, true);

  // Re-arming without disarm must clean up the previous session's AudioContext
  await sendBridge({ type: "arm", leadMs: 20, tailMs: 200, timeoutMs: 5000 });
  assert.equal(closedCtxs, 1);

  // cdkSort with missing srcId must NOT silently swap items[0] and items[1]
  const sortRes = await sendBridge({ type: "cdkSort", srcId: "item-99", dstId: "item-2" });
  assert.equal(sortRes.ok, true);
  assert.equal(sortRes.result, false);

  await sendBridge({ type: "disarm" });
});

function loadBackgroundHarness(opts = {}) {
  const tabs = opts.tabs || [];
  let onMessageListener = null;
  let onRemovedListener = null;
  const sentMessages = [];
  const fetchCalls = [];
  let injectCount = 0;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.lastInstance = this;
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) this.onclose();
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const sandbox = {
    URL,
    Uint8Array,
    Map,
    Set,
    Promise,
    Date,
    console: { log() {} },
    navigator: { userAgent: "TestBrowser/1.0" },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    WebSocket: FakeWebSocket,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (opts.onFetch) return await opts.onFetch(url, init);
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "audio/mpeg" : "") },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
      };
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(fn) {
            onMessageListener = fn;
          }
        }
      },
      tabs: {
        query: async () => tabs,
        get: async (id) => tabs.find((t) => t.id === id) || null,
        update: async () => ({}),
        sendMessage(tabId, req, options, cb) {
          sentMessages.push({ tabId, req, options });
          const reply = opts.onSendMessage ? opts.onSendMessage(tabId, req, options, injectCount) : { success: true };
          cb(reply);
        },
        onUpdated: { addListener() {} },
        onRemoved: {
          addListener(fn) {
            onRemovedListener = fn;
          }
        }
      },
      scripting: {
        executeScript: async () => {
          injectCount++;
        }
      },
      webNavigation: {
        getAllFrames(details, cb) {
          cb(opts.getFrames ? opts.getFrames(injectCount) : [{ frameId: 0, url: "https://learn.better.efekta.com/" }]);
        }
      },
      alarms: {
        create() {},
        onAlarm: { addListener() {} }
      }
    }
  };

  vm.runInNewContext(BACKGROUND_SRC, sandbox, { filename: "background.js" });

  return {
    sandbox,
    FakeWebSocket,
    sentMessages,
    fetchCalls,
    getInjectCount: () => injectCount,
    triggerRemoved: (tabId) => onRemovedListener && onRemovedListener(tabId),
    sendRuntimeMessage(msg, sender = {}) {
      return new Promise((resolve) => {
        const ret = onMessageListener(msg, sender, resolve);
        if (ret !== true) {
          // Synchronous response already called or ignored
          setTimeout(() => resolve(undefined), 10);
        }
      });
    }
  };
}

test("background.js findEfektaTab rejects spoofed query/HTTP URLs and routes to real Efekta tab", async () => {
  const h = loadBackgroundHarness({
    tabs: [
      { id: 1, active: true, url: "https://evil.com/?q=learn.better.efekta.com" },
      { id: 2, active: false, url: "http://learn.better.efekta.com/insecure" },
      { id: 3, active: false, url: "https://learn.better.efekta.com/gap/ui/self-study" }
    ]
  });

  const res = await h.sendRuntimeMessage({ type: "POPUP_GET_STATUS" });
  assert.equal(res.hasEfektaTab, true);
  assert.equal(res.tabUrl, "https://learn.better.efekta.com/gap/ui/self-study");
});

test("background.js sendMessageToTabWithRetry executes pass 1 after reinjecting on empty top frame", async () => {
  const h = loadBackgroundHarness({
    tabs: [{ id: 10, active: true, url: "https://learn.better.efekta.com/gap/ui/self-study/lesson-view" }],
    getFrames: (injectCount) =>
      injectCount > 0
        ? [
            { frameId: 0, url: "https://learn.better.efekta.com/gap/ui/self-study/lesson-view" },
            { frameId: 7, url: "https://study.better.efekta.com/lesson-player/1" }
          ]
        : [{ frameId: 0, url: "https://learn.better.efekta.com/gap/ui/self-study/lesson-view" }],
    onSendMessage: (tabId, req, options) => {
      if (options.frameId === 0) {
        return { success: true, data: { elementsCount: 0, exerciseType: "unknown" } };
      }
      if (options.frameId === 7) {
        return { success: true, data: { elementsCount: 4, exerciseType: "multiple_choice" } };
      }
      return { success: false, error: "unexpected frame" };
    }
  });

  const ws = h.FakeWebSocket.lastInstance;
  await ws.onmessage({ data: JSON.stringify({ id: "req-1", action: "status" }) });
  assert.ok(h.getInjectCount() >= 1);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].success, true);
  assert.equal(ws.sent[0].data.exerciseType, "multiple_choice");
});

test("background.js FETCH_AUDIO_B64 blocks private/non-audio/oversized fetches and omits credentials", async () => {
  const h = loadBackgroundHarness({
    onFetch: async (url) => {
      if (url.includes("json-endpoint")) {
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : "") },
          arrayBuffer: async () => Uint8Array.from([123, 125]).buffer
        };
      }
      if (url.includes("huge.mp3")) {
        return {
          ok: true,
          status: 200,
          url,
          headers: {
            get: (k) =>
              k.toLowerCase() === "content-type"
                ? "audio/mpeg"
                : k.toLowerCase() === "content-length"
                ? String(9 * 1024 * 1024)
                : ""
          },
          arrayBuffer: async () => new ArrayBuffer(0)
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (k) => (k.toLowerCase() === "content-type" ? "audio/mpeg" : "") },
        arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer
      };
    }
  });

  const rHttp = await h.sendRuntimeMessage({ type: "FETCH_AUDIO_B64", url: "http://cdn.efekta.com/a.mp3" });
  assert.equal(rHttp.ok, false);

  const rPriv = await h.sendRuntimeMessage({ type: "FETCH_AUDIO_B64", url: "https://127.0.0.1/secret.mp3" });
  assert.equal(rPriv.ok, false);

  const rJson = await h.sendRuntimeMessage({ type: "FETCH_AUDIO_B64", url: "https://cdn.efekta.com/json-endpoint" });
  assert.equal(rJson.ok, false);
  assert.match(rJson.error, /non-audio/i);

  const rHuge = await h.sendRuntimeMessage({ type: "FETCH_AUDIO_B64", url: "https://cdn.efekta.com/huge.mp3" });
  assert.equal(rHuge.ok, false);
  assert.match(rHuge.error, /8MB/i);

  const rGood = await h.sendRuntimeMessage({ type: "FETCH_AUDIO_B64", url: "https://cdn.efekta.com/good.mp3" });
  assert.equal(rGood.ok, true);
  assert.equal(rGood.b64, "QUJD");
  const goodFetch = h.fetchCalls.find((c) => c.url === "https://cdn.efekta.com/good.mp3");
  assert.equal(goodFetch.init.credentials, "omit");
});

test("Progress Test stops autopilot on non-MC tasks and never skips on Next or guesses gaps", async () => {
  // 1. Tap-sequencing inside Progress Test must stop autopilot
  const h1 = loadContentHarness();
  const testHeader = new h1.FakeElement("ef-test-header", { text: "Progress Test" });
  const seq = new h1.FakeElement("ef-sequencing-tap-option-task");
  const ol = new h1.FakeElement("ol", { className: "ordered-item-container" });
  const ul = new h1.FakeElement("ul", { className: "unordered-item-container" });
  ul.appendChild(new h1.FakeElement("button", { className: "item", text: "Hello" }));
  ul.appendChild(new h1.FakeElement("button", { className: "item", text: "world." }));
  seq.appendChild(ol);
  seq.appendChild(ul);
  h1.doc.body.appendChild(testHeader);
  h1.doc.body.appendChild(seq);

  const autoRes = await h1.dispatchCommand({ action: "autopilot", target: "3" });
  assert.equal(autoRes.success, true);
  assert.equal(autoRes.needsAgent, true);
  assert.match(autoRes.message, /Progress Test/i);

  // 2. Progress Test choice with enabled Next button must still stop executeAutoNext after advancing to it
  const h2 = loadContentHarness();
  h2.doc.body.appendChild(new h2.FakeElement("ef-test-header", { text: "Progress Test" }));
  let qNum = 1;
  const q1Opt = new h2.FakeElement("button", { className: "option-button not-assessed", text: "Option A" });
  const q2Opt = new h2.FakeElement("button", { className: "option-button not-assessed", text: "Option B" });
  const nextBtn = new h2.FakeElement("button", {
    className: "next-task-button",
    text: "Next",
    onclick() {
      qNum++;
    }
  });
  h2.doc.body.appendChild(q1Opt);
  h2.doc.body.appendChild(q2Opt);
  h2.doc.body.appendChild(nextBtn);

  const nextRes = await h2.dispatchCommand({ action: "next" });
  assert.equal(nextRes.success, true);
  assert.equal(qNum, 2, "must click Next once to reach Q2 and STOP, never skipping Q2+!");
});

test("solveMultipleChoice clicks Check button instead of exiting early when wrong option enables Check", async () => {
  const h = loadContentHarness();
  let selectedOpt = null;
  let checkedCount = 0;

  const feedbackEl = new h.FakeElement("div", { className: "feedback", text: "" });
  const checkBtn = new h.FakeElement("button", {
    className: "next-task-button",
    text: "Check",
    disabled: true,
    onclick() {
      checkedCount++;
      if (selectedOpt === "wrong") {
        opt1.classList.add("incorrect");
        feedbackEl.className = "feedback incorrect";
        feedbackEl.childNodes = [];
        feedbackEl.appendText("Try again");
      } else if (selectedOpt === "right") {
        opt2.classList.add("correct");
        feedbackEl.className = "feedback correct";
        feedbackEl.childNodes = [];
        feedbackEl.appendText("Well done!");
        checkBtn.childNodes = [];
        checkBtn.appendText("Next");
      }
    }
  });
  const opt1 = new h.FakeElement("button", {
    className: "option-button",
    text: "Wrong Answer",
    onclick() {
      selectedOpt = "wrong";
      checkBtn.disabled = false;
    }
  });
  const opt2 = new h.FakeElement("button", {
    className: "option-button",
    text: "Right Answer",
    onclick() {
      selectedOpt = "right";
      checkBtn.disabled = false;
    }
  });

  h.doc.body.appendChild(opt1);
  h.doc.body.appendChild(opt2);
  h.doc.body.appendChild(checkBtn);
  h.doc.body.appendChild(feedbackEl);

  const res = await h.dispatchCommand({ action: "solve_choice" });
  assert.equal(res.success, true);
  assert.equal(selectedOpt, "right");
  assert.equal(checkedCount, 2);
});

test("hidden .summary-wp does not mask interactive exercise in autopilot", async () => {
  const h = loadContentHarness();
  const hiddenSummary = new h.FakeElement("div", {
    className: "summary-wp",
    computedStyle: { display: "none", visibility: "hidden", opacity: "0" },
    rect: { left: 0, top: 0, width: 0, height: 0 }
  });
  const seq = new h.FakeElement("ef-sequencing-task");
  seq.appendChild(new h.FakeElement("div", { className: "cdk-drag", attrs: { draggable: "true" }, text: "First turn" }));
  seq.appendChild(new h.FakeElement("div", { className: "cdk-drag", attrs: { draggable: "true" }, text: "Second turn" }));
  h.doc.body.appendChild(hiddenSummary);
  h.doc.body.appendChild(seq);

  const res = await h.dispatchCommand({ action: "autopilot", target: "2" });
  assert.equal(res.success, true);
  assert.equal(res.needsAgent, true);
  assert.equal(res.stoppedAt, "order_dialogue");
});

test("executeDialogue exits promptly when no options or video are present", async () => {
  const h = loadContentHarness();
  const start = Date.now();
  const res = await h.dispatchCommand({ action: "dialogue", target: "" });
  const elapsed = Date.now() - start;
  assert.equal(res.success, false);
  assert.match(res.error || res.message, /No dialogue response options/i);
  assert.ok(elapsed < 6000, `expected quick bounded exit, took ${elapsed}ms`);
});

test("executeGaps preserves possessive apostrophes and splits entries cleanly", async () => {
  const h = loadContentHarness();
  const typed = [];
  const inp1 = new h.FakeElement("input", { attrs: { type: "text" } });
  const inp2 = new h.FakeElement("input", { attrs: { type: "text" } });
  h.doc.body.appendChild(inp1);
  h.doc.body.appendChild(inp2);

  const res = await h.dispatchCommand({ action: "gaps", target: "students', teachers'" });
  assert.equal(res.success, true);
  typed.push(inp1.value, inp2.value);
  assert.deepEqual(typed, ["students'", "teachers'"]);
});

test("executeSequence handles duplicate tokens in multi-word pool", async () => {
  const h = loadContentHarness();
  const container = new h.FakeElement("ef-sequencing-tap-option-task");
  const ordered = new h.FakeElement("ol", { className: "ordered-item-container" });
  const unordered = new h.FakeElement("ul", { className: "unordered-item-container" });
  const clickedWords = [];

  for (const word of ["I want", "to", "go", "to", "the park."]) {
    const btn = new h.FakeElement("button", {
      className: "item",
      text: word,
      onclick(self) {
        clickedWords.push(word);
        self.remove();
        ordered.appendChild(self);
      }
    });
    unordered.appendChild(btn);
  }
  container.appendChild(ordered);
  container.appendChild(unordered);
  h.doc.body.appendChild(container);

  const res = await h.dispatchCommand({ action: "sequence", target: "I want to go to the park." });
  assert.equal(res.success, true);
  assert.deepEqual(clickedWords, ["I want", "to", "go", "to", "the park."]);
});

test("eval rejects uppercase/whitespace JS:/PAGE: and empty batch returns error", async () => {
  const h = loadContentHarness();
  const r1 = await h.dispatchCommand({ action: "eval", target: "  JS: return 1" });
  assert.equal(r1.success, false);
  const r2 = await h.dispatchCommand({ action: "eval", target: "PAGE: alert(1)" });
  assert.equal(r2.success, false);
  const r3 = await h.dispatchCommand({ action: "batch", commands: [] });
  assert.equal(r3.success, false);
  assert.match(r3.error, /empty/i);
});

test("executeLesson resumes from /gap/ui/home directly into lesson view", async () => {
  const h = loadContentHarness("https://learn.better.efekta.com/gap/ui/home");
  let clickedContinue = false;
  const contBtn = new h.FakeElement("button", {
    text: "Continue lesson",
    onclick() {
      clickedContinue = true;
      h.win.location.pathname = "/gap/ui/self-study/lesson-view";
      h.doc.body.appendChild(new h.FakeElement("ef-lesson-player"));
    }
  });
  h.doc.body.appendChild(contBtn);

  const res = await h.dispatchCommand({ action: "lesson", target: "resume" });
  assert.equal(res.success, true);
  assert.equal(clickedContinue, true);
  assert.match(res.message, /Resumed active lesson/i);
});

test("regular lesson .option-button.not-assessed is NOT Progress Test and deduplicates tap-option wrappers", async () => {
  const h = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  let pickedRight = false;

  const instr = new h.FakeElement("h3", { text: "View activity instructions" });
  const dbg = new h.FakeElement("p", { text: "Debugging details" });
  const moreBtn = new h.FakeElement("button", { className: "more-options-button", text: "" });
  const nextBtn = new h.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });

  const wrap1 = new h.FakeElement("ef-multiple-choice-tap-task-response-option", { className: "tap-option" });
  const opt1 = new h.FakeElement("button", {
    className: "option-button not-assessed",
    text: "Wrong choice",
    onclick() {
      opt1.classList.add("incorrect");
    }
  });
  wrap1.appendChild(opt1);

  const wrap2 = new h.FakeElement("ef-multiple-choice-tap-task-response-option", { className: "tap-option" });
  const opt2 = new h.FakeElement("button", {
    className: "option-button not-assessed",
    text: "Right choice",
    onclick() {
      pickedRight = true;
      opt2.classList.add("correct");
      nextBtn.disabled = false;
    }
  });
  wrap2.appendChild(opt2);

  h.doc.body.appendChild(instr);
  h.doc.body.appendChild(dbg);
  h.doc.body.appendChild(moreBtn);
  h.doc.body.appendChild(wrap1);
  h.doc.body.appendChild(wrap2);
  h.doc.body.appendChild(nextBtn);

  const st = await h.dispatchCommand({ action: "status" });
  assert.equal(st.success, true);
  assert.equal(st.data.isProgressTest, false);
  assert.equal(st.data.exerciseType, "multiple_choice");
  assert.deepEqual(Array.from(st.data.agentHint.options), ["opt-1: Wrong choice", "opt-2: Right choice"]);
  assert.equal(st.data.prompt, "");
  assert.equal(st.data.contextText.includes("Debugging details"), false);

  const sol = await h.dispatchCommand({ action: "solve_choice" });
  assert.equal(sol.success, true);
  assert.equal(pickedRight, true);
});

test("table contextText includes rows/inputs, excludes column-header slots, and executeGaps clicks button.typing-status", async () => {
  const h = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const committed = [];

  const table = new h.FakeElement("table");
  const hdrRow = new h.FakeElement("tr");
  const th1 = new h.FakeElement("th");
  th1.appendChild(new h.FakeElement("ef-stimulus", { className: "column-header", text: "Verb" }));
  const th2 = new h.FakeElement("th");
  th2.appendChild(new h.FakeElement("ef-stimulus", { className: "column-header", text: "Noun" }));
  hdrRow.appendChild(th1);
  hdrRow.appendChild(th2);
  table.appendChild(hdrRow);

  const nextBtn = new h.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });

  const makeRow = (expected, nounText) => {
    const tr = new h.FakeElement("tr");
    const td1 = new h.FakeElement("td");
    const gapWrap = new h.FakeElement("ef-gapfill-item", { className: "gap-item" });
    const inp = new h.FakeElement("input", { attrs: { type: "text" }, value: "" });
    const submitBtn = new h.FakeElement("button", {
      className: "typing-status",
      text: "Check",
      onclick() {
        committed.push(inp.value);
        inp.remove();
        submitBtn.remove();
        if (committed.length === 2) nextBtn.disabled = false;
      }
    });
    gapWrap.appendChild(inp);
    gapWrap.appendChild(submitBtn);
    td1.appendChild(gapWrap);
    const td2 = new h.FakeElement("td", { text: nounText });
    tr.appendChild(td1);
    tr.appendChild(td2);
    return tr;
  };

  table.appendChild(makeRow("propose", "proposal"));
  table.appendChild(makeRow("resign", "resignation"));
  h.doc.body.appendChild(table);
  h.doc.body.appendChild(nextBtn);

  const st = await h.dispatchCommand({ action: "status" });
  assert.equal(st.data.exerciseType, "fill_in_the_blanks");
  assert.deepEqual(Array.from(st.data.agentHint.slots), []);
  assert.ok(st.data.contextText.includes("Verb | Noun"));
  assert.ok(st.data.contextText.some((line) => line.includes("[input-1]") && line.includes("proposal")));
  assert.ok(st.data.contextText.some((line) => line.includes("[input-2]") && line.includes("resignation")));

  const gRes = await h.dispatchCommand({ action: "gaps", target: "propose, resign" });
  assert.equal(gRes.success, true);
  assert.deepEqual(committed, ["propose", "resign"]);
  assert.equal(gRes.data.canProceed, true);
});

test("autoPeekSelectionGapOptions peeks per-slot drawers, closes cleanly, and executeGaps handles stale drawers", async () => {
  const h = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const slotMenus = {
    s1: ["proposed", "budgeted"],
    s2: ["morale", "further"]
  };
  let openSlot = null;
  const drawerContainer = new h.FakeElement("div", { className: "drawer-options" });
  const filledValues = {};
  const nextBtn = new h.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });

  const renderDrawer = (slotKey, gapBtn) => {
    drawerContainer.children = [];
    drawerContainer.childNodes = [];
    if (!slotKey) return;
    for (const word of slotMenus[slotKey]) {
      const opt = new h.FakeElement("div", {
        className: "drawer-option",
        text: word,
        onclick() {
          filledValues[slotKey] = word;
          gapBtn.remove();
          openSlot = null;
          renderDrawer(null, null);
          if (Object.keys(filledValues).length === 2) nextBtn.disabled = false;
        }
      });
      drawerContainer.appendChild(opt);
    }
  };

  const makeGap = (slotKey) => {
    const btn = new h.FakeElement("button", {
      className: "selection-gap-button",
      text: "Blank 1 of 1",
      onclick() {
        if (openSlot === slotKey) {
          openSlot = null;
          renderDrawer(null, null);
        } else {
          openSlot = slotKey;
          renderDrawer(slotKey, btn);
        }
      }
    });
    return btn;
  };

  h.doc.body.appendChild(makeGap("s1"));
  h.doc.body.appendChild(makeGap("s2"));
  h.doc.body.appendChild(drawerContainer);
  h.doc.body.appendChild(nextBtn);

  const st = await h.dispatchCommand({ action: "status" });
  assert.equal(st.data.exerciseType, "selection_gaps");
  assert.deepEqual(Array.from(st.data.agentHint.options), [
    "slot-1: proposed | budgeted",
    "slot-2: morale | further"
  ]);
  assert.equal(openSlot, null, "autoPeek must close drawer cleanly after inspecting all slots");

  const gRes = await h.dispatchCommand({ action: "gaps", target: "proposed, morale" });
  assert.equal(gRes.success, true);
  assert.deepEqual(filledValues, { s1: "proposed", s2: "morale" });
  assert.equal(gRes.data.canProceed, true);
});

test("video_stage mutes video before play() and falls back to ended event when autoplay is blocked", async () => {
  const h = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const nextBtn = new h.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });
  const video = new h.FakeElement("video");
  video.duration = 84.33;
  video.currentTime = 10;
  video.paused = true;
  video.ended = false;
  video.muted = false;
  let playAttemptedMuted = false;
  video.play = () => {
    playAttemptedMuted = !!video.muted;
    return Promise.reject(new Error("NotAllowedError"));
  };
  video.addEventListener("ended", () => {
    video.ended = true;
    nextBtn.disabled = false;
  });

  h.doc.body.appendChild(video);
  h.doc.body.appendChild(nextBtn);

  const res = await h.dispatchCommand({ action: "next", amount: 1 });
  assert.equal(res.success, true);
  assert.equal(playAttemptedMuted, true, "video must be muted before calling play()");
  assert.equal(video.ended, true);
  assert.equal(video.currentTime, 84.33);
});

test("lesson_completed stops autopilot cleanly and executeLesson extracts currentLevel across multiple .sticky nodes", async () => {
  const h1 = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const s1 = new h1.FakeElement("ef-lesson-overview-step", { className: "is-passed", text: "Step 1 Passed" });
  const s2 = new h1.FakeElement("ef-lesson-overview-step", { className: "is-passed", text: "Step 2 Passed" });
  h1.doc.body.appendChild(s1);
  h1.doc.body.appendChild(s2);

  const autoRes = await h1.dispatchCommand({ action: "autopilot" });
  assert.equal(autoRes.success, true);
  assert.equal(autoRes.stoppedAt, "lesson_completed");
  assert.equal(autoRes.data.exerciseType, "lesson_completed");

  const h2 = loadContentHarness("https://learn.better.efekta.com/gap/ui/self-study");
  h2.doc.body.appendChild(new h2.FakeElement("div", { className: "sticky", text: "Efekta Navigation" }));
  const lvlBar = new h2.FakeElement("div", { className: "sticky" });
  lvlBar.appendChild(new h2.FakeElement("button", { text: "Level 10" }));
  h2.doc.body.appendChild(lvlBar);
  const sec = new h2.FakeElement("div", { attrs: { "data-id": "selfStudy-level-view-list-section-unit-1" } });
  sec.appendChild(new h2.FakeElement("h2", { attrs: { "data-id": "unit-1" }, text: "Meetings" }));
  const card = new h2.FakeElement("div", { attrs: { role: "link", "aria-label": "Lesson 1 of 4, Opening" } });
  card.appendChild(new h2.FakeElement("h3", { attrs: { "data-id": "u1l1-title" }, text: "Opening" }));
  sec.appendChild(card);
  h2.doc.body.appendChild(sec);

  const listRes = await h2.dispatchCommand({ action: "lesson", target: "list" });
  assert.equal(listRes.success, true);
  assert.equal(listRes.data.currentLevel, "Level 10");
});

test("background.js excludes catalyst-enter/Turnstile/reCAPTCHA, redacts JWT tokens, and reports human_verification_required", async () => {
  const executedTargets = [];
  const h = loadBackgroundHarness({
    tabs: [
      {
        id: 20,
        active: true,
        url: "https://learn.better.efekta.com/gap/ui/self-study/lesson-view?token=eyJhbGciOiJSUzI1NiJ9.secret"
      }
    ],
    getFrames: () => [
      { frameId: 0, url: "https://learn.better.efekta.com/gap/ui/self-study/lesson-view?token=eyJsecret" },
      {
        frameId: 5,
        url: "https://catalyst-enter.better.efekta.com/?redirect_uri=https%3A%2F%2Flesson-player.study.better.efekta.com%2F"
      },
      { frameId: 6, url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile" },
      { frameId: 7, url: "https://www.google.com/recaptcha/api2/anchor" }
    ],
    onSendMessage: (tabId, req, options) => {
      if (options.frameId === 0) {
        return { success: true, data: { elementsCount: 0, exerciseType: "unknown" } };
      }
      return { success: false, error: "should never message auth frames" };
    }
  });
  h.sandbox.chrome.scripting.executeScript = async (cfg) => {
    executedTargets.push(cfg);
  };

  const ws = h.FakeWebSocket.lastInstance;
  await ws.onmessage({ data: JSON.stringify({ id: "req-hv", action: "status" }) });
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].success, true);
  assert.equal(ws.sent[0].data.exerciseType, "human_verification_required");
  // Must NEVER inject into frames 5, 6, or 7
  for (const cfg of executedTargets) {
    assert.ok(!cfg.target.frameIds.includes(5));
    assert.ok(!cfg.target.frameIds.includes(6));
    assert.ok(!cfg.target.frameIds.includes(7));
  }

  // Popup status must redact JWT query parameters
  const popupSt = await h.sendRuntimeMessage({ type: "POPUP_GET_STATUS" });
  assert.equal(popupSt.tabUrl.includes("eyJhbGci"), false);
  assert.ok(popupSt.tabUrl.includes("REDACTED"));
});

test("autopilot autonomously solves selection_gaps, categorize_columns, matching_pairs, order_dialogue, and Verb/Noun table blanks on regular lessons", async () => {
  // 1. Autonomous categorize_columns solver
  const hSort = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const nextSort = new hSort.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });
  const correctSlotFor = { "I agree": "agreeing", "I disagree": "disagreeing" };
  let lastPickedItem = null;

  const makeSortItem = (label) => {
    const btn = new hSort.FakeElement("button", {
      className: "item option",
      text: label,
      onclick() {
        lastPickedItem = btn;
      }
    });
    return btn;
  };
  const itemA = makeSortItem("I agree");
  const itemB = makeSortItem("I disagree");

  const makeSortSlot = (cat) =>
    new hSort.FakeElement("button", {
      className: "item target",
      text: cat,
      onclick() {
        if (!lastPickedItem) return;
        if (correctSlotFor[lastPickedItem.textContent] === cat) {
          lastPickedItem.remove();
          lastPickedItem = null;
          if (!itemA.isConnected && !itemB.isConnected) nextSort.disabled = false;
        } else {
          lastPickedItem.classList.add("incorrect");
          setTimeout(() => lastPickedItem && lastPickedItem.classList.remove("incorrect"), 40);
        }
      }
    });

  hSort.doc.body.appendChild(makeSortSlot("disagreeing"));
  hSort.doc.body.appendChild(makeSortSlot("agreeing"));
  hSort.doc.body.appendChild(itemA);
  hSort.doc.body.appendChild(itemB);
  hSort.doc.body.appendChild(nextSort);

  const sortRes = await hSort.dispatchCommand({ action: "solve_sort" });
  assert.equal(sortRes.success, true);
  assert.equal(nextSort.disabled, false);

  // 2. Autonomous matching_pairs solver
  const hPair = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const nextPair = new hPair.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });
  const pairMap = { task: "job", rumor: "gossip" };
  let activeLeft = null;
  let matchedCount = 0;

  const makeLeft = (word) => {
    const el = new hPair.FakeElement("div", {
      className: "matching-option-wp target",
      text: word,
      onclick() {
        activeLeft = el;
      }
    });
    return el;
  };
  const makeRight = (word) => {
    const el = new hPair.FakeElement("div", {
      className: "matching-option-wp option",
      text: word,
      onclick() {
        if (!activeLeft) return;
        if (pairMap[activeLeft.textContent] === word) {
          activeLeft.classList.add("correct");
          el.classList.add("correct");
          matchedCount++;
          if (matchedCount === 2) nextPair.disabled = false;
        } else {
          activeLeft.classList.add("incorrect");
          el.classList.add("incorrect");
          const l = activeLeft;
          setTimeout(() => {
            l.classList.remove("incorrect");
            el.classList.remove("incorrect");
          }, 40);
        }
      }
    });
    return el;
  };

  hPair.doc.body.appendChild(makeLeft("task"));
  hPair.doc.body.appendChild(makeLeft("rumor"));
  hPair.doc.body.appendChild(makeRight("gossip"));
  hPair.doc.body.appendChild(makeRight("job"));
  hPair.doc.body.appendChild(nextPair);

  const pairRes = await hPair.dispatchCommand({ action: "solve_pair" });
  assert.equal(pairRes.success, true);
  assert.equal(nextPair.disabled, false);

  // 3. Autonomous order_dialogue (ef-sequencing-task) solver with per-slot .is-unassessed locking
  const hOrd = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const targetOrder = ["first proposal", "second proposal", "third proposal"];
  const seqTask = new hOrd.FakeElement("ef-sequencing-task");

  const makeSeqItem = (text) => {
    const item = new hOrd.FakeElement("ef-sequencing-sort-column-item", { className: "drop-list-item" });
    const drag = new hOrd.FakeElement("div", { className: "cdk-drag list-item is-unassessed", text });
    item.appendChild(drag);
    return item;
  };
  seqTask.appendChild(makeSeqItem("second proposal"));
  seqTask.appendChild(makeSeqItem("third proposal"));
  seqTask.appendChild(makeSeqItem("first proposal"));

  // Handle cdkSort bridge message in fake DOM (matching how injected.js reorders ef-sequencing-sort-column-item)
  hOrd.doc.addEventListener("efekta:in", (ev) => {
    const req = JSON.parse(ev.detail);
    if (req.type === "cdkSort") {
      const srcEl = seqTask.children.find((c) => c.getAttribute("data-efekta-id") === req.srcId);
      const dstEl = seqTask.children.find((c) => c.getAttribute("data-efekta-id") === req.dstId);
      if (srcEl && dstEl && srcEl !== dstEl) {
        const idxA = seqTask.children.indexOf(srcEl);
        const idxB = seqTask.children.indexOf(dstEl);
        seqTask.children.splice(idxA, 1);
        seqTask.children.splice(idxB, 0, srcEl);
        seqTask.childNodes = seqTask.children.slice();
      }
      hOrd.doc.dispatchEvent({
        type: "efekta:out",
        detail: JSON.stringify({ reqId: req.reqId, ok: true, result: true })
      });
    }
  });

  const checkOrdBtn = new hOrd.FakeElement("button", {
    className: "check-task-button next-task-button",
    text: "Check",
    onclick() {
      let allCorrect = true;
      seqTask.children.forEach((child, idx) => {
        const dragDiv = child.querySelector(".cdk-drag");
        if (child.textContent.trim() === targetOrder[idx]) {
          if (dragDiv) dragDiv.classList.remove("is-unassessed");
        } else {
          allCorrect = false;
        }
      });
      if (allCorrect) {
        checkOrdBtn.childNodes = [];
        checkOrdBtn.appendText("Next");
      }
    }
  });
  hOrd.doc.body.appendChild(seqTask);
  hOrd.doc.body.appendChild(checkOrdBtn);

  const ordRes = await hOrd.dispatchCommand({ action: "solve_order" });
  assert.equal(ordRes.success, true);
  assert.deepEqual(
    seqTask.children.map((c) => c.textContent.trim()),
    targetOrder
  );

  // 4. Autonomous fill_in_the_blanks Verb/Noun table solver
  const hTbl = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  const tbl = new hTbl.FakeElement("table");
  const nextTbl = new hTbl.FakeElement("button", { className: "next-task-button", text: "Next", disabled: true });
  let solvedRows = 0;

  const addWordFamilyRow = (expectedVerb, givenNoun) => {
    const tr = new hTbl.FakeElement("tr");
    const td1 = new hTbl.FakeElement("td");
    const gap = new hTbl.FakeElement("ef-gapfill-item");
    const inp = new hTbl.FakeElement("input", { attrs: { type: "text" }, value: "" });
    const btn = new hTbl.FakeElement("button", {
      className: "typing-status",
      text: "Check",
      onclick() {
        if ((inp.value || "").toLowerCase() === expectedVerb) {
          inp.remove();
          btn.remove();
          td1.appendText(expectedVerb);
          solvedRows++;
          if (solvedRows === 2) nextTbl.disabled = false;
        }
      }
    });
    gap.appendChild(inp);
    gap.appendChild(btn);
    td1.appendChild(gap);
    const td2 = new hTbl.FakeElement("td", { text: givenNoun });
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbl.appendChild(tr);
  };
  addWordFamilyRow("propose", "proposal");
  addWordFamilyRow("resign", "resignation");
  hTbl.doc.body.appendChild(tbl);
  hTbl.doc.body.appendChild(nextTbl);

  const tblRes = await hTbl.dispatchCommand({ action: "solve_gaps" });
  assert.equal(tblRes.success, true);
  assert.equal(solvedRows, 2);
  assert.equal(nextTbl.disabled, false);
});

test("step activity planner jumps to incomplete activity on Step not passed and speaks drill when needed for >50% pass threshold", async () => {
  const h = loadContentHarness("https://lesson-player.study.better.efekta.com/?product=gap-b2s");
  let jumpedToAct3 = false;

  const nav = new h.FakeElement("ef-activity-navigator");
  nav.appendChild(
    new h.FakeElement("div", {
      className: "wp",
      text: "Step navigation, Activity 1 of 4, Activity complete"
    })
  );
  nav.appendChild(
    new h.FakeElement("div", {
      className: "wp",
      text: "Step navigation, Activity 2 of 4, Activity complete"
    })
  );
  const act3 = new h.FakeElement("div", {
    className: "wp",
    text: "Step navigation, Activity 3 of 4, 0% complete",
    onclick() {
      jumpedToAct3 = true;
      promptEl.childNodes = [];
      promptEl.appendText("Lesson completed");
      h.doc.body.appendChild(new h.FakeElement("ef-lesson-overview-step", { className: "is-passed", text: "Step 1 Passed" }));
      h.doc.body.appendChild(new h.FakeElement("ef-lesson-overview-step", { className: "is-passed", text: "Step 2 Passed" }));
      nav.remove();
    }
  });
  nav.appendChild(act3);
  nav.appendChild(
    new h.FakeElement("div", {
      className: "wp selected",
      text: "Step summary"
    })
  );
  const promptEl = new h.FakeElement("h2", { text: "Step not passed. Pass at least 3 activities to pass this step!" });
  h.doc.body.appendChild(nav);
  h.doc.body.appendChild(promptEl);

  const res = await h.dispatchCommand({ action: "autopilot", target: "3" });
  assert.equal(res.success, true);
  assert.equal(jumpedToAct3, true);
});
