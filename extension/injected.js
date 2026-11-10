// Efekta Bridge - MAIN World Injected Script (Voice Engine v3)
//
// Runs inside the page's own JavaScript world (manifest content_scripts "world": "MAIN").
//
// Design rules:
//  1. The REAL microphone is NEVER touched by default. getUserMedia() passes straight through to the
//     browser, so a human speaking into the mic is recorded exactly as without the extension.
//  2. The lesson's own reference audio ("Play audio" button) is observed (fetch / XHR / decodeAudioData /
//     AudioBufferSourceNode.start / HTMLMediaElement.play) so it can be replayed as native-speaker speech.
//  3. Voice injection is ONE-SHOT and ARMED explicitly by an efekta `speak` command. Only the next
//     microphone capture that happens while armed (default window: 12s) receives a synthetic stream
//     that plays the prepared clip. After that, everything is back to the real microphone.
//
// Communication with the content script uses CustomEvents carrying JSON strings
// ("efekta:in" content->page, "efekta:out" page->content), which survive Firefox Xray wrappers.
(function () {
  "use strict";
  if (window.__efekta_injected_loaded) return;
  window.__efekta_injected_loaded = true;

  const VERSION = "3.0.0";
  const EVT_IN = "efekta:in";
  const EVT_OUT = "efekta:out";
  const MAX_CLIP_BYTES = 8 * 1024 * 1024;
  const MAX_CLIPS = 16;

  const OrigAudioContext = window.AudioContext || window.webkitAudioContext || null;
  const OrigOfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
  const BaseCtx = window.BaseAudioContext || OrigAudioContext;
  const origFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const origDecode = BaseCtx && BaseCtx.prototype ? BaseCtx.prototype.decodeAudioData : null;
  const md = navigator.mediaDevices;
  const origGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------------------------------
  // Telemetry ring buffer (read via `efekta voice`)
  // ------------------------------------------------------------------------------------------
  const events = [];
  function note(type, info) {
    try {
      events.push(Object.assign({ t: Date.now(), type }, info || {}));
      if (events.length > 80) events.shift();
    } catch (_) {}
  }

  // ------------------------------------------------------------------------------------------
  // 1. Reference audio capture
  // ------------------------------------------------------------------------------------------
  const clipBytes = new Map(); // absolute url -> { bytes, mime, ts }
  const bufferBytes = new WeakMap(); // AudioBuffer -> encoded bytes it was decoded from
  const ownNodes = new WeakSet(); // our own AudioBufferSourceNodes (excluded from capture)
  const ownStreams = new WeakSet(); // our own injected MediaStreams
  let lastAudioPlayback = null; // { ts, kind: "buffer" | "media", url, buffer, durationMs, endedAt, tag }
  let lastVideoPlayback = null;

  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|weba|flac)(\?|#|$)/i;
  function isAudioLike(url, mime) {
    const m = String(mime || "").toLowerCase();
    if (m.startsWith("audio/")) return true;
    if (m.startsWith("video/") || m.includes("json") || m.includes("html") || m.includes("javascript")) {
      return false;
    }
    return AUDIO_EXT.test(String(url || ""));
  }

  function absUrl(u) {
    try {
      return new URL(String(u || ""), location.href).href;
    } catch (_) {
      return String(u || "");
    }
  }

  function rememberBytes(url, bytes, mime) {
    try {
      if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_CLIP_BYTES) return;
      const key = absUrl(url);
      clipBytes.delete(key);
      clipBytes.set(key, { bytes, mime: mime || "", ts: Date.now() });
      while (clipBytes.size > MAX_CLIPS) clipBytes.delete(clipBytes.keys().next().value);
      note("clip", { url: key.slice(0, 180), bytes: bytes.byteLength, mime: String(mime || "") });
    } catch (_) {}
  }

  // fetch() responses carrying audio + outbound speech assessment logging
  if (origFetch) {
    try {
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        const p = nativeFetch.apply(this, arguments);
        try {
          const reqUrl =
            typeof input === "string" ? input : input && input.url ? input.url : String(input);
          const method = (init && init.method) || (input && input.method) || "GET";
          if (/speech|assess|audio|recognize|asr|record/i.test(reqUrl)) {
            note("fetch-out", { url: reqUrl.slice(0, 160), method });
          }
          p.then(
            (resp) => {
              try {
                const ct = (resp && resp.headers && resp.headers.get("content-type")) || "";
                const u = (resp && resp.url) || reqUrl;
                if (resp && resp.ok && isAudioLike(u, ct)) {
                  resp
                    .clone()
                    .arrayBuffer()
                    .then((b) => rememberBytes(u, b, ct), () => {});
                }
              } catch (_) {}
            },
            () => {}
          );
        } catch (_) {}
        return p;
      };
    } catch (_) {}
  }

  // XMLHttpRequest responses carrying audio (Howler.js & friends)
  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;
    XP.open = function (method, url) {
      try {
        this.__efkUrl = String(url);
        this.__efkMethod = String(method);
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XP.send = function (body) {
      try {
        const u = this.__efkUrl || "";
        if (/speech|assess|audio|recognize|asr|record/i.test(u)) {
          note("xhr-out", {
            url: u.slice(0, 160),
            method: this.__efkMethod,
            len: body ? (body.length || body.size || body.byteLength) : 0
          });
        }
        const xhr = this;
        xhr.addEventListener("load", function () {
          try {
            const rt = xhr.responseType;
            if (rt !== "arraybuffer" && rt !== "blob") return;
            if (!(xhr.status >= 200 && xhr.status < 300) || !xhr.response) return;
            const ct = xhr.getResponseHeader("content-type") || "";
            const u = xhr.responseURL || xhr.__efkUrl;
            if (!isAudioLike(u, ct)) return;
            if (rt === "arraybuffer") rememberBytes(u, xhr.response.slice(0), ct);
            else xhr.response.arrayBuffer().then((b) => rememberBytes(u, b, ct), () => {});
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  } catch (_) {}

  // Hook Web Speech API and WebSocket to detect Efekta's ASR mechanism
  try {
    const OrigSR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (OrigSR) {
      note("sr-supported", {});
      function EfektaSpeechRecognition() {
        const rec = new OrigSR();
        note("sr-constructed", {});
        const origStart = rec.start ? rec.start.bind(rec) : null;
        rec.start = function () {
          note("sr-start", { armed: isArmed() });
          if (origStart) return origStart.apply(this, arguments);
        };
        return rec;
      }
      EfektaSpeechRecognition.prototype = OrigSR.prototype;
      window.SpeechRecognition = EfektaSpeechRecognition;
      window.webkitSpeechRecognition = EfektaSpeechRecognition;
    }
  } catch (_) {}

  try {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const origWSSend = OrigWS.prototype.send;
      OrigWS.prototype.send = function (data) {
        try {
          if (this.url && !this.url.includes("127.0.0.1:8765")) {
            note("ws-send", {
              url: this.url.slice(0, 100),
              len: data ? (data.length || data.byteLength || data.size) : 0
            });
          }
        } catch (_) {}
        return origWSSend.apply(this, arguments);
      };
    }
  } catch (_) {}

  // decodeAudioData: remember which encoded bytes produced which AudioBuffer
  if (origDecode) {
    try {
      BaseCtx.prototype.decodeAudioData = function (data, success, failure) {
        let copy = null;
        try {
          if (data && data.byteLength && data.byteLength <= MAX_CLIP_BYTES) copy = data.slice(0);
        } catch (_) {}
        const link = (buf) => {
          try {
            if (buf && copy) bufferBytes.set(buf, copy);
          } catch (_) {}
        };
        const wrappedSuccess =
          typeof success === "function"
            ? function (buf) {
                link(buf);
                return success.apply(this, arguments);
              }
            : success;
        const pr = origDecode.call(this, data, wrappedSuccess, failure);
        try {
          if (pr && typeof pr.then === "function") pr.then(link, () => {});
        } catch (_) {}
        return pr;
      };
    } catch (_) {}
  }

  // Web Audio playback (AudioBufferSourceNode.start)
  try {
    const AP = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
    const origStart = AP && AP.start;
    if (origStart) {
      AP.start = function () {
        try {
          if (!ownNodes.has(this) && this.buffer && this.buffer.duration > 0.35) {
            const rec = {
              ts: Date.now(),
              kind: "buffer",
              tag: "webaudio",
              url: "",
              buffer: this.buffer,
              durationMs: Math.round(this.buffer.duration * 1000),
              endedAt: 0
            };
            this.addEventListener("ended", () => {
              rec.endedAt = Date.now();
            });
            lastAudioPlayback = rec;
            note("page-play", { kind: "buffer", durationMs: rec.durationMs });
          }
        } catch (_) {}
        return origStart.apply(this, arguments);
      };
    }
  } catch (_) {}

  // <audio>/<video> playback (HTMLMediaElement.play)
  try {
    const MP = HTMLMediaElement.prototype;
    const origPlay = MP.play;
    MP.play = function () {
      try {
        if (!this.__efkOwn) {
          let url = this.currentSrc || this.src || "";
          if (!url && this.querySelector) {
            const s = this.querySelector("source[src]");
            if (s) url = s.src;
          }
          const tag = (this.tagName || "").toLowerCase();
          const rec = {
            ts: Date.now(),
            kind: "media",
            tag,
            url: url ? absUrl(url) : "",
            buffer: null,
            durationMs: isFinite(this.duration) && this.duration > 0 ? Math.round(this.duration * 1000) : 0,
            endedAt: 0,
            el: this
          };
          const onEnd = () => {
            if (!rec.endedAt) rec.endedAt = Date.now();
          };
          this.addEventListener("ended", onEnd, { once: true });
          this.addEventListener("pause", onEnd, { once: true });
          this.addEventListener(
            "loadedmetadata",
            () => {
              if (isFinite(this.duration)) rec.durationMs = Math.round(this.duration * 1000);
            },
            { once: true }
          );
          if (tag === "video") lastVideoPlayback = rec;
          else lastAudioPlayback = rec;
          note("page-play", { kind: "media", tag, url: rec.url.slice(0, 180) });
        }
      } catch (_) {}
      return origPlay.apply(this, arguments);
    };
  } catch (_) {}

  // ------------------------------------------------------------------------------------------
  // 2. Clip preparation (reference / TTS / noise)
  // ------------------------------------------------------------------------------------------
  let prepared = null; // { buffer: AudioBuffer, source, durationMs, url }

  async function decodeBytes(bytes) {
    if (!OrigOfflineAudioContext) throw new Error("OfflineAudioContext not available");
    // OfflineAudioContext is not subject to autoplay policy and resamples to 48 kHz.
    const ctx = new OrigOfflineAudioContext(1, 1, 48000);
    const copy = bytes.slice(0);
    if (origDecode) return await origDecode.call(ctx, copy);
    return await ctx.decodeAudioData(copy);
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function describePlayback(rec) {
    if (!rec) return null;
    return {
      ts: rec.ts,
      kind: rec.kind,
      tag: rec.tag,
      url: rec.url ? rec.url.slice(0, 200) : "",
      durationMs: rec.durationMs,
      endedAt: rec.endedAt,
      playing: !rec.endedAt && Date.now() - rec.ts < (rec.durationMs || 15000) + 500
    };
  }

  async function prepareReference(since) {
    const sinceTs = Number(since) || 0;
    const candidates = [lastAudioPlayback, lastVideoPlayback].filter((r) => r && r.ts >= sinceTs);
    if (!candidates.length) {
      return { ok: false, error: "No page audio playback observed since the Play click" };
    }
    const rec = candidates[0];
    let buffer = null;
    if (rec.kind === "buffer") {
      buffer = rec.buffer;
    } else {
      let bytes = null;
      const entry = rec.url ? clipBytes.get(rec.url) : null;
      if (entry) bytes = entry.bytes;
      let fetchError = "";
      if (!bytes && rec.url && origFetch) {
        try {
          const r = await origFetch(rec.url);
          if (r.ok) bytes = await r.arrayBuffer();
          else fetchError = "HTTP " + r.status;
        } catch (e) {
          fetchError = (e && e.message) || String(e);
        }
      }
      if (!bytes) {
        return {
          ok: false,
          needFetch: rec.url && /^https:/i.test(rec.url) ? rec.url : "",
          error: "Reference audio bytes not accessible from page" + (fetchError ? ": " + fetchError : ""),
          playback: describePlayback(rec)
        };
      }
      buffer = await decodeBytes(bytes);
    }
    // Also pause any in-memory reference <audio> element so Efekta unlocks the mic button immediately
    if (rec.el && typeof rec.el.pause === "function") {
      try {
        rec.el.pause();
        if (isFinite(rec.el.duration) && rec.el.duration > 0) {
          rec.el.currentTime = rec.el.duration;
        }
        rec.el.dispatchEvent(new Event("ended"));
      } catch (_) {}
    }
    prepared = {
      buffer,
      source: "reference",
      durationMs: Math.round(buffer.duration * 1000),
      url: rec.url || ""
    };
    return {
      ok: true,
      source: "reference",
      durationMs: prepared.durationMs,
      playback: describePlayback(rec)
    };
  }

  async function prepareAudioB64(b64, source) {
    const bytes = b64ToBytes(b64);
    const buffer = await decodeBytes(bytes);
    prepared = {
      buffer,
      b64,
      source: source || "tts",
      durationMs: Math.round(buffer.duration * 1000),
      url: ""
    };
    return { ok: true, source: prepared.source, durationMs: prepared.durationMs };
  }

  // ------------------------------------------------------------------------------------------
  // 3. One-shot armed voice injection
  // ------------------------------------------------------------------------------------------
  let armed = null; // { id, buffer, b64, source, leadMs, tailMs, expiresAt }
  let session = null; // last injection session
  let seq = 0;
  const recorders = [];
  const allCreatedCtxs = new Set();

  function newOutput(sampleRate) {
    const ctx = sampleRate ? new OrigAudioContext({ sampleRate }) : new OrigAudioContext();
    allCreatedCtxs.add(ctx);
    const dest = ctx.createMediaStreamDestination();
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
    return { ctx, dest, stream: dest.stream };
  }

  function isArmed() {
    if (armed && Date.now() > armed.expiresAt) {
      note("arm-expired", { id: armed.id });
      armed = null;
    }
    return !!armed;
  }

  function resumeAllContexts() {
    for (const ctx of allCreatedCtxs) {
      try {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
      } catch (_) {}
    }
  }

  window.addEventListener("pointerdown", resumeAllContexts, true);
  window.addEventListener("mousedown", resumeAllContexts, true);
  window.addEventListener("click", resumeAllContexts, true);

  function consume(via, sampleRate) {
    if (!armed) return session;
    const a = armed;
    armed = null;
    const out = newOutput(sampleRate);

    const durMs = a.buffer ? Math.round(a.buffer.duration * 1000) : 2500;
    const leadMs = Math.max(0, Number(a.leadMs) || 150);
    const s = {
      id: a.id,
      via,
      source: a.source,
      buffer: a.buffer,
      b64: a.b64,
      leadMs,
      tailMs: Math.max(400, Number(a.tailMs) || 800),
      outputs: [out],
      stream: out.stream,
      createdAt: Date.now(),
      playStartedAt: 0,
      playEndsAt: Date.now() + leadMs + durMs,
      playEndedAt: 0,
      trigger: "",
      stoppedByPage: false,
      stoppedAt: 0,
      closed: false,
      realHold: null
    };
    ownStreams.add(out.stream);
    session = s;
    note("inj-consumed", {
      id: s.id,
      via,
      source: s.source,
      rate: out.ctx.sampleRate
    });
    ensureRunning(s).then(() => startPlayback(s, "auto"));
    setTimeout(() => cleanupSession(s), durMs + leadMs + 20000);
    return s;
  }

  // Make sure our AudioContext is actually running without ever blocking on getUserMedia
  async function ensureRunning(s) {
    for (const o of s.outputs) {
      try {
        if (o.ctx.state !== "running") {
          await Promise.race([o.ctx.resume(), sleep(200)]);
        }
      } catch (_) {}
    }
    const mainCtx = s.outputs[0].ctx;
    note("inj-ctx-state", { id: s.id, state: mainCtx.state });
    return mainCtx.state === "running";
  }

  function startPlayback(s, trigger) {
    if (!s || s.closed || s.playStartedAt) return;
    s.playStartedAt = Date.now();
    s.trigger = trigger;
    const durMs = s.buffer ? Math.round(s.buffer.duration * 1000) : 2500;
    const leadMs = Math.max(0, Number(s.leadMs) || 150);
    s.playEndsAt = s.playStartedAt + leadMs + durMs;

    let pending = 0;
    const onDone = () => {
      pending--;
      if (pending <= 0 && !s.playEndedAt) {
        s.playEndedAt = Date.now();
        note("inj-play-ended", { id: s.id, via: "all" });
      }
    };

    for (const o of s.outputs) {
      try {
        if (o.ctx.state === "suspended") o.ctx.resume().catch(() => {});
        pending++;
        const src = o.ctx.createBufferSource();
        ownNodes.add(src);
        src.buffer = s.buffer;
        const gain = o.ctx.createGain();
        gain.gain.value = 1.6;
        src.connect(gain);
        gain.connect(o.dest);
        src.onended = onDone;
        src.start(o.ctx.currentTime + leadMs / 1000);
      } catch (e) {
        note("inj-play-error", { id: s.id, error: String(e) });
      }
    }

    if (pending === 0) s.playEndedAt = Date.now();
    note("inj-play-start", { id: s.id, trigger, durMs });
  }

  function cleanupSession(s) {
    if (!s || s.closed) return;
    const clipDur = s.buffer ? Math.round(s.buffer.duration * 1000) : 2500;
    const minEnd = (s.playEndsAt || (s.createdAt + (s.leadMs || 200) + clipDur)) + (s.tailMs || 1000);
    if (Date.now() < minEnd) {
      setTimeout(() => cleanupSession(s), Math.max(50, minEnd - Date.now()));
      return;
    }
    s.closed = true;
    if (s.audioEl) {
      try {
        s.audioEl.pause();
        s.audioEl.src = "";
      } catch (_) {}
    }
    if (s.blobUrl) {
      try { URL.revokeObjectURL(s.blobUrl); } catch (_) {}
    }
    for (const o of s.outputs) {
      try {
        if (o.ctx.state !== "closed") o.ctx.close();
      } catch (_) {}
    }
    if (s.realHold) {
      try {
        s.realHold.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      s.realHold = null;
    }
    note("inj-closed", { id: s.id });
  }

  // getUserMedia: real mic is 100% untouched unless injection is explicitly armed right now
  if (origGUM) {
    try {
      md.getUserMedia = async function (constraints) {
        const wantsAudio = !!(constraints && constraints.audio);
        if (!wantsAudio || !isArmed()) {
          note("gum-real", { wantsAudio, armed: isArmed() });
          return origGUM.call(md, constraints);
        }
        note("gum-inject-start", { armed: true });
        try {
          const s = consume("getUserMedia");
          if (s && s.outputs && s.outputs[0]) {
            await ensureRunning(s);
            startPlayback(s, "getUserMedia");
            return s.outputs[0].stream;
          }
        } catch (err) {
          note("gum-inject-err", { error: String(err) });
        }
        return origGUM.call(md, constraints);
      };
    } catch (_) {}
  }

  // MediaRecorder: swap a cached real-mic stream while armed + detect recording start/stop
  try {
    const OrigMR = window.MediaRecorder;
    if (OrigMR) {
      const MRP = OrigMR.prototype;
      const origMRStart = MRP.start;
      const origMRStop = MRP.stop;
      MRP.start = function () {
        const r = origMRStart.apply(this, arguments);
        try {
          note("mr-start", {});
          if (session && this.stream === session.stream) startPlayback(session, "MediaRecorder.start");
        } catch (_) {}
        return r;
      };
      MRP.stop = function () {
        try {
          note("mr-stop", {});
        } catch (_) {}
        return origMRStop.apply(this, arguments);
      };
      class EfektaMediaRecorder extends OrigMR {
        constructor(stream, options) {
          let st = stream;
          let swapped = null;
          try {
            if (
              st &&
              !ownStreams.has(st) &&
              st.getAudioTracks &&
              st.getAudioTracks().length &&
              isArmed()
            ) {
              swapped = consume("MediaRecorder");
              st = swapped.stream;
            }
          } catch (_) {}
          super(st, options);
          if (swapped) ensureRunning(swapped);
          try {
            recorders.push(this);
            if (recorders.length > 6) recorders.shift();
          } catch (_) {}
        }
      }
      window.MediaRecorder = EfektaMediaRecorder;
    }
  } catch (_) {}

  // AudioContext.createMediaStreamSource: direct in-context injection + start playback when the page wires the mic
  try {
    const ACP = OrigAudioContext && OrigAudioContext.prototype;
    const origCMSS = ACP && ACP.createMediaStreamSource;
    if (origCMSS) {
      ACP.createMediaStreamSource = function (stream) {
        let st = stream;
        const realNode = origCMSS.call(this, st);
        try {
          if ((st && ownStreams.has(st)) || isArmed()) {
            const s =
              session && session.stream === st
                ? session
                : isArmed()
                ? consume("createMediaStreamSource")
                : null;
            if (s && s.buffer) {
              note("cmss-inject-direct", { id: s.id, rate: this.sampleRate });
              // Create BufferSource directly inside Efekta's own AudioContext
              const pageSrc = this.createBufferSource();
              pageSrc.buffer = s.buffer;
              const origConnect = realNode.connect.bind(realNode);
              realNode.connect = function (dest, ...rest) {
                try {
                  pageSrc.connect(dest);
                } catch (_) {}
                return origConnect(dest, ...rest);
              };
              const leadMs = Math.max(0, Number(s.leadMs) || 150);
              pageSrc.start(this.currentTime + leadMs / 1000);
              pageSrc.onended = () => {
                if (!s.playEndedAt) {
                  s.playEndedAt = Date.now();
                  note("inj-play-ended", { id: s.id, via: "pageCtxDirect" });
                }
              };
            }
          }
        } catch (e) {
          note("cmss-hook-err", { error: (e && e.message) || String(e) });
        }
        return realNode;
      };
    }
  } catch (_) {}

  // ------------------------------------------------------------------------------------------
  // 4. Status + message bridge
  // ------------------------------------------------------------------------------------------
  function sessionStatus() {
    const s = session;
    if (!s) return null;
    let recorderState = "";
    try {
      const r = recorders.filter((x) => x.stream === s.stream || s.outputs.some((o) => o.stream === x.stream));
      if (r.length) recorderState = r[r.length - 1].state;
    } catch (_) {}
    return {
      id: s.id,
      via: s.via,
      source: s.source,
      trigger: s.trigger,
      ctxState: s.outputs[0].ctx.state,
      createdAt: s.createdAt,
      playStartedAt: s.playStartedAt,
      playEndsAt: s.playEndsAt,
      playEndedAt: s.playEndedAt,
      stoppedByPage: s.stoppedByPage,
      stoppedAt: s.stoppedAt,
      closed: s.closed,
      recorderState,
      durationMs: Math.round(s.buffer.duration * 1000)
    };
  }

  async function handle(msg) {
    switch (msg.type) {
      case "hello":
        return { ok: true, version: VERSION };
      case "status":
        return {
          ok: true,
          version: VERSION,
          now: Date.now(),
          armed: isArmed() ? { id: armed.id, source: armed.source, expiresAt: armed.expiresAt } : null,
          session: sessionStatus(),
          prepared: prepared ? { source: prepared.source, durationMs: prepared.durationMs } : null,
          lastAudioPlayback: describePlayback(lastAudioPlayback),
          lastVideoPlayback: describePlayback(lastVideoPlayback),
          clips: clipBytes.size
        };
      case "events":
        return { ok: true, events: events.slice(-(Number(msg.limit) || 40)) };
      case "prepareRef":
        return await prepareReference(msg.since);
      case "prepareAudio":
        return await prepareAudioB64(msg.b64, msg.source);
      case "arm": {
        if (!prepared) return { ok: false, error: "No clip prepared" };
        if (!OrigAudioContext) return { ok: false, error: "Web Audio API not available" };
        const armId = ++seq;
        armed = {
          id: armId,
          buffer: prepared.buffer,
          b64: prepared.b64 || "",
          source: prepared.source,
          leadMs: Math.max(0, Number(msg.leadMs) || 150),
          tailMs: Math.max(0, Number(msg.tailMs) || 1200),
          expiresAt: Date.now() + Math.max(1000, Number(msg.timeoutMs) || 15000)
        };
        session = null;
        note("armed", { id: armId, source: armed.source });
        return { ok: true, id: armId };
      }
      case "click": {
        const sel = msg.selector || msg.target || "button.audio-recorder-btn";
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: "Element not found: " + sel };
        try { el.scrollIntoView({ behavior: "instant", block: "center" }); } catch (_) {}
        el.click();
        return { ok: true, tag: el.tagName };
      }
      case "disarm": {
        const was = !!armed;
        armed = null;
        if (session) {
          session.closed = true;
          cleanupSession(session);
          session = null;
        }
        return { ok: true, wasArmed: was };
      }
      case "eval": {
        try {
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction("document", "window", msg.code);
          const res = await fn(document, window);
          return { ok: true, result: res };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      default:
        return { ok: false, error: "Unknown voice bridge message: " + msg.type };
    }
  }

  document.addEventListener(EVT_IN, (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(String(ev.detail || ""));
    } catch (_) {
      return;
    }
    if (!msg || !msg.reqId) return;
    const reply = (payload) => {
      try {
        document.dispatchEvent(
          new CustomEvent(EVT_OUT, { detail: JSON.stringify(Object.assign({ reqId: msg.reqId }, payload)) })
        );
      } catch (_) {}
    };
    handle(msg).then(reply, (err) => reply({ ok: false, error: (err && err.message) || String(err) }));
  });

  note("loaded", { version: VERSION, frame: location.href.slice(0, 120) });
})();
