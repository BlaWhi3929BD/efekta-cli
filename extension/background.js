// Efekta Bridge - Service Worker / Background Script (v3.0)
const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";
const DAEMON_TTS_URL = "http://127.0.0.1:8765/api/tts";

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const tabFrames = new Map(); // tabId -> Map(frameId -> { url, isLessonPlayer, isTop })
const tabActiveFrames = new Map(); // tabId -> active frameId

function log(...args) {
  console.log("[Efekta-Daemon-Bridge]", ...args);
}

function isTransportError(errMsg) {
  if (!errMsg) return false;
  const s = String(errMsg).toLowerCase();
  return (
    s.includes("receiving end does not exist") ||
    s.includes("could not establish connection") ||
    s.includes("message port closed") ||
    s.includes("message manager disconnected") ||
    s.includes("frame was removed") ||
    s.includes("no tab with id") ||
    s.includes("empty response from content script")
  );
}

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|weba|flac)$/i;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x4000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function isLearnEfektaUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "https:" && u.hostname.toLowerCase() === "learn.better.efekta.com";
  } catch (_) {
    return false;
  }
}

function isEfektaUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "efekta.com" || h.endsWith(".efekta.com");
  } catch (_) {
    return false;
  }
}

function isStudyPlayerUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "study.better.efekta.com" || h.endsWith(".study.better.efekta.com");
  } catch (_) {
    return false;
  }
}

function isAuthGatewayUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();
    return (
      h === "catalyst-enter.better.efekta.com" ||
      h.includes("catalyst-enter") ||
      h === "challenges.cloudflare.com" ||
      h.endsWith(".cloudflare.com") ||
      ((h === "www.google.com" ||
        h === "google.com" ||
        h === "www.recaptcha.net" ||
        h === "recaptcha.net" ||
        h === "www.gstatic.com") &&
        p.includes("recaptcha")) ||
      h === "hcaptcha.com" ||
      h.endsWith(".hcaptcha.com")
    );
  } catch (_) {
    return false;
  }
}

function buildHumanVerificationResponse(authUrl) {
  const safeUrl = sanitizeUrl(authUrl);
  const summary =
    "Human verification (Cloudflare Turnstile / reCAPTCHA) is displayed in the browser. Complete it manually in the browser window.";
  return {
    success: true,
    needsAgent: true,
    stoppedAt: "human_verification_required",
    message: summary,
    data: {
      url: safeUrl,
      title: "Human Verification Required",
      exerciseType: "human_verification_required",
      isProgressTest: false,
      prompt: summary,
      contextText: [],
      feedback: "",
      agentHint: {
        exerciseType: "human_verification_required",
        actionTemplate: "",
        summary,
        slots: [],
        items: [],
        options: [],
        inputs: []
      },
      video: {
        hasVideo: false,
        hasAudio: false,
        paused: true,
        ended: true,
        currentTime: 0,
        duration: 0,
        isPlaying: false
      },
      canProceed: false,
      nextButtonId: "",
      elementsCount: 0,
      elements: []
    }
  };
}

async function detectAuthGatewayOnlyFrame(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return null;
  try {
    const allFrames = await new Promise((resolve) => {
      chrome.webNavigation.getAllFrames({ tabId }, resolve);
    });
    if (!Array.isArray(allFrames) || allFrames.length === 0) return null;
    if (allFrames.some((f) => f && f.frameId !== 0 && isStudyPlayerUrl(f.url))) {
      return null;
    }
    const authFrame = allFrames.find((f) => f && f.frameId !== 0 && isAuthGatewayUrl(f.url));
    return authFrame ? authFrame.url : null;
  } catch (_) {
    return null;
  }
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(token|access_token|id_token|jwt|code|auth|session|sig|signature)$/i.test(key)) {
        u.searchParams.set(key, "[REDACTED]");
      }
    }
    return u.toString();
  } catch (_) {
    return String(rawUrl).split("?")[0];
  }
}

function isPrivateOrBlockedHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    !h ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  ) {
    return true;
  }
  // IPv4 literal check
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b, c, d] = ipv4Match.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      return true;
    }
    return false;
  }
  // Reject raw IPv6 literals for local/private/special ranges (or all non-global prefixes)
  if (h.includes(":")) {
    if (
      h === "::" ||
      h === "::1" ||
      h.startsWith("::") ||
      h.startsWith("0:") ||
      h.startsWith("64:ff9b:") ||
      h.startsWith("100::") ||
      h.startsWith("2001:db8:") ||
      h.startsWith("2002:") ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe8") ||
      h.startsWith("fe9") ||
      h.startsWith("fea") ||
      h.startsWith("feb") ||
      h.startsWith("fec") ||
      h.startsWith("fed") ||
      h.startsWith("fee") ||
      h.startsWith("fef") ||
      h.startsWith("ff")
    ) {
      return true;
    }
  }
  return false;
}

function isAllowedAudioFetchUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (u.protocol !== "https:" || u.username || u.password) return false;
    return !isPrivateOrBlockedHost(u.hostname);
  } catch (_) {
    return false;
  }
}

function isAllowedAudioMime(rawUrl, contentType) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (
    mime.startsWith("audio/") ||
    mime === "application/ogg" ||
    mime === "video/mp4" ||
    mime === "video/webm"
  ) {
    return true;
  }
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    try {
      const u = new URL(String(rawUrl || ""));
      return AUDIO_EXT_RE.test(u.pathname);
    } catch (_) {
      return false;
    }
  }
  return false;
}

function safeWsSend(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

// Find tab where Efekta is open (prefers active tab in current window if multiple exist)
async function findEfektaTab() {
  try {
    const tabs = await chrome.tabs.query({});
    const exactTabs = tabs.filter((t) => isLearnEfektaUrl(t.url));
    if (exactTabs.length > 0) {
      return exactTabs.find((t) => t.active) || exactTabs[0];
    }
    const anyEfekta = tabs.filter((t) => isEfektaUrl(t.url));
    return anyEfekta.find((t) => t.active) || anyEfekta[0] || null;
  } catch (_) {
    return null;
  }
}

// Send status update (hello / ping) to Go daemon so it knows which browser has Efekta open
async function sendStatusUpdate(type = "ping") {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const tab = await findEfektaTab();
  safeWsSend(socket, {
    type,
    client: "efekta-extension-v3",
    hasEfektaTab: !!tab,
    tabUrl: tab ? sanitizeUrl(tab.url) : "",
    userAgent: navigator.userAgent
  });
}

// Inject content scripts ONLY into Efekta dashboard/player frames — NEVER into catalyst-enter or Turnstile auth frames!
async function ensureContentScriptInjected(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  let contentFrameIds = [0];
  let mainWorldFrameIds = [];

  if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
    try {
      const allFrames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId }, resolve);
      });
      if (Array.isArray(allFrames) && allFrames.length > 0) {
        contentFrameIds = [];
        for (const f of allFrames) {
          if (!f || typeof f.frameId !== "number" || !f.url || isAuthGatewayUrl(f.url)) {
            continue;
          }
          if (isLearnEfektaUrl(f.url) || isStudyPlayerUrl(f.url)) {
            contentFrameIds.push(f.frameId);
          }
          if (isStudyPlayerUrl(f.url)) {
            mainWorldFrameIds.push(f.frameId);
          }
        }
      }
    } catch (_) {}
  }

  if (contentFrameIds.length > 0) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: contentFrameIds },
        files: ["content.js"]
      });
    } catch (e) {
      log("executeScript content.js error:", e && e.message);
    }
  }
  if (mainWorldFrameIds.length > 0) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: mainWorldFrameIds },
        files: ["injected.js"],
        world: "MAIN"
      });
    } catch (e) {
      log("executeScript injected.js error:", e && e.message);
    }
  }
}

function sendMsg(tabId, req, options = {}) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, req, options, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            transportError: true,
            error: chrome.runtime.lastError.message
          });
        } else if (!resp) {
          resolve({
            success: false,
            transportError: true,
            error: "Empty response from content script"
          });
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      resolve({
        success: false,
        transportError: true,
        error: e && e.message ? e.message : String(e)
      });
    }
  });
}

