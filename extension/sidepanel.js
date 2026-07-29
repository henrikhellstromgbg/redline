(() => {
  "use strict";

  const shared = globalThis.RedlineShared;
  if (!shared) {
    throw new Error("Redline shared APIs did not load.");
  }

  const STORAGE_KEY = shared.STORAGE_KEY;
  const RECOVERY_KEY = shared.RECOVERY_KEY;
  const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
  const TAB_STATUS_PREFIX = "redline:tab-status:";

  const elements = {
    annotateButton: document.querySelector("#annotate-button"),
    annotationCount: document.querySelector("#annotation-count"),
    annotationGroups: document.querySelector("#annotation-groups"),
    annotationSummary: document.querySelector("#annotation-summary"),
    annotationTemplate: document.querySelector("#annotation-template"),
    captureHelp: document.querySelector("#capture-help"),
    connection: document.querySelector("#connection"),
    connectionLocation: document.querySelector("#connection-location"),
    connectionStatus: document.querySelector("#connection-status"),
    copyButton: document.querySelector("#copy-button"),
    copyHelp: document.querySelector("#copy-help"),
    emptyState: document.querySelector("#empty-state"),
    exportButton: document.querySelector("#export-button"),
    importButton: document.querySelector("#import-button"),
    importInput: document.querySelector("#import-input"),
    intent: document.querySelector("#review-intent"),
    newReviewButton: document.querySelector("#new-review-button"),
    saveStatus: document.querySelector("#save-status"),
    saveStatusText: document.querySelector("#save-status-text"),
    title: document.querySelector("#review-title")
  };

  let review = null;
  let activeTab = null;
  let connected = false;
  let writeChain = Promise.resolve();
  let statusTimer = 0;
  let preservedCandidate = null;
  const ownMutationIds = new Set();

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isEditableTarget(target) {
    return target instanceof HTMLElement && (
      target.isContentEditable ||
      target.matches("input, textarea, select")
    );
  }

  function annotationLabel(count) {
    return `${count} ${count === 1 ? "annotation" : "annotations"}`;
  }

  function setStatus(message, tone = "neutral", { sticky = false } = {}) {
    window.clearTimeout(statusTimer);
    elements.saveStatus.dataset.tone = tone;
    elements.saveStatusText.textContent = message;

    if (!sticky && tone !== "error") {
      statusTimer = window.setTimeout(() => {
        elements.saveStatus.dataset.tone = "neutral";
        elements.saveStatusText.textContent = "Saved locally";
      }, 2800);
    }
  }

  function sourceFromActiveTab() {
    if (!activeTab?.url) return undefined;

    try {
      const url = new URL(activeTab.url);
      return {
        origin: url.origin,
        title: activeTab.title || "",
        url: activeTab.url
      };
    } catch {
      return undefined;
    }
  }

  function createReview(title = "Design review") {
    return shared.createReview({
      title,
      intent: "triage",
      source: sourceFromActiveTab()
    });
  }

  async function readStoredReview() {
    const stored = await chrome.storage.local.get([STORAGE_KEY, RECOVERY_KEY]);
    const candidate = stored[STORAGE_KEY];
    preservedCandidate = stored[RECOVERY_KEY] || null;

    if (!candidate) return createReview();

    try {
      const normalized = shared.normalizeReview(candidate);
      if (preservedCandidate) {
        setStatus("Original recovery data is available to export.", "error", { sticky: true });
      }
      return normalized;
    } catch (error) {
      console.error("Redline could not open the stored review.", error);
      preservedCandidate = clone(candidate);
      try {
        await chrome.storage.local.set({ [RECOVERY_KEY]: preservedCandidate });
      } catch (backupError) {
        console.error("Redline could not create a recovery backup.", backupError);
      }
      setStatus("Stored review could not be opened. Export original data before starting over.", "error", { sticky: true });
      return createReview("Recovered review");
    }
  }

  function mutationId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  function mutateReview(operation, payload = {}, successMessage = "Saved locally", options = {}) {
    const id = `panel:${mutationId()}`;
    ownMutationIds.add(id);
    setStatus("Saving locally…", "working", { sticky: true });

    writeChain = writeChain
      .catch(() => undefined)
      .then(() => chrome.runtime.sendMessage({
        type: "redline:mutate-review",
        operation,
        mutationId: id,
        clearRecovery: Boolean(options.clearRecovery),
        ...payload
      }))
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || "Review mutation failed");
        review = shared.normalizeReview(response.review);
        if (options.clearRecovery) preservedCandidate = null;
        if (options.render) renderReview();
        else updateShareActions();
        setStatus(successMessage, "success");
        return review;
      })
      .catch((error) => {
        console.error("Redline could not save the review.", error);
        setStatus("Could not save. The review remains open; export it to keep a copy.", "error", { sticky: true });
        throw error;
      })
      .finally(() => {
        window.setTimeout(() => ownMutationIds.delete(id), 2000);
      });

    return writeChain;
  }

  function textEntry(term, value) {
    if (value == null || value === "") return null;
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = String(value);
    return [dt, dd];
  }

  function appendTargetEvidence(list, annotation) {
    const target = annotation.target || {};
    const entries = [
      textEntry("Element", [target.role, target.name].filter(Boolean).join(" · ") || target.tag),
      textEntry("Text", target.text),
      textEntry("Selector", target.selector),
      textEntry("Element ID", target.id),
      textEntry("Test ID", target.testId),
      textEntry("Page", annotation.url)
    ].filter(Boolean);

    if (entries.length === 0) {
      const empty = document.createElement("dd");
      empty.textContent = "No technical target evidence captured.";
      empty.style.gridColumn = "1 / -1";
      list.append(empty);
      return;
    }

    for (const entry of entries) list.append(...entry);
  }

  function renderAnnotations() {
    const count = review.annotations.length;
    elements.annotationCount.textContent = annotationLabel(count);
    elements.annotationSummary.textContent = String(count);
    elements.emptyState.hidden = count > 0;
    elements.annotationGroups.replaceChildren();
    elements.exportButton.disabled = count === 0 && !preservedCandidate;
    elements.exportButton.textContent = preservedCandidate ? "Export original data" : "Export review";
    updateShareActions();

    const groups = shared.groupAnnotationsByPath(review);
    let annotationIndex = 0;

    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "route-group";
      section.setAttribute("aria-label", `Annotations for ${group.path || "/"}`);

      const heading = document.createElement("div");
      heading.className = "route-heading";
      const path = document.createElement("span");
      path.className = "route-path";
      path.textContent = group.path || "/";
      path.title = group.url || group.path || "/";
      const groupCount = document.createElement("span");
      groupCount.className = "route-count";
      groupCount.textContent = annotationLabel(group.annotations.length);
      heading.append(path, groupCount);

      const items = document.createElement("div");
      items.className = "route-items";

      for (const annotation of group.annotations) {
        annotationIndex += 1;
        const fragment = elements.annotationTemplate.content.cloneNode(true);
        const card = fragment.querySelector(".annotation-card");
        const label = fragment.querySelector(".annotation-number");
        const input = fragment.querySelector(".instruction-input");
        const locateButton = fragment.querySelector(".locate-button");
        const removeButton = fragment.querySelector(".remove-button");
        const targetList = fragment.querySelector(".target-list");

        card.dataset.annotationId = annotation.id;
        label.textContent = `Annotation ${annotationIndex}`;
        input.value = annotation.instruction;
        input.id = `instruction-${annotation.id}`;
        fragment.querySelector(".annotation-label").htmlFor = input.id;
        locateButton.dataset.annotationId = annotation.id;
        locateButton.setAttribute("aria-label", `Locate annotation ${annotationIndex} on the page`);
        locateButton.disabled = !connected;
        removeButton.dataset.annotationId = annotation.id;
        removeButton.setAttribute("aria-label", `Remove annotation ${annotationIndex}`);
        appendTargetEvidence(targetList, annotation);
        items.append(fragment);
      }

      section.append(heading, items);
      elements.annotationGroups.append(section);
    }
  }

  function updateShareActions() {
    if (!review) return;
    const count = review.annotations.length;
    const agentReady = count > 0 && review.intent === "agent";
    elements.copyButton.disabled = !agentReady;
    elements.copyHelp.hidden = agentReady || count === 0;
    elements.copyHelp.textContent = review.intent === "designer"
      ? "This review is marked to return to the designer, so agent handoff is disabled."
      : "Choose Fix with agent to enable agent handoff.";
  }

  function renderReview({ preserveEditing = false } = {}) {
    const active = preserveEditing ? document.activeElement : null;
    const editing = active === elements.title
      ? { type: "title", value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : active?.matches?.(".instruction-input")
        ? {
            type: "annotation",
            id: active.closest(".annotation-card")?.dataset.annotationId,
            value: active.value,
            start: active.selectionStart,
            end: active.selectionEnd
          }
        : null;

    elements.title.value = review.title;
    elements.intent.value = review.intent;
    renderAnnotations();

    if (!editing) return;
    const control = editing.type === "title"
      ? elements.title
      : elements.annotationGroups.querySelector(
          `[data-annotation-id="${CSS.escape(editing.id || "")}"] .instruction-input`
        );
    if (!control) return;
    control.value = editing.value;
    control.focus();
    control.setSelectionRange(editing.start, editing.end);
  }

  function supportedTab(tab) {
    if (!tab?.id || !tab.url) return false;
    try {
      return SUPPORTED_PROTOCOLS.has(new URL(tab.url).protocol);
    } catch {
      return false;
    }
  }

  function displayTabLocation(tab) {
    if (!tab?.url) return "";
    try {
      const url = new URL(tab.url);
      return `${url.host}${url.pathname}`;
    } catch {
      return tab.url;
    }
  }

  function renderConnection(state, message, tab = activeTab) {
    connected = state === "connected";
    elements.connection.dataset.state = state;
    elements.connectionStatus.textContent = message;
    elements.connectionLocation.textContent = displayTabLocation(tab);
    elements.connectionLocation.title = tab?.url || "";
    elements.annotateButton.disabled = !connected;
    elements.captureHelp.textContent = connected
      ? "Draw one frame on the page. Redline returns to browsing after the note is added."
      : "Open a normal web page, then start Redline from the toolbar.";

    for (const button of elements.annotationGroups.querySelectorAll(".locate-button")) {
      button.disabled = !connected;
    }
  }

  async function sendToActiveTab(type, payload = {}) {
    if (!activeTab?.id || !connected) {
      throw new Error("No supported page is connected.");
    }
    return chrome.tabs.sendMessage(activeTab.id, { type, ...payload });
  }

  async function connectToActiveTab() {
    renderConnection("loading", "Connecting to this tab…");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;

    if (!supportedTab(activeTab)) {
      renderConnection("error", "This browser page cannot be annotated.");
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(activeTab.id, { type: "redline:ping" });
      if (response?.ok === false) throw new Error(response.error || "Redline did not connect.");
      renderConnection("connected", "Connected to this tab");
    } catch (error) {
      console.warn("Redline content script is unavailable.", error);
      try {
        const connection = await chrome.runtime.sendMessage({
          type: "redline:connect-tab",
          tabId: activeTab.id
        });
        if (!connection?.ok) throw new Error(connection?.error || "Redline could not connect.");
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: "redline:ping" });
        if (response?.ok === false) throw new Error(response.error || "Redline did not connect.");
        renderConnection("connected", "Connected to this tab");
      } catch (connectionError) {
        console.warn("Redline could not activate on this tab.", connectionError);
        renderConnection("error", connectionError.message || "Redline is not active on this tab.");
      }
    }
  }

  async function refreshPageOverlay() {
    if (!connected) return;
    try {
      await sendToActiveTab("redline:refresh", { review });
    } catch (error) {
      console.warn("Redline could not refresh the page overlay.", error);
      renderConnection("error", "Connection to this tab was lost.");
    }
  }

  async function startAnnotation() {
    try {
      const response = await sendToActiveTab("redline:annotate", { reviewId: review.id });
      if (response?.ok === false) throw new Error(response.error || "Annotation could not start.");
      setStatus("Draw around the issue on the page.", "success");
    } catch (error) {
      console.error("Redline could not start annotation.", error);
      setStatus("Could not start annotation. Start Redline again from the page toolbar.", "error", { sticky: true });
      await connectToActiveTab();
    }
  }

  async function locateAnnotation(annotationId) {
    const annotation = review.annotations.find((item) => item.id === annotationId);
    if (!annotation) return;

    try {
      const response = await sendToActiveTab("redline:locate", { id: annotation.id });
      if (response?.ok === false) throw new Error(response.error || "Annotation could not be located.");
      setStatus("Annotation highlighted on the page.", "success");
    } catch (error) {
      console.error("Redline could not locate the annotation.", error);
      const activePath = (() => {
        try {
          const url = new URL(activeTab.url);
          return `${url.pathname}${url.search}${url.hash}`;
        } catch {
          return "";
        }
      })();
      const message = activePath !== annotation.path
        ? `Open ${annotation.path} in the connected tab, then try Locate again.`
        : "Could not locate this annotation on the current page.";
      setStatus(message, "error", { sticky: true });
    }
  }

  function updateAnnotationText(annotationId, instruction) {
    mutateReview("update-annotation", {
      annotationId,
      patch: { instruction }
    }).then(refreshPageOverlay).catch((error) => {
      console.error("Redline could not update the annotation.", error);
      setStatus("Could not update this annotation. Its previous text remains saved.", "error", { sticky: true });
    });
  }

  function removeAnnotation(annotationId) {
    const card = elements.annotationGroups.querySelector(`[data-annotation-id="${CSS.escape(annotationId)}"]`);
    mutateReview(
      "remove-annotation",
      { annotationId },
      "Annotation removed",
      { render: true }
    ).then(async () => {
      await refreshPageOverlay();
      const nextControl = elements.annotationGroups.querySelector("textarea, button") || elements.annotateButton;
      nextControl.focus();
    }).catch((error) => {
      console.error("Redline could not remove the annotation.", error);
      card?.querySelector(".remove-button")?.focus();
      setStatus("Could not remove this annotation.", "error", { sticky: true });
    });
  }

  function safeFileName(title) {
    const normalized = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${normalized || "design-review"}.redline.json`;
  }

  function exportReview() {
    try {
      const content = preservedCandidate
        ? JSON.stringify(preservedCandidate, null, 2)
        : shared.serializeReview(review, 2);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = preservedCandidate
        ? `${safeFileName(review.title).replace(/\.redline\.json$/, "")}.recovery.json`
        : safeFileName(review.title);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(preservedCandidate ? "Original data download prepared." : "Review download prepared.", "success");
    } catch (error) {
      console.error("Redline could not export the review.", error);
      setStatus("Could not prepare the review download. Your local review is unchanged.", "error", { sticky: true });
    }
  }

  async function importReview(file) {
    try {
      const input = JSON.parse(await file.text());
      const importedReview = shared.normalizeReview(input);
      if (review.annotations.length > 0 || preservedCandidate) {
        const confirmed = window.confirm(
          "Replace the current review with this file? Export the current review first if you want to keep a shareable copy."
        );
        if (!confirmed) return;
      }
      await mutateReview(
        "replace",
        { review: importedReview },
        "Review imported",
        { clearRecovery: true, render: true }
      );
      await refreshPageOverlay();
    } catch (error) {
      console.error("Redline could not import the selected file.", error);
      setStatus("This file is not a compatible Redline review. Your current review is unchanged.", "error", { sticky: true });
    } finally {
      elements.importInput.value = "";
    }
  }

  async function copyForAgent() {
    try {
      const prompt = shared.buildAgentPrompt(review);
      await navigator.clipboard.writeText(prompt);
      setStatus("Agent handoff copied.", "success");
    } catch (error) {
      console.error("Redline could not copy the agent handoff.", error);
      setStatus("Could not copy. Export the review and give the file to the agent instead.", "error", { sticky: true });
    }
  }

  async function startNewReview() {
    if (review.annotations.length > 0 || preservedCandidate) {
      const confirmed = window.confirm(
        "Start a new review? Export this review first if you want to keep a shareable copy."
      );
      if (!confirmed) return;
    }

    const nextReview = createReview();
    try {
      await mutateReview(
        "replace",
        { review: nextReview },
        "New review started",
        { clearRecovery: true, render: true }
      );
      await refreshPageOverlay();
      elements.title.focus();
      elements.title.select();
    } catch {
      // mutateReview() already reports the storage failure and preserves the open review.
    }
  }

  function bindEvents() {
    elements.annotateButton.addEventListener("click", startAnnotation);
    elements.importButton.addEventListener("click", () => elements.importInput.click());
    elements.exportButton.addEventListener("click", exportReview);
    elements.copyButton.addEventListener("click", copyForAgent);
    elements.newReviewButton.addEventListener("click", startNewReview);

    elements.importInput.addEventListener("change", () => {
      const [file] = elements.importInput.files;
      if (file) importReview(file);
    });

    elements.title.addEventListener("input", () => {
      const title = elements.title.value.slice(0, 120);
      if (!title.trim()) {
        setStatus("Review title cannot be empty. The previous title remains saved.", "error", { sticky: true });
        return;
      }
      mutateReview("patch-review", {
        patch: { title, updatedAt: new Date().toISOString() }
      }).catch(() => undefined);
    });

    elements.title.addEventListener("blur", () => {
      if (!elements.title.value.trim()) elements.title.value = review.title;
    });

    elements.intent.addEventListener("change", () => {
      review = { ...review, intent: elements.intent.value };
      updateShareActions();
      mutateReview("patch-review", {
        patch: {
          intent: elements.intent.value,
          updatedAt: new Date().toISOString()
        }
      }, "Handoff updated").catch(() => undefined);
    });

    elements.annotationGroups.addEventListener("input", (event) => {
      if (!event.target.matches(".instruction-input")) return;
      const card = event.target.closest(".annotation-card");
      if (!event.target.value.trim()) {
        event.target.setAttribute("aria-invalid", "true");
        setStatus("An annotation note cannot be empty. Add text or Remove it.", "error", { sticky: true });
        return;
      }
      event.target.removeAttribute("aria-invalid");
      updateAnnotationText(card.dataset.annotationId, event.target.value);
    });

    elements.annotationGroups.addEventListener("focusout", (event) => {
      if (!event.target.matches(".instruction-input") || event.target.value.trim()) return;
      const card = event.target.closest(".annotation-card");
      const annotation = review.annotations.find((item) => item.id === card.dataset.annotationId);
      event.target.value = annotation?.instruction || "";
      event.target.removeAttribute("aria-invalid");
    });

    elements.annotationGroups.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.matches(".locate-button")) locateAnnotation(button.dataset.annotationId);
      if (button.matches(".remove-button")) removeAnnotation(button.dataset.annotationId);
    });

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) return;
      if (event.key.toLowerCase() === "r" && connected) {
        event.preventDefault();
        startAnnotation();
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "redline:review-committed") {
        if (ownMutationIds.has(message.mutationId)) return;
        try {
          review = shared.normalizeReview(message.review);
          renderReview({ preserveEditing: true });
          setStatus("Review updated from the page.", "success");
        } catch (error) {
          console.error("Redline ignored an invalid review update.", error);
          setStatus("An invalid review update was ignored. Your open review is unchanged.", "error", { sticky: true });
        }
        return;
      }

      if (message?.type !== "redline:tab-status" || message.status?.tabId !== activeTab?.id) return;
      const { state, message: statusMessage } = message.status;
      if (state === "connected") {
        window.setTimeout(connectToActiveTab, 80);
      } else {
        renderConnection(state === "connecting" ? "loading" : "error", statusMessage || "Redline could not connect.");
      }
    });

    chrome.tabs.onActivated.addListener(connectToActiveTab);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId === activeTab?.id && (changeInfo.status === "complete" || changeInfo.url)) {
        window.setTimeout(connectToActiveTab, 120);
      }
    });
  }

  async function initialize() {
    bindEvents();

    try {
      review = await readStoredReview();
      renderReview();
      if (!(await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]) {
        await mutateReview("replace", { review });
      }
    } catch (error) {
      console.error("Redline could not initialize local storage.", error);
      review = createReview("Unsaved review");
      renderReview();
      setStatus("Local storage is unavailable. You can still export the review.", "error", { sticky: true });
    }

    try {
      await connectToActiveTab();
      if (activeTab?.id && !connected) {
        const key = `${TAB_STATUS_PREFIX}${activeTab.id}`;
        const storedStatus = await chrome.storage.session.get(key);
        const status = storedStatus[key];
        if (status?.state === "connecting") {
          renderConnection("loading", status.message || "Connecting to this tab…");
        } else if (status?.state === "error") {
          renderConnection("error", status.message || "Redline could not connect.");
        } else if (status?.state === "connected") {
          window.setTimeout(connectToActiveTab, 80);
        }
      }
    } catch (error) {
      console.error("Redline could not inspect the active tab.", error);
      renderConnection("error", "Could not inspect the active tab.");
    }
  }

  initialize();
})();
