# Redline agent workflow

Redline turns a human design review into a structured implementation queue. Use this
contract when operating the overlay, receiving a shared review, or implementing its
items.

Redline is an injected browser overlay, not an MCP server. Use the browser-control or
DevTools surface available in the current agent environment.

## Security boundary

Injection gives `overlay.js` page-level access. Read and inject a local, reviewed copy
of the file. Do not fetch and execute a mutable GitHub `main` branch or an unpinned
CDN asset in an authenticated application tab.

The queue may contain URLs, visible text, styles, selectors, and React debug metadata.
It lives in the application's origin as `localStorage['redline.queue']` and in memory
as `window.__redlineQueue`. Do not move it to another service unless the user has
authorized that destination and data.

## 1. Start a review

1. Read the repository-local `overlay.js`.
2. Inject the file contents into the target tab through the available browser or
   DevTools evaluation tool. Do not add a remote script tag.
3. Verify that the tab logs:

   ```text
   [redline] review mode on. Mark, Browse, Save view, Finish.
   ```

4. Tell the user:

   > Review mode is on. Say when you have pressed Finish.

5. Wait for the user. Do not poll the queue merely to detect completion.

Injection is idempotent while the live instance and root are present. Reinjecting
after a route change reuses the same toolbar. A stale instance is fully torn down,
including its global event listeners and URL timer, before replacement.

## 2. What happens during review

- **Mark** (`r`): the user draws a rectangle and writes an instruction.
- **Browse** (`b` or Esc): pointer events reach the application so the user can open
  another UI state.
- **Save view**: marks are archived with that view's URL, title, viewport, and scroll
  information, then persisted incrementally.
- **SPA navigation**: a `popstate` listener plus a lightweight URL watcher detect
  route changes and auto-archive unsaved marks under their original URL.
- **Edit/Remove**: current and saved instructions can be changed or deleted. Saved
  changes attempt persistence immediately.
- **Finish**: remaining marks are archived, the queue is persisted, frames are
  removed, and copy/reopen/close actions are shown.

If `localStorage` is unavailable, full, or blocked, Redline must show a persistence
warning. The current queue remains available as `window.__redlineQueue`, and copy
actions provide the recovery path. Do not tell the user the review is durably saved
when persistence failed.

## 3. Read the finished queue

After the user confirms Finish, read:

```js
localStorage.getItem("redline.queue")
```

If that is unavailable or the UI reported a persistence failure, read:

```js
window.__redlineQueue
```

Validate that the queue has `version: 2` and a `views` array before implementing it.
Redline migrates valid version-1 queues but refuses to silently overwrite corrupt or
future-version data.

## 4. Implement the queue

Loop through `views`, then through each view's `items`. Treat one item as one task.

For every item:

1. Use `instruction` as the user's source of truth.
2. Navigate to the view URL, matching by path when development host or port differs.
3. Inspect `elements` as ranked evidence:
   - `leaf` usually identifies the exact control or text element;
   - `container` provides layout and spacing context;
   - every non-null `selector` was verified to resolve uniquely to the exact element
     at capture time;
   - `styles` records selected computed values;
   - `react.components` and optional `react.source` can help locate source code.
4. Confirm the target in the current DOM instead of blindly trusting stale selectors.
5. Implement the change in the codebase.
6. Verify the result in the browser at the relevant viewport/state.

Coordinates are complementary evidence:

- `rect`: viewport coordinates at capture time;
- `pageRect`: document coordinates;
- `scroll`: capture-time scroll position.

## 5. Clean up

Only after every item is implemented and verified, clear the queue in the reviewed
application tab:

```js
localStorage.removeItem("redline.queue")
```

Do not clear the queue merely because implementation has started.

## Receiving a shared agent prompt

**Copy agent prompt** creates a self-contained handoff containing both the version-2
queue and the exact running overlay source.

Ask the receiver one question:

- implement the queue directly; or
- open it visually for Edit/Remove triage first.

For direct implementation, follow sections 3–5.

For visual triage:

1. Open a tab running the same application.
2. Write the embedded queue JSON to `localStorage['redline.queue']`.
3. Inject the embedded overlay source from the prompt. Do not fetch another version.
4. Tell the user review mode is on and wait for Finish.
5. Re-read the edited queue and implement it.

The full schema and user-facing workflow are documented in `README.md`; engineering
invariants and required regression coverage are in `PLAN.md`.
