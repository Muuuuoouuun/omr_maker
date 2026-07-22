# Design QA — 문항 수 입력 겹침 수정

- Source visual truth: `/var/folders/l6/tx5c_hw97452y83gkpgpnxcr0000gn/T/TemporaryItems/NSIRD_screencaptureui_T9tL4A/스크린샷 2026-07-22 오전 9.14.39.png`
- Implementation screenshot: `/tmp/omr-question-count-overlap-fixed-mobile.png`
- Viewport: 320 × 800 CSS px
- Source pixels: 330 × 183 px
- Implementation pixels: 320 × 800 px
- Density normalization: implementation capture is 1 CSS px per image px; the source is a focused crop, so the comparison used the matching visible control region rather than full-frame scale.
- State: create editor settings, 45 questions, five-choice mode, direct-count input focused.

## Full-view comparison evidence

The implementation preserves the existing hierarchy, typography, button styling, colors, labels, and five-choice controls. At 320 px wide, all five presets and the direct input remain on one line without horizontal page overflow.

## Focused region comparison evidence

The source shows the `50` preset extending 11.95 px into the direct input (preset right edge 212.95 px; input left edge 201 px). After the fix, the `50` preset ends at 211.41 px and the input starts at 217 px, leaving 5.59 px of visible separation. Preset buttons remain approximately 34 × 34 px and the direct input remains 44 px high.

## Required fidelity surfaces

- Fonts and typography: unchanged; labels, button numerals, weight, line height, and input text remain consistent with the existing editor.
- Spacing and layout rhythm: passed; the collision is removed and the intended 0.35rem inter-control gap is visible.
- Colors and visual tokens: unchanged; selected, neutral, border, and focus tokens remain intact.
- Image quality and asset fidelity: no image assets are part of this control group; existing app iconography is unchanged.
- Copy and content: unchanged; presets remain `20/25/30/40/50`, direct input remains `45`, and `선택지 수` controls retain their labels.

## Comparison history

1. P1 — The `50` preset and direct-count input overlapped at 320 px, obscuring both controls.
2. Fix — Reduced the direct-input grid track from 5.25rem to 4.25rem and made the five preset tracks shrinkable with `minmax(0, 2.15rem)`.
3. Post-fix evidence — no bounding-box intersection, no horizontal overflow, `45` input commits successfully, and browser console has no errors or warnings on a fresh tab.

## Findings

No actionable P0, P1, or P2 findings remain in the requested control area.

final result: passed
