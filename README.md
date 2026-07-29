# redline

Design-QA for agent coding. You mark areas on live web pages, write one short
instruction per mark, and press Finish. redline writes a structured JSON queue that
a coding agent with browser access (Claude Code, Codex, anything that can drive a
tab) reads and works through. You make the judgement, the agent does the
implementation, the queue is the contract.

This is not a builder (Onlook, Subframe) and not a human comment tool (Vercel
Toolbar, Marker.io). The reader is an agent, so every mark carries technical
ground: CSS selector, computed styles, and React component names when present.

## What it is

`overlay.js` is the whole tool — one self-contained vanilla JS IIFE, no
dependencies, no build step. Run it on any tab and a small floating toolbar
appears.

![redline in action](test/screenshot.png)

## Install

Pick whichever fits — the tool is the same either way.

- **Console paste (works everywhere, including strict-CSP apps).** Open DevTools,
  paste the contents of [`overlay.js`](overlay.js) into the console, press Enter.
- **Bookmarklet (one click, for sites without a strict CSP).** Make a new bookmark
  with this URL, then click it on any page:

  ```
  javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/henrikhellstromgbg/redline@main/overlay.js';document.body.appendChild(s);})();
  ```

  Many apps block remote scripts via Content-Security-Policy; there, use the console
  paste instead.
- **Ask your coding agent.** If you're already in an agent session with browser
  access (Claude Code, Codex, or similar), just say "start a redline review on this
  page" — the agent reads `overlay.js` and runs it for you. See
  [`AGENT.md`](AGENT.md).

Running it again is always safe — the overlay is idempotent and resumes an
in-progress review from `localStorage`.

## How to run a review

1. Open the page you want to review in Chrome.
2. Load `overlay.js` — paste it into the DevTools console, or ask your coding agent
   to start a review. Running it again is safe (idempotent).
3. Use the toolbar (bottom right):
   - **Mark** — draw a rectangle over the thing to change. A popover opens: type
     the instruction, Enter saves, Esc discards. The mark stays as a numbered frame.
   - **Browse** — pause. Pointer events pass through so you can open a dropdown,
     modal or date picker. Switch back to Mark to annotate that new state.
   - The **counter** ("2 views, 5 marks") opens the panel. It lists the current
     view's marks (click the dot to scroll to and blink a frame, click the text to
     edit its instruction, Remove to delete) and, below, one collapsed section per
     saved view (title/path + mark count; click to expand). Saved rows have Edit
     and Remove, and both write straight to the queue.
   - **Edit a mark**: click its numbered badge on the page, or its row text in the
     panel. The popover reopens pre-filled; Enter saves the new text, Esc leaves it
     unchanged. Only the text changes — the captured element data is kept. Removing
     the last item from a saved view drops that view.
   - Editing a **saved** view's item: if you are still on that view's URL, a dashed
     ghost frame is scrolled into view where the mark sat and the popover anchors to
     it; if you have navigated away, the popover stays centered with a grey line
     naming the view and mark number. The ghost clears when you press Enter or Esc.
   - **Save view** — archive this page's marks and move to the next page. The
     overlay stays up and switches to Browse so you can navigate.
   - **Finish** — archive any remaining marks, save the queue, log
     `[redline] queue ready: N views, M marks`, show a confirmation with **Copy
     JSON**, **Reopen** and **Close**, and take the frames down for clean
     screenshots. **Reopen** brings the review back with every view intact if you
     pressed Finish too early.
4. Keyboard: `r` = mark, `b` = browse, `Esc` = browse (when not mid-drag). Shortcuts
   are ignored while you type in a page field.

### A review can span many pages

- One review = many **views**, one view per page or state. Each Save view writes
  the queue incrementally, so nothing is lost.
- On a single-page-app route change the overlay survives, and any unsaved marks are
  auto-archived as a view for the page they were drawn on. Coordinates never mix.
- A hard reload clears the overlay but the saved views stay in `localStorage`.
  Loading it again resumes the same review instead of starting over. The queue is
  only cleared when the agent runs `localStorage.removeItem('redline.queue')`.

Tell the agent when you have pressed Finish. It reads the queue and implements.

## Data model (version 2)

`localStorage['redline.queue']` (and `window.__redlineQueue`) hold:

