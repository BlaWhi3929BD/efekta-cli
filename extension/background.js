// Efekta Bridge - Service Worker / Background Script
const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
const tabFrames = new Map(); // tabId -> Map(frameId -> { url, isLessonPlayer })

function log(...args) {
  console.log("[Efekta-Daemon-Bridge]", ...args);
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
  } catch (e) {
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
        client: "efekta-extension-v2",
        hasEfektaTab: !!tab,
        tabUrl: tab ? tab.url : "",
        userAgent: navigator.userAgent
      })
    );
  } catch (_) {}
}

// Ensure content scripts are injected even if tab was opened BEFORE extension was loaded
async function ensureContentScriptInjected(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["injected.js"],
      world: "MAIN"
    });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (_) {}
}

function sendMsg(tabId, req, options = {}) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, req, options, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { success: false, error: "Empty response from content script" });
      }
    });
  });
}

// Send command to content script with automatic iframe and frame-routing support
async function sendMessageToTabWithRetry(tabId, req) {
  const framesMap = tabFrames.get(tabId);
  let lessonFrameId = null;

  if (framesMap) {
    for (const [fId, info] of framesMap.entries()) {
      if (info.isLessonPlayer || (info.url && (info.url.includes("lesson-player") || info.url.includes("gap")))) {
        if (fId !== 0) {
          lessonFrameId = fId;
          break;
        }
      }
    }
  }

  // If a child lesson-player iframe is registered, prioritize sending to it
  if (lessonFrameId !== null) {
    const res = await sendMsg(tabId, req, { frameId: lessonFrameId });
    if (res && res.success) {
      if (req.action !== "status" || (res.data && res.data.elementsCount > 0)) {
        return res;
      }
    }
  }

  // Send to top-level frame (frameId: 0)
  let res = await sendMsg(tabId, req, { frameId: 0 });
  if (res && res.success && (req.action !== "status" || (res.data && res.data.elementsCount > 0))) {
    return res;
  }

  // If status returned 0 elements, check any other registered child frames
  if (framesMap && req.action === "status") {
    for (const [fId] of framesMap.entries()) {
      if (fId !== 0 && fId !== lessonFrameId) {
        const childRes = await sendMsg(tabId, req, { frameId: fId });
        if (childRes && childRes.success && childRes.data && childRes.data.elementsCount > 0) {
          return childRes;
        }
      }
    }
  }

  return res;
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
      await sendStatusUpdate("hello");

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // 15s WebSocket heartbeat keeps Manifest V3 Service Worker alive in Chromium 116+
      heartbeatTimer = setInterval(() => {
        sendStatusUpdate("ping");
      }, 15000);
    };

    ws.onmessage = async (event) => {
      let req;
      try {
        req = JSON.parse(event.data);
      } catch (err) {
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

        const response = await sendMessageToTabWithRetry(tab.id, req);
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
  } catch (err) {
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

// Keep MV3 service worker awake via chrome.alarms as backup
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

// Notify daemon immediately when user opens or navigates an Efekta tab
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
    log(`Registered frame (tab ${sender.tab.id}, frame ${frameId}): ${msg.url} (lesson=${msg.isLessonPlayer})`);
    return;
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
