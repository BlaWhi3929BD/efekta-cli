// Efekta Bridge - Content Script (Turbo Engine v3.0 + Voice Engine v3.0)
(function () {
  if (window.__efekta_content_active_instance) return;
  window.__efekta_content_active_instance = true;

  const EVT_IN = "efekta:in";
  const EVT_OUT = "efekta:out";

  // Fallback injection in case browser didn't support world: "MAIN" in manifest
  function injectPageScriptFallback() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("injected.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {}
  }
  injectPageScriptFallback();

  // Register frame with background service so commands can be routed directly to iframes
  try {
    const isTop = window === window.top;
    chrome.runtime.sendMessage({
      type: "FRAME_REGISTER",
      url: window.location.href,
      isTop,
      isLessonPlayer:
        !isTop &&
        (window.location.href.includes("lesson-player") ||
          window.location.href.includes("study.better.efekta.com"))
    });
  } catch (_) {}

  const elementRegistry = new Map();
  const idToTextMap = new Map();
  // Batch-level snapshot preserved across subcommands in a single batch call
  const batchElementSnapshot = new Map();
  const batchTextSnapshot = new Map();
  let inBatchExecution = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Send a request to MAIN-world injected.js over CustomEvent JSON bridge
  let voiceReqSeq = 0;
  function callVoiceBridge(payload, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const reqId = `vreq-${Date.now()}-${++voiceReqSeq}`;
      let done = false;
      const onOut = (ev) => {
        if (done) return;
        let data = null;
        try {
          data = JSON.parse(String(ev.detail || ""));
        } catch (_) {
          return;
        }
        if (!data || data.reqId !== reqId) return;
        done = true;
        document.removeEventListener(EVT_OUT, onOut);
        clearTimeout(timer);
        resolve(data);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        document.removeEventListener(EVT_OUT, onOut);
        resolve({ ok: false, error: "Voice bridge timeout" });
      }, timeoutMs);

      document.addEventListener(EVT_OUT, onOut);
      try {
        document.dispatchEvent(
          new CustomEvent(EVT_IN, {
            detail: JSON.stringify(Object.assign({}, payload, { reqId }))
          })
        );
      } catch (e) {
        done = true;
        document.removeEventListener(EVT_OUT, onOut);
        clearTimeout(timer);
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = win.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        parseFloat(style.opacity) === 0
      ) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Extract clean human-visible text without screen-reader duplicates (.cdk-visually-hidden),
  // hidden gap sizing placeholders, or icon ligatures
  function cleanText(el) {
    if (!el) return "";
    const hiddenSelector =
      ".cdk-visually-hidden, .sr-only, .visually-hidden, .screen-reader-overview, [hidden], .longest-option, ef-icon, mat-icon, svg, script, style";
    let raw = "";
    try {
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      const walker = doc.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_ACCEPT;
            if (p.closest && p.closest(hiddenSelector)) {
              return NodeFilter.FILTER_REJECT;
            }
            try {
              const st = win.getComputedStyle(p);
              if (
                st &&
                (st.display === "none" ||
                  st.visibility === "hidden" ||
                  parseFloat(st.opacity) === 0)
              ) {
                return NodeFilter.FILTER_REJECT;
              }
            } catch (_) {}
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      const parts = [];
      let cur = walker.nextNode();
      while (cur) {
        const val = (cur.nodeValue || "").trim();
        if (val) parts.push(val);
        cur = walker.nextNode();
      }
      raw = parts.join(" ");
    } catch (_) {
      raw = el.innerText || el.textContent || "";
    }

    if (!raw) {
      raw =
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        "";
    }

    raw = String(raw).trim().replace(/\s+/g, " ");

    // Deduplicate repeated halves caused by nested aria spans (e.g. "stress stress" -> "stress")
    const words = raw.split(" ");
    if (words.length >= 2 && words.length % 2 === 0) {
      const half = words.length / 2;
      const firstHalf = words.slice(0, half).join(" ");
      const secondHalf = words.slice(half).join(" ");
      if (firstHalf.toLowerCase() === secondHalf.toLowerCase()) {
        raw = firstHalf;
      }
    }
    return raw;
  }

  // Wait automatically until Efekta's transient UI locks (.locked, .item-disabled) clear
  async function waitUntilUnlocked(maxWaitMs = 1600) {
    const start = Date.now();
    const docs = getAllDocs();
    while (Date.now() - start < maxWaitMs) {
      let busy = false;
      for (const doc of docs) {
        if (
          doc.querySelector(
            ".locked, .item-disabled, .matching-option-wp.disabled"
          )
        ) {
          busy = true;
          break;
        }
      }
      if (!busy) return true;
      await sleep(25);
    }
    return false;
  }

  // Auto-dismiss transient "Okay, got it" activity instruction overlays
  async function dismissOverlaysIfPresent() {
    const docs = getAllDocs();
    for (const doc of docs) {
      const buttons = Array.from(doc.querySelectorAll("button")).filter(isVisible);
      const gotIt = buttons.find((b) => /^(okay,\s*got it|got it|ok,\s*got it)$/i.test(cleanText(b)));
      if (gotIt) {
        await simulateClick(gotIt);
        await sleep(120);
        return true;
      }
    }
    return false;
  }

  // Dispatch realistic single click (pierces shadow DOM and ef-lesson-overview-step)
  async function simulateClick(rawEl) {
    if (!rawEl) return false;
    let el = rawEl;
    if (rawEl.shadowRoot) {
      const shadowBtn = rawEl.shadowRoot.querySelector(
        'button, a, [role="button"], div, span'
      );
      if (shadowBtn) el = shadowBtn;
    } else if (rawEl.tagName && /^(ef-|app-|ui-)/i.test(rawEl.tagName)) {
      // For Angular custom elements without shadow DOM, target inner clickable element
      const innerTarget = rawEl.querySelector(
        '.content, .step, button, a, [role="button"], ef-lesson-overview-step-info'
      );
      if (innerTarget) el = innerTarget;
    }

    try {
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    } catch (_) {}

    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const PEvent = win.PointerEvent || PointerEvent;
    const MEvent = win.MouseEvent || MouseEvent;

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const doc = el.ownerDocument || document;
    let hitEl = el;
    try {
      if (typeof doc.elementFromPoint === "function") {
        const topEl = doc.elementFromPoint(x, y);
        if (topEl && (topEl === el || el.contains(topEl) || topEl.contains(el))) {
          hitEl = topEl;
        }
      }
    } catch (_) {}

    const baseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: x,
      clientY: y,
      screenX: x + (win.screenX || 0),
      screenY: y + (win.screenY || 0),
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    };

    hitEl.dispatchEvent(new PEvent("pointerover", baseInit));
    hitEl.dispatchEvent(new PEvent("pointerenter", { ...baseInit, bubbles: false }));
    hitEl.dispatchEvent(new MEvent("mouseover", baseInit));
    hitEl.dispatchEvent(new MEvent("mouseenter", { ...baseInit, bubbles: false }));
    hitEl.dispatchEvent(new PEvent("pointerdown", baseInit));
    hitEl.dispatchEvent(new MEvent("mousedown", baseInit));

    if (typeof hitEl.focus === "function") {
      try {
        hitEl.focus({ preventScroll: true });
      } catch (_) {}
    }

    await sleep(20);

    const upInit = { ...baseInit, buttons: 0 };
    hitEl.dispatchEvent(new PEvent("pointerup", upInit));
    hitEl.dispatchEvent(new MEvent("mouseup", upInit));

    if (typeof hitEl.click === "function") {
      hitEl.click();
    } else {
      hitEl.dispatchEvent(new MEvent("click", upInit));
    }

    if (el && el !== hitEl && typeof el.click === "function") {
      try {
        el.click();
      } catch (_) {}
    }
    if (rawEl && rawEl !== el && rawEl !== hitEl && typeof rawEl.click === "function") {
      try {
        rawEl.click();
      } catch (_) {}
    }

    return true;
  }

  // Simulate Drag and Drop across HTML5 DnD, @dnd-kit (Pointer), and react-beautiful-dnd (Mouse)
  async function simulateDragAndDrop(sourceEl, targetEl) {
    if (!sourceEl || !targetEl) return false;

    try {
      sourceEl.scrollIntoView({ behavior: "instant", block: "center" });
      targetEl.scrollIntoView({ behavior: "instant", block: "center" });
    } catch (_) {}

    await sleep(10);

    const srcRect = sourceEl.getBoundingClientRect();
    const dstRect = targetEl.getBoundingClientRect();

    const startX = srcRect.left + srcRect.width / 2;
    const startY = srcRect.top + srcRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;

    const downInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: startX,
      clientY: startY,
      screenX: startX + (window.screenX || 0),
      screenY: startY + (window.screenY || 0),
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    };

    const win = (sourceEl.ownerDocument && sourceEl.ownerDocument.defaultView) || window;
    const doc = sourceEl.ownerDocument || document;

    sourceEl.dispatchEvent(new PointerEvent("pointerover", downInit));
    sourceEl.dispatchEvent(new MouseEvent("mouseover", downInit));
    sourceEl.dispatchEvent(new PointerEvent("pointerdown", downInit));
    sourceEl.dispatchEvent(new MouseEvent("mousedown", downInit));

    let dataTransfer = null;
    try {
      dataTransfer = new DataTransfer();
      const text = cleanText(sourceEl);
      dataTransfer.setData("text/plain", text);
      sourceEl.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer,
          clientX: startX,
          clientY: startY
        })
      );
    } catch (_) {}

    await sleep(40);

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const curX = startX + ((endX - startX) * i) / steps;
      const curY = startY + ((endY - startY) * i) / steps;
      const moveInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: curX,
        clientY: curY,
        screenX: curX + (win.screenX || 0),
        screenY: curY + (win.screenY || 0),
        button: 0,
        buttons: 1,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse"
      };

      const hoverEl = doc.elementFromPoint(curX, curY) || targetEl;
      hoverEl.dispatchEvent(new PointerEvent("pointermove", moveInit));
      hoverEl.dispatchEvent(new MouseEvent("mousemove", moveInit));
      doc.dispatchEvent(new PointerEvent("pointermove", moveInit));
      doc.dispatchEvent(new MouseEvent("mousemove", moveInit));
      win.dispatchEvent(new PointerEvent("pointermove", moveInit));
      win.dispatchEvent(new MouseEvent("mousemove", moveInit));

      if (dataTransfer) {
        if (i === steps - 1) {
          targetEl.dispatchEvent(
            new DragEvent("dragenter", {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer,
              clientX: curX,
              clientY: curY
            })
          );
        }
        targetEl.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer,
            clientX: curX,
            clientY: curY
          })
        );
      }
      await sleep(25);
    }

    if (dataTransfer) {
      targetEl.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer,
          clientX: endX,
          clientY: endY
        })
      );
    }

    const upInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: endX,
      clientY: endY,
      screenX: endX + (win.screenX || 0),
      screenY: endY + (win.screenY || 0),
      button: 0,
      buttons: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    };

    targetEl.dispatchEvent(new PointerEvent("pointerup", upInit));
    targetEl.dispatchEvent(new MouseEvent("mouseup", upInit));
    doc.dispatchEvent(new PointerEvent("pointerup", upInit));
    doc.dispatchEvent(new MouseEvent("mouseup", upInit));
    win.dispatchEvent(new PointerEvent("pointerup", upInit));
    win.dispatchEvent(new MouseEvent("mouseup", upInit));

    if (dataTransfer) {
      sourceEl.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer,
          clientX: endX,
          clientY: endY
        })
      );
    }

    return true;
  }

  // React/Angular compatible controlled input value setter
  function setNativeValue(el, value) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    let proto = null;
    if (tag === "input") proto = window.HTMLInputElement.prototype;
    else if (tag === "textarea") proto = window.HTMLTextAreaElement.prototype;
    else if (tag === "select") proto = window.HTMLSelectElement.prototype;

    if (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
        return;
      }
    }
    el.value = value;
  }

  // Simulate text typing compatible with React/Angular and contenteditable blanks.
  // Fast-paths long essay inputs (>30 chars) in <50ms so 120-word writing tasks never time out!
  async function simulateType(el, text, delayMs = 6) {
    if (!el) return false;
    await dismissOverlaysIfPresent();
    await simulateClick(el);
    try {
      el.focus();
    } catch (_) {}

    const str = String(text || "");
    const isContentEditable =
      el.isContentEditable || el.getAttribute("contenteditable") === "true";

    if (isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
      );
      if (str.length > 35) {
        el.textContent = str;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            inputType: "insertText",
            data: str
          })
        );
      } else {
        for (const ch of str) {
          el.dispatchEvent(
            new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })
          );
          el.textContent += ch;
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              cancelable: false,
              inputType: "insertText",
              data: ch
            })
          );
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    setNativeValue(el, "");
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
    );

    if (str.length > 35) {
      // Instant bulk fill for long essays / sentences with realistic final keystroke events
      const prefix = str.slice(0, -1);
      const lastCh = str.slice(-1);
      if (prefix) {
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: prefix
          })
        );
        setNativeValue(el, prefix);
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            inputType: "insertText",
            data: prefix
          })
        );
      }
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: lastCh, bubbles: true, cancelable: true })
      );
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: lastCh
        })
      );
      setNativeValue(el, str);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: lastCh
        })
      );
      el.dispatchEvent(new KeyboardEvent("keyup", { key: lastCh, bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const wci = el.closest ? el.closest("ef-writing-challenge-input") : null;
      if (wci && wci.__zone_symbol__onInputChangedfalse) {
        const z = wci.__zone_symbol__onInputChangedfalse;
        if (z && z[0] && typeof z[0].callback === "function") {
          try {
            z[0].callback(str);
          } catch (_) {}
        }
      }
      await sleep(30);
      return true;
    }

    let current = "";
    for (const ch of str) {
      current += ch;
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })
      );
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: ch
        })
      );
      setNativeValue(el, current);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: ch
        })
      );
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      if (delayMs > 0) await sleep(delayMs);
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Simulate pressing a special key (Enter, Backspace, Escape, Tab, Space, Arrow*)
  async function simulateKeyPress(targetSpec, key) {
    const el =
      (targetSpec ? resolveElement(targetSpec) : null) ||
      document.activeElement ||
      document.body;
    const keyMap = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Space: { key: " ", code: "Space", keyCode: 32 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }
    };
    const info = keyMap[key] || { key, code: key, keyCode: key.charCodeAt(0) || 0 };
    const init = {
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    await sleep(10);
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }

  // Gather all accessible documents (top-level window + same-origin iframes)
  function getAllDocs() {
    const docs = [document];
    try {
      const iframes = Array.from(document.querySelectorAll("iframe"));
      for (const frame of iframes) {
        try {
          if (frame.contentDocument && frame.contentDocument.body) {
            docs.push(frame.contentDocument);
          }
        } catch (_) {}
      }
    } catch (_) {}
    return docs;
  }

  function findInteractiveByText(needleRaw) {
    if (!needleRaw) return null;
    const needle = needleRaw.trim().toLowerCase();
    if (!needle) return null;
    const docs = getAllDocs();
    const sel =
      "button, [role='button'], .matching-option-wp, .drawer-option, ef-lesson-overview-step, a, label, li, div, span";
    for (const doc of docs) {
      const candidates = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
      const exact = candidates.find((e) => cleanText(e).toLowerCase() === needle);
      if (exact) return exact;
      const partial = candidates.find((e) => cleanText(e).toLowerCase().includes(needle));
      if (partial) return partial;
    }
    return null;
  }

  // Resolve element by virtual ID, batch snapshot, saved ID text snapshot, data-efekta-id, coordinates "x,y", CSS selector, or text
  function resolveElement(target) {
    if (!target) return null;

    function isConnectedNode(el) {
      return (
        el &&
        (el.isConnected ||
          (el.ownerDocument && el.ownerDocument.body && el.ownerDocument.body.contains(el)))
      );
    }

    function findOnce(allowSavedTextFallback) {
      // 1. If in batch execution, prefer the initial pre-batch DOM reference if still connected!
      if (inBatchExecution && batchElementSnapshot.has(target)) {
        const snapEl = batchElementSnapshot.get(target);
        if (isConnectedNode(snapEl) && isVisible(snapEl)) {
          return snapEl;
        }
      }

      if (elementRegistry.has(target)) {
        const el = elementRegistry.get(target);
        if (isConnectedNode(el)) {
          return el;
        }
      }

      const docs = getAllDocs();

      // Lookup via persistent data attribute (including shadow roots)
      for (const doc of docs) {
        try {
          const byAttr = doc.querySelector(`[data-efekta-id="${CSS.escape(target)}"]`);
          if (byAttr && isVisible(byAttr)) return byAttr;
          const allHosts = doc.querySelectorAll("*");
          for (const host of allHosts) {
            if (host.shadowRoot) {
              const inner = host.shadowRoot.querySelector(
                `[data-efekta-id="${CSS.escape(target)}"]`
              );
              if (inner && isVisible(inner)) return inner;
            }
          }
        } catch (_) {}
      }

      // If target was a virtual ID whose DOM element re-rendered mid-batch, match by its snapshotted clean text!
      if (allowSavedTextFallback) {
        const savedText =
          (inBatchExecution && batchTextSnapshot.get(target)) || idToTextMap.get(target);
        if (savedText) {
          const bySaved = findInteractiveByText(savedText);
          if (bySaved) return bySaved;
        }
      }

      // Coordinate lookup "x,y"
      if (typeof target === "string" && /^\d+\s*,\s*\d+$/.test(target.trim())) {
        const [x, y] = target.split(",").map((s) => Number(s.trim()));
        if (!isNaN(x) && !isNaN(y)) {
          for (const doc of docs) {
            const el = doc.elementFromPoint(x, y);
            if (el) return el;
          }
        }
      }

      // CSS selector lookup
      for (const doc of docs) {
        try {
          const bySelector = doc.querySelector(target);
          if (bySelector && isVisible(bySelector)) return bySelector;
          const allHosts = doc.querySelectorAll("*");
          for (const host of allHosts) {
            if (host.shadowRoot) {
              const inner = host.shadowRoot.querySelector(target);
              if (inner && isVisible(inner)) return inner;
            }
          }
        } catch (_) {}
      }

      // Text content match fallback
      return findInteractiveByText(target);
    }

    const firstTry = findOnce(true);
    if (firstTry) return firstTry;

    // Element not found - re-index DOM and retry
    inspectState();
    return findOnce(true);
  }

  // Extract visible media status (Video & Audio)
  function getMediaStatus() {
    const docs = getAllDocs();
    const mediaList = [];
    for (const doc of docs) {
      mediaList.push(...Array.from(doc.querySelectorAll("video")));
      mediaList.push(...Array.from(doc.querySelectorAll("audio")));
    }
    if (!mediaList.length) {
      return {
        hasVideo: false,
        hasAudio: false,
        isPlaying: false,
        paused: true,
        ended: true,
        currentTime: 0,
        duration: 0
      };
    }
    const visibleMedia = mediaList.filter((m) => {
      const src = (m.currentSrc || m.src || "").toLowerCase();
      if (src.includes("addi") || src.includes("rain.mp4")) return false;
      if (!isVisible(m)) return false;
      return true;
    });
    const candidates = visibleMedia.length ? visibleMedia : mediaList;
    const active = candidates.find((m) => !m.paused && !m.ended) || candidates[0];
    const hasVideo = candidates.some((m) => m.tagName.toLowerCase() === "video");
    const hasAudio = candidates.some((m) => m.tagName.toLowerCase() === "audio");
    return {
      hasVideo,
      hasAudio,
      paused: !!active.paused,
      ended: !!active.ended,
      currentTime: Number((active.currentTime || 0).toFixed(2)),
      duration: Number((active.duration || 0).toFixed(2)) || 0,
      isPlaying: !active.paused && !active.ended && active.currentTime > 0
    };
  }

  // Extract speaking task metadata (target phrase to pronounce, Play Audio button, progress counter)
  function extractSpeakingInfo(docs) {
    let targetPhrase = "";
    let playAudioBtn = null;
    let progressText = "";
    let isSpeakingPractice = false;

    for (const doc of docs) {
      const practiceTask = doc.querySelector("ef-speaking-practice-task");
      if (practiceTask && isVisible(practiceTask)) {
        isSpeakingPractice = true;
      }

      const wordLabels = Array.from(
        doc.querySelectorAll("ef-speaking-practice-task label.word, span.target ol li label, label.word")
      ).filter(isVisible);
      if (wordLabels.length > 0) {
        const joined = wordLabels
          .map((w) => cleanText(w))
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (joined) {
          targetPhrase = joined;
          isSpeakingPractice = true;
        }
      }

      if (!targetPhrase) {
        const targetOl = doc.querySelector("ef-speaking-practice-task span.target ol, span.target ol");
        if (targetOl && isVisible(targetOl)) {
          targetPhrase = cleanText(targetOl);
          isSpeakingPractice = true;
        }
      }

      const audioBtn = doc.querySelector(
        "ef-speaking-practice-task button.audio-btn, ef-media-short-audio-player button, button.audio-btn.with-label, button.audio-btn"
      );
      if (audioBtn && isVisible(audioBtn)) {
        playAudioBtn = audioBtn;
      }

      const heading = doc.querySelector(".question-options-heading");
      if (heading && isVisible(heading)) {
        progressText = cleanText(heading);
      }
    }

    return {
      isSpeakingPractice,
      targetPhrase,
      playAudioBtn,
      progressText
    };
  }

  // Build rich, noise-free semantic page state + instant agentHint for AI agents
  function inspectState() {
    elementRegistry.clear();
    idToTextMap.clear();
    const docs = getAllDocs();
    for (const doc of docs) {
      try {
        doc
          .querySelectorAll("[data-efekta-id]")
          .forEach((n) => n.removeAttribute("data-efekta-id"));
      } catch (_) {}
    }

    const counters = {
      opt: 1,
      item: 1,
      slot: 1,
      input: 1,
      next: 1,
      skip: 1,
      act: 1,
      mic: 1,
      stage: 1,
      btn: 1
    };

    const interactiveSelectors = [
      "button",
      "[role='button']",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='radio']",
      "[role='checkbox']",
      "[role='option']",
      "[role='tab']",
      ".matching-option-wp",
      ".drawer-option",
      "ef-multiple-choice-speech-task-response-option",
      ".response-option",
      "button.selection-gap-button",
      "button.item",
      "ef-lesson-overview-step",
      "ef-activity-navigator .wp",
      "[draggable='true']",
      ".draggable",
      "[data-rbd-draggable-id]",
      "[data-rbd-droppable-id]",
      "[data-testid]",
      "[class*='option']",
      "[class*='choice']",
      "[class*='answer-option']",
      "[class*='answer-item']",
      "[class*='card']",
      "[class*='word']",
      "[class*='chip']",
      "[class*='token']",
      "[class*='blank']",
      "[class*='gap']",
      "[class*='slot']",
      "[class*='drop']",
      "[class*='column']",
      "[class*='category']",
      "[class*='stage']",
      "[class*='step']"
    ].join(",");

    const containerBlacklistSelector = [
      ".question-options",
      ".question-options-heading",
      ".options",
      ".task-wp",
      ".contents",
      ".item-list",
      ".items-container",
      ".matching-options",
      ".drawer-options",
      ".answers-info",
      ".correct-answers-info",
      ".skipped-answers-info",
      "ef-end-of-activity-summary",
      ".summary-wp",
      ".end-of-activity-summary",
      "ef-instructions",
      "ef-matching-task",
      "ef-dynamic-renderer",
      "ef-activity-navigator",
      "ef-speaking-practice-task",
      "ef-multiple-choice-speech-task",
      ".step-overview-list"
    ].join(",");

    const chromeNoiseRegex =
      /^(show subtitles|hide subtitles|mute video|unmute video|play video|pause video|1x|1\.25x|1\.5x|0\.75x|0\.5x|view activity instructions|open help menu|open hint|open calculator|more options|close|back)$/i;

    const rawSet = new Set();
    for (const doc of docs) {
      doc.querySelectorAll(interactiveSelectors).forEach((el) => rawSet.add(el));
      const pointerCandidates = doc.querySelectorAll("div, span, li, label");
      for (const node of pointerCandidates) {
        if (rawSet.has(node)) continue;
        const r = node.getBoundingClientRect();
        if (r.width >= 20 && r.width <= 700 && r.height >= 18 && r.height <= 220) {
          try {
            const w = (node.ownerDocument && node.ownerDocument.defaultView) || window;
            if (w.getComputedStyle(node).cursor === "pointer") {
              rawSet.add(node);
            }
          } catch (_) {}
        }
      }
    }

    const rawList = Array.from(rawSet);
    const elements = [];
    const registeredNodes = new Set();

    for (const el of rawList) {
      if (registeredNodes.has(el)) continue;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (
        tag === "body" ||
        tag === "html" ||
        tag === "head" ||
        tag === "ol" ||
        tag === "ul" ||
        tag === "form" ||
        tag === "ef-matching-option"
      ) {
        continue;
      }

      // Skip non-interactive speaking display word labels (<label class="word"> inside ef-speaking-practice-task)
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      const role = (el.getAttribute("role") || "").toLowerCase();
      const testId = (el.getAttribute("data-testid") || "").toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      const rawText = cleanText(el);
      if (
        tag === "label" &&
        /\bword\b/.test(cls) &&
        el.closest &&
        el.closest("ef-speaking-practice-task, span.target")
      ) {
        continue;
      }

      // Skip known layout/wrapper containers so they never swallow child options/cards
      try {
        if (el.matches && el.matches(containerBlacklistSelector)) continue;
      } catch (_) {}

      // Skip static non-button children inside end-of-activity summary or instructions
      if (
        el.closest &&
        el.closest(
          "ef-end-of-activity-summary, .summary-wp, .end-of-activity-summary, ef-instructions, .answers-info"
        )
      ) {
        if (tag !== "button" && role !== "button") {
          continue;
        }
      }

      // Skip already completed matching pairs
      if (
        cls.includes("matching-option-wp") &&
        (cls.includes("correct") ||
          (el.parentElement &&
            (el.parentElement.className || "").toLowerCase().includes("correct")))
      ) {
        continue;
      }

      // Skip generic container divs/sections that wrap multiple interactive children
      if (tag === "div" || tag === "section" || tag === "main" || tag === "article") {
        if (
          !cls.includes("matching-option-wp") &&
          !cls.includes("drawer-option") &&
          !cls.includes("wp")
        ) {
          const childInteractives = el.querySelectorAll(
            "button, [role='button'], .matching-option-wp, .drawer-option, input, ef-lesson-overview-step"
          );
          if (childInteractives.length >= 2) {
            continue;
          }
        }
      }

      const rect = el.getBoundingClientRect();
      if (
        tag === "div" &&
        rect.width > window.innerWidth * 0.8 &&
        rect.height > window.innerHeight * 0.45 &&
        !el.getAttribute("draggable")
      ) {
        continue;
      }

      // Filter out irrelevant media player / header UI chrome
      if (
        chromeNoiseRegex.test(rawText) ||
        chromeNoiseRegex.test(ariaLabel)
      ) {
        continue;
      }

      // Skip child spans/divs if an interactive parent is already registered
      let hasRegisteredParent = false;
      let parent = el.parentElement;
      while (
        parent &&
        parent.tagName &&
        parent.tagName.toLowerCase() !== "body" &&
        parent.tagName.toLowerCase() !== "html"
      ) {
        if (registeredNodes.has(parent)) {
          const pTag = parent.tagName.toLowerCase();
          if (pTag !== "ol" && pTag !== "ul") {
            if (
              tag !== "input" &&
              tag !== "textarea" &&
              tag !== "button" &&
              !cls.includes("matching-option-wp") &&
              !cls.includes("drawer-option") &&
              tag !== "ef-multiple-choice-speech-task-response-option" &&
              !cls.includes("response-option")
            ) {
              hasRegisteredParent = true;
              break;
            }
          }
        }
        parent = parent.parentElement;
      }
      if (hasRegisteredParent) continue;

      // Classify element accurately
      let type = "button";
      let prefix = "btn";
      const lowerText = (rawText + " " + ariaLabel + " " + testId).toLowerCase();

      // 1. Top activity progress dots (ef-activity-navigator .wp)
      if (
        (el.closest && el.closest("ef-activity-navigator")) ||
        lowerText.includes("step navigation") ||
        /\bactivity\s+\d+\s+of\s+\d+\b/i.test(lowerText)
      ) {
        type = "activity_nav";
        prefix = "act";
      }
      // 2. Skip task button ("SKIP")
      else if (
        cls.includes("skip-task-button") ||
        /^skip$/i.test(rawText)
      ) {
        type = "skip_btn";
        prefix = "skip";
      }
      // 3. Matching pairs (.matching-option-wp) & Sorting buttons (button.item.target / button.item.option)
      else if (cls.includes("matching-option-wp") || (tag === "button" && /\bitem\b/.test(cls))) {
        if (cls.includes("target")) {
          type = "drop_target";
          prefix = "slot";
        } else {
          type = "draggable";
          prefix = "item";
        }
      }
      // 4. Selection-gap blank button (button.selection-gap-button)
      else if (cls.includes("selection-gap-button")) {
        type = "drop_target";
        prefix = "slot";
      }
      // 5. Bottom word drawer option (div.drawer-option)
      else if (cls.includes("drawer-option")) {
        type = "choice";
        prefix = "opt";
      }
      // 6. Text inputs / contenteditable blanks
      else if (
        tag === "input" ||
        tag === "textarea" ||
        el.isContentEditable ||
        el.getAttribute("contenteditable") === "true"
      ) {
        if (el.type === "radio" || el.type === "checkbox") {
          type = "choice";
          prefix = "opt";
        } else {
          type = "input";
          prefix = "input";
        }
      }
      // 7. Next / Continue / Start Next Step / Back to lesson overview / Generate feedback button
      else if (
        cls.includes("next-task-button") ||
        cls.includes("self-evaluation-submit") ||
        /^(next|start next step|continue|submit|check|proceed|done|finish|start lesson|try again|back to lesson overview|return to unit overview|generate feedback|далее|продолжить|проверить|готово)$/i.test(
          rawText
        )
      ) {
        type = "next_btn";
        prefix = "next";
      }
      // 8. Microphone / Record button
      else if (
        cls.includes("mic") ||
        cls.includes("record") ||
        cls.includes("audio-recorder-btn") ||
        /\b(record|speak|microphone|start recording|stop recording|click to record|запись)\b/i.test(
          lowerText
        )
      ) {
        type = "mic_btn";
        prefix = "mic";
      }
      // 9. Lesson Overview Steps / Stage navigation
      else if (
        tag === "ef-lesson-overview-step" ||
        role === "tab" ||
        cls.includes("stage") ||
        cls.includes("overview-step") ||
        testId.includes("stage") ||
        testId.includes("step")
      ) {
        type = "stage_nav";
        prefix = "stage";
      }
      // 10. Draggable tokens / cards
      else if (
        el.getAttribute("draggable") === "true" ||
        el.hasAttribute("data-rbd-draggable-id") ||
        cls.includes("draggable") ||
        cls.includes("word-chip") ||
        cls.includes("chip") ||
        cls.includes("token") ||
        (cls.includes("card") && !cls.includes("column") && rect.height < 180)
      ) {
        type = "draggable";
        prefix = "item";
      }
      // 11. Drop slots / blanks / columns
      else if (
        el.hasAttribute("data-rbd-droppable-id") ||
        cls.includes("slot") ||
        cls.includes("blank") ||
        (/\b(gap|fill-gap)\b/.test(cls) && !cls.includes("gap-b2s")) ||
        cls.includes("drop") ||
        cls.includes("column") ||
        cls.includes("category") ||
        cls.includes("bucket")
      ) {
        type = "drop_target";
        prefix = "slot";
      }
      // 12. Multiple choice options & avatar speech response options (A, B, C)
      else if (
        role === "radio" ||
        role === "checkbox" ||
        role === "option" ||
        tag === "ef-multiple-choice-speech-task-response-option" ||
        cls.includes("response-option") ||
        (cls.includes("choice") && !cls.includes("heading")) ||
        (cls.includes("option") && !cls.includes("heading")) ||
        /\b(answer-option|answer-item)\b/i.test(cls)
      ) {
        type = "choice";
        prefix = "opt";
      } else if (tag === "button" || role === "button") {
        type = "button";
        prefix = "btn";
      } else {
        if (!rawText) continue;
        type = "element";
        prefix = "btn";
      }

      let finalText = rawText;
      if (
        tag === "ef-multiple-choice-speech-task-response-option" ||
        cls.includes("response-option")
      ) {
        const pfxEl = el.querySelector(".prefix, [class*='prefix']");
        const cntEl = el.querySelector(".content, label, [class*='content']");
        if (pfxEl && cntEl) {
          const p = (pfxEl.textContent || "").replace(/[:.)-\s]+$/, "").trim().toUpperCase();
          const c = (cntEl.textContent || "").replace(/\s+/g, " ").trim();
          if (p && c) {
            finalText = `${p}: ${c}`;
          }
        } else if (/^[A-Z]\s*[:.)-]?\s+\S/i.test(rawText)) {
          finalText = rawText.replace(/^([A-Z])\s*[:.)-]?\s+(.*)$/i, "$1: $2");
        }
      }

      const id = `${prefix}-${counters[prefix]++}`;
      el.setAttribute("data-efekta-id", id);
      elementRegistry.set(id, el);
      if (finalText) idToTextMap.set(id, finalText);
      registeredNodes.add(el);

      const selected =
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-checked") === "true" ||
        el.checked === true ||
        cls.includes("selected") ||
        cls.includes("active") ||
        cls.includes("checked");

      let disabled =
        el.disabled === true ||
        el.getAttribute("aria-disabled") === "true" ||
        cls.includes("disabled");
      if (type !== "mic_btn") {
        disabled = disabled || cls.includes("no-pointer");
      }

      elements.push({
        id,
        type,
        text: finalText.slice(0, 140),
        tag,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        selected,
        disabled,
        className: cls.slice(0, 80)
      });
    }

    // Extract clean task prompt / instructions
    const promptCandidates = [];
    for (const doc of docs) {
      promptCandidates.push(
        ...Array.from(
          doc.querySelectorAll(
            "h1, h2, h3, ef-instructions, [class*='prompt'], [class*='instruction'], [class*='question-title'], [class*='rubric'], [class*='header-title']"
          )
        )
          .filter(isVisible)
          .map((e) => cleanText(e))
          .filter((t) => t.length > 2 && t.length < 300)
      );
    }
    const prompt = Array.from(new Set(promptCandidates)).slice(0, 3).join(" | ");

    // Extract speaking practice phrase if present
    const speakingInfo = extractSpeakingInfo(docs);

    // Extract context sentences (with inline [input-N] / [slot-N] placeholders, without hidden sizing text!)
    const contextNodes = [];
    for (const doc of docs) {
      contextNodes.push(
        ...Array.from(
          doc.querySelectorAll(
            "p, [class*='sentence'], [class*='passage'], [class*='dialogue'], [class*='transcript'], [class*='phrase'], [class*='statement'], [class*='question-text'], .gap-sentence"
          )
        ).filter(isVisible)
      );
    }

    const contextLines = [];
    const seenContext = new Set();

    if (speakingInfo.targetPhrase) {
      seenContext.add(speakingInfo.targetPhrase);
      contextLines.push(speakingInfo.targetPhrase);
      if (speakingInfo.progressText) {
        contextLines.push(`Progress: ${speakingInfo.progressText}`);
      }
    }

    for (const node of contextNodes) {
      let textWithBlanks = "";
      const walker = document.createTreeWalker(
        node,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(n) {
            const p = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
            if (!p) return NodeFilter.FILTER_ACCEPT;
            if (
              p.closest &&
              p.closest(
                ".cdk-visually-hidden, .sr-only, .screen-reader-overview, [hidden], .longest-option, ef-icon, svg"
              )
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            // Skip any hidden width-sizing spans inside selection-gap wrappers
            if (n.nodeType === Node.TEXT_NODE && n.parentElement) {
              const pe = n.parentElement;
              if (
                pe.closest &&
                pe.closest("ef-selection-gap, .selection-gap-wrapper, .selection-gap") &&
                !pe.closest("[data-efekta-id^='slot-']")
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              try {
                const w = (doc.defaultView) || window;
                const st = w.getComputedStyle(pe);
                if (
                  st.display === "none" ||
                  st.visibility === "hidden" ||
                  parseFloat(st.opacity) === 0
                ) {
                  return NodeFilter.FILTER_REJECT;
                }
              } catch (_) {}
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let cur = walker.nextNode();
      while (cur) {
        if (cur.nodeType === Node.TEXT_NODE) {
          const parentGap =
            cur.parentElement &&
            cur.parentElement.closest &&
            cur.parentElement.closest("[data-efekta-id^='slot-'], [data-efekta-id^='input-']");
          if (!parentGap) {
            textWithBlanks += cur.nodeValue;
          }
        } else if (cur.nodeType === Node.ELEMENT_NODE) {
          const eid = cur.getAttribute("data-efekta-id");
          if (eid && (eid.startsWith("input-") || eid.startsWith("slot-"))) {
            const val = cleanText(cur);
            textWithBlanks += ` [${eid}${val ? "=" + val : ""}] `;
          }
        }
        cur = walker.nextNode();
      }
      const cleaned = (textWithBlanks || cleanText(node)).trim().replace(/\s+/g, " ");
      if (cleaned.length > 2 && cleaned.length < 500 && !seenContext.has(cleaned)) {
        seenContext.add(cleaned);
        contextLines.push(cleaned);
      }
    }

    // Detect feedback
    let feedback = "";
    const feedbackEls = [];
    for (const doc of docs) {
      feedbackEls.push(
        ...Array.from(
          doc.querySelectorAll(
            "[class*='feedback'], [class*=' result'], [role='alert'], .step-passed"
          )
        ).filter(isVisible)
      );
    }
    for (const f of feedbackEls) {
      const fText = cleanText(f);
      const fCls = (typeof f.className === "string" ? f.className : "").toLowerCase();
      if (fCls.includes("incorrect") || fCls.includes("wrong") || fCls.includes("error")) {
        feedback = "incorrect: " + fText.slice(0, 100);
        break;
      } else if (fCls.includes("correct") || fCls.includes("success")) {
        feedback = "correct: " + fText.slice(0, 100);
        break;
      } else if (fText.length > 0 && fText.length < 120) {
        feedback = fText;
      }
    }

    const videoStatus = getMediaStatus();

    const choiceEls = elements.filter((e) => e.type === "choice" && !e.disabled);
    const dragEls = elements.filter((e) => e.type === "draggable" && !e.disabled);
    const slotEls = elements.filter((e) => e.type === "drop_target");
    const inputEls = elements.filter((e) => e.type === "input");
    const stageEls = elements.filter((e) => e.type === "stage_nav");
    const skipBtn = elements.find((e) => e.type === "skip_btn" && !e.disabled);
    const nextBtn = elements.find((e) => e.type === "next_btn" && !e.disabled);
    const hasMic = elements.some((e) => e.type === "mic_btn");

    const hasMatchingCards = elements.some((e) =>
      (e.className || "").includes("matching-option-wp")
    );
    const hasSelectionGaps = elements.some((e) =>
      (e.className || "").includes("selection-gap-button")
    );

    // Also inspect hidden drawer options if selection_gaps drawer hasn't been opened yet
    let drawerChoiceStrings = choiceEls.map((o) => `${o.id}: ${o.text}`);
    if (hasSelectionGaps && drawerChoiceStrings.length === 0) {
      const hiddenDrawerOpts = [];
      for (const doc of docs) {
        doc.querySelectorAll("div.drawer-option, .drawer-option").forEach((el) => {
          const t = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (t && !hiddenDrawerOpts.includes(t)) hiddenDrawerOpts.push(t);
        });
      }
      if (hiddenDrawerOpts.length > 0) {
        drawerChoiceStrings = hiddenDrawerOpts.map((t, idx) => `opt-${idx + 1}: ${t}`);
      }
    }

    // Precise Exercise Type & Instant Agent Hint
    let exerciseType = "unknown";
    let actionTemplate = "";
    let summary = "";

    const isActivitySummary = docs.some((doc) => {
      const summaryEl = doc.querySelector(
        "ef-end-of-activity-summary, .tasks-wp.summary-shown, .summary-wp, .summary-shown"
      );
      return summaryEl && isVisible(summaryEl);
    });

    if (isActivitySummary) {
      exerciseType = "passive_screen";
      actionTemplate = `efekta next --json -c`;
      summary = `End of activity summary screen (${nextBtn ? nextBtn.id : "unlocked"}). Run 'efekta next --json -c' to continue.`;
    } else if (hasMic) {
      const speechChoices = choiceEls.filter(
        (e) =>
          e.tag === "ef-multiple-choice-speech-task-response-option" ||
          (e.className || "").includes("response-option") ||
          (e.text && /^[A-Z]\s*:/i.test(e.text))
      );

      if (speechChoices.length > 0) {
        exerciseType = "speaking_avatar";
        actionTemplate = `efekta batch "speak opt-1; next" --json -c`;
        summary = `Avatar dialogue with ${speechChoices.length} options (${speechChoices.map((c) => c.text.slice(0, 2)).join(", ")}). Run 'efekta batch "speak opt-X; next" --json -c' or 'speak B; next' to select and speak your chosen option.`;
      } else if (speakingInfo.isSpeakingPractice || speakingInfo.targetPhrase || speakingInfo.playAudioBtn) {
        exerciseType = "speaking_practice";
        actionTemplate = `efekta batch "speak all; next" --json -c`;
        summary = speakingInfo.targetPhrase
          ? `Pronunciation speaking drill ("${speakingInfo.targetPhrase}"). Run 'efekta batch "speak all; next" --json -c' to speak with real English audio${skipBtn ? ` (or 'click ${skipBtn.id}; next' to skip)` : ""}.`
          : `Speaking drill. Run 'efekta batch "speak all; next" --json -c' to speak with real English audio.`;
      } else {
        exerciseType = "speaking_avatar";
        if (skipBtn) {
          actionTemplate = `efekta batch "click ${skipBtn.id}; next" --json -c`;
          summary = `Speaking task (skip: ${skipBtn.id}). Run 'efekta batch "speak; next" --json -c' or 'click ${skipBtn.id}; next' to skip.`;
        } else if (videoStatus.isPlaying || (videoStatus.hasVideo && !videoStatus.ended)) {
          actionTemplate = `efekta batch "wait video-end; next" --json -c`;
          summary = "Avatar video is playing. Run 'efekta batch \"wait video-end; next\" --json -c' to wait for dialogue options.";
        } else {
          actionTemplate = `efekta batch "speak; next" --json -c`;
          summary = "Speaking task. Run 'efekta batch \"speak; next\" --json -c' to speak English.";
        }
      }
    } else if (hasMatchingCards && slotEls.length > 0 && dragEls.length > 0) {
      exerciseType = "matching_pairs";
      actionTemplate = `efekta batch "pair slot-1:item-X, slot-2:item-Y; next" --json -c`;
      summary = `Match ${slotEls.length} left slots with ${dragEls.length} right items in one batch, ending with '; next'.`;
    } else if (hasSelectionGaps && slotEls.length > 0) {
      exerciseType = "selection_gaps";
      actionTemplate = `efekta batch "gaps word1, word2, word3; next" --json -c`;
      summary = `Fill ${slotEls.length} gap buttons in order using 'gaps word1, word2...; next'.`;
    } else if (inputEls.length > 0) {
      exerciseType = "fill_in_the_blanks";
      actionTemplate = `efekta batch "gaps word1, word2; next" --json -c`;
      summary = `Type ${inputEls.length} blanks in order using 'gaps word1, word2; next'.`;
    } else if (dragEls.length > 0 && slotEls.length > 1) {
      exerciseType = "categorize_columns";
      actionTemplate = `efekta batch "sort slot-1:item-1,item-2; sort slot-2:item-3,item-4; next" --json -c`;
      summary = `Sort ${dragEls.length} items into ${slotEls.length} categories in one batch, ending with '; next'.`;
    } else if (dragEls.length > 0) {
      exerciseType = "order_sentence";
      actionTemplate = `efekta batch "pick item-1,item-2,item-3; next" --json -c`;
      summary = `Click/order ${dragEls.length} tokens in sentence order using 'pick item-X,item-Y; next'.`;
    } else if (choiceEls.length >= 2) {
      exerciseType = "multiple_choice";
      actionTemplate = `efekta batch "pick opt-1; next" --json -c`;
      summary = `Pick the right option(s) from ${choiceEls.length} choices and auto-advance with '; next'.`;
    } else if (stageEls.length >= 2 && !nextBtn) {
      exerciseType = "lesson_overview";
      actionTemplate = `efekta next --json -c`;
      summary = `Lesson overview screen (${stageEls.length} steps). Run 'efekta next --json -c' to enter the next incomplete step.`;
    } else if (nextBtn) {
      exerciseType = "passive_screen";
      actionTemplate = `efekta next --json -c`;
      summary = `Passive/reading/summary screen (${nextBtn.id} unlocked). Run 'efekta next --json -c' to fast-forward to the next interactive exercise.`;
    } else if (videoStatus.hasVideo) {
      exerciseType = "video_stage";
      actionTemplate = `efekta next --json -c`;
      summary = `Video stage. Run 'efekta next --json -c' or 'efekta wait video-end'.`;
    }

    const agentHint = {
      exerciseType,
      actionTemplate,
      summary,
      slots: slotEls.map((s) => `${s.id}: ${s.text || "___"}`),
      items: dragEls.map((i) => `${i.id}: ${i.text}`),
      options: drawerChoiceStrings,
      inputs: inputEls.map((inp) => `${inp.id}: ${inp.text || "___"}`)
    };

    let canProceed = !!nextBtn;
    if (exerciseType === "speaking_practice") {
      let isBusy = false;
      let isCorrect = false;
      let isIncorrect = false;
      for (const doc of docs) {
        if (
          doc.querySelector(
            ".speech-action-control.recording, .speech-action-control.waiting_for_assessment"
          )
        ) {
          isBusy = true;
        }
        if (
          doc.querySelector(
            ".speech-action-control.correct, .speech-action-control.playbackEnabled.correct"
          )
        ) {
          isCorrect = true;
        }
        if (doc.querySelector(".speech-action-control.incorrect")) {
          isIncorrect = true;
        }
      }
      if (isBusy || isIncorrect) {
        canProceed = false;
      } else if (isCorrect) {
        canProceed = !!nextBtn;
      } else if (hasMic) {
        canProceed = false;
      }
    }

    return {
      url: window.location.href,
      title: document.title,
      exerciseType,
      prompt,
      contextText: contextLines.slice(0, 12),
      feedback,
      agentHint,
      video: videoStatus,
      canProceed,
      nextButtonId: nextBtn ? nextBtn.id : "",
      elementsCount: elements.length,
      elements
    };
  }

  // If on selection_gaps and options list is still empty, auto-peek slot-1 so the word bank is visible immediately!
  async function autoPeekSelectionGapOptions(st) {
    if (!st || st.exerciseType !== "selection_gaps") return st;
    if (st.agentHint && st.agentHint.options && st.agentHint.options.length > 0) return st;

    const docs = getAllDocs();
    for (const doc of docs) {
      const firstGap = doc.querySelector("button.selection-gap-button");
      if (firstGap && isVisible(firstGap)) {
        await simulateClick(firstGap);
        const start = Date.now();
        while (Date.now() - start < 450) {
          await sleep(35);
          const opts = Array.from(
            doc.querySelectorAll("div.drawer-option, .drawer-option")
          ).filter(isVisible);
          if (opts.length > 0) break;
        }
        return inspectState();
      }
    }
    return st;
  }

  // Wait for a condition ("video-end", "next", "unlocked", or duration in ms)
  async function waitForCondition(condition, timeoutMs = 15000) {
    const start = Date.now();
    if (!condition || /^\d+$/.test(String(condition))) {
      const ms = parseInt(condition, 10) || 200;
      await sleep(ms);
      return { success: true, message: `Waited ${ms}ms` };
    }

    const cond = String(condition).toLowerCase();
    if (cond === "unlocked") {
      await waitUntilUnlocked(timeoutMs);
      return { success: true, message: "UI unlocked" };
    }

    while (Date.now() - start < timeoutMs) {
      if (cond === "video-end" || cond === "video" || cond === "audio-end") {
        const media = getMediaStatus();
        if (!media.isPlaying || media.ended) {
          return { success: true, message: "Media playback finished", media };
        }
      } else if (cond === "next" || cond === "proceed") {
        const st = inspectState();
        if (st.canProceed) {
          return { success: true, message: `Next button unlocked (${st.nextButtonId})` };
        }
      }
      await sleep(100);
    }
    return {
      success: false,
      error: `Timeout (${timeoutMs}ms) waiting for condition: ${condition}`
    };
  }

  // Turbo Action 1: Multi-target click / pick ("opt-1,opt-3,opt-5") with automatic lock synchronization
  async function executePick(targetSpec) {
    if (!targetSpec) {
      return { success: false, error: "No target specified for pick/click" };
    }
    await dismissOverlaysIfPresent();
    const rawStr = String(targetSpec).trim();
    const isCoord = /^\d+\s*,\s*\d+$/.test(rawStr);
    const targets = isCoord
      ? [rawStr]
      : rawStr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    // Snapshot DOM nodes & texts BEFORE clicking so DOM re-indexing never shifts IDs
    if (!inBatchExecution) inspectState();
    const snapshots = targets.map((t) => ({
      target: t,
      el: resolveElement(t),
      text: (inBatchExecution && batchTextSnapshot.get(t)) || idToTextMap.get(t) || t
    }));

    const clicked = [];
    for (let i = 0; i < snapshots.length; i++) {
      await waitUntilUnlocked(1600);
      const snap = snapshots[i];
      let el = snap.el;
      if (!el || !el.isConnected) {
        el = findInteractiveByText(snap.text) || resolveElement(snap.target);
      }
      if (!el) {
        return {
          success: false,
          error: `Element not found: ${snap.target} (${snap.text})`,
          clicked
        };
      }
      await simulateClick(el);
      clicked.push(`${snap.target} ("${cleanText(el)}")`);
      if (i + 1 < snapshots.length) {
        await sleep(190);
      } else {
        await sleep(140);
      }
    }
    await waitUntilUnlocked(1600);
    return {
      success: true,
      message: `Clicked ${clicked.join(", ")}`,
      clicked
    };
  }

  // Turbo Action 2: Pair matching ("slot-1:item-3, slot-2:item-1") with upfront text snapshot
  async function executePair(specStr) {
    if (!specStr) {
      return { success: false, error: "Usage: pair slot-1:item-3, slot-2:item-1" };
    }
    await dismissOverlaysIfPresent();
    if (!inBatchExecution) inspectState();
    const rawPairs = String(specStr)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const planned = [];
    for (const pairToken of rawPairs) {
      const sepIdx = pairToken.indexOf(":");
      const eqIdx = pairToken.indexOf("=");
      const idx = sepIdx !== -1 ? sepIdx : eqIdx;
      if (idx === -1) continue;
      const leftKey = pairToken.slice(0, idx).trim();
      const rightKey = pairToken.slice(idx + 1).trim();
      const leftEl = resolveElement(leftKey);
      const rightEl = resolveElement(rightKey);
      planned.push({
        leftKey,
        rightKey,
        leftEl,
        rightEl,
        leftText:
          (inBatchExecution && batchTextSnapshot.get(leftKey)) ||
          idToTextMap.get(leftKey) ||
          (leftEl ? cleanText(leftEl) : leftKey),
        rightText:
          (inBatchExecution && batchTextSnapshot.get(rightKey)) ||
          idToTextMap.get(rightKey) ||
          (rightEl ? cleanText(rightEl) : rightKey)
      });
    }

    if (planned.length === 0) {
      return { success: false, error: `No valid left:right pairs in "${specStr}"` };
    }

    const matched = [];
    for (const p of planned) {
      await waitUntilUnlocked(1800);
      const lEl =
        p.leftEl && p.leftEl.isConnected
          ? p.leftEl
          : findInteractiveByText(p.leftText) || resolveElement(p.leftKey);
      const rEl =
        p.rightEl && p.rightEl.isConnected
          ? p.rightEl
          : findInteractiveByText(p.rightText) || resolveElement(p.rightKey);
      if (!lEl || !rEl) {
        return {
          success: false,
          error: `Pair element not found: ${p.leftKey} ("${p.leftText}") -> ${p.rightKey} ("${p.rightText}")`,
          matched
        };
      }
      await simulateClick(lEl);
      await sleep(85);
      await simulateClick(rEl);
      matched.push(`${p.leftText} -> ${p.rightText}`);

      // Wait up to 600ms for pair animation (.correct) to finish
      const start = Date.now();
      while (Date.now() - start < 600) {
        await sleep(40);
        const lCls = (lEl.className || "").toLowerCase();
        const rCls = (rEl.className || "").toLowerCase();
        if (lCls.includes("correct") || rCls.includes("correct") || !lEl.isConnected) {
          break;
        }
      }
    }
    await sleep(100);
    return {
      success: true,
      message: `Matched ${matched.length} pairs: ${matched.join(" | ")}`,
      matched
    };
  }

  // Turbo Action 3: Category sorting ("slot-1:item-1,item-3" or multiple groups) immune to DOM removal
  async function executeSort(specStr) {
    if (!specStr) {
      return { success: false, error: "Usage: sort slot-1:item-1,item-2" };
    }
    await dismissOverlaysIfPresent();
    if (!inBatchExecution) inspectState();

    // Support multiple groups separated by "|" OR space-separated "slot-1:item-1,item-2 slot-2:item-3,item-4"
    const normalized = String(specStr).replace(/\s+(?=(?:slot|col|cat)-\d+\s*:)/gi, " | ");
    const groupsRaw = normalized
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);

    const groups = [];
    for (const g of groupsRaw) {
      const colonIdx = g.indexOf(":");
      if (colonIdx === -1) continue;
      const slotKey = g.slice(0, colonIdx).trim();
      const itemKeys = g
        .slice(colonIdx + 1)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const slotEl = resolveElement(slotKey);
      const slotText =
        (inBatchExecution && batchTextSnapshot.get(slotKey)) ||
        idToTextMap.get(slotKey) ||
        (slotEl ? cleanText(slotEl) : slotKey);
      const items = itemKeys.map((k) => {
        const el = resolveElement(k);
        return {
          key: k,
          el,
          text:
            (inBatchExecution && batchTextSnapshot.get(k)) ||
            idToTextMap.get(k) ||
            (el ? cleanText(el) : k)
        };
      });
      groups.push({ slotKey, slotEl, slotText, items });
    }

    if (groups.length === 0) {
      return { success: false, error: `Invalid sort specification: "${specStr}"` };
    }

    const sorted = [];
    for (const grp of groups) {
      for (const it of grp.items) {
        await waitUntilUnlocked(1800);
        let itemEl = it.el && it.el.isConnected && isVisible(it.el) ? it.el : null;
        if (!itemEl) {
          itemEl = findInteractiveByText(it.text) || resolveElement(it.key);
        }
        let slotEl = grp.slotEl && grp.slotEl.isConnected ? grp.slotEl : null;
        if (!slotEl) {
          slotEl = findInteractiveByText(grp.slotText) || resolveElement(grp.slotKey);
        }
        if (!itemEl || !slotEl) {
          return {
            success: false,
            error: `Sort element not found: ${it.key} ("${it.text}") -> ${grp.slotKey} ("${grp.slotText}")`,
            sorted
          };
        }

        await simulateClick(itemEl);
        await sleep(95);
        await simulateClick(slotEl);
        sorted.push(`${it.text} -> ${grp.slotText}`);

        // Wait up to 700ms until item is removed from DOM or animation finishes
        const start = Date.now();
        while (Date.now() - start < 700) {
          await sleep(40);
          if (!itemEl.isConnected || !isVisible(itemEl)) break;
        }
        await waitUntilUnlocked(1500);
      }
    }
    await sleep(80);
    return {
      success: true,
      message: `Sorted ${sorted.length} items: ${sorted.join(" | ")}`,
      sorted
    };
  }

  // Turbo Action 4: Fill selection-gap drawers or text blanks in order ("word1, word2, word3")
  // Immune to DOM replacement when filled gaps turn into spans, and never double-clicks an already-open gap!
  async function executeGaps(specStr) {
    if (!specStr) {
      return { success: false, error: "Usage: gaps word1, word2, word3" };
    }
    await dismissOverlaysIfPresent();

    const entries = String(specStr)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const filled = [];
    const docs = getAllDocs();

    // Snapshot all selection-gap buttons and inputs upfront before filling any gap!
    const initialGapButtons = [];
    for (const doc of docs) {
      initialGapButtons.push(
        ...Array.from(doc.querySelectorAll("button.selection-gap-button")).filter(isVisible)
      );
    }
    const slotDomMap = new Map();
    initialGapButtons.forEach((btn, idx) => {
      slotDomMap.set(`slot-${idx + 1}`, btn);
      const attrId = btn.getAttribute("data-efekta-id");
      if (attrId) slotDomMap.set(attrId, btn);
    });

    const getVisibleDrawerOptions = () => {
      const list = [];
      for (const doc of docs) {
        list.push(
          ...Array.from(doc.querySelectorAll("div.drawer-option, .drawer-option")).filter(
            isVisible
          )
        );
      }
      return list;
    };

    for (let i = 0; i < entries.length; i++) {
      await waitUntilUnlocked(1500);
      let targetKey = "";
      let word = entries[i];
      const eqIdx = word.indexOf("=");
      if (eqIdx !== -1 && /^(slot|input)-\d+$/i.test(word.slice(0, eqIdx).trim())) {
        targetKey = word.slice(0, eqIdx).trim().toLowerCase();
        word = word.slice(eqIdx + 1).trim();
      }
      word = word.replace(/^["']|["']$/g, "").trim();

      if (initialGapButtons.length > 0) {
        // Resolve the exact gap button for this iteration from our upfront snapshot
        let gapBtn =
          (targetKey && slotDomMap.get(targetKey)) ||
          initialGapButtons[i] ||
          null;

        if (!gapBtn || !gapBtn.isConnected || !isVisible(gapBtn)) {
          // Fallback: find the first currently visible unfilled gap button
          const currentButtons = [];
          for (const doc of docs) {
            currentButtons.push(
              ...Array.from(doc.querySelectorAll("button.selection-gap-button")).filter(
                isVisible
              )
            );
          }
          gapBtn =
            currentButtons.find((b) => {
              const t = cleanText(b).toLowerCase();
              const cls = (b.className || "").toLowerCase();
              return (
                !t ||
                t.includes("blank") ||
                /^[_.\s-]+$/.test(t) ||
                cls.includes("empty") ||
                !cls.includes("filled")
              );
            }) || currentButtons[0];
        }

        let drawerOpts = getVisibleDrawerOptions();
        const isGapAlreadySelected =
          gapBtn &&
          drawerOpts.length > 0 &&
          ((gapBtn.className || "").toLowerCase().includes("selected") ||
            (gapBtn.className || "").toLowerCase().includes("active") ||
            gapBtn.getAttribute("aria-expanded") === "true" ||
            (i === 0 && !targetKey) ||
            (i === 0 && targetKey === "slot-1"));

        if (!isGapAlreadySelected && gapBtn) {
          await simulateClick(gapBtn);
          const waitStart = Date.now();
          while (Date.now() - waitStart < 650) {
            await sleep(35);
            drawerOpts = getVisibleDrawerOptions();
            if (drawerOpts.length > 0) break;
          }
        }

        // If drawer still didn't open (e.g. first click closed a different drawer), click gapBtn once more
        if (drawerOpts.length === 0 && gapBtn) {
          await simulateClick(gapBtn);
          const waitStart = Date.now();
          while (Date.now() - waitStart < 650) {
            await sleep(35);
            drawerOpts = getVisibleDrawerOptions();
            if (drawerOpts.length > 0) break;
          }
        }

        const needle = word.toLowerCase();
        const matchOpt =
          drawerOpts.find((o) => cleanText(o).toLowerCase() === needle) ||
          drawerOpts.find((o) => cleanText(o).toLowerCase().includes(needle));

        if (!matchOpt) {
          return {
            success: false,
            error: `Drawer option "${word}" not found (available: ${drawerOpts
              .map((o) => cleanText(o))
              .join(", ")})`,
            filled
          };
        }

        await simulateClick(matchOpt);
        filled.push(word);

        // Wait up to 400ms for drawer selection to commit before moving to next gap
        const commitStart = Date.now();
        while (Date.now() - commitStart < 400) {
          await sleep(40);
          if (!matchOpt.isConnected || !isVisible(matchOpt)) break;
        }
        await sleep(120);
        continue;
      }

      // Case B: Standard <input> / <textarea> / [contenteditable] blanks
      const st = inspectState();
      const inputEls = st.elements.filter((e) => e.type === "input");
      const targetId =
        targetKey || (inputEls[i] ? inputEls[i].id : inputEls[0] ? inputEls[0].id : "");
      const inputDom = resolveElement(targetId);
      if (!inputDom) {
        return {
          success: false,
          error: `No gap button or input element found for "${word}"`,
          filled
        };
      }
      await simulateType(inputDom, word, 6);
      filled.push(`${targetId}=${word}`);
      await sleep(180);
    }

    return {
      success: true,
      message: `Filled ${filled.length} gaps: ${filled.join(", ")}`,
      filled
    };
  }

  // Check if a state represents an active exercise requiring agent decision
  function isInteractiveExercise(st) {
    if (!st) return false;
    const t = st.exerciseType;
    if (
      t === "matching_pairs" ||
      t === "categorize_columns" ||
      t === "selection_gaps" ||
      t === "fill_in_the_blanks" ||
      t === "order_sentence" ||
      t === "multiple_choice" ||
      t === "speaking_practice" ||
      t === "speaking_avatar"
    ) {
      // Self-evaluation screen ("How did you find the task?") is handled automatically by executeAutoNext!
      if (
        t === "multiple_choice" &&
        /how did you find the task/i.test(st.prompt || "")
      ) {
        return false;
      }
      // If end-of-activity summary is shown, it's a passive screen!
      const docs = getAllDocs();
      if (
        docs.some((d) =>
          d.querySelector(
            "ef-end-of-activity-summary, .tasks-wp.summary-shown, .summary-wp, .summary-shown"
          )
        )
      ) {
        return false;
      }
      // If canProceed is ALREADY true (e.g. "Correct answers" review screen where old options are disabled), it's passive!
      if (st.canProceed && t !== "speaking_avatar" && t !== "speaking_practice") {
        return false;
      }
      return true;
    }
    return false;
  }

  // Turbo Action 5: Auto-Fast-Forward ("next" / "ff")
  // Advances from current screen and automatically glides through consecutive passive screens
  // (reading cards, "Correct answers" review, self-evaluation, AI feedback, "Step passed!" summary, Lesson Overview)
  async function executeAutoNext(maxHops = 9) {
    const autoReadNotes = [];
    let hops = 0;

    for (let step = 0; step < maxHops; step++) {
      await dismissOverlaysIfPresent();
      await waitUntilUnlocked(1500);
      const st = inspectState();

      // On step > 0, stop immediately as soon as we land on an interactive exercise!
      if (step > 0 && isInteractiveExercise(st)) {
        await autoPeekSelectionGapOptions(st);
        return {
          success: true,
          message: `Advanced ${hops} screen(s) to ${st.exerciseType}`,
          hops,
          autoReadNotes
        };
      }

      // Record note from passive screen before advancing
      const noteParts = [];
      if (st.prompt) noteParts.push(st.prompt);
      if (st.contextText && st.contextText.length > 0) {
        noteParts.push(st.contextText.slice(0, 4).join(" | "));
      }
      if (noteParts.length > 0) {
        const note = noteParts.join(" — ").slice(0, 260);
        if (!autoReadNotes.includes(note)) autoReadNotes.push(note);
      }

      let clickedTarget = "";

      // Priority 0.5: Fast-forward passive video stage if video is blocking Next button
      if (!st.canProceed && (st.exerciseType === "video_stage" || (st.video && st.video.hasVideo && !st.video.ended))) {
        const docs = getAllDocs();
        let seeked = false;
        for (const doc of docs) {
          doc.querySelectorAll("video").forEach((v) => {
            try {
              if (isFinite(v.duration) && v.duration > 0 && !v.ended) {
                v.currentTime = Math.max(0, v.duration - 0.25);
                v.play().catch(() => {});
                seeked = true;
              }
            } catch (_) {}
          });
        }
        if (seeked) {
          await sleep(600);
          const afterSeekSt = inspectState();
          if (afterSeekSt.nextButtonId) {
            const btn = resolveElement(afterSeekSt.nextButtonId);
            if (btn) {
              await simulateClick(btn);
              clickedTarget = afterSeekSt.nextButtonId;
            }
          }
        }
      }

      // Priority 0: Self-evaluation screen ("How did you find the task?") -> auto-pick option & click "Generate feedback"
      if (/how did you find the task/i.test(st.prompt || "")) {
        const docs = getAllDocs();
        for (const doc of docs) {
          const evalOpts = Array.from(
            doc.querySelectorAll("button.self-evaluation-option, .self-evaluation-option")
          ).filter(isVisible);
          if (evalOpts.length > 0) {
            const pickEl = evalOpts[1] || evalOpts[0];
            await simulateClick(pickEl);
            await sleep(160);
          }
          const genBtn = doc.querySelector("button.self-evaluation-submit, .self-evaluation-submit");
          if (genBtn && isVisible(genBtn)) {
            await simulateClick(genBtn);
            clickedTarget = "self-evaluation-submit";
            // Wait up to 4.5s for Efekta's AI feedback screen (next-1) to appear
            const waitStart = Date.now();
            while (Date.now() - waitStart < 4500) {
              await sleep(200);
              const checkSt = inspectState();
              if (checkSt.canProceed) break;
            }
            break;
          }
        }
      }

      // Priority 1: Active Next / Start next step / Continue / Back to lesson overview button
      if (!clickedTarget && st.canProceed && st.nextButtonId) {
        const btn = resolveElement(st.nextButtonId);
        if (btn) {
          await simulateClick(btn);
          clickedTarget = st.nextButtonId;
        }
      }

      // Priority 2: Lesson Overview screen -> click first incomplete ef-lesson-overview-step (or Return to unit overview if all done)
      if (!clickedTarget) {
        const docs = getAllDocs();
        for (const doc of docs) {
          const returnBtn = Array.from(doc.querySelectorAll("button.primary, button")).find(
            (b) => isVisible(b) && /^return to unit overview$/i.test(cleanText(b))
          );
          if (returnBtn) {
            await simulateClick(returnBtn);
            clickedTarget = "return-to-unit-overview";
            break;
          }

          const steps = Array.from(
            doc.querySelectorAll("ef-lesson-overview-step")
          ).filter(isVisible);
          if (steps.length > 0) {
            const incomplete =
              steps.find((s) => {
                const txt = (s.innerText || s.textContent || "").toLowerCase();
                const cls = (s.className || "").toLowerCase();
                return (
                  !cls.includes("completed") &&
                  !cls.includes("passed") &&
                  !txt.includes("completed") &&
                  !s.querySelector(".completed, .passed, [class*='check'], [class*='is-passed']")
                );
              }) || null;
            if (incomplete) {
              const target = incomplete.querySelector(".content, .step, div") || incomplete;
              await simulateClick(target);
              await simulateClick(incomplete);
              clickedTarget = "lesson-overview-step";
              break;
            }
          }
        }
      }

      // Priority 3: Optional speaking task with SKIP button on step 0 when 'next' is explicitly invoked
      if (!clickedTarget && step === 0) {
        const skipEl = st.elements.find((e) => e.type === "skip_btn" && !e.disabled);
        if (skipEl) {
          const domSkip = resolveElement(skipEl.id);
          if (domSkip) {
            await simulateClick(domSkip);
            clickedTarget = skipEl.id;
          }
        }
      }

      if (!clickedTarget) {
        if (step === 0) {
          return {
            success: false,
            error: "No active Next, Skip, or Lesson Overview step button available to advance",
            autoReadNotes
          };
        }
        break;
      }

      hops++;

      // Wait for screen transition (poll until DOM changes and settles)
      await sleep(340);
      await waitUntilUnlocked(1500);
      await dismissOverlaysIfPresent();
      const afterSt = inspectState();
      if (isInteractiveExercise(afterSt)) {
        await autoPeekSelectionGapOptions(afterSt);
        return {
          success: true,
          message: `Advanced ${hops} screen(s) to ${afterSt.exerciseType}`,
          hops,
          autoReadNotes
        };
      }
      await sleep(200);
    }

    const finalSt = inspectState();
    await autoPeekSelectionGapOptions(finalSt);
    return {
      success: true,
      message: `Fast-forwarded ${hops} screen(s) (current: ${finalSt.exerciseType})`,
      hops,
      autoReadNotes
    };
  }

  // Turbo Action 6: Real-Speech Voice Engine ("speak [text|all|ref]")
  // Speaks a single phrase using either the page's own native reference audio ("Play audio")
  // or synthesized English TTS via the Go daemon (/api/tts), streaming into the one-shot armed microphone!
  async function speakSinglePhrase(customSpec = "") {
    await dismissOverlaysIfPresent();
    const log = [];

    const media = getMediaStatus();
    if (media.isPlaying && media.hasVideo) {
      log.push("Waiting for avatar video to finish speaking...");
      await waitForCondition("video-end", 20000);
    }

    const docs = getAllDocs();
    const speakingInfo = extractSpeakingInfo(docs);
    const st = inspectState();

    const rawSpec = String(customSpec || "").trim();
    const isAutoOrRef =
      !rawSpec ||
      rawSpec.toLowerCase() === "auto" ||
      rawSpec.toLowerCase() === "all" ||
      rawSpec.toLowerCase() === "ref" ||
      rawSpec.toLowerCase() === "reference";

    // 1. Resolve avatar multiple-choice response option (opt-X, A/B/C, 1/2/3, text match)
    let chosenOptionEl = null;
    let chosenOptionText = "";

    const choiceEntries = Array.from(elementRegistry.entries()).filter(([id, el]) => {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      return (
        tag === "ef-multiple-choice-speech-task-response-option" ||
        cls.includes("response-option") ||
        id.startsWith("opt-")
      );
    });

    if (rawSpec && !isAutoOrRef) {
      const s = rawSpec.toLowerCase().replace(/^["']|["']$/g, "").trim();
      // Match by exact ID ("opt-2")
      for (const [id, el] of choiceEntries) {
        if (id.toLowerCase() === s) {
          chosenOptionEl = el;
          chosenOptionText = idToTextMap.get(id) || cleanText(el);
          break;
        }
      }
      // Match by single letter ("a", "b", "c")
      if (!chosenOptionEl && /^[a-z]$/i.test(s)) {
        for (const [id, el] of choiceEntries) {
          const t = idToTextMap.get(id) || cleanText(el);
          if (new RegExp(`^${s}\\s*[:.)-]`, "i").test(t)) {
            chosenOptionEl = el;
            chosenOptionText = t;
            break;
          }
        }
      }
      // Match by single digit ("1", "2", "3") -> maps to opt-1, opt-2...
      if (!chosenOptionEl && /^[1-9]$/.test(s)) {
        const targetId = `opt-${s}`;
        for (const [id, el] of choiceEntries) {
          if (id.toLowerCase() === targetId) {
            chosenOptionEl = el;
            chosenOptionText = idToTextMap.get(id) || cleanText(el);
            break;
          }
        }
      }
      // Match by substring in option text
      if (!chosenOptionEl && choiceEntries.length > 0) {
        for (const [id, el] of choiceEntries) {
          const t = idToTextMap.get(id) || cleanText(el);
          if (t.toLowerCase().includes(s)) {
            chosenOptionEl = el;
            chosenOptionText = t;
            break;
          }
        }
      }
    } else if (choiceEntries.length > 0 && !speakingInfo.isSpeakingPractice) {
      // Default to first option if avatar dialogue options are on screen and no specific spec was provided
      chosenOptionEl = choiceEntries[0][1];
      chosenOptionText = idToTextMap.get(choiceEntries[0][0]) || cleanText(chosenOptionEl);
    }

    let targetPhrase = "";
    if (chosenOptionEl) {
      // Simulate click on the chosen option card so Angular registers the selection
      await simulateClick(chosenOptionEl);
      await sleep(120);
      // Strip any letter prefix ("A: ", "B: ", "C. ") so TTS speaks only the clean sentence
      targetPhrase = chosenOptionText.replace(/^[A-Z]\s*[:.)-]\s*/i, "").trim();
      log.push(`Selected dialogue option: "${chosenOptionText}" (speaking: "${targetPhrase}")`);
    } else if (!isAutoOrRef && rawSpec) {
      targetPhrase = rawSpec.replace(/^["']|["']$/g, "").trim();
    } else {
      targetPhrase =
        speakingInfo.targetPhrase ||
        (st.contextText && st.contextText[0]) ||
        st.prompt ||
        "I think that is a great point and I completely agree.";
    }

    const explicitText = isAutoOrRef ? "" : rawSpec.replace(/^["']|["']$/g, "").trim();
    let preparedClip = null;

    try {
      // Strategy 1: Native Reference Audio Loopback (if "Play audio" button exists and no custom option/text chosen)
      if (!chosenOptionEl && !explicitText && speakingInfo.playAudioBtn) {
        const sinceTs = Date.now() - 50;
        log.push("Clicking 'Play audio' to capture native reference audio...");
        await simulateClick(speakingInfo.playAudioBtn);

        const waitStart = Date.now();
        while (Date.now() - waitStart < 1500) {
          await sleep(90);
          const vStat = await callVoiceBridge({ type: "status" });
          if (
            vStat &&
            vStat.ok &&
            ((vStat.lastAudioPlayback && vStat.lastAudioPlayback.ts >= sinceTs) ||
              (vStat.lastVideoPlayback && vStat.lastVideoPlayback.ts >= sinceTs))
          ) {
            break;
          }
        }

        const prep = await callVoiceBridge({ type: "prepareRef", since: sinceTs }, 5000);
        if (prep && prep.ok) {
          preparedClip = prep;
          log.push(`Prepared native reference audio (${prep.durationMs}ms)`);
        } else if (prep && prep.needFetch) {
          log.push(`Fetching reference audio via extension background: ${prep.needFetch}`);
          const fetched = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: "FETCH_AUDIO_B64", url: prep.needFetch },
              (r) => resolve(r || { ok: false })
            );
          });
          if (fetched && fetched.ok && fetched.b64) {
            const dec = await callVoiceBridge(
              { type: "prepareAudio", b64: fetched.b64, source: "reference-url" },
              5000
            );
            if (dec && dec.ok) {
              preparedClip = dec;
              log.push(`Prepared fetched reference audio (${dec.durationMs}ms)`);
            }
          }
        }

        // Pause preview audio or wait until Play Audio finishes so mic-1 is unlocked
        for (const doc of docs) {
          doc.querySelectorAll("audio").forEach((a) => {
            try {
              a.pause();
            } catch (_) {}
          });
        }
        await sleep(220);
      }

      // Strategy 2: Synthesize clean English speech via Go Daemon (/api/tts)
      if (!preparedClip) {
        log.push(`Synthesizing English TTS for: "${targetPhrase}"`);
        const ttsResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "SYNTH_TTS_B64", text: targetPhrase, lang: "en" },
            (r) => resolve(r || { ok: false, error: "No response from background TTS" })
          );
        });
        if (!ttsResp || !ttsResp.ok || !ttsResp.b64) {
          return {
            success: false,
            error: `Failed to prepare speech audio: ${(ttsResp && ttsResp.error) || "TTS unavailable"}`,
            log
          };
        }
        const dec = await callVoiceBridge(
          { type: "prepareAudio", b64: ttsResp.b64, source: "tts" },
          5000
        );
        if (!dec || !dec.ok) {
          return {
            success: false,
            error: `Failed to decode TTS audio: ${(dec && dec.error) || "decode error"}`,
            log
          };
        }
        preparedClip = dec;
        log.push(`Prepared English TTS audio (${dec.durationMs}ms)`);
      }

      // Wait up to 3.5s for mic button to be enabled (not disabled while reference audio finishes)
      let micEl = null;
      const micWaitStart = Date.now();
      while (Date.now() - micWaitStart < 3500) {
        const curSt = inspectState();
        const micMeta = curSt.elements.find((e) => e.type === "mic_btn" && !e.disabled);
        if (micMeta) {
          micEl = resolveElement(micMeta.id);
          if (micEl) break;
        }
        await sleep(120);
      }

      if (!micEl) {
        return {
          success: false,
          error: "Microphone button (mic-1) not found or disabled",
          log
        };
      }

      const clipDurMs = Math.max(1200, Number(preparedClip.durationMs) || 2200);
      const leadMs = 220;
      const tailMs = 1300;

      // Arm one-shot microphone stream injection
      const armRes = await callVoiceBridge({
        type: "arm",
        leadMs,
        tailMs,
        timeoutMs: clipDurMs + 10000
      });
      if (!armRes || !armRes.ok) {
        return {
          success: false,
          error: `Failed to arm voice injector: ${(armRes && armRes.error) || "unknown"}`,
          log
        };
      }

      // Click microphone button once to start recording
      await simulateClick(micEl);
      log.push(`Started speaking (${preparedClip.source}, ${clipDurMs}ms)...`);

      // Wait while phrase plays into Efekta's audio stream
      const minPlayMs = clipDurMs + leadMs;
      const recordWaitMs = Math.min(minPlayMs + 1200, 15000);
      const recStart = Date.now();
      let stoppedAutomatically = false;
      while (Date.now() - recStart < recordWaitMs) {
        await sleep(150);
        const vStat = await callVoiceBridge({ type: "status" });
        if (vStat && vStat.session && vStat.session.stoppedByPage) {
          stoppedAutomatically = true;
          break;
        }
        if (vStat && vStat.session && vStat.session.playEndedAt) {
          await sleep(350);
          break;
        }
      }

      // Ensure recording is stopped so Efekta submits audio to ASR
      await sleep(300);
      let isRecording = false;
      let recBtn = null;
      for (const doc of getAllDocs()) {
        const ctrl = doc.querySelector(
          ".speech-action-control.recording, button.audio-recorder-btn [aria-label*='Recording' i], ef-svg-stop"
        );
        if (ctrl) {
          isRecording = true;
          recBtn = ctrl.closest("button.audio-recorder-btn, [data-qa='audio-record-or-play']") || ctrl;
          break;
        }
      }
      if (isRecording && recBtn) {
        await simulateClick(recBtn);
        log.push("Clicked mic button once to stop recording");
      }

      // Wait up to 6.5s for Efekta ASR grading to complete
      const gradeStart = Date.now();
      while (Date.now() - gradeStart < 6500) {
        await sleep(200);
        let isWaiting = false;
        let isCorrect = false;
        for (const doc of docs) {
          if (doc.querySelector(".speech-action-control.waiting_for_assessment")) {
            isWaiting = true;
          }
          if (
            doc.querySelector(
              ".speech-action-control.correct, .speech-action-control.playbackEnabled.correct"
            )
          ) {
            isCorrect = true;
          }
        }
        const afterSt = inspectState();
        if (!isWaiting) {
          if (isCorrect || afterSt.canProceed) {
            log.push(`Speech accepted! Next button unlocked (${afterSt.nextButtonId || "passed"}).`);
            return {
              success: true,
              message: `Spoke "${targetPhrase}" (${preparedClip.source}) and passed!`,
              spokenText: targetPhrase,
              source: preparedClip.source,
              canProceed: true,
              log
            };
          }
          break;
        }
      }

      const endSt = inspectState();
      return {
        success: true,
        message: `Spoke "${targetPhrase}" (${preparedClip.source})`,
        spokenText: targetPhrase,
        source: preparedClip.source,
        canProceed: endSt.canProceed,
        log
      };
    } finally {
      // ALWAYS disarm so the user's real physical microphone works normally afterward!
      await callVoiceBridge({ type: "disarm", closeSession: false });
    }
  }

  // Execute "speak" or "speak all" across a single phrase or an entire 5-phrase speaking drill
  async function executeSpeak(spec = "") {
    const raw = String(spec || "").trim().toLowerCase();
    const runAll = raw === "all" || raw === "";
    const docs = getAllDocs();
    const info = extractSpeakingInfo(docs);

    // If not a multi-phrase speaking drill or custom text was specified, speak once
    if (!runAll || (!info.isSpeakingPractice && raw !== "all")) {
      return await speakSinglePhrase(spec);
    }

    const spokenPhrases = [];
    const logs = [];
    for (let itemIdx = 0; itemIdx < 8; itemIdx++) {
      const curDocs = getAllDocs();
      const curInfo = extractSpeakingInfo(curDocs);
      const curSt = inspectState();
      const hasMic = curSt.elements.some((e) => e.type === "mic_btn");
      if (!hasMic) break;

      const res = await speakSinglePhrase("");
      if (res.log) logs.push(...res.log);
      if (!res.success) {
        return {
          success: spokenPhrases.length > 0,
          error: res.error,
          spokenPhrases,
          log: logs
        };
      }
      if (res.spokenText) spokenPhrases.push(res.spokenText);

      const postSt = inspectState();
      if (!postSt.canProceed || !postSt.nextButtonId) {
        break;
      }

      // Check if we are on the final item or passed required (e.g. "4 / 5" or "5 / 5") -> leave Next ready for '; next'
      const optList = (postSt.agentHint && postSt.agentHint.options) || [];
      const ctxList = postSt.contextText || [];
      const allText = optList.concat(ctxList).join(" ") + " " + (curInfo.progressText || "");
      const m = allText.match(/(\d+)\s*\/\s*(\d+)/);
      if (m && (m[1] === m[2] || Number(m[1]) >= 4)) {
        break;
      }

      // Otherwise click Next to advance to the next phrase (e.g. 1/5 -> 2/5)
      const nextEl = resolveElement(postSt.nextButtonId);
      if (!nextEl) break;
      await simulateClick(nextEl);
      await sleep(380);
      await waitUntilUnlocked(1500);
    }

    return {
      success: true,
      message: `Completed ${spokenPhrases.length} speaking phrase(s): ${spokenPhrases.join(" | ")}`,
      spokenPhrases,
      log: logs
    };
  }

  // Solver 1: Multiple Choice Brute-Forcer
  async function solveMultipleChoice(delayMs = 140) {
    await dismissOverlaysIfPresent();
    const initialState = inspectState();
    let candidateMeta = initialState.elements.filter((e) => e.type === "choice" && !e.disabled);
    if (candidateMeta.length === 0) {
      candidateMeta = initialState.elements.filter(
        (e) => e.type === "button" && !e.disabled && e.text.length > 0
      );
    }

    if (candidateMeta.length === 0) {
      return { success: false, message: "No clickable choice options found on page" };
    }

    const candidates = candidateMeta
      .map((meta) => ({ meta, domEl: resolveElement(meta.id), text: meta.text }))
      .filter((item) => item.domEl !== null);

    const clicked = [];
    for (const { meta, domEl, text } of candidates) {
      await waitUntilUnlocked(1500);
      const targetEl = domEl.isConnected ? domEl : findInteractiveByText(text);
      if (!targetEl) continue;
      await simulateClick(targetEl);
      clicked.push(`${meta.id} ("${text}")`);

      // Poll up to 320ms for canProceed to unlock
      const waitStart = Date.now();
      while (Date.now() - waitStart < Math.max(delayMs, 260)) {
        await sleep(45);
        const checkSt = inspectState();
        if (checkSt.canProceed && !checkSt.feedback.startsWith("incorrect")) {
          return {
            success: true,
            message: `Unlocked progression with ${meta.id} ("${text}")`,
            nextButtonId: checkSt.nextButtonId,
            clicked
          };
        }
      }

      const curState = inspectState();
      const checkBtn = curState.elements.find(
        (e) =>
          e.type === "next_btn" &&
          !e.disabled &&
          /\b(check|submit|проверить)\b/i.test(e.text)
      );
      if (checkBtn) {
        const checkEl = resolveElement(checkBtn.id);
        if (checkEl) {
          await simulateClick(checkEl);
          await sleep(delayMs);
        }
      }

      const afterCheck = inspectState();
      if (afterCheck.canProceed && !afterCheck.feedback.startsWith("incorrect")) {
        return {
          success: true,
          message: `Unlocked progression with ${meta.id} ("${text}")`,
          nextButtonId: afterCheck.nextButtonId,
          clicked
        };
      }
    }

    const finalState = inspectState();
    return {
      success: finalState.canProceed,
      message: finalState.canProceed
        ? "Completed options and unlocked next"
        : "Clicked all options; inspect state for multi-select or next button",
      clicked
    };
  }

  // Solver 2: Sentence Ordering Heuristic (Capitalization + End Punctuation)
  async function solveSentenceHeuristic() {
    const state = inspectState();
    const items = state.elements.filter((e) => e.type === "draggable" && e.text.length > 0);
    const slots = state.elements.filter((e) => e.type === "drop_target");

    if (items.length === 0) {
      return { success: false, message: "No draggable word tokens found" };
    }

    const nonICapitalized = items.filter(
      (it) => it.text !== "I" && !it.text.startsWith("I'") && /^[A-ZА-ЯЁ]/.test(it.text)
    );
    const iWords = items.filter((it) => it.text === "I" || it.text.startsWith("I'"));
    const firstCandidates = nonICapitalized.length > 0 ? nonICapitalized : iWords;
    const lastCandidates = items.filter((it) => /[.?!…]+["'”’)]*$/.test(it.text));

    const firstWord = firstCandidates[0] || null;
    const lastWord = lastCandidates[0] || null;
    const middleWords = items.filter(
      (it) =>
        (!firstWord || it.id !== firstWord.id) &&
        (!lastWord || it.id !== lastWord.id)
    );

    return {
      success: true,
      message: "Analyzed sentence tokens with capitalization and punctuation heuristics",
      analysis: {
        prompt: state.prompt,
        contextText: state.contextText,
        totalWords: items.length,
        totalSlots: slots.length,
        firstWord: firstWord ? { id: firstWord.id, text: firstWord.text } : null,
        lastWord: lastWord ? { id: lastWord.id, text: lastWord.text } : null,
        middleWords: middleWords.map((w) => ({ id: w.id, text: w.text })),
        allWords: items.map((w) => ({ id: w.id, text: w.text })),
        slots: slots.map((s) => ({ id: s.id, text: s.text }))
      }
    };
  }

  // Solver 3: Smart Speaking Solver
  // - On pronunciation / speaking practice drills (ef-speaking-practice-task): speaks all phrases with native/TTS audio!
  // - On AI Avatar dialogues: speaks chosen multiple-choice response option cleanly with TTS audio.
  async function solveSpeakingTask() {
    const docs = getAllDocs();
    const info = extractSpeakingInfo(docs);

    // Case 1: Speaking practice drill (target phrase / Play Audio button) -> real speech!
    if (info.isSpeakingPractice || info.targetPhrase || info.playAudioBtn) {
      return await executeSpeak("all");
    }

    const log = [];
    const media = getMediaStatus();
    if (media.isPlaying && media.hasVideo) {
      log.push("Waiting for avatar video to finish speaking...");
      await waitForCondition("video-end", 20000);
    }

    // Check if avatar dialogue has choices A, B, C visible
    const st = inspectState();
    const choiceEls = (st.elements || []).filter(
      (e) =>
        e.type === "choice" &&
        !e.disabled &&
        (e.tag === "ef-multiple-choice-speech-task-response-option" ||
          (e.className || "").includes("response-option") ||
          (e.text && /^[A-Z]\s*:/i.test(e.text)))
    );

    let target = "";
    if (choiceEls.length > 0) {
      target = choiceEls[0].id || "opt-1";
      log.push(`Avatar dialogue detected with ${choiceEls.length} choices. Speaking ${target}...`);
    }

    const res = await speakSinglePhrase(target);
    if (res.log) log.push(...res.log);
    const afterSt = inspectState();
    return {
      success: res.success || afterSt.canProceed,
      message: res.message || (afterSt.canProceed ? "Passed speaking task" : "Spoke phrase"),
      canProceed: afterSt.canProceed,
      spokenText: res.spokenText,
      log
    };
  }

  // Execute single action object (used by both direct messages and batch runner)
  async function executeSingleCommand(cmd) {
    const action = (cmd.action || "").toLowerCase();
    switch (action) {
      case "status":
      case "state": {
        let st = inspectState();
        st = await autoPeekSelectionGapOptions(st);
        return { success: true, data: st };
      }
      case "click":
      case "pick": {
        return await executePick(cmd.target || cmd.text);
      }
      case "pair":
      case "match": {
        return await executePair(cmd.target || cmd.text);
      }
      case "sort": {
        return await executeSort(cmd.target || cmd.text);
      }
      case "gaps":
      case "fill": {
        return await executeGaps(cmd.target || cmd.text);
      }
      case "seek": {
        const docs = getAllDocs();
        let count = 0;
        for (const doc of docs) {
          doc.querySelectorAll("video, audio").forEach((m) => {
            try {
              if (isFinite(m.duration) && m.duration > 0 && !m.ended) {
                m.currentTime = Math.max(0, m.duration - 0.25);
                m.play().catch(() => {});
                count++;
              }
            } catch (_) {}
          });
        }
        await sleep(400);
        return { success: true, message: `Fast-forwarded ${count} media element(s)` };
      }
      case "speak":
      case "say": {
        return await executeSpeak(cmd.target || cmd.text || "");
      }
      case "voice": {
        const sub = (cmd.target || "status").toLowerCase();
        if (sub === "disarm" || sub === "off" || sub === "reset") {
          const r = await callVoiceBridge({ type: "disarm", closeSession: true });
          return { success: true, message: "Microphone disarmed (real mic active)", data: r };
        }
        if (sub === "events" || sub === "log") {
          const r = await callVoiceBridge({ type: "events", limit: 40 });
          return { success: true, data: r };
        }
        const r = await callVoiceBridge({ type: "status" });
        return { success: true, data: r };
      }
      case "next":
      case "ff": {
        return await executeAutoNext(cmd.amount || 9);
      }
      case "drag": {
        await waitUntilUnlocked(1500);
        const src = resolveElement(cmd.source);
        const dst = resolveElement(cmd.target);
        if (!src || !dst) {
          return {
            success: false,
            error: `Drag source (${cmd.source}: ${!!src}) or target (${cmd.target}: ${!!dst}) not found`
          };
        }
        await simulateDragAndDrop(src, dst);
        return { success: true, message: `Dragged ${cmd.source} -> ${cmd.target}` };
      }
      case "type": {
        await dismissOverlaysIfPresent();
        const el = resolveElement(cmd.target);
        if (!el) return { success: false, error: `Input element not found: ${cmd.target}` };
        await simulateType(el, cmd.text || "", cmd.delayMs || 6);
        return { success: true, message: `Typed "${cmd.text}" into ${cmd.target}` };
      }
      case "press":
      case "key": {
        const key = cmd.text || cmd.target || "Enter";
        const target = cmd.text ? cmd.target : "";
        await simulateKeyPress(target, key);
        return { success: true, message: `Pressed key ${key}` };
      }
      case "scroll": {
        const dy = cmd.amount || (cmd.direction === "up" ? -400 : 400);
        window.scrollBy({ top: dy, behavior: "smooth" });
        return { success: true, message: `Scrolled ${dy}px` };
      }
      case "wait":
      case "sleep": {
        const cond = cmd.target || cmd.delayMs || 200;
        return await waitForCondition(cond, cmd.amount || 15000);
      }
      case "solve_choice": {
        const res = await solveMultipleChoice(cmd.delayMs || 140);
        return { success: res.success, message: res.message, data: res };
      }
      case "solve_sentence": {
        const res = await solveSentenceHeuristic();
        return { success: res.success, message: res.message, data: res };
      }
      case "skip_speaking": {
        const res = await solveSpeakingTask();
        return {
          success: res.success,
          message: res.message || "Speaking solver executed",
          data: res
        };
      }
      case "eval": {
        const rawTarget = cmd.target || "body";
        const docs = getAllDocs();

        if (rawTarget.startsWith("page:") || rawTarget.startsWith("js:")) {
          const code = rawTarget.slice(rawTarget.indexOf(":") + 1).trim();
          const r = await callVoiceBridge({ type: "eval", code });
          return {
            success: r && r.ok,
            data: r ? r.result : null,
            error: r ? r.error : "No bridge response"
          };
        }

        if (rawTarget.startsWith("info:")) {
          const sel = rawTarget.slice(5).trim();
          const infos = [];
          for (const doc of docs) {
            const elements = Array.from(doc.querySelectorAll(sel));
            for (const el of elements.slice(0, 10)) {
              const rect = el.getBoundingClientRect();
              const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
              const cs = win.getComputedStyle(el);
              infos.push({
                tag: el.tagName.toLowerCase(),
                id: el.getAttribute("data-efekta-id") || el.id || "",
                className: el.className || "",
                text: cleanText(el),
                visible: isVisible(el),
                display: cs.display,
                cursor: cs.cursor,
                pointerEvents: cs.pointerEvents,
                rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
                html: el.outerHTML.slice(0, 400),
                childrenCount: el.children.length
              });
            }
          }
          return { success: true, data: infos };
        }

        if (rawTarget.startsWith("click:")) {
          const sel = rawTarget.slice(6).trim();
          for (const doc of docs) {
            const el = doc.querySelector(sel);
            if (el) {
              const res = await simulateClick(el);
              return { success: true, message: `Clicked ${sel}`, clicked: true, tag: el.tagName };
            }
          }
          return { success: false, error: `Element not found for click: ${sel}` };
        }

        const selector = rawTarget;
        const nodes = [];
        for (const doc of docs) {
          try {
            nodes.push(...Array.from(doc.querySelectorAll(selector)));
            const allHosts = doc.querySelectorAll("*");
            for (const host of allHosts) {
              if (host.shadowRoot) {
                try {
                  nodes.push(...Array.from(host.shadowRoot.querySelectorAll(selector)));
                } catch (_) {}
              }
            }
          } catch (_) {}
        }
        return {
          success: true,
          data: nodes.slice(0, 50).map((n) => ({
            tag: n.tagName.toLowerCase(),
            id: n.getAttribute("data-efekta-id") || n.id || "",
            className: (typeof n.className === "string" ? n.className : "").slice(0, 80),
            text: cleanText(n).slice(0, 200),
            src: n.getAttribute("src") || "",
            href: n.getAttribute("href") || ""
          }))
        };
      }
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      try {
        if (request.action === "batch") {
          // Take upfront pre-batch snapshot so consecutive sort/pick/pair commands never suffer from DOM ID shifts!
          inspectState();
          batchElementSnapshot.clear();
          batchTextSnapshot.clear();
          for (const [k, v] of elementRegistry.entries()) batchElementSnapshot.set(k, v);
          for (const [k, v] of idToTextMap.entries()) batchTextSnapshot.set(k, v);
          inBatchExecution = true;

          const results = [];
          const autoReadNotes = [];
          const commands = request.commands || [];
          try {
            for (const sub of commands) {
              const r = await executeSingleCommand(sub);
              if (r.autoReadNotes && r.autoReadNotes.length > 0) {
                for (const n of r.autoReadNotes) {
                  if (!autoReadNotes.includes(n)) autoReadNotes.push(n);
                }
              }
              results.push({ action: sub.action, target: sub.target, ...r });
              if (!r.success && sub.stopOnError) break;
            }
          } finally {
            inBatchExecution = false;
            batchElementSnapshot.clear();
            batchTextSnapshot.clear();
          }

          let finalState = inspectState();
          finalState = await autoPeekSelectionGapOptions(finalState);
          if (autoReadNotes.length > 0) {
            finalState.autoReadNotes = autoReadNotes;
          }
          sendResponse({
            success: results.every((r) => r.success),
            message: `Executed ${results.length} batch commands`,
            results,
            data: finalState
          });
          return;
        }

        const result = await executeSingleCommand(request);
        const act = (request.action || "").toLowerCase();
        if (
          act !== "status" &&
          act !== "state" &&
          act !== "eval" &&
          act !== "voice" &&
          act !== "screenshot" &&
          !result.data
        ) {
          let st = inspectState();
          st = await autoPeekSelectionGapOptions(st);
          if (result.autoReadNotes && result.autoReadNotes.length > 0) {
            st.autoReadNotes = result.autoReadNotes;
          }
          result.data = st;
        }
        sendResponse(result);
      } catch (err) {
        inBatchExecution = false;
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    })();
    return true;
  });
})();