// Discover ordered candidate frameIds for a tab, pruning any stale/removed frames
async function getCandidateFrames(tabId) {
  const candidates = [];
  const pushUnique = (fId) => {
    if (typeof fId === "number" && !candidates.includes(fId)) {
      candidates.push(fId);
    }
  };

  let liveFrameIds = null;
  if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
    try {
      const allFrames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId }, resolve);
      });
      if (Array.isArray(allFrames) && allFrames.length > 0) {
        liveFrameIds = new Set(allFrames.map((f) => f.frameId));
        // Clean up any stale frames in tabFrames / tabActiveFrames
        if (tabActiveFrames.has(tabId) && !liveFrameIds.has(tabActiveFrames.get(tabId))) {
          tabActiveFrames.delete(tabId);
        }
        const map = tabFrames.get(tabId);
        if (map) {
          for (const k of Array.from(map.keys())) {
            if (!liveFrameIds.has(k)) map.delete(k);
          }
        }

        // Priority 1: Active study/lesson-player iframe matched strictly by hostname (never query params like redirect_uri)
        for (const f of allFrames) {
          if (f.frameId !== 0 && isStudyPlayerUrl(f.url)) {
            pushUnique(f.frameId);
          }
        }
        // Priority 1b: Registered lesson player frames from FRAME_REGISTER (excluding auth gateways)
        if (map) {
          for (const [k, info] of map.entries()) {
            if (
              k !== 0 &&
              info.isLessonPlayer &&
              !isAuthGatewayUrl(info.url) &&
              (!liveFrameIds || liveFrameIds.has(k))
            ) {
              pushUnique(k);
            }
          }
        }
        // Priority 2: Last known active frame (if non-zero and not an auth gateway)
        if (tabActiveFrames.has(tabId) && tabActiveFrames.get(tabId) !== 0) {
          const activeId = tabActiveFrames.get(tabId);
          const activeMeta = allFrames.find((f) => f.frameId === activeId);
          if (!activeMeta || !isAuthGatewayUrl(activeMeta.url)) {
            pushUnique(activeId);
          }
        }
        // Priority 3: Other non-auth Efekta child iframes
        for (const f of allFrames) {
          if (f.frameId !== 0 && isEfektaUrl(f.url) && !isAuthGatewayUrl(f.url)) {
            pushUnique(f.frameId);
          }
        }
        // Priority 4: Top-level frame (frameId 0)
        pushUnique(0);
        return candidates;
      }
    } catch (_) {}
  }

  if (tabActiveFrames.has(tabId)) {
    pushUnique(tabActiveFrames.get(tabId));
  }

  const framesMap = tabFrames.get(tabId);
  if (framesMap) {
    for (const [fId, info] of framesMap.entries()) {
      if (fId !== 0 && info.isLessonPlayer) pushUnique(fId);
    }
    for (const [fId] of framesMap.entries()) {
      if (fId !== 0) pushUnique(fId);
    }
  }

  pushUnique(0);
  return candidates;
}

const SELF_STUDY_URL = "https://learn.better.efekta.com/gap/ui/self-study";

