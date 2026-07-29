# Design

## Source of truth
- Status: Active for the `experiment/redline-shared-review` branch.
- Last refreshed: 2026-07-29.
- Primary product surfaces: in-page annotation overlay, recipient triage panel, portable review import/export, agent handoff.
- Evidence reviewed: `README.md`, `PLAN.md`, `AGENT.md`, `overlay.js`, `test/demo.html`, `test/screenshot.png`, and the original product context in `/Users/henrikhellstrom/tools/redline/PLAN.md`.

## Brand
- Personality: direct, calm, technical without looking like developer tooling.
- Trust signals: local-first, explicit capture state, visible save/share result, readable open format, no hidden upload.
- Avoid: project-management chrome, AI-generated wording, dashboard density, rounded playful annotation shapes, and technical metadata in the normal reviewer UI.

## Product goals
- Goals:
  - Replace screenshot annotation and the recipient's manual interpretation work.
  - Let a designer outline a problem on the live product and attach a short instruction.
  - Let a recipient reopen the review on their version of the app, see annotations in context, edit or remove low-priority items, and choose human or agent execution.
  - Preserve enough target evidence for an agent without making the human understand selectors or DOM internals.
  - Stay free, local-first, and shareable through GitHub.
- Non-goals:
  - General issue tracking, assignments, threaded comments, team analytics, cloud accounts, or a hosted collaboration backend.
  - A visual builder or autonomous design agent.
  - Screenshot-first review.
- Success signals:
  - The designer can annotate without leaving the live app.
  - A recipient can import one artifact and understand the review without interpreting separate screenshots.
  - Removing an item and exporting the accepted subset require no developer tooling.
  - An agent can consume accepted items without another translation step.

## Personas and jobs
- Primary personas:
  - Designer/reviewer: identifies UX, UI, visual, and bug problems in a live product.
  - Recipient/developer (William): reopens and triages the review, then chooses how accepted work is executed.
  - Coding agent: consumes accepted observations as structured tasks and verifies fixes.
- User jobs:
  - “Show exactly what is wrong and where, without preparing screenshots.”
  - “Review the designer's notes in my own running app and remove what is not relevant now.”
  - “Turn the accepted review into implementation tasks with minimal interpretation.”
- Key contexts of use:
  - Local development, preview deployments, authenticated product routes, modals, menus, and other transient UI states.

## Information architecture
- Primary navigation:
  - Browser action starts or reconnects Redline.
  - Side panel contains the complete review and all human decisions.
  - The page overlay appears only while drawing, locating, or highlighting an annotation.
- Core routes/screens:
  - Capture: current review, annotation count, one-shot Annotate action.
  - Triage: imported/current review grouped by route, editable annotations, Remove action, execution choice.
  - Share: export/import `.redline.json`, copy accepted items for an agent.
- Content hierarchy:
  - Review title and current app.
  - Primary actions: Annotate, Import/Export, Copy for agent.
  - Route groups derived from annotations.
  - Annotation instruction first; route and target evidence second; technical diagnostics hidden.

## Design principles
- Live context first: the running product is the review canvas. Images are optional fallback evidence, never the primary workflow.
- Observation, not view: every annotation is self-contained and persisted immediately; route groups are derived presentation.
- Human decision before automation: William triages the review before an agent receives accepted items.
- One obvious action per moment: browsing is default; Annotate arms exactly one drag and then returns to browsing.
- Portable data, installed runtime: shared artifacts contain review data and producer metadata, never executable overlay source.
- Local and inspectable: data stays in extension storage or an exported file unless the user explicitly shares it.
- Tradeoffs:
  - Prefer a Chrome-first extension experiment over immediate cross-browser abstraction.
  - Prefer stable semantic target evidence over private React Fiber metadata.
  - Keep the original single-file overlay as a separate proven implementation, not a compatibility constraint for this experiment.

## Visual language
- Color: neutral paper-white surfaces, near-black text, zinc/grey borders, one red annotation accent, green only for confirmed handoff success.
- Typography: system sans; 14px minimum for controls and body text; clear 12px metadata only when secondary and high-contrast.
- Spacing/layout rhythm: compact 4/8/12/16px rhythm; side panel designed for 320–420px width.
- Shape/radius/elevation: annotation frames and accent borders are square; controls and panels use subtle 4–6px radius; restrained shadows.
- Motion: brief highlight pulse and panel transitions only; no decorative motion.
- Imagery/iconography: text-first controls with small familiar symbols where they improve scanning; no custom illustration requirement.

