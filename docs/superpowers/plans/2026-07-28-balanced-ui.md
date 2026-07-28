# Balanced UI/UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved B · Balanced visual contract and raise UI/UX to at least 85 through hierarchy, emphasis, spacing, restrained motion, and accessible interaction.

**Architecture:** Add semantic visual tokens to the existing CSS-variable design system, then migrate only the four representative journeys: teacher dashboard, exam creation, student solve, and student review. Reuse a focused dialog hook instead of rewriting pages.

**Tech Stack:** React 19, Next.js App Router, CSS variables, Vitest, Playwright

---

## File map

- `src/app/globals.css`: hierarchy, spacing, elevation, and motion tokens.
- `src/app/page.tsx`: main landmark and visible level-one role heading.
- `src/app/create/page.tsx`: accessible upload actions and mobile primary action.
- `src/components/AnswerImportModal.tsx`: accessible file action and dialog focus contract.
- `src/hooks/useDialogFocus.ts`: initial focus, focus trap, Escape, focus return.
- `src/app/manifest.ts`: installation orientation follows device.
- `src/lib/uiSurface.test.ts`: static semantic contract.
- `e2e/ui-ux-audit.spec.ts`, `e2e/teacher-mobile.spec.ts`: rendered UI contract.

### Task 1: Add Balanced visual tokens

**Files:**
- Modify: `src/app/globals.css`
- Test: `src/lib/uiSurface.test.ts`

- [ ] **Step 1: Write the failing token contract**

Add expectations:

```ts
expect(css).toContain("--space-related: 1rem");
expect(css).toContain("--space-card: 1.5rem");
expect(css).toContain("--space-section: 2.5rem");
expect(css).toContain("--motion-hover: 160ms");
expect(css).toContain("--motion-panel: 210ms");
expect(css).toContain("--text-body-min: 1rem");
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/lib/uiSurface.test.ts
```

Expected: FAIL because Balanced tokens do not exist.

- [ ] **Step 3: Define the tokens**

Add to `:root`:

```css
--space-related: 1rem;
--space-card: 1.5rem;
--space-section: 2.5rem;
--motion-hover: 160ms;
--motion-panel: 210ms;
--motion-distance: 0.375rem;
--ease-balanced: cubic-bezier(0.2, 0.8, 0.2, 1);
--text-body-min: 1rem;
--text-caption-min: 0.8125rem;
--shadow-action: 0 8px 18px rgb(37 99 235 / 20%);
```

Add a reduced-motion rule that sets both motion durations to `1ms`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run src/lib/uiSurface.test.ts
git add src/app/globals.css src/lib/uiSurface.test.ts
git commit -m "style: add balanced hierarchy and motion tokens"
```

### Task 2: Establish page landmarks and heading hierarchy

**Files:**
- Modify: `src/app/page.tsx`
- Test: `src/lib/uiSurface.test.ts`
- Modify: `e2e/ui-ux-audit.spec.ts`

- [ ] **Step 1: Write failing semantic assertions**

Assert the home source contains:

```ts
expect(homePage).toContain("<main");
expect(homePage).toMatch(/<h1[^>]*>/);
```

Add browser assertions:

```ts
await expect(page.locator("main")).toHaveCount(1);
await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/uiSurface.test.ts
npx playwright test e2e/ui-ux-audit.spec.ts --project=chromium --grep "landmark"
```

- [ ] **Step 3: Implement semantic structure**

Wrap the role-selection/login content in:

```tsx
<main id="main-content" className="landing-main">
```

Use one visible `<h1>` per active role state. Keep decorative product branding outside the heading hierarchy.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/uiSurface.test.ts
npx playwright test e2e/ui-ux-audit.spec.ts --project=chromium --grep "landmark"
git add src/app/page.tsx src/lib/uiSurface.test.ts e2e/ui-ux-audit.spec.ts
git commit -m "fix: add semantic landing hierarchy"
```

### Task 3: Make upload actions keyboard accessible

**Files:**
- Modify: `src/app/create/page.tsx`
- Modify: `src/components/AnswerImportModal.tsx`
- Test: `src/components/AnswerImportModal.test.tsx`
- Modify: `e2e/teacher-pages.spec.ts`

- [ ] **Step 1: Write the failing file-action contract**

Export and test:

```ts
export function activateFilePicker(input: Pick<HTMLInputElement, "click">): void {
  input.click();
}
```

Browser contract:

```ts
const upload = page.getByRole("button", { name: "문제지 PDF 업로드" });
await upload.focus();
await page.keyboard.press("Enter");
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run src/components/AnswerImportModal.test.tsx
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "keyboard upload"
```

- [ ] **Step 3: Implement button-backed inputs**

Keep the file inputs visually hidden, reference them with `useRef<HTMLInputElement>`, and render:

```tsx
<button
  type="button"
  className="btn btn-secondary"
  onClick={() => pdfInputRef.current?.click()}
>
  문제지 PDF 업로드
</button>
```