async function waitForTabExitLessonView(tabId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.url && !t.url.includes("/lesson-view") && t.status === "complete") {
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function ensureSelfStudyFromLessonView(tab) {
  const activeFrame = tabActiveFrames.get(tab.id);
  const inLesson = (tab.url && tab.url.includes("/lesson-view")) || (activeFrame && activeFrame !== 0);
  if (!inLesson) return tab;

  try {
    await sendMessageToTabWithRetry(tab.id, { action: "_click_close_lesson" });
  } catch (_) {}

  const exitedViaBtn = await waitForTabExitLessonView(tab.id, 2500);
  if (!exitedViaBtn) {
    try {
      await chrome.tabs.update(tab.id, { url: SELF_STUDY_URL });
      await waitForTabExitLessonView(tab.id, 8000);
    } catch (_) {}
  }
  tabActiveFrames.delete(tab.id);
  await ensureContentScriptInjected(tab.id);
  await new Promise((r) => setTimeout(r, 350));
  return await chrome.tabs.get(tab.id);
}

async function sendMessageToTopFrame(tabId, req) {
  for (let pass = 0; pass < 2; pass++) {
    const res = await sendMsg(tabId, req, { frameId: 0 });
    if (res && !res.transportError && !isTransportError(res.error)) {
      tabActiveFrames.delete(tabId);
      return res;
    }
    if (pass === 0) {
      await ensureContentScriptInjected(tabId);
      await new Promise((r) => setTimeout(r, 250));
    } else {
      return res;
    }
  }
  return { success: false, error: "Failed to communicate with Efekta top frame" };
}

// Send command to content script with automatic iframe discovery, active-frame routing, and auto-reinject
async function sendMessageToTabWithRetry(tabId, req) {
  for (let pass = 0; pass < 2; pass++) {
    const candidateFrames = await getCandidateFrames(tabId);
    let lastAppFailure = null;
    let lastTransportError = "No frames available";
    let bestEmptyStatus = null;
    let retryAfterInject = false;

    for (const fId of candidateFrames) {
      const res = await sendMsg(tabId, req, { frameId: fId });
      if (res && res.success) {
        // If top frame (frame 0) responded but has 0 elements or 0 spoken phrases while child frames exist, prefer child frames!
        const isEmptyFrame =
          fId === 0 &&
          res.data &&
          res.data.elementsCount === 0 &&
          res.data.exerciseType === "unknown";
        const isSpokenZeroOnEmpty =
          fId === 0 &&
          typeof res.message === "string" &&
          res.message.includes("Completed 0");

        if ((isEmptyFrame || isSpokenZeroOnEmpty) && candidateFrames.some((c) => c !== 0)) {
          if (!bestEmptyStatus) bestEmptyStatus = res;
          continue;
        }

        // If top frame is empty and no child frame was found, try injecting scripts into all frames and retry pass 1!
        if (pass === 0 && isEmptyFrame && !candidateFrames.some((c) => c !== 0)) {
          if (!bestEmptyStatus) bestEmptyStatus = res;
          await ensureContentScriptInjected(tabId);
          await new Promise((r) => setTimeout(r, 280));
          retryAfterInject = true;
          break;
        }

        if (req.action === "status" || req.action === "state") {
          if (res.data && res.data.elementsCount > 0) {
            tabActiveFrames.set(tabId, fId);
            return res;
          }
          if (!bestEmptyStatus) bestEmptyStatus = res;
          continue;
        } else if (req.action === "eval") {
          if (Array.isArray(res.data) && res.data.length > 0) {
            tabActiveFrames.set(tabId, fId);
            return res;
          }
          if (!bestEmptyStatus) bestEmptyStatus = res;
          continue;
        } else {
          tabActiveFrames.set(tabId, fId);
          return res;
        }
      } else if (res) {
        if (res.transportError || isTransportError(res.error)) {
          lastTransportError = res.error;
          const map = tabFrames.get(tabId);
          if (map) map.delete(fId);
          if (tabActiveFrames.get(tabId) === fId) tabActiveFrames.delete(tabId);
        } else {
          // Real error from a live content script (e.g. element not found in this frame)
          if (!lastAppFailure) lastAppFailure = res;
        }
      }
    }

    if (retryAfterInject && pass === 0) {
      continue;
    }

    if (bestEmptyStatus) {
      if (pass === 1 || !retryAfterInject) {
        const authUrl = await detectAuthGatewayOnlyFrame(tabId);
        if (authUrl) {
          return buildHumanVerificationResponse(authUrl);
        }
      }
      return bestEmptyStatus;
    }

    if (lastAppFailure) {
      return lastAppFailure;
    }

    // All frames failed with transport error: inject scripts and retry after brief settle delay
    if (pass === 0) {
      const authUrl = await detectAuthGatewayOnlyFrame(tabId);
      if (authUrl) {
        return buildHumanVerificationResponse(authUrl);
      }
      await ensureContentScriptInjected(tabId);
      await new Promise((r) => setTimeout(r, 220));
    } else {
      return { success: false, error: lastTransportError };
    }
  }

  return { success: false, error: "Failed to communicate with Efekta tab" };
}

function connectDaemon() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    const socket = new WebSocket(DAEMON_WS_URL);
    ws = socket;

    socket.onopen = async () => {
      if (ws !== socket) return;
      log("Connected to Go daemon at", DAEMON_WS_URL);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        const tab = await findEfektaTab();
        if (tab) await ensureContentScriptInjected(tab.id);
      } catch (_) {}
      await sendStatusUpdate("hello");

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // 15s WebSocket heartbeat keeps Manifest V3 Service Worker alive
      heartbeatTimer = setInterval(() => {
        sendStatusUpdate("ping");
      }, 15000);
    };

    socket.onmessage = async (event) => {
      if (ws !== socket) return;
      let req;
      try {
        req = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (req.action === "ping") {
        await sendStatusUpdate("pong");
        return;
      }

      const reqId = req.id;
      const action = req.action;

      try {
        const tab = await findEfektaTab();
        if (!tab) {
          safeWsSend(socket, {
            id: reqId,
            success: false,
            error:
              "No Efekta tab found in browser. Please open https://learn.better.efekta.com"
          });
          return;
        }

        if (action === "debug_frames") {
          let navFrames = [];
          if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
            navFrames = await new Promise((r) => chrome.webNavigation.getAllFrames({ tabId: tab.id }, r));
          }
          const registered = [];
          const map = tabFrames.get(tab.id);
          if (map) {
            for (const [fId, info] of map.entries()) {
              registered.push({ fId, ...info });
            }
          }
          const candidateFrames = await getCandidateFrames(tab.id);
          const probeResults = [];
          for (const fId of candidateFrames) {
            const res = await sendMsg(tab.id, { action: "status" }, { frameId: fId });
            probeResults.push({
              fId,
              resSuccess: res ? res.success : false,
              elementsCount: (res && res.data && res.data.elementsCount) || 0,
              url: (res && res.data && res.data.url) || "",
              error: res && res.error
            });
          }
          safeWsSend(socket, {
            id: reqId,
            success: true,
            data: {
              tabId: tab.id,
              activeFrame: tabActiveFrames.get(tab.id),
              candidateFrames,
              probeResults: probeResults.map((p) => ({ ...p, url: sanitizeUrl(p.url) })),
              navFrames: (navFrames || []).map((f) => ({ ...f, url: sanitizeUrl(f.url) })),
              registered: registered.map((r) => ({ ...r, url: sanitizeUrl(r.url) }))
            }
          });
          return;
        }

        if (action === "reload_tab") {
          await chrome.tabs.reload(tab.id);
          safeWsSend(socket, { id: reqId, success: true, message: "Efekta tab reloaded" });
          return;
        }

        if (action === "reload_extension") {
          safeWsSend(socket, { id: reqId, success: true, message: "Extension reloading..." });
          setTimeout(() => {
            if (chrome.runtime && chrome.runtime.reload) {
              chrome.runtime.reload();
            }
          }, 60);
          return;
        }

        if (action === "screenshot") {
          try {
            if (!tab.active && chrome.tabs && chrome.tabs.update) {
              await chrome.tabs.update(tab.id, { active: true });
              await new Promise((r) => setTimeout(r, 80));
            }
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
            safeWsSend(socket, {
              id: reqId,
              success: true,
              data: {
                tabId: tab.id,
                url: sanitizeUrl(tab.url),
                screenshotBase64: dataUrl.replace(/^data:image\/png;base64,/, "")
              }
            });
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            const hint = /activeTab/i.test(msg)
              ? " (On Firefox MV3, click the Efekta extension toolbar icon once or grant host permissions in about:addons)"
              : "";
            safeWsSend(socket, {
              id: reqId,
              success: false,
              error: "Screenshot capture failed: " + msg + hint
            });
          }
          return;
        }

        let response;
        if (action === "lesson") {
          const lessonQuery = String(req.target || req.text || "next").trim().toLowerCase();
          if (lessonQuery === "close" || lessonQuery === "exit") {
            await ensureSelfStudyFromLessonView(tab);
            response = {
              success: true,
              message: "Closed lesson, returned to course overview"
            };
          } else if (lessonQuery === "resume") {
            response = await sendMessageToTabWithRetry(tab.id, req);
          } else {
            await ensureSelfStudyFromLessonView(tab);
            response = await sendMessageToTopFrame(tab.id, req);
            // When a lesson starts, the lesson player loads inside a cross-origin study.better.efekta.com iframe.
            // Wait briefly for it to mount and return the real Step 1 state instead of empty top-frame state.
            if (
              response &&
              response.success &&
              response.lesson &&
              lessonQuery !== "list" &&
              lessonQuery !== "ls" &&
              chrome.webNavigation &&
              chrome.webNavigation.getAllFrames
            ) {
              let playerFrameId = null;
              let authGatewaySeen = false;
              const waitEnd = Date.now() + 8000;
              while (Date.now() < waitEnd) {
                const frames = await new Promise((resolve) =>
                  chrome.webNavigation.getAllFrames({ tabId: tab.id }, resolve)
                );
                if (Array.isArray(frames)) {
                  const player = frames.find((f) => f.frameId !== 0 && isStudyPlayerUrl(f.url));
                  if (player) {
                    playerFrameId = player.frameId;
                    break;
                  }
                  if (frames.some((f) => isAuthGatewayUrl(f.url))) {
                    authGatewaySeen = true;
                  }
                }
                await new Promise((r) => setTimeout(r, 300));
              }
              if (playerFrameId !== null) {
                await ensureContentScriptInjected(tab.id);
                // Poll player frame until Angular bootstraps and renders elements (up to 5s)
                let readyState = null;
                const readyEnd = Date.now() + 5000;
                while (Date.now() < readyEnd) {
                  await new Promise((r) => setTimeout(r, 250));
                  const stRes = await sendMsg(tab.id, { action: "status" }, { frameId: playerFrameId });
                  if (stRes && stRes.success && stRes.data && stRes.data.elementsCount > 0) {
                    tabActiveFrames.set(tab.id, playerFrameId);
                    readyState = stRes.data;
                    break;
                  }
                }
                const playerRes = await sendMessageToTabWithRetry(tab.id, { action: "next", amount: 4 });
                if (playerRes && playerRes.data && (playerRes.data.elementsCount > 0 || !readyState)) {
                  response.data = playerRes.data;
                  response.autoAdvance = playerRes;
                } else if (readyState) {
                  response.data = readyState;
                  response.autoAdvance = playerRes;
                }
              } else if (authGatewaySeen) {
                const authUrl = await detectAuthGatewayOnlyFrame(tab.id);
                const hv = buildHumanVerificationResponse(authUrl || "https://catalyst-enter.better.efekta.com/");
                response.message =
                  (response.message || "Started lesson") +
                  " (human verification required in browser)";
                response.data = hv.data;
              }
            }
          }
        } else if (
          action === "batch" &&
          Array.isArray(req.commands) &&
          req.commands.length > 0 &&
          String(req.commands[0].action || "").toLowerCase() === "lesson" &&
          String(req.commands[0].target || "").trim().toLowerCase() !== "resume"
        ) {
          await ensureSelfStudyFromLessonView(tab);
          response = await sendMessageToTopFrame(tab.id, req);
        } else {
          response = await sendMessageToTabWithRetry(tab.id, req);
        }
        safeWsSend(socket, {
          id: reqId,
          ...response
        });
      } catch (e) {
        safeWsSend(socket, {
          id: reqId,
          success: false,
          error: "Error processing request: " + (e && e.message ? e.message : String(e))
        });
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      try {
        socket.close();
      } catch (_) {}
    };
  } catch (_) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectDaemon();
    }, 2000);
  }
}

