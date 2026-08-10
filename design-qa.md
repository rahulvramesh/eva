# Eva Tool-Call Timeline and Visibility Design QA

- Source visual truth: `/var/folders/52/j35mntw55kb4sz70shw0f5s80000gn/T/codex-clipboard-d439e5e5-d0de-4dd8-9a38-47bb242b5696.png`
- Normalized source: `/Users/rahulvramesh/workspace/eva/design-qa-reference.png`
- Transcript implementation: `/Users/rahulvramesh/workspace/eva/design-qa-tool-calls.png`
- Settings implementation: `/Users/rahulvramesh/workspace/eva/design-qa-settings.png`
- Source pixels: 936 × 1072 at an inferred Retina 2× density; normalized to 468 × 536.
- Implementation: 468 × 536 browser pixels and CSS pixels at device scale factor 1.
- State: dark compact chat, completed shell tool call, collapsed timeline row; Assistant Settings scrolled to the persistent tool-call visibility control.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: Eva retains the source's system sans-serif chat hierarchy and monospace command treatment. The compact tool row uses a stronger action label, muted command preview, and legible semantic completion state.
- Spacing and layout rhythm: The user prompt, tool row, and assistant response form one compact chronological group. The row aligns to the transcript width, uses the existing 12 px radius language, and does not displace the fixed composer.
- Colors and visual tokens: The row uses Eva's existing charcoal surfaces and low-contrast borders. Completed state uses a restrained green token; Light mode has explicit corresponding surface, text, and border tokens.
- Image quality and asset fidelity: Existing Eva raster identity remains unchanged. All tool, status, visibility, and disclosure icons use the project's Phosphor icon library; no placeholder, emoji, handcrafted SVG, or CSS illustration was introduced.
- Copy and content: `Ran command`, command preview, `Done`, `Input`, and `Output` clearly describe the tool lifecycle. Settings uses `Tool Call Details` with explicit `Show` and `Hide` choices plus scope copy.

## Full-view comparison evidence

The normalized source and final transcript capture were opened together at 468 × 536. Both preserve the dark compact assistant surface, right-aligned user bubble, uppercase speaker labels, soft gray borders, and native system typography. The new tool row intentionally occupies the missing activity position between the initiating user message and Eva's final response. Dynamic assistant copy differs because the implementation capture uses deterministic QA data rather than the user's real Claude diagnostic response.

## Focused-region comparison evidence

`design-qa-settings.png` verifies the settings control at the compact viewport. The popover remains inside the window, scrolls when its contents exceed available height, exposes both Show and Hide states, and distinguishes the instant display preference from model changes. The tool row was expanded during interaction QA to verify readable JSON input and multiline output, then captured collapsed for the final transcript comparison.

## Comparison history

1. Initial implementation: tool events were correctly rendered and the visibility choice persisted, but the footer still said `Applies to the next message`. This was a P2 ambiguity because the display preference changes immediately.
2. Fix: changed the footer to `Model changes apply to the next message`, changed the dialog label to `Assistant settings`, and increased command-preview contrast.
3. Post-fix evidence: the revised compact settings capture shows the instant Show/Hide preference separately from next-message model behavior; the revised transcript capture keeps the command preview readable without competing with the assistant response.

## Interaction and runtime checks

- Shell tool start, streaming update, completion, and persisted replay verified through the fake backend and server tests.
- Tool row expands to show structured input and full output, then collapses cleanly.
- Hide removes the tool row while keeping the assistant response visible.
- Hidden preference survived a browser reload; Show restored the row immediately.
- Compact settings popover measured 360 × 444 CSS pixels with vertical scrolling available for its 536 px content.
- Browser console checked after send, expand, Show/Hide, theme, and reload interactions: zero errors.
- `pnpm check`: typecheck passed, 14 tests passed, and production build passed.

## Follow-up Polish

- P3: Add elapsed time to completed tool rows once the backend records a reliable duration.

final result: passed