Use the same contract for the answer-key PDF button.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/components/AnswerImportModal.test.tsx
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "keyboard upload"
git add src/app/create/page.tsx src/components/AnswerImportModal.tsx src/components/AnswerImportModal.test.tsx e2e/teacher-pages.spec.ts
git commit -m "fix: make PDF uploads keyboard operable"
```

### Task 4: Share the dialog focus contract

**Files:**
- Create: `src/hooks/useDialogFocus.ts`
- Create: `src/hooks/useDialogFocus.test.ts`
- Modify: `src/components/AnswerImportModal.tsx`
- Modify: `src/app/create/page.tsx`

- [ ] **Step 1: Write failing helper tests**

Test the exported selector and key decisions:

```ts
expect(DIALOG_FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
expect(resolveDialogKeyAction("Escape", false)).toBe("close");
expect(resolveDialogKeyAction("Tab", true)).toBe("wrap-first");
expect(resolveDialogKeyAction("Tab", false)).toBe("wrap-last");
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/hooks/useDialogFocus.test.ts
```

- [ ] **Step 3: Implement the hook**

Export:

```ts
export const DIALOG_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function resolveDialogKeyAction(
  key: string,
  atLast: boolean,
  atFirst = false,
): "close" | "wrap-first" | "wrap-last" | "none" {
  if (key === "Escape") return "close";
  if (key !== "Tab") return "none";
  if (atLast) return "wrap-first";
  if (atFirst) return "wrap-last";
  return "none";
}
```

The hook captures `document.activeElement`, focuses the first control, traps Tab, closes on Escape, and restores focus on cleanup.

- [ ] **Step 4: Apply it to answer import and settings reset dialogs**

Each dialog root gets `ref`, `tabIndex={-1}`, `aria-modal="true"`, and an `aria-labelledby` ID.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/hooks/useDialogFocus.test.ts src/components/AnswerImportModal.test.tsx
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "dialog focus"
git add src/hooks/useDialogFocus.ts src/hooks/useDialogFocus.test.ts src/components/AnswerImportModal.tsx src/app/create/page.tsx
git commit -m "fix: standardize dialog focus behavior"
```

### Task 5: Keep the mobile primary action visible

**Files:**
- Modify: `src/app/create/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/teacher-mobile.spec.ts`

- [ ] **Step 1: Write the failing mobile contract**

At 390×844:

```ts
const distribute = page.getByRole("button", { name: "배포하기" });
await expect(distribute).toBeInViewport();
const box = await distribute.boundingBox();
expect(box?.height).toBeGreaterThanOrEqual(44);
```

- [ ] **Step 2: Verify RED**

```bash
npx playwright test e2e/teacher-mobile.spec.ts --project=chromium --grep "primary create action"
```

- [ ] **Step 3: Implement the mobile action rail**

Move `배포하기` into a `.create-primary-actions` container and apply:

```css
@media (max-width: 640px) {
  .create-primary-actions {
    position: sticky;
    bottom: max(0.75rem, env(safe-area-inset-bottom));
    z-index: 30;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-related);
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: rgb(255 255 255 / 92%);
    backdrop-filter: blur(14px);
    box-shadow: var(--shadow-action);
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
npx playwright test e2e/teacher-mobile.spec.ts --project=chromium --grep "primary create action"
git add src/app/create/page.tsx src/app/globals.css e2e/teacher-mobile.spec.ts
git commit -m "fix: keep mobile distribution action visible"
```

### Task 6: Allow tablet landscape and verify restrained motion

**Files:**
- Modify: `src/app/manifest.ts`
- Modify: `src/lib/pwaAssets.test.ts`
- Modify: `e2e/tablet-layout.spec.ts`
- Modify: `e2e/ui-ux-audit.spec.ts`

- [ ] **Step 1: Write failing contracts**

```ts
expect(manifest.orientation).toBe("any");
```

Browser:

```ts
await page.emulateMedia({ reducedMotion: "reduce" });
const duration = await page.locator(".primary-action").evaluate(
  element => getComputedStyle(element).transitionDuration,
);
expect(["0s", "0.001s"]).toContain(duration);
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/pwaAssets.test.ts
npx playwright test e2e/tablet-layout.spec.ts e2e/ui-ux-audit.spec.ts --project=chromium --grep "orientation|reduced motion"
```

- [ ] **Step 3: Implement**

Set:

```ts
orientation: "any",
```

Apply Balanced motion tokens to primary actions, cards, modal panels, and tab indicators. Do not animate layout dimensions or continuous counters.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/pwaAssets.test.ts
npx playwright test e2e/tablet-layout.spec.ts e2e/ui-ux-audit.spec.ts --project=chromium --grep "orientation|reduced motion"
git add src/app/manifest.ts src/lib/pwaAssets.test.ts src/app/globals.css e2e/tablet-layout.spec.ts e2e/ui-ux-audit.spec.ts
git commit -m "style: support landscape and reduced motion"
```
