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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

// Find tab where Efekta is open (prefers active tab in current window if multiple exist)
async function findEfektaTab() {
  try {
    const tabs = await chrome.tabs.query({});
    const exactTabs = tabs.filter((t) => t.url && t.url.includes("learn.better.efekta.com"));
    if (exactTabs.length > 0) {
      return exactTabs.find((t) => t.active) || exactTabs[0];
    }
    const anyEfekta = tabs.filter((t) => t.url && t.url.includes("efekta.com"));
    return anyEfekta.find((t) => t.active) || anyEfekta[0] || null;
  } catch (_) {
    return null;
  }
}

// Send status update (hello / ping) to Go daemon so it knows which browser has Efekta open
async function sendStatusUpdate(type = "ping") {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tab = await findEfektaTab();
  try {
    ws.send(
      JSON.stringify({
        type,
        client: "efekta-extension-v3",
        hasEfektaTab: !!tab,
        tabUrl: tab ? tab.url : "",
        userAgent: navigator.userAgent
      })
    );
  } catch (_) {}
}

// Ensure content scripts are injected into all frames even if tab was opened BEFORE extension reload
async function ensureContentScriptInjected(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (e) {
    log("executeScript content.js error:", e && e.message);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["injected.js"],
      world: "MAIN"
    });
  } catch (e) {
    log("executeScript injected.js error:", e && e.message);
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

        // Priority 1: Active lesson-player iframe if present
        for (const f of allFrames) {
          if (f.frameId !== 0 && f.url && f.url.includes("lesson-player")) {
            pushUnique(f.frameId);
          }
        }
        // Priority 1b: Registered lesson player frames from FRAME_REGISTER
        if (map) {
          for (const [k, info] of map.entries()) {
            if (k !== 0 && info.isLessonPlayer && (!liveFrameIds || liveFrameIds.has(k))) {
              pushUnique(k);
            }
          }
        }
        // Priority 2: Last known active frame (if non-zero)
        if (tabActiveFrames.has(tabId) && tabActiveFrames.get(tabId) !== 0) {
          pushUnique(tabActiveFrames.get(tabId));
        }
        // Priority 3: Other study/gap iframes
        for (const f of allFrames) {
          if (
            f.frameId !== 0 &&
            f.url &&
            (f.url.includes("study") || f.url.includes("gap"))
          ) {
            pushUnique(f.frameId);
          }
        }
        // Priority 4: Top-level frame (frameId 0)
        pushUnique(0);
        // Priority 5: Any remaining non-blank child frames
        for (const f of allFrames) {
          if (f.frameId !== 0 && f.url && !f.url.startsWith("about:")) {
            pushUnique(f.frameId);
          }
        }
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
    await chrome.tabs.update(tab.id, { url: SELF_STUDY_URL });
    await waitForTabExitLessonView(tab.id, 8000);
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

    if (bestEmptyStatus) {
      return bestEmptyStatus;
    }

    if (lastAppFailure) {
      return lastAppFailure;
    }

    // All frames failed with transport error: inject scripts and retry after brief settle delay
    if (pass === 0) {
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
    ws = new WebSocket(DAEMON_WS_URL);

    ws.onopen = async () => {
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

    ws.onmessage = async (event) => {
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
          ws.send(
            JSON.stringify({
              id: reqId,
              success: false,
              error:
                "No Efekta tab found in browser. Please open https://learn.better.efekta.com"
            })
          );
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
          ws.send(JSON.stringify({
            id: reqId,
            success: true,
            data: {
              tabId: tab.id,
              activeFrame: tabActiveFrames.get(tab.id),
              candidateFrames,
              probeResults,
              navFrames,
              registered
            }
          }));
          return;
        }

        if (action === "reload_tab") {
          await chrome.tabs.reload(tab.id);
          ws.send(JSON.stringify({ id: reqId, success: true, message: "Efekta tab reloaded" }));
          return;
        }

        if (action === "reload_extension") {
          ws.send(JSON.stringify({ id: reqId, success: true, message: "Extension reloading..." }));
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
            ws.send(
              JSON.stringify({
                id: reqId,
                success: true,
                data: {
                  tabId: tab.id,
                  url: tab.url,
                  screenshotBase64: dataUrl.replace(/^data:image\/png;base64,/, "")
                }
              })
            );
          } catch (e) {
            ws.send(
              JSON.stringify({
                id: reqId,
                success: false,
                error: "Screenshot capture failed: " + e.message
              })
            );
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
        ws.send(
          JSON.stringify({
            id: reqId,
            ...response
          })
        );
      } catch (e) {
        ws.send(
          JSON.stringify({
            id: reqId,
            success: false,
            error: "Error processing request: " + e.message
          })
        );
      }
    };

    ws.onclose = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
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
  chrome.alarms.create("efekta-keepalive", { periodInMinutes: 0.4 });
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
    if (changeInfo.status === "complete" && tab.url && tab.url.includes("efekta.com")) {
      sendStatusUpdate("ping");
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
      sendResponse({ ok: true, tabId: tab ? tab.id : null });
    });
    return true;
  }

  // Fetch cross-origin reference audio bytes for Voice Engine
  if (msg && msg.type === "FETCH_AUDIO_B64" && msg.url) {
    let validHttps = false;
    try {
      validHttps = new URL(msg.url).protocol === "https:";
    } catch (_) {}
    if (!validHttps) {
      sendResponse({ ok: false, error: "Blocked non-HTTPS audio URL" });
      return false;
    }
    (async () => {
      try {
        const resp = await fetch(msg.url);
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        const buf = await resp.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({
          ok: true,
          b64,
          mime: resp.headers.get("content-type") || "audio/mpeg"
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
        tabUrl: tab ? tab.url : ""
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
          tabUrl: tab ? tab.url : ""
        });
      });
    }, 300);
    return true;
  }
});

connectDaemon();
