/* redline — design-QA overlay for agent coding.
 * Self-contained vanilla JS IIFE. No dependencies, no build step.
 * Inject into any tab via Chrome MCP javascript_tool or paste into DevTools.
 * Idempotent: re-running reuses the existing instance instead of duplicating.
 *
 * v0.5: multi-view review (version 2 queue), testid-anchored selectors,
 * leaf-element capture, edit/remove with ghost frame, reopen after finish,
 * one-paste agent handoff prompt.
 */
(function () {
  "use strict";

  var ROOT_ID = "rl-root";
  var STORAGE_KEY = "redline.queue";
  var PALETTE = ["#e11d48", "#7c3aed", "#059669", "#d97706", "#2563eb"];

  // Idempotency: if a live (unfinished) instance already owns the page, reuse
  // it. A finished instance is torn down below and rebuilt so a new review can
  // start after Finish.
  if (window.__redline && !window.__redline.finished && document.getElementById(ROOT_ID)) {
    try {
      window.__redline.show();
    } catch (e) {}
    console.log("[redline] already active, reusing instance");
    return window.__redline;
  }
  // Stale reference but no root in DOM: clear it and rebuild.
  if (window.__redline) {
    try {
      window.__redline.teardown();
    } catch (e) {}
  }

  // ---- state -------------------------------------------------------------
  var marks = []; // current-view marks: { id, color, instruction, rect, pageRect, scroll, elements, frameEl, badgeEl }
  var views = []; // archived views: { url, title, savedAt, viewport, items }
  var createdAt = null;
  var nextId = 1;
  var mode = "draw"; // "draw" | "browse"
  var finished = false;
  var currentViewUrl = null; // URL where the current view's marks were made
  var currentViewTitle = null;
  var lastUrl = location.href;
  var urlTimer = null;

  function nowISO() {
    return new Date().toISOString();
  }

  function readQueue() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Resume: if a version 2 queue already exists, continue on it.
  var boot = readQueue();
  if (boot && boot.version === 2 && Array.isArray(boot.views)) {
    views = boot.views.slice();
    createdAt = boot.createdAt || nowISO();
  } else {
    createdAt = nowISO();
  }

  // ---- root + styles -----------------------------------------------------
  var rootEl = document.createElement("div");
  rootEl.id = ROOT_ID;

  var styleEl = document.createElement("style");
  styleEl.textContent = [
    "#rl-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
    "color:#111;}",
    "#rl-root *{box-sizing:border-box;}",
    ".rl-draw-layer{position:fixed;inset:0;pointer-events:none;cursor:crosshair;}",
    "#rl-root.rl-mode-draw .rl-draw-layer{pointer-events:auto;}",
    ".rl-marks{position:fixed;inset:0;pointer-events:none;}",
    ".rl-frame{position:absolute;border:2px solid #e11d48;border-radius:0;pointer-events:none;",
    "box-shadow:0 0 0 1px rgba(255,255,255,.6);transition:box-shadow .15s;}",
    ".rl-frame.rl-blink{box-shadow:0 0 0 4px rgba(255,255,255,.9),0 0 0 8px currentColor;}",
    ".rl-ghost{position:absolute;border:2px dashed;border-radius:0;pointer-events:none;",
    "box-shadow:0 0 0 1px rgba(255,255,255,.6);}",
    ".rl-badge{position:absolute;top:-2px;left:-2px;min-width:20px;height:20px;line-height:20px;",
    "padding:0 5px;border-radius:0;color:#fff;font-size:14px;font-weight:700;text-align:center;",
    "font-family:inherit;cursor:pointer;pointer-events:auto;}",
    ".rl-drag{position:fixed;border:2px dashed #e11d48;border-radius:0;background:rgba(225,29,72,.08);",
    "pointer-events:none;}",
    ".rl-toolbar{position:fixed;right:16px;bottom:16px;pointer-events:auto;background:#fff;",
    "border:1px solid #d4d4d8;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.18);",
    "display:flex;align-items:center;gap:6px;padding:6px;font-size:14px;}",
    ".rl-btn{font-size:14px;font-family:inherit;line-height:1;padding:8px 12px;border-radius:6px;",
    "border:1px solid #d4d4d8;background:#fafafa;color:#18181b;cursor:pointer;}",
    ".rl-btn:hover{background:#f1f1f4;}",
    ".rl-btn.rl-active{background:#18181b;color:#fff;border-color:#18181b;}",
    ".rl-btn-finish{background:#059669;color:#fff;border-color:#059669;}",
    ".rl-btn-finish:hover{background:#047857;}",
    ".rl-count{font-size:14px;padding:8px 10px;cursor:pointer;color:#3f3f46;border-radius:6px;",
    "user-select:none;white-space:nowrap;}",
    ".rl-count:hover{background:#f1f1f4;}",
    ".rl-popover{position:fixed;pointer-events:auto;background:#fff;border:1px solid #d4d4d8;",
    "border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.2);padding:10px;width:280px;}",
    ".rl-popover textarea{width:100%;min-height:56px;resize:vertical;font-size:14px;",
    "font-family:inherit;padding:8px;border:1px solid #d4d4d8;border-radius:6px;color:#111;}",
    ".rl-popover textarea:focus{outline:2px solid #2563eb;outline-offset:0;}",
    ".rl-hint{font-size:14px;color:#71717a;margin-top:6px;}",
    ".rl-context{font-size:14px;color:#71717a;margin-bottom:6px;}",
    ".rl-panel{position:fixed;right:16px;bottom:70px;pointer-events:auto;background:#fff;",
    "border:1px solid #d4d4d8;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.18);",
    "width:320px;max-height:50vh;overflow:auto;padding:6px;}",
    ".rl-row{display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;font-size:14px;",
    "cursor:pointer;}",
    ".rl-row:hover{background:#f4f4f5;}",
    ".rl-dot{width:14px;height:14px;flex:0 0 14px;border-radius:0;}",
    ".rl-row-text{flex:1;color:#27272a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rl-del{font-size:14px;border:none;background:transparent;color:#a1a1aa;cursor:pointer;",
    "padding:2px 6px;border-radius:6px;}",
    ".rl-del:hover{color:#e11d48;background:#fef2f2;}",
    ".rl-edit{font-size:14px;border:none;background:transparent;color:#3f3f46;cursor:pointer;",
    "padding:2px 6px;border-radius:6px;}",
    ".rl-edit:hover{color:#2563eb;background:#eef2ff;}",
    ".rl-vsection{border-top:1px solid #ececef;margin-top:6px;padding-top:6px;}",
    ".rl-vhead{display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;font-size:14px;",
    "cursor:pointer;color:#3f3f46;user-select:none;}",
    ".rl-vhead:hover{background:#f4f4f5;}",
    ".rl-caret{width:12px;flex:0 0 12px;color:#a1a1aa;font-size:14px;}",
    ".rl-vtitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rl-vcount{color:#a1a1aa;font-size:14px;white-space:nowrap;}",
    ".rl-toast{position:fixed;right:16px;bottom:16px;pointer-events:auto;background:#18181b;",
    "color:#fafafa;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.3);padding:12px 14px;",
    "font-size:14px;display:flex;align-items:center;gap:10px;}",
    ".rl-toast .rl-btn{background:#fafafa;color:#18181b;}",
    ".rl-empty{font-size:14px;color:#71717a;padding:10px;}"
  ].join("");

  var drawLayer = document.createElement("div");
  drawLayer.className = "rl-draw-layer";

  var marksLayer = document.createElement("div");
  marksLayer.className = "rl-marks";

  var toolbar = document.createElement("div");
  toolbar.className = "rl-toolbar";

  var btnMark = mkBtn("Mark", "rl-btn");
  var btnBrowse = mkBtn("Browse", "rl-btn");
  var countEl = document.createElement("div");
  countEl.className = "rl-count";
  var btnSaveView = mkBtn("Save view", "rl-btn");
  var btnFinish = mkBtn("Finish", "rl-btn rl-btn-finish");

  toolbar.appendChild(btnMark);
  toolbar.appendChild(btnBrowse);
  toolbar.appendChild(countEl);
  toolbar.appendChild(btnSaveView);
  toolbar.appendChild(btnFinish);

  rootEl.appendChild(styleEl);
  rootEl.appendChild(drawLayer);
  rootEl.appendChild(marksLayer);
  rootEl.appendChild(toolbar);
  document.documentElement.appendChild(rootEl);

  var panelEl = null;
  var popoverEl = null;
  var expandedViews = new WeakSet(); // saved-view sections expanded in the panel
  var ghostEl = null; // temporary dashed frame shown while editing a saved item

  // ---- helpers -----------------------------------------------------------
  function mkBtn(label, cls) {
    var b = document.createElement("button");
    b.className = cls;
    b.type = "button";
    b.textContent = label;
    return b;
  }

  function colorFor(i) {
    return PALETTE[i % PALETTE.length];
  }

  function viewportNow() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  }

  function setMode(m) {
    if (finished) return;
    mode = m;
    rootEl.classList.toggle("rl-mode-draw", m === "draw");
    rootEl.classList.toggle("rl-mode-browse", m === "browse");
    btnMark.classList.toggle("rl-active", m === "draw");
    btnBrowse.classList.toggle("rl-active", m === "browse");
  }

  function savedMarkCount() {
    var n = 0;
    for (var i = 0; i < views.length; i++) n += views[i].items.length;
    return n;
  }

  function renderCount() {
    var savedViews = views.length;
    var cur = marks.length;
    if (savedViews === 0) {
      countEl.textContent = cur === 1 ? "1 mark" : cur + " marks";
    } else {
      var total = savedMarkCount() + cur;
      countEl.textContent =
        savedViews +
        (savedViews === 1 ? " view, " : " views, ") +
        total +
        (total === 1 ? " mark" : " marks");
    }
  }

  // ---- selector generation ----------------------------------------------
  function isHashy(cls) {
    if (!cls) return true;
    if (/^rl-/.test(cls)) return true; // our own classes
    if (/^_/.test(cls)) return true; // CSS-module leading underscore
    if (/[A-Za-z]+_[A-Za-z0-9]{4,}/.test(cls)) return true; // btn_1a2b3 module hash
    if (/^[a-f0-9]{6,}$/i.test(cls) && /[0-9]/.test(cls)) return true; // bare hash token
    return false;
  }

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }

  function unique(sel, el) {
    try {
      var list = document.querySelectorAll(sel);
      return list.length === 1 && list[0] === el;
    } catch (e) {
      return false;
    }
  }

  function stableClasses(el) {
    var out = [];
    var cl = el.classList ? Array.prototype.slice.call(el.classList) : [];
    for (var i = 0; i < cl.length; i++) {
      if (!isHashy(cl[i])) out.push(cl[i]);
    }
    return out;
  }

  function nthIndex(node) {
    var idx = 1;
    var sib = node;
    while ((sib = sib.previousElementSibling)) idx++;
    return idx;
  }

  // Anchor selector for a single node: stable id or data-testid/data-test.
  function anchorSelectorFor(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.id && !isHashy(node.id)) return "#" + cssEsc(node.id);
    if (node.getAttribute) {
      var tid = node.getAttribute("data-testid");
      if (tid) return '[data-testid="' + tid + '"]';
      var td = node.getAttribute("data-test");
      if (td) return '[data-test="' + td + '"]';
    }
    return null;
  }

  // v0.2: short nth-child chain anchored on the nearest ancestor (<=10 levels)
  // carrying a data-testid/data-test/stable id.
  function testidAnchoredPath(el) {
    var chain = [];
    var node = el;
    for (var levels = 0; node && node.nodeType === 1 && levels <= 10; levels++) {
      var parent = node.parentElement;
      if (!parent) break;
      chain.unshift(node.tagName.toLowerCase() + ":nth-child(" + nthIndex(node) + ")");
      var anchor = anchorSelectorFor(parent);
      if (anchor) {
        return anchor + " > " + chain.join(" > ");
      }
      node = parent;
    }
    return null;
  }

  // Root fallback: nth-child chain up to nearest ancestor with a stable id.
  function nthChildPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id && !isHashy(node.id)) {
        parts.unshift("#" + cssEsc(node.id));
        break;
      }
      var parent = node.parentNode;
      if (parent) {
        parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + nthIndex(node) + ")");
      } else {
        parts.unshift(node.tagName.toLowerCase());
      }
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function buildSelector(el) {
    var tag = el.tagName.toLowerCase();
    // 1) id
    if (el.id && !isHashy(el.id)) {
      var s = "#" + cssEsc(el.id);
      if (unique(s, el)) return s;
    }
    // 2) data-testid / data-test on the element itself
    var tid = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (tid) {
      var attr = el.getAttribute("data-testid") ? "data-testid" : "data-test";
      var st = "[" + attr + '="' + tid + '"]';
      if (unique(st, el)) return st;
      var st2 = tag + st;
      if (unique(st2, el)) return st2;
    }
    // 3) tag + stable classes (shortest unique)
    var classes = stableClasses(el);
    if (classes.length) {
      for (var k = 1; k <= classes.length; k++) {
        var combo = tag + "." + classes.slice(0, k).map(cssEsc).join(".");
        if (unique(combo, el)) return combo;
      }
      var all = tag + "." + classes.map(cssEsc).join(".");
      if (unique(all, el)) return all;
    }
    // 4) testid-anchored short chain (v0.2)
    var anchored = testidAnchoredPath(el);
    if (anchored && unique(anchored, el)) return anchored;
    // 5) nth-child chain from nearest id ancestor (root fallback)
    var path = nthChildPath(el);
    if (path && unique(path, el)) return path;
    return path || tag;
  }

  // ---- computed styles ---------------------------------------------------
  function pickStyles(el) {
    var cs = getComputedStyle(el);
    return {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      display: cs.display,
      gap: cs.gap,
      textTransform: cs.textTransform,
      border: cs.border
    };
  }

  // ---- react fiber -------------------------------------------------------
  function reactInfo(el) {
    try {
      var key = null;
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        if (
          keys[i].indexOf("__reactFiber$") === 0 ||
          keys[i].indexOf("__reactInternalInstance$") === 0
        ) {
          key = keys[i];
          break;
        }
      }
      if (!key) return null;
      var node = el[key];
      var names = [];
      var source = null;
      var guard = 0;
      while (node && guard++ < 300) {
        var t = node.type;
        if (t) {
          var n = null;
          if (typeof t === "function") n = t.displayName || t.name;
          else if (typeof t === "object") n = t.displayName || t.name;
          if (n && names.indexOf(n) === -1 && names.length < 3) names.push(n);
        }
        if (!source && node._debugSource) {
          source = {
            fileName: node._debugSource.fileName,
            lineNumber: node._debugSource.lineNumber
          };
        }
        if (names.length >= 3 && source) break;
        node = node.return;
      }
      if (names.length === 0 && !source) return null;
      return { components: names.slice(0, 3), source: source };
    } catch (e) {
      return null;
    }
  }

  // ---- element capture ---------------------------------------------------
  function describe(el, overlap, rectArea) {
    var r = el.getBoundingClientRect();
    var ea = r.width * r.height;
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
      overlap: Math.round(overlap * 100) / 100,
      role: ea < rectArea ? "leaf" : "container",
      styles: pickStyles(el),
      react: reactInfo(el)
    };
  }

  function lca(a, b) {
    var ap = [];
    var n = a;
    while (n) {
      ap.push(n);
      n = n.parentElement;
    }
    n = b;
    while (n) {
      if (ap.indexOf(n) !== -1) return n;
      n = n.parentElement;
    }
    return document.body;
  }

  function commonAncestor(els) {
    if (!els.length) return document.body;
    var anc = els[0];
    for (var i = 1; i < els.length; i++) {
      anc = lca(anc, els[i]);
      if (!anc) return document.body;
    }
    return anc || document.body;
  }

  function intersects(r, rect) {
    var ix = Math.max(0, Math.min(rect.x + rect.w, r.right) - Math.max(rect.x, r.left));
    var iy = Math.max(0, Math.min(rect.y + rect.h, r.bottom) - Math.max(rect.y, r.top));
    return ix * iy;
  }

  function captureElements(rect) {
    var fx = [0.15, 0.5, 0.85];
    var fy = [0.15, 0.5, 0.85];
    var pts = [];
    for (var a = 0; a < fx.length; a++) {
      for (var b = 0; b < fy.length; b++) {
        pts.push([rect.x + rect.w * fx[a], rect.y + rect.h * fy[b]]);
      }
    }
    pts.push([rect.x + rect.w / 2, rect.y + rect.h / 2]);

    // Hide overlay so elementsFromPoint reaches page elements only.
    var prevDisplay = rootEl.style.display;
    rootEl.style.display = "none";
    var seen = new Set();
    var candidates = [];
    var topHits = [];
    for (var p = 0; p < pts.length; p++) {
      var found = document.elementsFromPoint(pts[p][0], pts[p][1]);
      // topmost non-overlay hit at this point -> container-anchor sampling
      for (var g = 0; g < found.length; g++) {
        if (!rootEl.contains(found[g])) {
          topHits.push(found[g]);
          break;
        }
      }
      for (var f = 0; f < found.length; f++) {
        if (!seen.has(found[f])) {
          seen.add(found[f]);
          candidates.push(found[f]);
        }
      }
    }
    rootEl.style.display = prevDisplay;

    var rectArea = Math.max(1, rect.w * rect.h);

    // v0.2: leaf sweep. Walk the nearest common container of the point hits and
    // add small elements (>50% of their own area inside the rect, area < rect).
    var container = commonAncestor(
      topHits.filter(function (e) {
        return e && e !== document.documentElement && e !== document.body;
      })
    );
    if (container && container.nodeType === 1) {
      try {
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, null);
        var node;
        var swept = 0;
        while ((node = walker.nextNode()) && swept < 4000) {
          swept++;
          if (rootEl.contains(node)) continue;
          if (seen.has(node)) continue;
          var r = node.getBoundingClientRect();
          var ea = r.width * r.height;
          if (ea <= 0) continue;
          if (ea >= rectArea) continue; // smaller than the mark
          var inter = intersects(r, rect);
          if (inter <= 0) continue;
          if (inter > 0.5 * ea) {
            seen.add(node);
            candidates.push(node);
          }
        }
      } catch (e) {}
    }

    // Score all candidates.
    var scored = [];
    for (var c = 0; c < candidates.length; c++) {
      var el = candidates[c];
      if (!el || el === document.documentElement || el === document.body) continue;
      if (rootEl.contains(el)) continue;
      var br = el.getBoundingClientRect();
      var inter2 = intersects(br, rect);
      if (inter2 <= 0) continue;
      var elArea = Math.max(1, br.width * br.height);
      var overlap = inter2 / elArea; // intersection / element area
      var sortKey = overlap;
      if (elArea > 4 * rectArea) sortKey *= 0.1; // penalize wrappers much larger than the mark
      scored.push({ el: el, overlap: overlap, sortKey: sortKey });
    }
    scored.sort(function (x, y) {
      return y.sortKey - x.sortKey;
    });
    var top = scored.slice(0, 8); // v0.2: cap raised to 8
    return top.map(function (s) {
      return describe(s.el, s.overlap, rectArea);
    });
  }

  // ---- frames ------------------------------------------------------------
  function drawFrame(mark) {
    var frame = document.createElement("div");
    frame.className = "rl-frame";
    frame.style.color = mark.color;
    frame.style.borderColor = mark.color;
    frame.style.left = mark.rect.x + "px";
    frame.style.top = mark.rect.y + "px";
    frame.style.width = mark.rect.w + "px";
    frame.style.height = mark.rect.h + "px";

    var badge = document.createElement("div");
    badge.className = "rl-badge";
    badge.style.background = mark.color;
    badge.textContent = String(mark.id);
    badge.title = "Edit instruction";
    badge.addEventListener("click", function (e) {
      e.stopPropagation();
      editMarkInstruction(mark);
    });
    frame.appendChild(badge);

    marksLayer.appendChild(frame);
    mark.frameEl = frame;
    mark.badgeEl = badge;
  }

  function repositionFrames() {
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!m.frameEl) continue;
      m.frameEl.style.left = m.pageRect.x - window.scrollX + "px";
      m.frameEl.style.top = m.pageRect.y - window.scrollY + "px";
    }
    if (ghostEl && ghostEl._pageRect) {
      var gx = ghostEl._pageRect.x - window.scrollX;
      var gy = ghostEl._pageRect.y - window.scrollY;
      ghostEl.style.left = gx + "px";
      ghostEl.style.top = gy + "px";
      if (popoverEl && popoverEl._followGhost) {
        positionPopover({
          x: gx,
          y: gy,
          w: parseFloat(ghostEl.style.width),
          h: parseFloat(ghostEl.style.height)
        });
      }
    }
  }

  // ---- add / remove a mark ----------------------------------------------
  function addMark(rect, instruction) {
    if (finished) return null;
    if (!currentViewUrl) {
      currentViewUrl = location.href;
      currentViewTitle = document.title;
    }
    rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h)
    };
    var scroll = { x: window.scrollX, y: window.scrollY };
    var pageRect = { x: rect.x + scroll.x, y: rect.y + scroll.y, w: rect.w, h: rect.h };
    var elements = captureElements(rect);
    var mark = {
      id: nextId++,
      color: colorFor(marks.length),
      instruction: instruction || "",
      rect: rect,
      pageRect: pageRect,
      scroll: scroll,
      elements: elements
    };
    marks.push(mark);
    drawFrame(mark);
    renderCount();
    if (panelEl) renderPanel();
    return mark;
  }

  function removeMark(id) {
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].id === id) {
        if (marks[i].frameEl && marks[i].frameEl.parentNode) {
          marks[i].frameEl.parentNode.removeChild(marks[i].frameEl);
        }
        marks.splice(i, 1);
        break;
      }
    }
    renderCount();
    if (panelEl) renderPanel();
  }

  // ---- serialize + views -------------------------------------------------
  function serializeItem(m) {
    return {
      id: m.id,
      color: m.color,
      instruction: m.instruction,
      rect: m.rect,
      pageRect: m.pageRect,
      scroll: m.scroll,
      elements: m.elements
    };
  }

  function writeQueue() {
    var q = { version: 2, createdAt: createdAt, views: views };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(q));
    } catch (e) {
      console.warn("[redline] localStorage write failed", e);
    }
    window.__redlineQueue = q;
    return q;
  }

  // Archive the current view's marks. Returns the view object, or false.
  function archiveCurrentView() {
    if (!marks.length) return false;
    var view = {
      url: currentViewUrl || location.href,
      title: currentViewTitle != null ? currentViewTitle : document.title,
      savedAt: nowISO(),
      viewport: viewportNow(),
      items: marks.map(serializeItem)
    };
    views.push(view);
    // clear current-view state
    marksLayer.textContent = "";
    marks = [];
    nextId = 1;
    currentViewUrl = null;
    currentViewTitle = null;
    writeQueue(); // incremental: nothing lost on a hard reload
    renderCount();
    if (panelEl) renderPanel();
    return view;
  }

  function saveView() {
    if (finished) return;
    var view = archiveCurrentView();
    if (view) {
      console.log(
        "[redline] view saved: " + (view.title || view.url) + " (" + view.items.length + " marks)"
      );
    }
    setMode("browse"); // continue to the next view
  }

  // ---- panel -------------------------------------------------------------
  function shortText(s) {
    return (s || "(no instruction)").slice(0, 40);
  }

  function viewLabel(view) {
    if (view.title) return view.title;
    try {
      var u = new URL(view.url);
      return u.pathname + (u.search || "");
    } catch (e) {
      return view.url || "(view)";
    }
  }

  // A current-view row: dot scrolls/blinks, text opens the edit popover, Remove deletes.
  function buildCurrentRow(m) {
    var row = document.createElement("div");
    row.className = "rl-row";
    var dot = document.createElement("span");
    dot.className = "rl-dot";
    dot.style.background = m.color;
    dot.style.cursor = "pointer";
    dot.title = "Scroll to mark";
    dot.addEventListener("click", function (e) {
      e.stopPropagation();
      blinkMark(m);
    });
    var text = document.createElement("span");
    text.className = "rl-row-text";
    text.textContent = m.id + ". " + shortText(m.instruction);
    text.title = "Edit instruction";
    text.addEventListener("click", function (e) {
      e.stopPropagation();
      editMarkInstruction(m);
    });
    var del = document.createElement("button");
    del.className = "rl-del";
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      removeMark(m.id);
    });
    row.appendChild(dot);
    row.appendChild(text);
    row.appendChild(del);
    return row;
  }

  // A saved-view item row: text/Edit open the popover, Remove writes straight to the queue.
  function buildSavedRow(view, item) {
    var row = document.createElement("div");
    row.className = "rl-row";
    var dot = document.createElement("span");
    dot.className = "rl-dot";
    dot.style.background = item.color || "#a1a1aa";
    var text = document.createElement("span");
    text.className = "rl-row-text";
    text.textContent = item.id + ". " + shortText(item.instruction);
    text.title = "Edit instruction";
    text.addEventListener("click", function (e) {
      e.stopPropagation();
      editSavedItem(view, item);
    });
    var edit = document.createElement("button");
    edit.className = "rl-edit";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", function (e) {
      e.stopPropagation();
      editSavedItem(view, item);
    });
    var del = document.createElement("button");
    del.className = "rl-del";
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      removeSavedItem(view, item);
    });
    row.appendChild(dot);
    row.appendChild(text);
    row.appendChild(edit);
    row.appendChild(del);
    return row;
  }

  function buildViewSection(view) {
    var sec = document.createElement("div");
    sec.className = "rl-vsection";
    var head = document.createElement("div");
    head.className = "rl-vhead";
    var expanded = expandedViews.has(view);
    var caret = document.createElement("span");
    caret.className = "rl-caret";
    caret.textContent = expanded ? "▾" : "▸"; // ▾ / ▸
    var title = document.createElement("span");
    title.className = "rl-vtitle";
    title.textContent = viewLabel(view);
    var count = document.createElement("span");
    count.className = "rl-vcount";
    count.textContent = view.items.length + (view.items.length === 1 ? " mark" : " marks");
    head.appendChild(caret);
    head.appendChild(title);
    head.appendChild(count);
    head.addEventListener("click", function () {
      if (expandedViews.has(view)) expandedViews.delete(view);
      else expandedViews.add(view);
      renderPanel();
    });
    sec.appendChild(head);
    if (expanded) {
      var items = document.createElement("div");
      items.className = "rl-vitems";
      view.items.forEach(function (item) {
        items.appendChild(buildSavedRow(view, item));
      });
      sec.appendChild(items);
    }
    return sec;
  }

  function renderPanel() {
    if (!panelEl) return;
    panelEl.textContent = "";
    // current view marks
    if (!marks.length) {
      var empty = document.createElement("div");
      empty.className = "rl-empty";
      empty.textContent = views.length > 0 ? "No marks in this view yet" : "No marks yet";
      panelEl.appendChild(empty);
    } else {
      marks.forEach(function (m) {
        panelEl.appendChild(buildCurrentRow(m));
      });
    }
    // saved views (collapsed sections)
    views.forEach(function (view) {
      panelEl.appendChild(buildViewSection(view));
    });
  }

  // Edit the current view's mark: text only, no element re-capture.
  function editMarkInstruction(m) {
    var ar = {
      x: m.pageRect.x - window.scrollX,
      y: m.pageRect.y - window.scrollY,
      w: m.rect.w,
      h: m.rect.h
    };
    openPopover({
      anchorRect: ar,
      text: m.instruction,
      onSave: function (val) {
        m.instruction = val;
        renderCount();
        if (panelEl) renderPanel();
      }
    });
  }

  // Edit a saved view's item: write straight to the version 2 queue.
  // When still on the view's URL, show a temporary ghost frame where the mark sat
  // and anchor the popover to it; otherwise centre the popover with a context line.
  function editSavedItem(view, item) {
    var onSave = function (val) {
      item.instruction = val;
      writeQueue();
      if (panelEl) renderPanel();
    };
    if (location.href === view.url) {
      // Scroll the mark into the upper third (same logic as blinkMark). The ghost
      // and popover both track the ghost's real position as the scroll settles, so
      // clamped scrolls still align (see repositionFrames).
      var targetY = Math.max(0, item.pageRect.y - window.innerHeight / 3);
      var ar = {
        x: item.pageRect.x - window.scrollX,
        y: item.pageRect.y - window.scrollY,
        w: item.rect.w,
        h: item.rect.h
      };
      openPopover({ anchorRect: ar, followGhost: true, text: item.instruction, onSave: onSave });
      window.scrollTo({ top: targetY, behavior: "smooth" });
      // Build the ghost after openPopover (which cleared any previous popover/ghost).
      ghostEl = document.createElement("div");
      ghostEl.className = "rl-ghost";
      ghostEl.style.borderColor = item.color;
      ghostEl.style.color = item.color;
      ghostEl.style.width = item.rect.w + "px";
      ghostEl.style.height = item.rect.h + "px";
      ghostEl.style.left = item.pageRect.x - window.scrollX + "px";
      ghostEl.style.top = item.pageRect.y - window.scrollY + "px";
      ghostEl._pageRect = item.pageRect;
      var gb = document.createElement("div");
      gb.className = "rl-badge";
      gb.style.background = item.color;
      gb.textContent = String(item.id);
      ghostEl.appendChild(gb);
      marksLayer.appendChild(ghostEl);
    } else {
      openPopover({
        anchorRect: null,
        contextLine: viewLabel(view) + " · #" + item.id,
        text: item.instruction,
        onSave: onSave
      });
    }
  }

  // Remove a saved view's item; drop the view if it becomes empty.
  function removeSavedItem(view, item) {
    var idx = view.items.indexOf(item);
    if (idx >= 0) view.items.splice(idx, 1);
    if (view.items.length === 0) {
      var vi = views.indexOf(view);
      if (vi >= 0) views.splice(vi, 1);
    }
    writeQueue();
    renderCount();
    if (panelEl) renderPanel();
  }

  function togglePanel() {
    if (panelEl) {
      panelEl.parentNode.removeChild(panelEl);
      panelEl = null;
      return;
    }
    panelEl = document.createElement("div");
    panelEl.className = "rl-panel";
    rootEl.appendChild(panelEl);
    renderPanel();
  }

  function blinkMark(m) {
    if (!m.frameEl) return;
    window.scrollTo({
      top: Math.max(0, m.pageRect.y - window.innerHeight / 3),
      behavior: "smooth"
    });
    m.frameEl.classList.add("rl-blink");
    setTimeout(function () {
      if (m.frameEl) m.frameEl.classList.remove("rl-blink");
    }, 900);
  }

  // ---- popover -----------------------------------------------------------
  function positionPopover(ar) {
    if (!popoverEl) return;
    if (ar) {
      var px = Math.min(ar.x, window.innerWidth - 296);
      var py = ar.y + ar.h + 8;
      if (py + 120 > window.innerHeight) py = Math.max(8, ar.y - 128);
      popoverEl.style.left = Math.max(8, px) + "px";
      popoverEl.style.top = py + "px";
    } else {
      // centered (used when the frame no longer exists, e.g. cross-URL edits)
      popoverEl.style.left = Math.max(8, (window.innerWidth - 296) / 2) + "px";
      popoverEl.style.top = Math.max(8, window.innerHeight / 2 - 70) + "px";
    }
  }

  // opts: { anchorRect (viewport rect or null=centered), text, contextLine,
  //         followGhost, onSave(value), onCancel() }
  function openPopover(opts) {
    opts = opts || {};
    closePopover();
    setMode("browse"); // pause drawing while typing so page keys/scroll behave
    popoverEl = document.createElement("div");
    popoverEl.className = "rl-popover";
    if (opts.contextLine) {
      var ctx = document.createElement("div");
      ctx.className = "rl-context";
      ctx.textContent = opts.contextLine;
      popoverEl.appendChild(ctx); // above the textarea
    }
    var ta = document.createElement("textarea");
    ta.placeholder = "Describe the change";
    ta.value = opts.text || "";
    var hint = document.createElement("div");
    hint.className = "rl-hint";
    hint.textContent = "Enter to save, Esc to discard";
    popoverEl.appendChild(ta);
    popoverEl.appendChild(hint);
    rootEl.appendChild(popoverEl);

    popoverEl._followGhost = !!opts.followGhost;
    positionPopover(opts.anchorRect);
    ta.focus();
    try {
      var L = ta.value.length;
      ta.setSelectionRange(L, L);
    } catch (e) {}

    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var val = ta.value.trim();
        closePopover();
        if (opts.onSave) opts.onSave(val);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
        if (opts.onCancel) opts.onCancel();
      }
    });
  }

  function closePopover() {
    if (popoverEl && popoverEl.parentNode) popoverEl.parentNode.removeChild(popoverEl);
    popoverEl = null;
    removeGhost();
    removePending();
  }

  function removeGhost() {
    if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl);
    ghostEl = null;
  }

  // ---- drag to draw ------------------------------------------------------
  var dragging = false;
  var dragStart = null;
  var dragEl = null;
  var pendingEl = null; // preview frame kept visible while the instruction popover is open

  function showPending(rect) {
    removePending();
    pendingEl = document.createElement("div");
    pendingEl.className = "rl-frame";
    var col = colorFor(marks.length);
    pendingEl.style.color = col;
    pendingEl.style.borderColor = col;
    pendingEl.style.left = rect.x + "px";
    pendingEl.style.top = rect.y + "px";
    pendingEl.style.width = rect.w + "px";
    pendingEl.style.height = rect.h + "px";
    marksLayer.appendChild(pendingEl);
  }

  function removePending() {
    if (pendingEl && pendingEl.parentNode) pendingEl.parentNode.removeChild(pendingEl);
    pendingEl = null;
  }

  drawLayer.addEventListener("mousedown", function (e) {
    if (mode !== "draw" || finished) return;
    if (e.button !== 0) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    dragEl = document.createElement("div");
    dragEl.className = "rl-drag";
    dragEl.style.left = e.clientX + "px";
    dragEl.style.top = e.clientY + "px";
    dragEl.style.width = "0px";
    dragEl.style.height = "0px";
    rootEl.appendChild(dragEl);
    e.preventDefault();
  });

  window.addEventListener("mousemove", function (e) {
    if (!dragging || !dragEl) return;
    var x = Math.min(e.clientX, dragStart.x);
    var y = Math.min(e.clientY, dragStart.y);
    var w = Math.abs(e.clientX - dragStart.x);
    var h = Math.abs(e.clientY - dragStart.y);
    dragEl.style.left = x + "px";
    dragEl.style.top = y + "px";
    dragEl.style.width = w + "px";
    dragEl.style.height = h + "px";
  });

  window.addEventListener("mouseup", function (e) {
    if (!dragging) return;
    dragging = false;
    var x = Math.min(e.clientX, dragStart.x);
    var y = Math.min(e.clientY, dragStart.y);
    var w = Math.abs(e.clientX - dragStart.x);
    var h = Math.abs(e.clientY - dragStart.y);
    if (dragEl && dragEl.parentNode) dragEl.parentNode.removeChild(dragEl);
    dragEl = null;
    if (w < 6 || h < 6) return; // ignore accidental clicks
    var rect = { x: x, y: y, w: w, h: h };
    openPopover({
      anchorRect: rect,
      text: "",
      onSave: function (val) {
        removePending();
        addMark(rect, val);
        setMode("draw");
      },
      onCancel: function () {
        removePending();
        setMode("draw");
      }
    });
    // After openPopover (whose closePopover would otherwise clear it): keep the
    // drawn rectangle visible while the instruction is typed.
    showPending(rect);
  });

  // ---- keyboard ----------------------------------------------------------
  function typingInPage() {
    var a = document.activeElement;
    if (!a) return false;
    if (rootEl.contains(a)) return true; // our own popover input
    var tag = a.tagName ? a.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || tag === "select" || a.isContentEditable;
  }

  window.addEventListener(
    "keydown",
    function (e) {
      if (finished) return;
      if (typingInPage()) return;
      if (e.key === "r" || e.key === "R") {
        setMode("draw");
      } else if (e.key === "b" || e.key === "B") {
        setMode("browse");
      } else if (e.key === "Escape") {
        if (!dragging && mode === "draw") setMode("browse");
      }
    },
    true
  );

  // ---- scroll ------------------------------------------------------------
  window.addEventListener("scroll", repositionFrames, true);
  window.addEventListener("resize", repositionFrames, true);

  // ---- SPA URL watch -----------------------------------------------------
  // Overlay survives client-side nav (root sits on documentElement). When the
  // URL changes with unsaved marks, auto-archive them so coordinates from
  // different views never mix.
  function checkUrl() {
    if (finished) return;
    if (location.href !== lastUrl) {
      if (marks.length) {
        var view = archiveCurrentView();
        if (view) {
          console.log(
            "[redline] url changed, auto-saved view: " +
              (view.title || view.url) +
              " (" +
              view.items.length +
              " marks)"
          );
        }
      }
      lastUrl = location.href;
    }
  }
  window.addEventListener("popstate", checkUrl);
  urlTimer = setInterval(checkUrl, 500);

  // ---- finish ------------------------------------------------------------
  // Build a complete handoff prompt for another person's agent CLI: paste it
  // into Claude Code / Codex and the receiving agent takes over from there.
  function buildHandoffPrompt(json) {
    var q = json || JSON.stringify({ version: 2, createdAt: createdAt, views: views });
    return [
      "You are receiving a redline design review: a queue of visual fixes a designer",
      "marked on a live web app. Tool reference: https://github.com/henrikhellstromgbg/redline",
      "(see AGENT.md there for the full workflow). The queue JSON is embedded at the",
      "bottom of this prompt.",
      "",
      "First ask me ONE question: should you",
      "(a) implement the queue directly, or",
      "(b) open the review visually in my browser first so I can triage it (edit or",
      "    remove items) before you implement?",
      "",
      "If (a) implement:",
      "- Each item = one task. Use instruction + selector + computed styles as ground",
      "  truth. Candidates with role \"leaf\" are usually the exact target; \"container\"",
      "  rows are wrappers for context. Selectors are pre-verified with querySelector.",
      "- Each view has the url it was marked on (match on path if host/port differ).",
      "- Verify each fix in the browser, then clear the queue:",
      "  localStorage.removeItem('redline.queue')",
      "",
      "If (b) triage first:",
      "- In a tab running this app, write the JSON below into",
      "  localStorage['redline.queue'].",
      "- Fetch https://raw.githubusercontent.com/henrikhellstromgbg/redline/main/overlay.js",
      "  yourself and inject its CONTENTS into the tab via the Chrome MCP",
      "  javascript_tool (do not add a remote <script> tag, strict CSP will block it).",
      "  The overlay resumes the queue automatically.",
      "- Tell me review mode is on, wait until I say I have pressed Finish, then",
      "  re-read the queue and proceed as in (a).",
      "",
      "Review queue JSON:",
      q
    ].join("\n");
  }

  function showToast(json, viewCount, markCount) {
    var toast = document.createElement("div");
    toast.className = "rl-toast";
    var label = document.createElement("span");
    label.textContent =
      "Review saved, " +
      viewCount +
      (viewCount === 1 ? " view, " : " views, ") +
      markCount +
      (markCount === 1 ? " mark" : " marks");
    var copyPrompt = mkBtn("Copy agent prompt", "rl-btn");
    copyPrompt.addEventListener("click", function () {
      try {
        navigator.clipboard.writeText(buildHandoffPrompt(json));
        copyPrompt.textContent = "Copied";
      } catch (e) {
        copyPrompt.textContent = "Copy failed";
      }
    });
    var copy = mkBtn("Copy JSON", "rl-btn");
    copy.addEventListener("click", function () {
      try {
        navigator.clipboard.writeText(json);
        copy.textContent = "Copied";
      } catch (e) {
        copy.textContent = "Copy failed";
      }
    });
    var reopenBtn = mkBtn("Reopen", "rl-btn");
    reopenBtn.addEventListener("click", function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      reopen();
    });
    var close = mkBtn("Close", "rl-btn");
    close.addEventListener("click", function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
    toast.appendChild(label);
    toast.appendChild(copyPrompt);
    toast.appendChild(copy);
    toast.appendChild(reopenBtn);
    toast.appendChild(close);
    rootEl.appendChild(toast);
  }

  // Reopen a finished review with the in-memory queue intact (no localStorage
  // re-read). Rebuilds the layers finish() tore down and restarts the watcher.
  function reopen() {
    if (!finished) return;
    finished = false;
    if (!drawLayer.parentNode) rootEl.insertBefore(drawLayer, marksLayer);
    if (!toolbar.parentNode) rootEl.appendChild(toolbar);
    panelEl = null; // finish() detached it; drop the stale reference
    if (!urlTimer) {
      lastUrl = location.href;
      urlTimer = setInterval(checkUrl, 500);
    }
    setMode("browse");
    renderCount();
    console.log(
      "[redline] review reopened: " + views.length + " views, " + savedMarkCount() + " marks"
    );
  }

  function finish() {
    if (finished) return;
    archiveCurrentView(); // archive any unsaved marks as a final view
    var q = writeQueue();
    var totalMarks = savedMarkCount();
    console.log("[redline] queue ready: " + q.views.length + " views, " + totalMarks + " marks");

    finished = true;
    if (urlTimer) {
      clearInterval(urlTimer);
      urlTimer = null;
    }
    // Take down frames, toolbar and panel so the agent gets clean screenshots.
    if (marksLayer.parentNode) marksLayer.textContent = "";
    if (drawLayer.parentNode) drawLayer.parentNode.removeChild(drawLayer);
    if (toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    closePopover();
    rootEl.classList.remove("rl-mode-draw");
    showToast(JSON.stringify(q), q.views.length, totalMarks);
  }

  // ---- teardown ----------------------------------------------------------
  function teardown() {
    try {
      window.removeEventListener("scroll", repositionFrames, true);
      window.removeEventListener("resize", repositionFrames, true);
      window.removeEventListener("popstate", checkUrl);
      if (urlTimer) clearInterval(urlTimer);
    } catch (e) {}
    var existing = document.getElementById(ROOT_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
  }

  function show() {
    rootEl.style.display = "";
  }

  // ---- wire toolbar ------------------------------------------------------
  btnMark.addEventListener("click", function () {
    setMode("draw");
  });
  btnBrowse.addEventListener("click", function () {
    setMode("browse");
  });
  countEl.addEventListener("click", togglePanel);
  btnSaveView.addEventListener("click", saveView);
  btnFinish.addEventListener("click", finish);

  setMode("draw");
  renderCount();

  // ---- public API (used by the test harness and re-injection) ------------
  window.__redline = {
    addMark: addMark,
    removeMark: removeMark,
    saveView: saveView,
    finish: finish,
    reopen: reopen,
    buildHandoffPrompt: buildHandoffPrompt,
    done: finish, // v0.1 alias
    setMode: setMode,
    teardown: teardown,
    show: show,
    writeQueue: writeQueue,
    togglePanel: togglePanel,
    editMarkInstruction: editMarkInstruction,
    editSavedItem: editSavedItem,
    removeSavedItem: removeSavedItem,
    get marks() {
      return marks;
    },
    get views() {
      return views;
    },
    get mode() {
      return mode;
    },
    get finished() {
      return finished;
    }
  };

  var resumeMsg =
    views.length > 0
      ? " resumed: " + views.length + " views, " + savedMarkCount() + " marks"
      : "";
  console.log("[redline] review mode on. Mark, Browse, Save view, Finish." + resumeMsg);
  return window.__redline;
})();