if (chrome.alarms) {
  try {
    chrome.alarms.create("efekta-keepalive", { periodInMinutes: 0.5 });
  } catch (_) {}
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "efekta-keepalive") {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectDaemon();
      } else {
        sendStatusUpdate("ping");
      }
    }
  });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab && isEfektaUrl(tab.url)) {
      sendStatusUpdate("ping");
    }
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrames.delete(tabId);
    tabActiveFrames.delete(tabId);
  });
}

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectDaemon();
    } else {
      sendStatusUpdate("ping");
    }
  });
}

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details && details.url && isEfektaUrl(details.url)) {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectDaemon();
      } else {
        sendStatusUpdate("ping");
      }
    }
  });
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FRAME_REGISTER" && sender && sender.tab) {
    let map = tabFrames.get(sender.tab.id);
    if (!map) {
      map = new Map();
      tabFrames.set(sender.tab.id, map);
    }
    const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
    map.set(frameId, {
      url: msg.url,
      isLessonPlayer: !!msg.isLessonPlayer,
      isTop: !!msg.isTop
    });
    if (msg.isLessonPlayer && frameId !== 0) {
      tabActiveFrames.set(sender.tab.id, frameId);
    }
    return;
  }

  if (msg && msg.type === "NAVIGATE_TAB" && msg.url && sender && sender.tab) {
    try {
      const parsed = new URL(msg.url);
      if (parsed.protocol !== "https:" || parsed.hostname !== "learn.better.efekta.com") {
        sendResponse({ ok: false, error: "Blocked unsafe navigation target" });
        return false;
      }
    } catch (_) {
      sendResponse({ ok: false, error: "Invalid navigation URL" });
      return false;
    }
    chrome.tabs.update(sender.tab.id, { url: msg.url }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, tabId: tab ? tab.id : null });
    });
    return true;
  }

  // Fetch cross-origin reference audio bytes for Voice Engine
  if (msg && msg.type === "FETCH_AUDIO_B64" && msg.url) {
    if (!isAllowedAudioFetchUrl(msg.url)) {
      sendResponse({ ok: false, error: "Blocked unsafe or non-HTTPS audio URL" });
      return false;
    }
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: "omit", redirect: "follow" });
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        const finalUrl = resp.url || msg.url;
        if (!isAllowedAudioFetchUrl(finalUrl)) {
          sendResponse({ ok: false, error: "Blocked unsafe audio redirect target" });
          return;
        }
        const contentType = resp.headers && resp.headers.get ? resp.headers.get("content-type") || "" : "";
        if (!isAllowedAudioMime(finalUrl, contentType)) {
          sendResponse({ ok: false, error: `Blocked non-audio content type: ${contentType || "unknown"}` });
          return;
        }
        const contentLength = Number(resp.headers && resp.headers.get ? resp.headers.get("content-length") : 0);
        if (contentLength > MAX_AUDIO_BYTES) {
          sendResponse({ ok: false, error: "Audio clip exceeds 8MB size limit" });
          return;
        }
        const buf = await resp.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          sendResponse({ ok: false, error: "Empty audio response" });
          return;
        }
        if (buf.byteLength > MAX_AUDIO_BYTES) {
          sendResponse({ ok: false, error: "Audio clip exceeds 8MB size limit" });
          return;
        }
        const b64 = arrayBufferToBase64(buf);
        sendResponse({
          ok: true,
          b64,
          mime: contentType || "audio/mpeg"
        });
      } catch (e) {
        // Fallback through local Go daemon proxy
        try {
          const dResp = await fetch(DAEMON_TTS_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Efekta-Client": "efekta-cli"
            },
            body: JSON.stringify({ url: msg.url })
          });
          const data = await dResp.json();
          if (data && data.success && data.audioBase64) {
            sendResponse({ ok: true, b64: data.audioBase64, mime: data.mime || "audio/mpeg" });
            return;
          }
        } catch (_) {}
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  // Synthesize English speech via Go daemon /api/tts for Voice Engine
  if (msg && msg.type === "SYNTH_TTS_B64" && msg.text) {
    (async () => {
      try {
        const resp = await fetch(DAEMON_TTS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Efekta-Client": "efekta-cli"
          },
          body: JSON.stringify({
            text: msg.text,
            lang: msg.lang || "en"
          })
        });
        const data = await resp.json();
        if (data && data.success && data.audioBase64) {
          sendResponse({
            ok: true,
            b64: data.audioBase64,
            mime: data.mime || "audio/mpeg",
            source: data.source || "tts"
          });
        } else {
          sendResponse({
            ok: false,
            error: (data && data.error) || "TTS synthesis failed"
          });
        }
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "POPUP_GET_STATUS") {
    findEfektaTab().then((tab) => {
      sendResponse({
        wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
        hasEfektaTab: !!tab,
        tabUrl: tab ? sanitizeUrl(tab.url) : ""
      });
    });
    return true;
  }

  if (msg && msg.type === "POPUP_RECONNECT") {
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }
    connectDaemon();
    setTimeout(() => {
      findEfektaTab().then((tab) => {
        sendResponse({
          wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
          hasEfektaTab: !!tab,
          tabUrl: tab ? sanitizeUrl(tab.url) : ""
        });
      });
    }, 300);
    return true;
  }
});

connectDaemon();