## Components
- Existing components to reuse conceptually:
  - Numbered annotation frame.
  - Instruction textarea/popover.
  - Review count.
- New/changed components:
  - Browser action activation.
  - One-shot annotation overlay using Shadow DOM.
  - Side-panel review header and route groups.
  - Annotation row with Locate, Edit, and Remove.
  - Review intent selector: “Fix with agent” or “Send back to designer”.
  - Import/export and concise agent handoff.
- Variants and states:
  - Empty review, capturing, saved annotation, route mismatch, imported review, persistence error, copied/exported success.
- Token/component ownership:
  - Experimental extension owns its styles within Shadow DOM and extension pages; it must not reuse host-page CSS.

## Accessibility
- Target standard: WCAG 2.2 AA for extension UI and overlay controls.
- Keyboard/focus behavior:
  - All actions are native buttons/inputs.
  - `R` arms one annotation when focus is not in an editable field.
  - Escape cancels capture or closes the instruction editor.
  - Focus returns to the invoking control after dialogs/editing.
- Contrast/readability: 4.5:1 for normal text; annotation colors never carry meaning alone.
- Screen-reader semantics: named toolbar/regions, live save status, labeled annotation counts and route groups.
- Reduced motion and sensory considerations: highlight animation disabled under `prefers-reduced-motion`; frames retain a visible border without animation.

## Responsive behavior
- Supported breakpoints/devices: Chrome desktop is the experiment target; side panel remains usable from 320px width. Touch capture is retained where the browser exposes the extension on touch devices.
- Layout adaptations: side-panel actions wrap; annotation metadata collapses before instruction text.
- Touch/hover differences: 40px minimum primary targets; no hover-only actions.

## Interaction states
- Loading: short “Connecting to this tab…” status while the content script is attached.
- Empty: explain the two-step flow—Annotate on the page, then Share when ready.
- Error: preserve in-memory review and offer export; never claim a save or copy succeeded before it did.
- Success: unobtrusive confirmation for annotation saved, review imported/exported, or prompt copied.
- Disabled: Annotate disabled on restricted browser pages or when no supported tab is connected, with explanation.
- Offline/slow network: normal operation is fully local and must not require a network.

## Content voice
- Tone: short, calm, concrete.
- Terminology:
  - Annotation for a designer's individual note.
  - Review for the collection shared with a recipient.
  - Annotate, Locate, Remove, Import review, Export review, Copy for agent.
  - Avoid queue, archive, saved view, task orchestration, and technical protocol terms in human UI.
- Microcopy rules: sentence case; actions start with verbs; error messages state what remains safe and the recovery action.

## Implementation constraints
- Framework/styling system: Chrome Manifest V3 experiment, dependency-free runtime JavaScript/CSS/HTML; source may be split into modules/files.
- Design-token constraints: extension-owned CSS custom properties; host-page styles must not cross the Shadow DOM boundary.
- Performance constraints:
  - No full-document continuous scanning.
  - Target evidence captured only when an annotation is completed.
  - Route observation may update presentation but cannot determine data correctness.
- Compatibility constraints:
  - Chrome 116+ for explicit `sidePanel.open()` from the toolbar gesture.
  - Use `activeTab`, `scripting`, `sidePanel`, and `storage`; no broad host permissions by default.
  - Content script runs isolated; private framework internals are out of scope.
- Test/screenshot expectations:
  - Unit coverage for schema validation/import/export and storage mutations.
  - Real-Chrome coverage for injection idempotency, one-shot capture, route grouping, import/export, triage removal, and concise agent handoff.
  - Visual smoke screenshots for empty, populated, and imported side-panel states.

## Open questions
- [ ] Whether external handoff needs optional screenshot crops for transient same-route states; owner: product; impact: artifact size and privacy.
- [ ] Whether William should choose one review-level execution intent or decide per annotation; owner: product; impact: triage UI and schema.
- [ ] Whether Chrome Web Store distribution is worthwhile after the unpacked-extension experiment; owner: product; impact: installation and release process.
- [ ] Whether a later MCP adapter solves a proven handoff gap; owner: product; impact: local service and security surface.
