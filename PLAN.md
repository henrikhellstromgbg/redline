# Redline v0.6 product and engineering contract

Redline is a dependency-free browser overlay for design QA between a human reviewer
and a coding agent. The reviewer marks visual problems on a live page; Redline records
the intent and technical context as a structured queue; the agent implements and
verifies each item.

Redline is not an MCP server. It is an injected browser tool that can be operated by
an agent through browser automation, MCP, or DevTools.

## Product boundaries

- One review can contain many views, routes, and UI states.
- The human supplies the judgement and instruction; Redline supplies evidence.
- The receiving agent remains responsible for locating source code, implementing the
  change, and verifying the result.
- Redline does not edit application code, upload data, or run a server.
- The shipped overlay remains one dependency-free JavaScript file with no build step.

## Security and privacy boundary

The overlay executes with the same page access as code pasted into DevTools. It can
read visible DOM text, URLs, computed styles, and framework debug metadata. Captured
queues are stored in the current origin's `localStorage` and exposed in memory as
`window.__redlineQueue`, so application scripts on that origin can read them.

Required safeguards:

- Never recommend executing a mutable `main` branch or unpinned remote script in a
  live application tab.
- Agent handoff prompts must include the exact running overlay source needed for
  visual triage; receivers must not fetch a newer copy implicitly.
- Documentation must tell users to avoid sensitive production pages unless this
  local capture and retention model is acceptable.
- Persistence and clipboard failures must be visible. The UI must never claim success
  before the underlying operation succeeds.

## Queue contract

The current schema is version 2:

```json
{
  "version": 2,
  "createdAt": "ISO-8601 timestamp",
  "views": [
    {
      "url": "https://app.example/path",
      "title": "Document title",
      "savedAt": "ISO-8601 timestamp",
      "viewport": {
        "w": 1440,
        "h": 900,
        "dpr": 2,
        "scrollX": 0,
        "scrollY": 300
      },
      "items": []
    }
  ]
}
```

Every item includes the instruction, mark coordinates, scroll position, color, and
up to eight ranked element candidates. A candidate can include:

- a selector that was verified to resolve uniquely to that exact element;
- tag name and bounded visible text;
- overlap score and `leaf`/`container` role;
- selected computed styles;
- React component/source metadata when available.

If an exact unique selector cannot be produced, the candidate must say so instead of
serializing a selector that may point at another element.

Version-1 queues should migrate when their shape is valid. Corrupt or future-version
queues must produce a visible warning and must not be silently overwritten.

## Lifecycle invariants

- Injecting Redline twice while it is active reuses one instance and one toolbar.
- `teardown()` removes every global event listener and timer owned by the instance.
- Save view and SPA navigation archive marks under the URL where they were created.
- Finish archives remaining marks, attempts durable persistence, removes review
  frames, and offers copy/export actions.
- Reopen restores interaction without duplicating listeners or losing archived views.
- A failed `localStorage` write leaves the queue available in memory and presents an
  explicit copy fallback; it is never labelled as durably saved.

## Selector strategy

Selectors are attempted in this order:

1. Stable unique `id`.
2. Unique `data-testid` or `data-test` on the element.
3. Short unique tag/class combination after filtering generated class names.
4. Short path from a stable ancestor.
5. Fully rooted `body > … > :nth-child(...)` fallback.

Attribute values must be CSS-escaped. Every result is checked for both uniqueness and
identity before serialization.

## Required regression coverage

The repository must provide an executable real-browser smoke suite covering:

- normal reinjection and teardown listener cleanup;
- exact selector identity under adversarial duplicate DOM suffixes;
- multi-view Save view, SPA route changes, and Finish;
- hard reload/resume where applicable;
- Finish, Reopen, adding another mark, and finishing again;
- current and saved item edit/remove behavior;
- persistence failure and the in-memory/copy fallback;
- clipboard rejection;
- parseable, self-contained agent handoff prompts without mutable remote loaders;
- version-1 migration plus corrupt/future queue handling;
- browse-mode pointer-event passthrough and keyboard shortcuts.

Tests may require an installed Chrome/Chromium, but must not add runtime dependencies
to the overlay.

## Future work

- Optional screenshot crops or image attachments per mark.
- Explicit queue import/export files for cross-origin or offline handoff.
- Source modules plus a generated single-file artifact if the IIFE becomes difficult
  to maintain; the distributed artifact must remain dependency-free.
- Optional extension packaging for users who want a pinned, auditable installation.
