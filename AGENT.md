# redline — agent workflow

You are Claude Code with the Chrome MCP tools. redline is the contract between
Henrik's design judgement and your implementation. Henrik marks areas on live
pages and writes one instruction per mark; you read the structured queue and work
through it. Follow this flow straight.

## 1. Inject the overlay

Read `overlay.js` from disk and inject the whole file into the target tab.

- Chrome DevTools MCP: `evaluate_script` with a function that `eval`s the source,
  or fetch it if the page is served from the redline folder.
- claude-in-chrome MCP: `javascript_tool` with the file contents as `text`.

Injection is idempotent. Running it again on the same page reuses the existing
instance instead of adding a second toolbar, so re-injecting after an SPA route
change is safe.

On success the console logs `[redline] review mode on. Mark, Browse, Save view, Finish.`
If a review is already in progress in `localStorage` it also prints
`resumed: N views, M marks` — see step 2.

## 2. Hand control to Henrik and wait

Tell Henrik:

> Review mode is on. Say when you have pressed Finish.

Then wait. No polling in MVP — Henrik replies in the chat when he is finished.
A review can span several pages. While he works he will:

- **Mark** (`r`): draw a rectangle, type the instruction, Enter to save.
- **Browse** (`b` or Esc): pointer events pass through so he can open a dropdown,
  modal or date picker, then switch back to Mark and annotate the new state.
- **Save view**: archive the current page's marks as one *view* and move on to the
  next page. The overlay stays up; the counter shows e.g. `2 views, 5 marks`.
- **Finish**: archive any remaining marks as a final view, write the queue, and
  take the overlay down for clean screenshots.
- The counter opens a panel listing the current view's marks and one collapsed
  section per saved view.
- **Edit**: he can revise any instruction after the fact — clicking a mark's badge
  or panel text for the current view, or Edit on a saved view's row. Edits to saved
  views are written to the queue immediately (only the instruction text changes, the
  captured element data is kept); Remove on a saved row rewrites the queue and drops
  a view that becomes empty. So the queue you read is always his latest wording.

### Multi-view, SPA nav and reloads

- One review = many views, one view per page/state. Each **Save view** writes the
  queue incrementally to `localStorage`, so nothing is lost.
- On client-side navigation (SPA route change), the overlay survives and any
  unsaved marks are auto-archived as a view attributed to the URL where they were
  drawn. Coordinates never mix between pages.
- A hard reload removes the overlay but the saved views stay in `localStorage`.
  Re-injecting **resumes** the same queue (it does not overwrite). If Henrik hard-
  reloads mid-review, just inject again and keep waiting.

## 3. Read the queue

After Henrik confirms Finish:

```js
localStorage.getItem("redline.queue")
```

Also available in-page as `window.__redlineQueue` (same object). Parse the JSON.
`[redline] queue ready: N views, M marks` in the console confirms it was written.

## 4. Screenshot the pages

Finish removes the frames, so screenshots are clean. Each view records its own
`url`, `title` and `viewport`. Per item use `pageRect`, `scroll` and `rect` to
locate the region: scroll to `pageRect.y`, and zoom on the region when you need
detail. `rect` is viewport coords at mark time, `pageRect` is document coords,
`scroll` is the scroll position then — the three together let you crop and re-find.

If a view's `url` differs from the page you are on, navigate there first.

## 5. Turn the queue into tasks

Loop the views; within each view loop its items. Create one task per item.
For each item:

- `instruction` is Henrik's intent — the source of truth for the change.
- `elements` holds up to 8 ranked candidates. Each has `role`: `"leaf"` (smaller
  than the mark — usually the exact text node or control) or `"container"` (a
  wrapper). Prefer the top `leaf` when the instruction is about text, a label or a
  single control; use a `container` when the change is about layout or spacing.
- Per candidate use `selector` (already verified to resolve uniquely on the page),
  `tag`, `text`, `overlap`, `styles` (the current computed values you are
  changing), and `react` (`components` + `source.fileName`/`lineNumber` when the
  app runs React in dev). Selectors anchor on the nearest `data-testid`/`data-test`
  or stable `id` ancestor when the element has none of its own, so they stay short
  and stable — e.g. `[data-testid="deal-sidebar-meta"] > dl:nth-child(1) > dt:nth-child(1)`.
  `react` is `null` on non-React or production pages — fall back to selector + text.

Implement in the codebase, then verify the change in the browser.

## 6. Clean up

When the whole queue is done:

```js
localStorage.removeItem("redline.queue")
```

The queue is only cleared here — never overwritten by re-injection.

## Data model

See `README.md` for the full version 2 shape. No server, no persistence beyond
`localStorage`.

## Receiving a shared review

A queue may arrive as a JSON file from another person instead of from your own review session. Treat it exactly like a locally produced queue:

1. If the receiver wants to triage first: write the JSON into `localStorage['redline.queue']` in a tab running the same app, inject `overlay.js` (it resumes automatically), let them Edit/Remove, wait for Finish.
2. Otherwise skip the browser and consume the JSON directly as the task list.
3. URL caveat: host/port may differ from your local setup — resolve each view by URL path, not full origin.