```json
{
  "version": 2,
  "createdAt": "2026-07-29T09:00:00.000Z",
  "views": [
    {
      "url": "http://localhost:3000/app/konton/123",
      "title": "Account 123",
      "savedAt": "2026-07-29T09:03:00.000Z",
      "viewport": { "w": 1440, "h": 900, "dpr": 2, "scrollX": 0, "scrollY": 300 },
      "items": [
        {
          "id": 1,
          "color": "#e11d48",
          "instruction": "Dropdown should not have rounded corners",
          "rect": { "x": 24, "y": 88, "w": 440, "h": 56 },
          "pageRect": { "x": 24, "y": 388, "w": 440, "h": 56 },
          "scroll": { "x": 0, "y": 300 },
          "elements": [
            {
              "selector": "#activity-type",
              "tag": "button",
              "text": "Activity: call",
              "overlap": 0.94,
              "role": "leaf",
              "styles": {
                "color": "…", "backgroundColor": "…", "fontSize": "…",
                "fontWeight": "…", "padding": "…", "margin": "…",
                "borderRadius": "…", "display": "…", "gap": "…",
                "textTransform": "…", "border": "…"
              },
              "react": {
                "components": ["ActivityTypeSelect", "ActivityModal"],
                "source": { "fileName": "src/components/ActivityTypeSelect.tsx", "lineNumber": 42 }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

- `views` is the review, one entry per page/state. Each view carries its own `url`,
  `title`, `savedAt`, `viewport` and `items`. Item `id`s restart at 1 per view.
- `rect` = viewport coords at mark time. `pageRect` = document coords.
  `scroll` = scroll position then. All three let the agent crop screenshots and
  re-find the element.
- `elements` = up to 8 candidates, ranked by overlap (intersection area / element
  area). A leaf sweep adds small text elements the point grid misses, and each
  candidate carries `role`: `"leaf"` (area smaller than the mark, usually the exact
  target) or `"container"` (a wrapper). Wrappers much larger than the mark
  (area > 4× the rectangle) are penalised so the real target ranks first. The
  overlay's own nodes are skipped.
- `selector` is verified against `document.querySelector` before it is written. When
  an element has no id/class of its own, the selector anchors on the nearest
  `data-testid`/`data-test`/stable-`id` ancestor (within 10 levels) for a short,
  stable path — e.g. `[data-testid="deal-sidebar-meta"] > dl:nth-child(1) > dt:nth-child(1)`.
- `react` is `null` when the page is not React or runs in production (no fiber /
  no `_debugSource`).

No server, no persistence beyond `localStorage`.

## Files

- `overlay.js` — the tool.
- `AGENT.md` — the agent-side workflow (load → wait → read queue → implement).
- `test/demo.html` — a static page with deliberate flaws (uppercase title,
  over-rounded card/dropdown, missing padding, weak grey, a `data-testid` container
  with a column of small labels) for testing without a real app.

## Test

Open `test/demo.html` in a debuggable Chrome, load `overlay.js`, mark a couple of
the flaws, press Save view / Finish, and read `localStorage['redline.queue']`. See
the "Testkrav" sections of `PLAN.md` for the full checklist.

## Handing the review to an agent

One copy, one paste — that's it. After **Finish**, hit **Copy agent prompt**. That
copies a complete, self-contained prompt — instructions plus the full queue JSON —
ready to paste straight into an agent's CLI (Claude Code, Codex, anything that can
drive a browser). Paste it into your own next agent turn to have it implemented, or
send it to a collaborator over Slack to hand the review off. Either way the
receiving agent asks its user one question:

- **implement directly**, working through the queue item by item, or
- **open the review visually first** — the agent loads `overlay.js` and the queue
  into the app tab, and the receiver triages with Edit/Remove before saying go.

Nobody touches localStorage or DevTools by hand; that's the agent's job. The prompt
is also available programmatically as `window.__redline.buildHandoffPrompt()`.

**Manual fallback** (no agent on the receiving end): **Copy JSON** instead, and the
receiver pastes it into their DevTools console before pasting `overlay.js`:

```js
localStorage.setItem('redline.queue', JSON.stringify(<QUEUE_JSON>));
// then paste overlay.js — it resumes the queue automatically
```

Note: view URLs may differ in port/host between machines. Agents should match on
path, and the ghost frame on saved-item edit only appears when the full URL matches.
