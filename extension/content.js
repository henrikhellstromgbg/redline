(function attachRedlineContentScript() {
  "use strict";

  const INSTANCE_KEY = "__redlineSharedReviewContent";
  const existing = globalThis[INSTANCE_KEY];
  if (existing && typeof existing.reconnect === "function") {
    existing.reconnect();
    return;
  }

  const Shared = globalThis.RedlineShared;
  const Targeting = globalThis.RedlineTargeting;
  if (!Shared || !Targeting) {
    throw new Error("Redline shared APIs did not load.");
  }
  const STORAGE_KEY = Shared.STORAGE_KEY;
  const HOST_ID = "redline-shared-review-overlay";
  const ROUTE_CHECK_MS = 400;
  const MAX_TEXT_LENGTH = 240;

  let review = null;
  let host = null;
  let shadow = null;
  let frameLayer = null;
  let captureLayer = null;
  let draftFrame = null;
  let editor = null;
  let statusRegion = null;
  let armed = false;
  let drag = null;
  let pendingCapture = null;
  let activePointerId = null;
  let routeSignature = getRouteSignature();
  let routeTimer = null;
  let statusTimer = null;
  let disconnected = false;

  const abortController = new AbortController();
  const { signal } = abortController;

  function now() {
    return new Date().toISOString();
  }

  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function getRoutePath() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function getRouteSignature() {
    return `${location.origin}${getRoutePath()}`;
  }

  function emptyReview() {
    return Shared.createReview({
      title: document.title ? `${document.title} review` : "Untitled review",
      source: { name: "Redline shared review", version: "1" },
    });
  }

  function annotationsOf(value) {
    return value && Array.isArray(value.annotations) ? value.annotations : [];
  }

  async function loadReview() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const candidate = stored[STORAGE_KEY];
      if (!candidate) {
        review = emptyReview();
      } else {
        try {
          review = Shared.normalizeReview(candidate);
        } catch (error) {
          console.error("Redline could not open the stored review.", error);
          await chrome.storage.local.set({ [Shared.RECOVERY_KEY]: candidate });
          review = emptyReview();
          showStatus("Stored review could not be opened. The original data was kept for recovery.", "error", 6000);
        }
      }
    } catch (_error) {
      review = review || emptyReview();
      showStatus("Couldn’t read the saved review. New annotations remain local until storage is available.", "error", 6000);
    }
    renderFrames();
    return review;
  }

  function routeMatches(annotation) {
    if (!annotation || typeof annotation !== "object") return false;
    return annotation.path === getRoutePath();
  }

  function listen(target, type, handler, options) {
    const listenerOptions = options ? { ...options, signal } : { signal };
    target.addEventListener(type, handler, listenerOptions);
  }

  async function installStyles() {
    const style = document.createElement("style");
    try {
      const response = await fetch(chrome.runtime.getURL("content.css"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      style.textContent = await response.text();
    } catch (_error) {
      style.textContent = `
        :host { all: initial; }
        .rl-layer { position: fixed; inset: 0; pointer-events: none; }
        .rl-capture { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
        .rl-frame { position: fixed; border: 2px solid #dc2626; box-sizing: border-box; pointer-events: none; }
        .rl-editor { position: fixed; z-index: 4; background: #fff; color: #18181b; padding: 12px; border: 1px solid #a1a1aa; font: 14px system-ui, sans-serif; pointer-events: auto; }
      `;
    }
    if (shadow) shadow.prepend(style);
  }

  function createOverlay() {
    const staleHost = document.getElementById(HOST_ID);
    if (staleHost) staleHost.remove();

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;";
    shadow = host.attachShadow({ mode: "closed" });

    const shell = document.createElement("div");
    shell.className = "rl-shell";
    shell.innerHTML = `
      <div class="rl-layer" data-frames aria-label="Redline annotations"></div>
      <div class="rl-layer rl-capture" data-capture hidden aria-label="Draw one annotation" role="application"></div>
      <div class="rl-status" data-status role="status" aria-live="polite" aria-atomic="true"></div>
    `;
    shadow.append(shell);
    frameLayer = shell.querySelector("[data-frames]");
    captureLayer = shell.querySelector("[data-capture]");
    statusRegion = shell.querySelector("[data-status]");
    captureLayer.tabIndex = -1;
    (document.documentElement || document.body).append(host);
    void installStyles();

    listen(captureLayer, "pointerdown", onPointerDown);
    listen(captureLayer, "pointermove", onPointerMove);
    listen(captureLayer, "pointerup", onPointerUp);
    listen(captureLayer, "pointercancel", cancelCapture);
    listen(window, "keydown", onGlobalKeyDown, true);
    listen(window, "scroll", renderFrames, { passive: true });
    listen(window, "resize", renderFrames, { passive: true });
    listen(window, "popstate", onPossibleRouteChange);
    listen(window, "hashchange", onPossibleRouteChange);
  }

  function showStatus(message, tone = "info", duration = 3000) {
    if (!statusRegion) return;
    clearTimeout(statusTimer);
    statusRegion.textContent = message;
    statusRegion.dataset.tone = tone;
    statusRegion.hidden = !message;
    if (message && duration > 0) {
      statusTimer = setTimeout(() => {
        if (statusRegion) statusRegion.hidden = true;
      }, duration);
    }
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
  }

  function onGlobalKeyDown(event) {
    if (event.key === "Escape") {
      if (editor) {
        event.preventDefault();
        closeEditor(false);
      } else if (armed || drag) {
        event.preventDefault();
        cancelCapture();
      }
      return;
    }
    if (editor) return;
    if ((event.key === "r" || event.key === "R") && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
      event.preventDefault();
      armCapture();
    }
  }

  function armCapture() {
    if (disconnected) return false;
    if (editor) closeEditor(false);
    armed = true;
    drag = null;
    pendingCapture = null;
    captureLayer.hidden = false;
    captureLayer.dataset.state = "armed";
    showStatus("Draw a box around one problem. Press Esc to cancel.", "info", 0);
    captureLayer.focus({ preventScroll: true });
    return true;
  }

  function pointFromEvent(event) {
    return {
      x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
      y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
    };
  }

  function normalizedRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  }

  function onPointerDown(event) {
    if (!armed || editor || (event.button !== 0 && event.pointerType === "mouse")) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    captureLayer.setPointerCapture?.(event.pointerId);
    const start = pointFromEvent(event);
    drag = { start, current: start };
    captureLayer.dataset.state = "drawing";
    draftFrame = document.createElement("div");
    draftFrame.className = "rl-frame rl-frame--draft";
    draftFrame.setAttribute("aria-hidden", "true");
    frameLayer.append(draftFrame);
    positionElement(draftFrame, normalizedRect(start, start));
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== activePointerId) return;
    event.preventDefault();
    drag.current = pointFromEvent(event);
    positionElement(draftFrame, normalizedRect(drag.start, drag.current));
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== activePointerId) return;
    event.preventDefault();
    drag.current = pointFromEvent(event);
    const rect = normalizedRect(drag.start, drag.current);
    captureLayer.releasePointerCapture?.(event.pointerId);
    activePointerId = null;

    if (rect.width < 4 || rect.height < 4) {
      cancelCapture();
      showStatus("Draw a larger box to add an annotation.", "error", 3500);
      return;
    }

    // Capture page and target evidence before the page is uncovered or note entry starts.
    pendingCapture = captureAnnotationEvidence(rect);
    drag = null;
    armed = false;
    captureLayer.hidden = true;
    captureLayer.dataset.state = "";
    openEditor(rect);
  }

  function cancelCapture() {
    if (activePointerId !== null) {
      try {
        captureLayer.releasePointerCapture?.(activePointerId);
      } catch (_error) {
        // Pointer may already be released by the browser.
      }
    }
    activePointerId = null;
    armed = false;
    drag = null;
    pendingCapture = null;
    captureLayer.hidden = true;
    captureLayer.dataset.state = "";
    draftFrame?.remove();
    draftFrame = null;
    showStatus("Annotation cancelled.", "info", 1800);
  }

  function captureAnnotationEvidence(rect) {
    const scroll = { x: window.scrollX, y: window.scrollY };
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const targetElement = elementBelowOverlay(center.x, center.y) || elementBelowOverlay(rect.x, rect.y);
    const targetRect = targetElement?.getBoundingClientRect();
    return {
      id: makeId(),
      instruction: "",
      createdAt: now(),
      url: location.href,
      path: getRoutePath(),
      title: document.title || "Untitled page",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      scroll,
      rect: roundRect(rect),
      pageRect: roundRect({
        x: rect.x + scroll.x,
        y: rect.y + scroll.y,
        width: rect.width,
        height: rect.height,
      }),
      target: targetElement ? captureTarget(targetElement, targetRect) : null,
    };
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function roundRect(rect) {
    return {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
  }

  function elementBelowOverlay(x, y) {
    if (!host) return null;
    const previous = host.style.pointerEvents;
    host.style.pointerEvents = "none";
    const candidates = document.elementsFromPoint(x, y);
    host.style.pointerEvents = previous;
    return candidates.find((element) => element !== host && element instanceof HTMLElement) || null;
  }

  function captureTarget(element, clientRect) {
    const selector = buildExactSelector(element);
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-qa");
    return {
      selector,
      tag: element.tagName.toLowerCase(),
      text: boundedText(element.innerText || element.textContent || ""),
      role: getRole(element),
      name: getAccessibleName(element),
      id: element.id || null,
      testId: testId || null,
      rect: clientRect ? roundRect(clientRect) : null,
    };
  }

  function boundedText(value) {
    const normalized = String(value).replace(/\s+/g, " ").trim();
    if (normalized.length <= MAX_TEXT_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
  }

  function getAccessibleName(element) {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return boundedText(ariaLabel);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (label.trim()) return boundedText(label);
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const labels = Array.from(element.labels || []).map((label) => label.textContent || "").join(" ");
      if (labels.trim()) return boundedText(labels);
      if (element.placeholder) return boundedText(element.placeholder);
    }
    if (element instanceof HTMLImageElement && element.alt) return boundedText(element.alt);
    if (element.getAttribute("title")) return boundedText(element.getAttribute("title"));
    return boundedText(element.innerText || element.textContent || "");
  }

  function getRole(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const roles = {
      A: element.hasAttribute("href") ? "link" : null,
      BUTTON: "button",
      DIALOG: "dialog",
      FORM: "form",
      H1: "heading",
      H2: "heading",
      H3: "heading",
      H4: "heading",
      H5: "heading",
      H6: "heading",
      IMG: "img",
      LI: "listitem",
      MAIN: "main",
      NAV: "navigation",
      OL: "list",
      TABLE: "table",
      TEXTAREA: "textbox",
      UL: "list",
    };
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    return roles[element.tagName] || null;
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
    return String(value).replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, digit) => {
      if (digit) return `\\3${digit} `;
      return `\\${match}`;
    });
  }

  function attributeSelector(name, value) {
    return Targeting.attributeSelector(name, value);
  }

  function isExactSelector(selector, element) {
    if (!selector) return false;
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch (_error) {
      return false;
    }
  }

  function buildExactSelector(element) {
    if (!(element instanceof Element)) return null;
    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      if (isExactSelector(selector, element)) return selector;
    }

    for (const name of ["data-testid", "data-test", "data-qa"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const selector = `${element.tagName.toLowerCase()}${attributeSelector(name, value)}`;
      if (isExactSelector(selector, element)) return selector;
    }

    const classNames = Array.from(element.classList)
      .filter((name) => name.length < 64 && !/^(css-|jsx-|sc-|_)/.test(name))
      .slice(0, 3);
    if (classNames.length) {
      const selector = `${element.tagName.toLowerCase()}${classNames.map((name) => `.${cssEscape(name)}`).join("")}`;
      if (isExactSelector(selector, element)) return selector;
    }

    const segments = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const segment = selectorSegment(current);
      segments.unshift(segment);
      const candidate = `body > ${segments.join(" > ")}`;
      if (isExactSelector(candidate, element)) return candidate;
      current = current.parentElement;
      if (current === document.body) break;
    }
    return null;
  }

  function selectorSegment(element) {
    const tag = element.tagName.toLowerCase();
    const siblings = element.parentElement ? Array.from(element.parentElement.children) : [];
    const sameTag = siblings.filter((sibling) => sibling.tagName === element.tagName);
    if (sameTag.length <= 1) return tag;
    return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
  }

  function openEditor(rect) {
    editor?.remove();
    editor = document.createElement("form");
    editor.className = "rl-editor";
    editor.setAttribute("aria-label", "Add annotation note");
    editor.innerHTML = `
      <label class="rl-editor__label" for="rl-note-${pendingCapture.id}">What needs fixing?</label>
      <textarea id="rl-note-${pendingCapture.id}" class="rl-editor__input" rows="3" placeholder="Describe the problem or bug" required></textarea>
      <p class="rl-editor__hint">Enter saves · Shift+Enter adds a line · Esc cancels</p>
      <p class="rl-editor__error" data-error role="alert" hidden></p>
      <div class="rl-editor__actions">
        <button type="button" data-cancel>Cancel</button>
        <button type="submit" data-save>Save annotation</button>
      </div>
    `;
    shadow.append(editor);
    positionEditor(editor, rect);

    const textarea = editor.querySelector("textarea");
    listen(editor, "submit", onEditorSubmit);
    listen(editor.querySelector("[data-cancel]"), "click", () => closeEditor(false));
    listen(textarea, "keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        editor.requestSubmit();
      }
    });
    textarea.focus({ preventScroll: true });
  }

  function positionEditor(node, rect) {
    const width = Math.min(360, Math.max(280, window.innerWidth - 24));
    node.style.width = `${width}px`;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.x));
    const below = rect.y + rect.height + 10;
    const top = below + 210 < window.innerHeight ? below : Math.max(12, rect.y - 210);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  async function onEditorSubmit(event) {
    event.preventDefault();
    if (!pendingCapture || !editor) return;
    const textarea = editor.querySelector("textarea");
    const error = editor.querySelector("[data-error]");
    const saveButton = editor.querySelector("[data-save]");
    const instruction = textarea.value.trim();
    if (!instruction) {
      error.textContent = "Write a short note before saving.";
      error.hidden = false;
      textarea.focus();
      return;
    }

    error.hidden = true;
    saveButton.disabled = true;
    textarea.disabled = true;
    const annotation = { ...pendingCapture, instruction };
    const previousReview = review || emptyReview();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "redline:mutate-review",
        operation: "append",
        annotation,
        fallbackReview: previousReview,
        mutationId: `content:${annotation.id}`
      });
      if (!response?.ok) throw new Error(response?.error || "Review mutation failed");
      review = Shared.normalizeReview(response.review);
    } catch (_error) {
      error.textContent = "Couldn’t save the annotation. Your note is still here; try again.";
      error.hidden = false;
      saveButton.disabled = false;
      textarea.disabled = false;
      textarea.focus();
      return;
    }

    closeEditor(true);
    renderFrames(annotation.id);
    showStatus("Annotation saved.", "success", 2400);
  }

  function closeEditor(saved) {
    editor?.remove();
    editor = null;
    pendingCapture = null;
    draftFrame?.remove();
    draftFrame = null;
    armed = false;
    drag = null;
    captureLayer.hidden = true;
    captureLayer.dataset.state = "";
    if (!saved) showStatus("Annotation cancelled.", "info", 1800);
  }

  function getDisplayedRect(annotation) {
    const selector = annotation?.target?.selector;
    const capturedTargetRect = annotation?.target?.rect;
    const capturedRect = annotation?.rect;
    if (selector && capturedTargetRect && capturedRect) {
      try {
        const matches = document.querySelectorAll(selector);
        if (matches.length === 1) {
          const currentTargetRect = matches[0].getBoundingClientRect();
          return {
            x: currentTargetRect.x + (Number(capturedRect.x) - Number(capturedTargetRect.x)),
            y: currentTargetRect.y + (Number(capturedRect.y) - Number(capturedTargetRect.y)),
            width: Number(capturedRect.width),
            height: Number(capturedRect.height),
          };
        }
      } catch (_error) {
        // Imported pages can legitimately stop supporting previously captured selectors.
      }
    }
    const pageRect = annotation?.pageRect;
    if (!pageRect) return null;
    return {
      x: Number(pageRect.x) - window.scrollX,
      y: Number(pageRect.y) - window.scrollY,
      width: Number(pageRect.width),
      height: Number(pageRect.height),
    };
  }

  function positionElement(element, rect) {
    if (!element || !rect) return;
    element.style.left = `${round(rect.x)}px`;
    element.style.top = `${round(rect.y)}px`;
    element.style.width = `${Math.max(0, round(rect.width))}px`;
    element.style.height = `${Math.max(0, round(rect.height))}px`;
  }

  function renderFrames(highlightId = null) {
    if (!frameLayer || !review) return;
    frameLayer.replaceChildren();
    const visible = annotationsOf(review).filter(routeMatches);
    visible.forEach((annotation, index) => {
      const rect = getDisplayedRect(annotation);
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return;
      const frame = document.createElement("div");
      frame.className = "rl-frame";
      frame.dataset.annotationId = annotation.id;
      frame.setAttribute("aria-label", `Annotation ${index + 1}: ${annotation.instruction || "No note"}`);
      if (annotation.id === highlightId) frame.dataset.highlight = "true";
      const badge = document.createElement("span");
      badge.className = "rl-frame__badge";
      badge.textContent = String(index + 1);
      frame.append(badge);
      positionElement(frame, rect);
      frameLayer.append(frame);
    });
  }

  function locateAnnotation(id) {
    const annotation = annotationsOf(review).find((item) => item.id === id);
    if (!annotation) return { ok: false, reason: "not-found" };
    if (!routeMatches(annotation)) {
      return { ok: false, reason: "route-mismatch", path: annotation.path };
    }

    let destination = annotation.pageRect;
    const selector = annotation.target?.selector;
    if (selector) {
      try {
        const matches = document.querySelectorAll(selector);
        if (matches.length === 1) {
          const targetRect = matches[0].getBoundingClientRect();
          destination = {
            x: targetRect.x + window.scrollX,
            y: targetRect.y + window.scrollY,
            width: targetRect.width,
            height: targetRect.height,
          };
        }
      } catch (_error) {
        // Stored selectors are evidence, never authority; use the captured rectangle.
      }
    }
    if (destination) {
      window.scrollTo({
        top: Math.max(0, Number(destination.y) - window.innerHeight / 3),
        left: Math.max(0, Number(destination.x) - window.innerWidth / 3),
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
    requestAnimationFrame(() => renderFrames(id));
    showStatus(`Located annotation ${annotationsOf(review).indexOf(annotation) + 1}.`, "info", 2200);
    return { ok: true };
  }

  function onPossibleRouteChange() {
    const next = getRouteSignature();
    if (next === routeSignature) return;
    routeSignature = next;
    renderFrames();
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    const candidate = changes[STORAGE_KEY].newValue;
    if (!candidate) {
      review = emptyReview();
      renderFrames();
      return;
    }
    try {
      review = Shared.normalizeReview(candidate);
      renderFrames();
    } catch (error) {
      console.error("Redline ignored an invalid storage update.", error);
      showStatus("An invalid review update was ignored.", "error", 5000);
    }
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== "string") return false;
    switch (message.type) {
      case "redline:ping":
        sendResponse({ ok: true, connected: !disconnected, path: getRoutePath(), armed });
        return false;
      case "redline:annotate":
        sendResponse({ ok: armCapture() });
        return false;
      case "redline:locate":
        sendResponse(locateAnnotation(message.id));
        return false;
      case "redline:refresh":
        void loadReview().then(() => sendResponse({ ok: true }));
        return true;
      case "redline:disconnect":
        sendResponse({ ok: true });
        teardown();
        return false;
      default:
        return false;
    }
  }

  function reconnect() {
    if (disconnected) return false;
    host?.removeAttribute("hidden");
    void loadReview();
    return true;
  }

  function teardown() {
    if (disconnected) return;
    disconnected = true;
    clearInterval(routeTimer);
    clearTimeout(statusTimer);
    abortController.abort();
    chrome.storage.onChanged.removeListener(onStorageChanged);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    host?.remove();
    host = null;
    shadow = null;
    frameLayer = null;
    captureLayer = null;
    editor = null;
    if (globalThis[INSTANCE_KEY]?.teardown === teardown) delete globalThis[INSTANCE_KEY];
  }

  createOverlay();
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  routeTimer = setInterval(onPossibleRouteChange, ROUTE_CHECK_MS);
  globalThis[INSTANCE_KEY] = { reconnect, teardown };
  void loadReview();
})();
