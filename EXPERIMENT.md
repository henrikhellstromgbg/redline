# Redline shared-review experiment

This branch is a separate Chrome extension experiment. It does not replace the
original `overlay.js` workflow and is not intended to be merged into `main` until
the workflow has been tested by real reviewers.

The experiment keeps Redline deliberately small:

1. A designer opens a live product and chooses **Annotate**.
2. They draw one frame and write one short instruction.
3. Redline saves the annotation immediately on the device.
4. The recipient imports the `.redline.json` file, removes anything that is not a
   priority, and chooses **Triage first**, **Fix with agent**, or **Send back to
   designer**.
5. The accepted review can be exported again or copied as a concise agent handoff.

Screenshots are not required. The file includes the page URL, route, rectangle,
viewport, scroll position, and stable DOM evidence when it can be captured.

## Try it without changing the original tool

1. Check out the `experiment/redline-shared-review` branch or use its isolated
   worktree.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this branch's `extension` directory.
5. Pin **Redline shared review** to the toolbar.
6. Open a normal `http`, `https`, or permitted `file` page and choose the Redline
   toolbar icon.

For local `file://` pages, enable **Allow access to file URLs** in the extension's
details. Chrome does not permit extensions to annotate browser-internal pages or
the Chrome Web Store.

## Share a review

- **Export review** downloads one portable `.redline.json` data file. It contains
  no executable overlay source.
- Send that file to the recipient through any channel you already use.
- The recipient installs the same reviewed extension revision, opens their running
  version of the product, and chooses **Import review**.
- **Locate** repositions the matching annotation on the current route. If the DOM
  changed, Redline falls back to its captured page rectangle.
- **Copy for agent** is enabled only after **Fix with agent** is selected. It
  copies only visible, allowlisted review fields and a short implementation
  instruction; unknown imported fields never enter the agent prompt.

## Privacy and recovery

- Reviews stay in `chrome.storage.local` until you explicitly export or copy them.
- A review can include URLs, visible text, accessible names, test IDs, and CSS
  selectors. Avoid sensitive production data unless sharing that evidence is
  acceptable.
- Invalid or future-version stored data is not silently overwritten. Redline keeps
  a recovery copy and exposes **Export original data** before starting over.
- Page capture and panel edits are serialized through the extension service worker,
  so a new annotation cannot overwrite a simultaneous title or triage edit.
- The extension requests only `activeTab`, `scripting`, `storage`, and `sidePanel`.
  It has no persistent host access and no network service.

## Test

Requirements: Node 22+ and Chrome/Chromium.

```sh
npm test
```

The committed tests cover the original overlay regressions, the portable review
schema, selector escaping, serialized concurrent mutations, intent-gated agent
handoff, and the extension manifest/security contract.

## Experiment files

- `extension/manifest.json`: Chrome Manifest V3 entry point.
- `extension/content.js`: one-shot live-page annotation overlay.
- `extension/sidepanel.html`: recipient triage and handoff UI.
- `extension/shared.js`: portable review schema and immutable mutations.
- `extension/targeting.js`: safe CSS target evidence helpers.
- `DESIGN.md`: product and interaction contract for this branch.
