// Efekta AI Bridge - Popup UI Script
function renderStatus(res) {
  const indicator = document.getElementById("indicator");
  const daemonEl = document.getElementById("daemon-status");
  const tabEl = document.getElementById("tab-status");

  if (!res) {
    indicator.className = "badge err";
    daemonEl.textContent = "Disconnected";
    daemonEl.style.color = "#ef4444";
    tabEl.textContent = "Unknown";
    return;
  }

  if (res.wsConnected) {
    daemonEl.textContent = "Connected ✓";
    daemonEl.style.color = "#22c55e";
  } else {
    daemonEl.textContent = "Waiting for CLI...";
    daemonEl.style.color = "#eab308";
  }

  if (res.hasEfektaTab) {
    tabEl.textContent = "Found ✓";
    tabEl.style.color = "#22c55e";
  } else {
    tabEl.textContent = "Not Open ✗";
    tabEl.style.color = "#ef4444";
  }

  indicator.className = res.wsConnected && res.hasEfektaTab ? "badge ok" : "badge err";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "POPUP_GET_STATUS" }, (res) => {
    renderStatus(res);
  });
}

document.getElementById("reconnect-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "POPUP_RECONNECT" }, (res) => {
    renderStatus(res);
  });
});

refresh();
