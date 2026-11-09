// Efekta Bridge - Content Script (Turbo Engine v2.2)
(function () {
  if (window.__efekta_content_loaded) return;
  window.__efekta_content_loaded = true;

  // Fallback injection in case browser didn't support world: "MAIN" in manifest
  function injectPageScriptFallback() {
    try {
      if (window.__efekta_injected_loaded) return;
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("injected.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {}
  }
  injectPageScriptFallback();

  // Register frame with background service so commands can be routed directly to iframes
  try {
    chrome.runtime.sendMessage({
      type: "FRAME_REGISTER",
      url: window.location.href,
      isTop: window === window.top,
      isLessonPlayer:
        window.location.href.includes("lesson-player") ||
        window.location.href.includes("gap")
    });
  } catch (_) {}

  const elementRegistry = new Map();
  const idToTextMap = new Map();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity) === 0
    ) {
      return false;
    }
    return true;
  }

  // Extract clean human-visible text without screen-reader duplicates (.cdk-visually-hidden) or icon ligatures
  function cleanText(el) {
    if (!el) return "";
    const hiddenSelector =
      ".cdk-visually-hidden, .sr-only, .visually-hidden, .screen-reader-overview, ef-icon, mat-icon, svg, script, style";
    let raw = "";
    try {
      const walker = document.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const p = node.parentElement;
            if (p && p.closest && p.closest(hiddenSelector)) {
              return NodeFilter.FILTER_REJECT;
            }
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

  // Wait automatically until Efekta's transient UI locks (.locked, .item-disabled, .item-selected) clear
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

  // Dispatch realistic single click (pierces shadow DOM and ef-lesson-overview-step)
  async function simulateClick(rawEl) {
    if (!rawEl) return false;
    let el = rawEl;
    const tag = (rawEl.tagName || "").toLowerCase();
    if (tag === "ef-lesson-overview-step") {
      const innerContent = rawEl.querySelector(".content, .step-content, button, div");
      if (innerContent) el = innerContent;
    } else if (rawEl.shadowRoot) {
      const shadowBtn = rawEl.shadowRoot.querySelector(
        'button, a, [role="button"], div, span'
      );
      if (shadowBtn) el = shadowBtn;
    }

    try {
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    } catch (_) {}

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const baseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX || 0),
      screenY: y + (window.screenY || 0),
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    };

    el.dispatchEvent(new PointerEvent("pointerover", baseInit));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...baseInit, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover", baseInit));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...baseInit, bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointerdown", baseInit));
    el.dispatchEvent(new MouseEvent("mousedown", baseInit));

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch (_) {}
    }

    await sleep(12);

    const upInit = { ...baseInit, buttons: 0 };
    el.dispatchEvent(new PointerEvent("pointerup", upInit));
    el.dispatchEvent(new MouseEvent("mouseup", upInit));

    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("click", upInit));
    }

    if (rawEl !== el) {
      try {
        if (typeof rawEl.click === "function") rawEl.click();
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

    await sleep(20);

    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const curX = startX + ((endX - startX) * i) / steps;
      const curY = startY + ((endY - startY) * i) / steps;
      const moveInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: curX,
        clientY: curY,
        screenX: curX + (window.screenX || 0),
        screenY: curY + (window.screenY || 0),
        button: 0,
        buttons: 1,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse"
      };

      const hoverEl = document.elementFromPoint(curX, curY) || targetEl;
      hoverEl.dispatchEvent(new PointerEvent("pointermove", moveInit));
      hoverEl.dispatchEvent(new MouseEvent("mousemove", moveInit));
      document.dispatchEvent(new PointerEvent("pointermove", moveInit));
      document.dispatchEvent(new MouseEvent("mousemove", moveInit));

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
      await sleep(12);
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
      view: window,
      clientX: endX,
      clientY: endY,
      screenX: endX + (window.screenX || 0),
      screenY: endY + (window.screenY || 0),
      button: 0,
      buttons: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    };

    targetEl.dispatchEvent(new PointerEvent("pointerup", upInit));
    targetEl.dispatchEvent(new MouseEvent("mouseup", upInit));
    document.dispatchEvent(new PointerEvent("pointerup", upInit));
    document.dispatchEvent(new MouseEvent("mouseup", upInit));

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

  // Simulate text typing compatible with React/Angular and contenteditable blanks
  async function simulateType(el, text, delayMs = 12) {
    if (!el) return false;
    await simulateClick(el);
    try {
      el.focus();
    } catch (_) {}

    const isContentEditable =
      el.isContentEditable || el.getAttribute("contenteditable") === "true";

    if (isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      for (const ch of text) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
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
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    setNativeValue(el, "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));

    let current = "";
    for (const ch of text) {
      current += ch;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
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
    const el = (targetSpec ? resolveElement(targetSpec) : null) || document.activeElement || document.body;
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

  // Resolve element by virtual ID, saved ID text snapshot, data-efekta-id, coordinates "x,y", CSS selector, or text
  function resolveElement(target) {
    if (!target) return null;

    function findOnce(allowSavedTextFallback) {
      if (elementRegistry.has(target)) {
        const el = elementRegistry.get(target);
        if (
          el &&
          (el.isConnected ||
            (el.ownerDocument && el.ownerDocument.body && el.ownerDocument.body.contains(el)))
        ) {
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
      if (allowSavedTextFallback && idToTextMap.has(target)) {
        const savedText = idToTextMap.get(target);
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
    return findOnce(false);
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
    const active = mediaList.find((m) => !m.paused && !m.ended) || mediaList[0];
    const hasVideo = mediaList.some((m) => m.tagName.toLowerCase() === "video");
    const hasAudio = mediaList.some((m) => m.tagName.toLowerCase() === "audio");
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
      "[class*='answer']",
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
      ".options",
      ".task-wp",
      ".contents",
      ".item-list",
      ".items-container",
      ".matching-options",
      ".drawer-options",
      ".answers-info",
      "ef-instructions",
      "ef-matching-task",
      "ef-dynamic-renderer",
      "ef-activity-navigator",
      ".step-overview-list"
    ].join(",");

    const chromeNoiseRegex =
      /^(show subtitles|hide subtitles|mute video|unmute video|play video|pause video|1x|1\.25x|1\.5x|0\.75x|0\.5x|view activity instructions|open help menu|open hint|more options|close|back)$/i;

    const rawSet = new Set();
    for (const doc of docs) {
      doc.querySelectorAll(interactiveSelectors).forEach((el) => rawSet.add(el));
      const pointerCandidates = doc.querySelectorAll("div, span, li, label");
      for (const node of pointerCandidates) {
        if (rawSet.has(node)) continue;
        const r = node.getBoundingClientRect();
        if (r.width >= 20 && r.width <= 700 && r.height >= 18 && r.height <= 220) {
          if (window.getComputedStyle(node).cursor === "pointer") {
            rawSet.add(node);
          }
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

      // Skip known layout/wrapper containers so they never swallow child options/cards
      try {
        if (el.matches && el.matches(containerBlacklistSelector)) continue;
      } catch (_) {}

      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();

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

      const role = (el.getAttribute("role") || "").toLowerCase();
      const testId = (el.getAttribute("data-testid") || "").toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      const rawText = cleanText(el);

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
              !cls.includes("drawer-option")
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
      // 7. Next / Continue / Start Next Step button
      else if (
        cls.includes("next-task-button") ||
        /^(next|start next step|continue|submit|check|proceed|done|finish|start lesson|try again|далее|продолжить|проверить|готово)$/i.test(
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
        /\b(record|speak|microphone|start recording|stop recording|запись)\b/i.test(lowerText)
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
      // 12. Multiple choice options
      else if (
        role === "radio" ||
        role === "checkbox" ||
        role === "option" ||
        cls.includes("choice") ||
        cls.includes("option") ||
        cls.includes("answer")
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

      const id = `${prefix}-${counters[prefix]++}`;
      el.setAttribute("data-efekta-id", id);
      elementRegistry.set(id, el);
      if (rawText) idToTextMap.set(id, rawText);
      registeredNodes.add(el);

      const selected =
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-checked") === "true" ||
        el.checked === true ||
        cls.includes("selected") ||
        cls.includes("active") ||
        cls.includes("checked");

      const disabled =
        el.disabled === true ||
        el.getAttribute("aria-disabled") === "true" ||
        cls.includes("disabled");

      elements.push({
        id,
        type,
        text: rawText.slice(0, 140),
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

    // Extract context sentences (with inline [input-N] / [slot-N] placeholders)
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
    for (const node of contextNodes) {
      let textWithBlanks = "";
      const walker = document.createTreeWalker(
        node,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(n) {
            const p = n.parentElement;
            if (
              p &&
              p.closest &&
              p.closest(".cdk-visually-hidden, .sr-only, .screen-reader-overview, ef-icon, svg")
            ) {
              return NodeFilter.FILTER_REJECT;
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

    // Precise Exercise Type & Instant Agent Hint
    let exerciseType = "unknown";
    let actionTemplate = "";
    let summary = "";

    if (hasMic) {
      exerciseType = "speaking_avatar";
      if (skipBtn) {
        actionTemplate = `efekta batch "click ${skipBtn.id}; next" --json`;
        summary = "Optional speaking task with SKIP button available.";
      } else {
        actionTemplate = `efekta batch "wait video-end; solve speak" --json`;
        summary = "Mandatory AI avatar dialogue: wait for video-end, then run solve speak to unlock manual choices.";
      }
    } else if (hasMatchingCards && slotEls.length > 0 && dragEls.length > 0) {
      exerciseType = "matching_pairs";
      actionTemplate = `efekta batch "pair slot-1:item-X, slot-2:item-Y; next" --json`;
      summary = `Match ${slotEls.length} left slots with ${dragEls.length} right items in one batch, ending with '; next'.`;
    } else if (hasSelectionGaps && slotEls.length > 0) {
      exerciseType = "selection_gaps";
      actionTemplate = `efekta batch "gaps word1, word2, word3; next" --json`;
      summary = `Fill ${slotEls.length} gap buttons in order using 'gaps word1, word2...; next'.`;
    } else if (inputEls.length > 0) {
      exerciseType = "fill_in_the_blanks";
      actionTemplate = `efekta batch "gaps word1, word2; next" --json`;
      summary = `Type ${inputEls.length} blanks in order using 'gaps word1, word2; next'.`;
    } else if (dragEls.length > 0 && slotEls.length > 1) {
      exerciseType = "categorize_columns";
      actionTemplate = `efekta batch "sort slot-1:item-1,item-2; sort slot-2:item-3,item-4; next" --json`;
      summary = `Sort ${dragEls.length} items into ${slotEls.length} categories in one batch, ending with '; next'.`;
    } else if (dragEls.length > 0) {
      exerciseType = "order_sentence";
      actionTemplate = `efekta batch "pick item-1,item-2,item-3; next" --json`;
      summary = `Click/order ${dragEls.length} tokens in sentence order using 'pick item-X,item-Y; next'.`;
    } else if (choiceEls.length >= 2) {
      exerciseType = "multiple_choice";
      actionTemplate = `efekta batch "pick opt-1; next" --json`;
      summary = `Pick the right option(s) from ${choiceEls.length} choices and auto-advance with '; next'.`;
    } else if (stageEls.length >= 2 && !nextBtn) {
      exerciseType = "lesson_overview";
      actionTemplate = `efekta next --json`;
      summary = `Lesson overview screen (${stageEls.length} steps). Run 'efekta next --json' to enter the next incomplete step.`;
    } else if (nextBtn) {
      exerciseType = "passive_screen";
      actionTemplate = `efekta next --json`;
      summary = `Passive/reading/summary screen (${nextBtn.id} unlocked). Run 'efekta next --json' to fast-forward to the next interactive exercise.`;
    } else if (videoStatus.hasVideo) {
      exerciseType = "video_stage";
      actionTemplate = `efekta next --json`;
      summary = `Video stage. Run 'efekta next --json' or 'efekta wait video-end'.`;
    }

    const agentHint = {
      exerciseType,
      actionTemplate,
      summary,
      slots: slotEls.map((s) => `${s.id}: ${s.text || "___"}`),
      items: dragEls.map((i) => `${i.id}: ${i.text}`),
      options: choiceEls.map((o) => `${o.id}: ${o.text}`),
      inputs: inputEls.map((inp) => `${inp.id}: ${inp.text || "___"}`)
    };

    return {
      url: window.location.href,
      title: document.title,
      exerciseType,
      prompt,
      contextText: contextLines.slice(0, 12),
      feedback,
      agentHint,
      video: videoStatus,
      canProceed: !!nextBtn,
      nextButtonId: nextBtn ? nextBtn.id : "",
      elementsCount: elements.length,
      elements
    };
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
      await sleep(120);
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
    const rawStr = String(targetSpec).trim();
    // If coordinate "x,y", treat as single target
    const isCoord = /^\d+\s*,\s*\d+$/.test(rawStr);
    const targets = isCoord
      ? [rawStr]
      : rawStr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    // Snapshot DOM nodes & texts BEFORE clicking so DOM re-indexing never shifts IDs
    inspectState();
    const snapshots = targets.map((t) => ({
      target: t,
      el: resolveElement(t),
      text: idToTextMap.get(t) || t
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
        await sleep(220);
      } else {
        await sleep(160);
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
    inspectState();
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
        leftText: idToTextMap.get(leftKey) || (leftEl ? cleanText(leftEl) : leftKey),
        rightText: idToTextMap.get(rightKey) || (rightEl ? cleanText(rightEl) : rightKey)
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
      await sleep(95);
      await simulateClick(rEl);
      matched.push(`${p.leftText} -> ${p.rightText}`);

      // Wait up to 650ms for pair animation (.correct) to finish
      const start = Date.now();
      while (Date.now() - start < 650) {
        await sleep(45);
        const lCls = (lEl.className || "").toLowerCase();
        const rCls = (rEl.className || "").toLowerCase();
        if (lCls.includes("correct") || rCls.includes("correct") || !lEl.isConnected) {
          break;
        }
      }
    }
    await sleep(120);
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
    inspectState();

    // Support multiple groups separated by "|" or space-separated "slot-X:..."
    const groupsRaw = String(specStr)
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
        idToTextMap.get(slotKey) || (slotEl ? cleanText(slotEl) : slotKey);
      const items = itemKeys.map((k) => {
        const el = resolveElement(k);
        return {
          key: k,
          el,
          text: idToTextMap.get(k) || (el ? cleanText(el) : k)
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
        let itemEl = it.el && it.el.isConnected ? it.el : null;
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
        await sleep(110);
        await simulateClick(slotEl);
        sorted.push(`${it.text} -> ${grp.slotText}`);

        // Wait up to 750ms until item is removed from DOM or animation finishes
        const start = Date.now();
        while (Date.now() - start < 750) {
          await sleep(45);
          if (!itemEl.isConnected || !isVisible(itemEl)) break;
        }
        await waitUntilUnlocked(1500);
      }
    }
    await sleep(100);
    return {
      success: true,
      message: `Sorted ${sorted.length} items: ${sorted.join(" | ")}`,
      sorted
    };
  }

  // Turbo Action 4: Fill selection-gap drawers or text blanks in order ("word1, word2, word3")
  async function executeGaps(specStr) {
    if (!specStr) {
      return { success: false, error: "Usage: gaps word1, word2, word3" };
    }
    const entries = String(specStr)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const filled = [];
    const docs = getAllDocs();

    for (let i = 0; i < entries.length; i++) {
      let targetKey = "";
      let word = entries[i];
      const eqIdx = word.indexOf("=");
      if (eqIdx !== -1 && /^(slot|input)-\d+$/i.test(word.slice(0, eqIdx).trim())) {
        targetKey = word.slice(0, eqIdx).trim();
        word = word.slice(eqIdx + 1).trim();
      }
      word = word.replace(/^["']|["']$/g, "").trim();

      // Case A: Selection-gap buttons + bottom .drawer-option drawer
      let gapButtons = [];
      for (const doc of docs) {
        gapButtons.push(
          ...Array.from(doc.querySelectorAll("button.selection-gap-button")).filter(
            isVisible
          )
        );
      }

      if (gapButtons.length > 0) {
        // Check if drawer options are already open
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

        let drawerOpts = getVisibleDrawerOptions();
        if (drawerOpts.length === 0 || targetKey) {
          let gapBtn = targetKey ? resolveElement(targetKey) : null;
          if (!gapBtn) {
            // Find first unfilled gap button (no text or placeholder)
            gapBtn =
              gapButtons.find((b) => {
                const t = cleanText(b);
                const cls = (b.className || "").toLowerCase();
                return !t || /^[_.\s-]+$/.test(t) || cls.includes("empty") || !cls.includes("filled");
              }) || gapButtons[Math.min(i, gapButtons.length - 1)];
          }
          if (gapBtn) {
            await simulateClick(gapBtn);
            const waitStart = Date.now();
            while (Date.now() - waitStart < 600) {
              await sleep(35);
              drawerOpts = getVisibleDrawerOptions();
              if (drawerOpts.length > 0) break;
            }
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
        await sleep(260);
        continue;
      }

      // Case B: Standard <input> / [contenteditable] blanks
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
      await simulateType(inputDom, word, 12);
      filled.push(`${targetId}=${word}`);
      await sleep(320);
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
      t === "speaking_avatar"
    ) {
      // If canProceed is ALREADY true (e.g. "Correct answers" review screen where old options are disabled), it's passive!
      if (st.canProceed && t !== "speaking_avatar") {
        return false;
      }
      return true;
    }
    return false;
  }

  // Turbo Action 5: Auto-Fast-Forward ("next" / "ff")
  // Advances from current screen and automatically glides through consecutive passive screens
  // (reading cards, "Correct answers" review, "Step passed!" summary, Lesson Overview)
  async function executeAutoNext(maxHops = 7) {
    const autoReadNotes = [];
    let hops = 0;

    for (let step = 0; step < maxHops; step++) {
      await waitUntilUnlocked(1500);
      const st = inspectState();

      // On step > 0, stop immediately as soon as we land on an interactive exercise!
      if (step > 0 && isInteractiveExercise(st)) {
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

      // Priority 1: Active Next / Start next step / Continue button
      if (st.canProceed && st.nextButtonId) {
        const btn = resolveElement(st.nextButtonId);
        if (btn) {
          await simulateClick(btn);
          clickedTarget = st.nextButtonId;
        }
      }

      // Priority 2: Lesson Overview screen -> click first incomplete ef-lesson-overview-step
      if (!clickedTarget) {
        const docs = getAllDocs();
        for (const doc of docs) {
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
                  !s.querySelector(".completed, .passed, [class*='check']")
                );
              }) || steps[0];
            await simulateClick(incomplete);
            clickedTarget = "lesson-overview-step";
            break;
          }
        }
      }

      // Priority 3: Optional speaking task with SKIP button on step 0
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
      await sleep(380);
      await waitUntilUnlocked(1500);
      const afterSt = inspectState();
      if (isInteractiveExercise(afterSt)) {
        return {
          success: true,
          message: `Advanced ${hops} screen(s) to ${afterSt.exerciseType}`,
          hops,
          autoReadNotes
        };
      }
      // Give Angular an extra 220ms if screen is still transitioning
      await sleep(220);
    }

    const finalSt = inspectState();
    return {
      success: true,
      message: `Fast-forwarded ${hops} screen(s) (current: ${finalSt.exerciseType})`,
      hops,
      autoReadNotes
    };
  }

  // Solver 1: Multiple Choice Brute-Forcer
  async function solveMultipleChoice(delayMs = 140) {
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
      await sleep(delayMs);
      await waitUntilUnlocked(1500);

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

  // Solver 3: Speaking Avatar 3-Attempt Bypass
  async function skipSpeakingDialog() {
    const log = [];

    const media = getMediaStatus();
    if (media.isPlaying) {
      log.push("Waiting for avatar video to finish speaking...");
      await waitForCondition("video-end", 20000);
    }

    window.postMessage({ source: "efekta-content", type: "SET_AUDIO_MOCK", enabled: true }, "*");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const state = inspectState();
      const choices = state.elements.filter((e) => e.type === "choice" && !e.disabled);
      if (choices.length >= 2) {
        log.push(
          `Manual choices unlocked after ${attempt - 1} attempt(s)! Found ${choices.length} options.`
        );
        return {
          success: true,
          manualChoicesUnlocked: true,
          choices: choices.map((c) => ({ id: c.id, text: c.text })),
          log
        };
      }

      const micBtn = state.elements.find((e) => e.type === "mic_btn" && !e.disabled);
      if (!micBtn) {
        log.push(`Attempt ${attempt}: Mic button not currently active, waiting 800ms...`);
        await sleep(800);
        const retryState = inspectState();
        const retryMic = retryState.elements.find((e) => e.type === "mic_btn" && !e.disabled);
        if (!retryMic) {
          log.push(`Attempt ${attempt}: No mic button found.`);
          break;
        }
        const el = resolveElement(retryMic.id);
        if (el) await simulateClick(el);
      } else {
        const el = resolveElement(micBtn.id);
        if (el) await simulateClick(el);
      }

      log.push(`Attempt ${attempt}: Started synthetic recording`);
      await sleep(1400);

      const midState = inspectState();
      const stopMic = midState.elements.find((e) => e.type === "mic_btn" && !e.disabled);
      if (stopMic) {
        const stopEl = resolveElement(stopMic.id);
        if (stopEl) await simulateClick(stopEl);
      }

      await sleep(1000);
    }

    const finalState = inspectState();
    const unlockedChoices = finalState.elements.filter((e) => e.type === "choice");
    return {
      success: true,
      manualChoicesUnlocked: unlockedChoices.length >= 2,
      choices: unlockedChoices.map((c) => ({ id: c.id, text: c.text })),
      log
    };
  }

  // Execute single action object (used by both direct messages and batch runner)
  async function executeSingleCommand(cmd) {
    const action = (cmd.action || "").toLowerCase();
    switch (action) {
      case "status":
      case "state": {
        return { success: true, data: inspectState() };
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
      case "next":
      case "ff": {
        return await executeAutoNext(cmd.amount || 7);
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
        const el = resolveElement(cmd.target);
        if (!el) return { success: false, error: `Input element not found: ${cmd.target}` };
        await simulateType(el, cmd.text || "", cmd.delayMs || 12);
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
        const res = await skipSpeakingDialog();
        return { success: res.success, message: "Speaking bypass executed", data: res };
      }
      case "eval": {
        const selector = cmd.target || "body";
        const docs = getAllDocs();
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
          const results = [];
          const autoReadNotes = [];
          const commands = request.commands || [];
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
          const finalState = inspectState();
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
        // Always include updated state in data for mutating commands so AI agents never need a separate status call!
        const act = (request.action || "").toLowerCase();
        if (
          act !== "status" &&
          act !== "state" &&
          act !== "eval" &&
          act !== "screenshot" &&
          !result.data
        ) {
          const st = inspectState();
          if (result.autoReadNotes && result.autoReadNotes.length > 0) {
            st.autoReadNotes = result.autoReadNotes;
          }
          result.data = st;
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({
          success: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    })();
    return true;
  });
})();
