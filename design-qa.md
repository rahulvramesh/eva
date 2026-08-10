# Eva Native Vibrancy and Appearance Design QA

- Source visual truth: `/var/folders/52/j35mntw55kb4sz70shw0f5s80000gn/T/codex-clipboard-d0fde5ac-5e42-4435-b251-11f983ed6e4a.png`
- Packaged dark implementation: `/Users/rahulvramesh/workspace/eva/design-electron-dark.png`
- Packaged light implementation: `/Users/rahulvramesh/workspace/eva/design-electron-light.png`
- Browser light implementation: `/Users/rahulvramesh/workspace/eva/design-light-browser.png`
- Combined dark comparison: `/Users/rahulvramesh/workspace/eva/design-comparison-vibrancy.png`
- Reference pixels: 1594 × 1534; normalized reference window crop: 824 × 770
- Packaged implementation window: 653 × 770 pixels and CSS pixels at 1× density
- Browser viewport: 1028 × 964 CSS pixels at device scale factor 1
- State: real packaged Electron window over macOS desktop material; settings open; Light and Dark each selected and captured

## Findings

No actionable P0, P1, or P2 mismatches remain.

- Fonts and typography: The existing compact native sans-serif hierarchy is preserved in both themes. Light mode maintains readable dark text, muted metadata, and semibold control values.
- Spacing and layout rhythm: Native vibrancy did not change frame bounds, corner radius, header geometry, composer position, settings anchoring, or persistent footer controls.
- Colors and visual tokens: Dark mode uses a translucent charcoal tint over native `under-window` vibrancy, matching the reference's softened desktop material. Light mode uses a translucent pale material with higher-opacity raised controls. Both maintain visible borders and focus states.
- Image quality and asset fidelity: Existing raster Eva identity and Phosphor interface icons remain sharp. No new placeholder, CSS illustration, handcrafted SVG, or simulated wallpaper was introduced.
- Copy and content: The added `Appearance` control clearly offers `Light` and `Dark`; all model, reasoning, system-instruction, and shortcut copy remains unchanged.

## Full-view comparison evidence

`design-comparison-vibrancy.png` places the reference window and the packaged dark Electron capture at the same 770 px height. The window tint, rounded perimeter, low-contrast chrome, translucent composer, and subdued dark material follow the source. The implementation remains compact rather than adopting the reference's enlarged saved bounds.

## Focused-region comparison evidence

The packaged Light and Dark screenshots keep the appearance switch and settings fields readable. The final settings card is deliberately opaque above the translucent window material, preventing message text from bleeding through while preserving the layered Raycast-like effect around it.

## Comparison history

1. Initial native capture: `under-window` vibrancy was enabled, but the renderer tint at 82% opacity hid most of the material effect.
2. Fix: reduced the macOS window tint to 52% opacity and made controls separately translucent; the packaged dark window now shows the native softened material.
3. Initial light capture: the settings card remained translucent enough for chat text to bleed through, a P2 readability issue.
4. Fix: kept the main light window at 62% opacity while making the settings card opaque. Post-fix `design-electron-light.png` shows clean field readability with the surrounding window still translucent.

## Interaction and runtime checks

- Light and Dark buttons update their pressed accessibility state in the packaged app.
- Electron receives the renderer theme over validated IPC and updates `nativeTheme.themeSource`.
- Light preference survived browser reload; packaged preference survived app relaunch.
- macOS packaged window uses `vibrancy: under-window` and `visualEffectState: active`.
- Windows path uses Electron acrylic material; Linux/browser retain a solid safe fallback.
- Browser console checked after theme interaction: no errors or warnings.
- `pnpm check`: 8 tests passed, typecheck passed, production build passed.
- `pnpm package`: unsigned arm64 macOS app created successfully.

## Follow-up polish

- P3: A third `System` appearance choice could be added later if automatic OS-theme following is desired.

final result: passed
