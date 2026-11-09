// Efekta Bridge - Service Worker / Background Script
const DAEMON_WS_URL = "ws://127.0.0.1:8765/ws";
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;

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

// Send command to content script with automatic injection recovery if tab wasn't refreshed
function sendMessageToTabWithRetry(tabId, req) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, req, async (response) => {
      if (chrome.runtime.lastError) {
        // Content script not loaded in this tab yet -> inject dynamically and retry once!
        await ensureContentScriptInjected(tabId);
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, req, (retryResp) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error:
                  chrome.runtime.lastError.message +
                  " (Please refresh the learn.better.efekta.com tab)"
              });
            } else {
              resolve(retryResp || { success: false, error: "Empty response from content script" });
            }
          });
        }, 120);
      } else {
        resolve(response || { success: false, error: "Empty response from content script" });
      }
    });
  });
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

// Handle messages from extension popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
