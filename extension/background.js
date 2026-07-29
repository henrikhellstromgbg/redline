importScripts("shared.js");

const STATUS_KEY_PREFIX = "redline:tab-status:";
const PANEL_PATH = "sidepanel.html";
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const RESTRICTED_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);
const Shared = globalThis.RedlineShared;
let reviewMutationChain = Promise.resolve();

async function currentReview(fallbackReview) {
  const stored = await chrome.storage.local.get([Shared.STORAGE_KEY, Shared.RECOVERY_KEY]);
  const candidate = stored[Shared.STORAGE_KEY];
  if (!candidate) {
    return fallbackReview ? Shared.normalizeReview(fallbackReview) : Shared.createReview();
  }

  try {
    return Shared.normalizeReview(candidate);
  } catch (error) {
    await chrome.storage.local.set({ [Shared.RECOVERY_KEY]: candidate });
    if (fallbackReview) return Shared.normalizeReview(fallbackReview);
    throw error;
  }
}

function mutateStoredReview(request) {
  const operation = async () => {
    let nextReview;
    if (request.operation === "replace") {
      nextReview = Shared.normalizeReview(request.review);
    } else {
      const review = await currentReview(request.fallbackReview);
      switch (request.operation) {
        case "append":
          nextReview = Shared.addAnnotation(review, request.annotation);
          break;
        case "update-annotation":
          nextReview = Shared.updateAnnotation(review, request.annotationId, request.patch);
          break;
        case "remove-annotation":
          nextReview = Shared.removeAnnotation(review, request.annotationId);
          break;
        case "patch-review":
          nextReview = Shared.normalizeReview({
            ...review,
            ...(Object.hasOwn(request.patch || {}, "title") ? { title: request.patch.title } : {}),
            ...(Object.hasOwn(request.patch || {}, "intent") ? { intent: request.patch.intent } : {}),
            updatedAt: request.patch?.updatedAt || new Date().toISOString()
          });
          break;
        default:
          throw new Error(`Unsupported review mutation: ${String(request.operation)}`);
      }
    }

    await chrome.storage.local.set({ [Shared.STORAGE_KEY]: nextReview });
    if (request.clearRecovery) await chrome.storage.local.remove(Shared.RECOVERY_KEY);

    chrome.runtime.sendMessage({
      type: "redline:review-committed",
      mutationId: request.mutationId || null,
      review: nextReview
    }).catch(() => {});
    return nextReview;
  };

  const result = reviewMutationChain.then(operation);
  reviewMutationChain = result.catch(() => undefined);
  return result;
}

function statusKey(tabId) {
  return `${STATUS_KEY_PREFIX}${tabId}`;
}

function pageRestriction(urlString) {
  if (!urlString) {
    // Chrome may withhold the URL from a side-panel initiated connection even
    // after an action click. Let scripting.executeScript enforce access instead.
    return null;
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    return "Redline cannot access this tab. Open a regular web page and try again.";
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    return "Redline cannot annotate browser or extension pages. Open a regular web page and try again.";
  }

  if (RESTRICTED_HOSTS.has(url.hostname)) {
    return "Chrome does not allow Redline to annotate the Chrome Web Store. Open the product page you want to review.";
  }

  return null;
}

async function publishStatus(tabId, state, message) {
  const status = {
    state,
    message,
    tabId,
    updatedAt: new Date().toISOString(),
  };

  try {
    await chrome.storage.session.set({ [statusKey(tabId)]: status });
  } catch (error) {
    console.debug("Redline could not persist the tab connection status.", error);
  }

  const isError = state === "error";
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: isError ? "!" : "" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b42318" }),
    chrome.action.setTitle({
      tabId,
      title: isError ? `Redline: ${message}` : "Open Redline",
    }),
  ]);

  chrome.runtime
    .sendMessage({ type: "redline:tab-status", status })
    .catch(() => {
      // The side panel may not have finished opening yet. It can read the
      // latest value from chrome.storage.session when it is ready.
    });
}

function explainInjectionFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);

  if (/file:\/\//i.test(detail)) {
    return "Redline needs file access for this local page. Enable file URL access for the extension, then try again.";
  }

  if (/chrome:\/\/|edge:\/\/|about:|extension page|extensions gallery|cannot access contents/i.test(detail)) {
    return "Redline cannot annotate browser or extension pages. Open a regular web page and try again.";
  }

  return "Redline could not connect to this page. Reload the page and try again; your existing review is still safe.";
}

async function connectToTab(tab) {
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return { ok: false, error: "Redline could not identify this tab." };
  }

  await chrome.sidePanel.setOptions({
    tabId,
    path: PANEL_PATH,
    enabled: true,
  });

  const restriction = pageRestriction(tab.url);
  if (restriction) {
    await publishStatus(tabId, "error", restriction);
    return { ok: false, error: restriction };
  }

  await publishStatus(tabId, "connecting", "Connecting to this tab…");

  try {
    // Files in one executeScript call run in order. The content script owns
    // singleton detection, so another click safely reconnects the same tab.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js", "targeting.js", "content.js"],
    });

    await publishStatus(tabId, "connected", "Redline is connected.");
    return { ok: true };
  } catch (error) {
    console.debug("Redline could not inject the page overlay.", error);
    const message = explainInjectionFailure(error);
    await publishStatus(tabId, "error", message);
    return { ok: false, error: message };
  }
}

async function configureSidePanel() {
  // Keep the action click available to this service worker. It opens the panel
  // explicitly below so the same user gesture also grants activeTab access.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(console.debug);
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(console.debug);
});

// Service workers may restart independently of install/startup events.
configureSidePanel().catch(console.debug);

function openRedlineForTab(tab) {
  if (typeof tab.id !== "number") return;
  const opening = chrome.sidePanel.open({ tabId: tab.id }).catch(async (error) => {
    const message = explainInjectionFailure(error);
    await publishStatus(tab.id, "error", message);
    return { ok: false, error: message };
  });
  const connecting = connectToTab(tab).catch(async (error) => {
    const message = explainInjectionFailure(error);
    await publishStatus(tab.id, "error", message);
    return { ok: false, error: message };
  });
  return Promise.all([opening, connecting]);
}

chrome.action.onClicked.addListener(openRedlineForTab);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "redline:connect-tab") {
    if (sender.url !== chrome.runtime.getURL(PANEL_PATH)) {
      sendResponse({ ok: false, error: "Only the Redline panel can connect a tab." });
      return false;
    }
    chrome.tabs.get(message.tabId)
      .then(connectToTab)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: explainInjectionFailure(error) }));
    return true;
  }

  if (message?.type !== "redline:mutate-review") return false;
  mutateStoredReview(message)
    .then((review) => sendResponse({ ok: true, review }))
    .catch((error) => {
      console.debug("Redline could not apply a review mutation.", error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(statusKey(tabId)).catch(() => {});
});
