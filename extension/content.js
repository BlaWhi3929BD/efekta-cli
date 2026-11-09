// Efekta Bridge - Content Script
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
      isLessonPlayer: window.location.href.includes("lesson-player") || window.location.href.includes("gap")
    });
  } catch (_) {}

  let elementRegistry = new Map();

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

  // Dispatch realistic single click (fixes double-click bug & async race)
  async function simulateClick(el) {
    if (!el) return false;
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

    await sleep(15);

    const upInit = { ...baseInit, buttons: 0 };
    el.dispatchEvent(new PointerEvent("pointerup", upInit));
    el.dispatchEvent(new MouseEvent("mouseup", upInit));

    // Fire a single native click (triggers both React synthetic onClick and native listeners)
    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("click", upInit));
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
      const text = (sourceEl.innerText || sourceEl.textContent || "").trim();
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
      await sleep(15);
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

  // React-compatible controlled input value setter
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

  // Simulate text typing compatible with React 16-19 and contenteditable blanks
  async function simulateType(el, text, delayMs = 15) {
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

    // Standard <input> / <textarea>
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

  // Helper to gather all accessible documents (top-level window + same-origin iframes)
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

  // Resolve element by virtual ID, data-efekta-id, coordinates "x,y", CSS selector, or exact text
  function resolveElement(target) {
    if (!target) return null;

    if (elementRegistry.has(target)) {
      const el = elementRegistry.get(target);
      if (el && el.ownerDocument && el.ownerDocument.body && el.ownerDocument.body.contains(el)) return el;
    }

    const docs = getAllDocs();

    // Lookup via persistent data attribute
    for (const doc of docs) {
      try {
        const byAttr = doc.querySelector(`[data-efekta-id="${CSS.escape(target)}"]`);
        if (byAttr) return byAttr;
      } catch (_) {}
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
        if (bySelector) return bySelector;
      } catch (_) {}
    }

    // Text content match fallback
    const needle = target.trim().toLowerCase();
    for (const doc of docs) {
      const candidates = Array.from(
        doc.querySelectorAll("button, [role='button'], a, label, li, div, span")
      );
      const exact = candidates.find(
        (e) => isVisible(e) && (e.innerText || e.textContent || "").trim().toLowerCase() === needle
      );
      if (exact) return exact;

      const partial = candidates.find(
        (e) =>
          isVisible(e) && (e.innerText || e.textContent || "").trim().toLowerCase().includes(needle)
      );
      if (partial) return partial;
    }

    return null;
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
      return { hasVideo: false, hasAudio: false, isPlaying: false, paused: true, ended: true, currentTime: 0, duration: 0 };
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

  // Build rich semantic page state for AI agents
  function inspectState() {
    elementRegistry.clear();
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
      if (tag === "body" || tag === "html" || tag === "head" || tag === "ol" || tag === "ul" || tag === "form") {
        continue;
      }

      const role = (el.getAttribute("role") || "").toLowerCase();
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      const testId = (el.getAttribute("data-testid") || "").toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      const rawText = (
        el.innerText ||
        el.textContent ||
        el.value ||
        ariaLabel ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ");

      // Skip huge layout wrappers that accidentally matched a class substring like "card-container" or "stage-wrapper"
      const rect = el.getBoundingClientRect();
      if (
        tag === "div" &&
        rect.width > window.innerWidth * 0.85 &&
        rect.height > window.innerHeight * 0.5 &&
        !el.getAttribute("draggable")
      ) {
        continue;
      }

      // Skip child spans/divs if an interactive parent is already registered (unless child is an input/button itself)
      let hasRegisteredParent = false;
      let parent = el.parentElement;
      while (parent && parent.tagName && parent.tagName.toLowerCase() !== "body" && parent.tagName.toLowerCase() !== "html") {
        if (registeredNodes.has(parent)) {
          const pTag = parent.tagName.toLowerCase();
          if (pTag !== "ol" && pTag !== "ul" && !parent.className.includes("list")) {
            if (tag !== "input" && tag !== "textarea" && tag !== "button") {
              hasRegisteredParent = true;
              break;
            }
          }
        }
        parent = parent.parentElement;
      }
      if (hasRegisteredParent) continue;

      // Classify element
      let type = "button";
      let prefix = "btn";
      const lowerText = (rawText + " " + ariaLabel + " " + testId).toLowerCase();

      if (
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
      } else if (
        /\b(next|continue|submit|check|proceed|done|finish|complete|start lesson|try again|skip|далее|продолжить|проверить|готово)\b/i.test(
          lowerText
        ) ||
        cls.includes("next") ||
        cls.includes("submit") ||
        cls.includes("continue")
      ) {
        type = "next_btn";
        prefix = "next";
      } else if (
        cls.includes("mic") ||
        cls.includes("record") ||
        /\b(record|speak|microphone|start recording|stop recording|запись)\b/i.test(lowerText)
      ) {
        type = "mic_btn";
        prefix = "mic";
      } else if (
        role === "tab" ||
        role === "listitem" ||
        tag === "li" ||
        cls.includes("stage") ||
        cls.includes("step") ||
        testId.includes("stage") ||
        testId.includes("step")
      ) {
        type = "stage_nav";
        prefix = "stage";
      } else if (
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
      } else if (
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
      } else if (
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
        // Non-interactive generic container without clear role
        if (!rawText) continue;
        type = "element";
        prefix = "btn";
      }

      const id = `${prefix}-${counters[prefix]++}`;
      el.setAttribute("data-efekta-id", id);
      elementRegistry.set(id, el);
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

    // Extract task prompt / instructions
    const promptCandidates = [];
    for (const doc of docs) {
      promptCandidates.push(
        ...Array.from(
          doc.querySelectorAll(
            "h1, h2, h3, [class*='prompt'], [class*='instruction'], [class*='question'], [class*='rubric'], [class*='header-title']"
          )
        )
          .filter(isVisible)
          .map((e) => (e.innerText || e.textContent || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 2 && t.length < 300)
      );
    }
    const prompt = Array.from(new Set(promptCandidates)).slice(0, 3).join(" | ");

    // Extract context sentences (including inline placeholders for inputs/blanks so AI knows sentence context!)
    const contextNodes = [];
    for (const doc of docs) {
      contextNodes.push(
        ...Array.from(
          doc.querySelectorAll(
            "p, [class*='sentence'], [class*='passage'], [class*='dialogue'], [class*='transcript'], [class*='phrase'], [class*='statement'], [class*='question-text']"
          )
        ).filter(isVisible)
      );
    }

    const contextLines = [];
    const seenContext = new Set();
    for (const node of contextNodes) {
      // Build string with inline markers for inputs/slots inside the sentence
      let textWithBlanks = "";
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let cur = walker.nextNode();
      while (cur) {
        if (cur.nodeType === Node.TEXT_NODE) {
          textWithBlanks += cur.nodeValue;
        } else if (cur.nodeType === Node.ELEMENT_NODE) {
          const eid = cur.getAttribute("data-efekta-id");
          if (eid && (eid.startsWith("input-") || eid.startsWith("slot-"))) {
            const val = (cur.value || cur.innerText || "").trim();
            textWithBlanks += ` [${eid}${val ? "=" + val : ""}] `;
          }
        }
        cur = walker.nextNode();
      }
      const cleaned = (textWithBlanks || node.innerText || "").trim().replace(/\s+/g, " ");
      if (cleaned.length > 2 && cleaned.length < 500 && !seenContext.has(cleaned)) {
        seenContext.add(cleaned);
        contextLines.push(cleaned);
      }
    }

    // Detect feedback (correct / incorrect / completed)
    let feedback = "";
    const feedbackEls = [];
    for (const doc of docs) {
      feedbackEls.push(
        ...Array.from(
          doc.querySelectorAll(
            "[class*='feedback'], [class*='correct'], [class*='incorrect'], [class*='error'], [class*='success'], [role='alert'], [class*='result'], [class*='modal']"
          )
        ).filter(isVisible)
      );
    }
    for (const f of feedbackEls) {
      const fText = (f.innerText || f.textContent || "").trim().replace(/\s+/g, " ");
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

    // Exercise type classification
    let exerciseType = "unknown";
    const choiceCount = elements.filter((e) => e.type === "choice").length;
    const dragCount = elements.filter((e) => e.type === "draggable").length;
    const slotCount = elements.filter((e) => e.type === "drop_target").length;
    const inputCount = elements.filter((e) => e.type === "input").length;
    const hasMic = elements.some((e) => e.type === "mic_btn");

    if (hasMic) {
      exerciseType = "speaking_avatar";
    } else if (inputCount > 0) {
      exerciseType = "fill_in_the_blanks";
    } else if (dragCount > 0 && slotCount > 1) {
      exerciseType = "categorize_columns";
    } else if (dragCount > 0) {
      exerciseType = "order_sentence";
    } else if (choiceCount >= 2) {
      exerciseType = "multiple_choice";
    } else if (videoStatus.hasVideo) {
      exerciseType = "video_stage";
    }

    const nextBtn = elements.find((e) => e.type === "next_btn" && !e.disabled);

    return {
      url: window.location.href,
      title: document.title,
      exerciseType,
      prompt,
      contextText: contextLines.slice(0, 10),
      feedback,
      video: videoStatus,
      canProceed: !!nextBtn,
      nextButtonId: nextBtn ? nextBtn.id : "",
      elementsCount: elements.length,
      elements
    };
  }

  // Wait for a condition ("video-end", "next", or duration in ms)
  async function waitForCondition(condition, timeoutMs = 15000) {
    const start = Date.now();
    if (!condition || /^\d+$/.test(String(condition))) {
      const ms = parseInt(condition, 10) || 200;
      await sleep(ms);
      return { success: true, message: `Waited ${ms}ms` };
    }

    const cond = String(condition).toLowerCase();
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
      await sleep(150);
    }
    return { success: false, error: `Timeout (${timeoutMs}ms) waiting for condition: ${condition}` };
  }

  // Solver 1: Multiple Choice Brute-Forcer (Fixes elementRegistry re-index bug!)
  async function solveMultipleChoice(delayMs = 90) {
    const initialState = inspectState();
    let candidateMeta = initialState.elements.filter((e) => e.type === "choice" && !e.disabled);
    if (candidateMeta.length === 0) {
      // Fallback: non-navigation buttons that might be choices
      candidateMeta = initialState.elements.filter(
        (e) => e.type === "button" && !e.disabled && e.text.length > 0
      );
    }

    if (candidateMeta.length === 0) {
      return { success: false, message: "No clickable choice options found on page" };
    }

    // Resolve live DOM references BEFORE the loop so re-inspecting never invalidates them
    const candidates = candidateMeta
      .map((meta) => ({ meta, domEl: resolveElement(meta.id) }))
      .filter((item) => item.domEl !== null);

    const clicked = [];
    for (const { meta, domEl } of candidates) {
      if (!document.body.contains(domEl)) continue;
      await simulateClick(domEl);
      clicked.push(`${meta.id} ("${meta.text}")`);
      await sleep(delayMs);

      const curState = inspectState();
      // If there's a "Check" / "Submit" button that must be clicked to validate the choice:
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
      if (
        afterCheck.canProceed &&
        !afterCheck.feedback.startsWith("incorrect")
      ) {
        return {
          success: true,
          message: `Unlocked progression with ${meta.id} ("${meta.text}")`,
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

    // First word heuristic:
    // Look for capitalized words excluding standalone "I" first. If none, fall back to "I".
    const nonICapitalized = items.filter(
      (it) => it.text !== "I" && !it.text.startsWith("I'") && /^[A-ZА-ЯЁ]/.test(it.text)
    );
    const iWords = items.filter((it) => it.text === "I" || it.text.startsWith("I'"));
    const firstCandidates = nonICapitalized.length > 0 ? nonICapitalized : iWords;

    // Last word heuristic: ends with ., ?, !
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

    // 1. Wait for avatar video to finish speaking if currently playing
    const media = getMediaStatus();
    if (media.isPlaying) {
      log.push("Waiting for avatar video to finish speaking...");
      await waitForCondition("video-end", 20000);
    }

    // 2. Ensure synthetic audio mock is enabled
    window.postMessage({ source: "efekta-content", type: "SET_AUDIO_MOCK", enabled: true }, "*");

    // 3. Burn up to 3 attempts so Efekta unlocks manual text choice mode
    for (let attempt = 1; attempt <= 3; attempt++) {
      const state = inspectState();
      // Check if manual choices already unlocked!
      const choices = state.elements.filter((e) => e.type === "choice" && !e.disabled);
      if (choices.length >= 2) {
        log.push(`Manual choices unlocked after ${attempt - 1} attempt(s)! Found ${choices.length} options.`);
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

      // Click again to stop recording if button is still in recording state
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
      case "click": {
        const el = resolveElement(cmd.target);
        if (!el) return { success: false, error: `Element not found: ${cmd.target}` };
        await simulateClick(el);
        return { success: true, message: `Clicked ${cmd.target}` };
      }
      case "drag": {
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
        await simulateType(el, cmd.text || "", cmd.delayMs || 15);
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
        const res = await solveMultipleChoice(cmd.delayMs || 90);
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
        // Safe DOM inspection helper (only queries/reads properties)
        const selector = cmd.target || "body";
        const docs = getAllDocs();
        const nodes = [];
        for (const doc of docs) {
          try {
            nodes.push(...Array.from(doc.querySelectorAll(selector)));
          } catch (_) {}
        }
        return {
          success: true,
          data: nodes.slice(0, 50).map((n) => ({
            tag: n.tagName.toLowerCase(),
            id: n.getAttribute("data-efekta-id") || n.id || "",
            className: (typeof n.className === "string" ? n.className : "").slice(0, 80),
            text: (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
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
          const commands = request.commands || [];
          for (const sub of commands) {
            const r = await executeSingleCommand(sub);
            results.push({ action: sub.action, target: sub.target, ...r });
            if (!r.success && sub.stopOnError) break;
          }
          sendResponse({
            success: true,
            message: `Executed ${results.length} batch commands`,
            results,
            data: inspectState()
          });
          return;
        }

        const result = await executeSingleCommand(request);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  });
})();
