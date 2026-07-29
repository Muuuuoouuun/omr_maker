# Quality Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a clean fresh-clone baseline, remove stale E2E failures, patch high-risk production dependencies, and make those guarantees release gates.

**Architecture:** Keep product behavior unchanged unless a browser test proves a real regression. Align tests with current product contracts, add an explicit PDF-render readiness signal, and make dependency security a blocking CI concern.

**Tech Stack:** Next.js 16, React 19, Vitest, Playwright, GitHub Actions, npm audit

---

## File map

- `src/lib/nativePlatformAssets.test.ts`: tracks only the shipped iOS/web/desktop native surface.
- `e2e/full-journey.spec.ts`: exact result heading locators.
- `e2e/teacher-pages.spec.ts`: current 45-question presets and explicit mockup identity.
- `e2e/pdf-drawing-toolbar.spec.ts`: waits for PDF canvas readiness before pointer input.
- `src/components/PDFViewer.tsx`: exposes a stable rendered-canvas readiness marker.
- `package.json`, `package-lock.json`: patched Next/PostCSS/sharp dependency graph.
- `.github/workflows/ci.yml`: production audit gate and live database contract gate.

### Task 1: Make fresh-clone unit tests truthful

**Files:**
- Modify: `src/lib/nativePlatformAssets.test.ts`

- [ ] **Step 1: Run the failing fresh-worktree test**

Run:

```bash
npx vitest run src/lib/nativePlatformAssets.test.ts
```

Expected: FAIL because the repository intentionally does not ship `android/`.

- [ ] **Step 2: Remove Android-only assertions and rename the suite**

Replace the suite name with:

```ts
describe("Windows, iOS, and web native development surface", () => {
```

Delete the Android manifest/assets test and remove `existsSync` plus `readPngSize` when unused. Keep the native WebView and PWA prompt assertions because Capacitor remains used for the supported iOS shell.

- [ ] **Step 3: Verify the focused and full suites**

Run:

```bash
npx vitest run src/lib/nativePlatformAssets.test.ts
npm test
```

Expected: focused test passes; all 1,052 remaining tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nativePlatformAssets.test.ts
git commit -m "test: drop stale Android asset contract"
```

### Task 2: Patch production dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Capture the failing audit**

Run:

```bash
npm audit --omit=dev --audit-level=high
```

Expected: non-zero with vulnerable `next`, `postcss`, and `sharp`.

- [ ] **Step 2: Update the dependency contract**

Use these exact entries:

```json
{
  "dependencies": {
    "next": "^16.2.12",
    "sharp": "0.35.3"
  },
  "devDependencies": {
    "@next/env": "^16.2.12",
    "eslint-config-next": "^16.2.12"
  },
  "overrides": {
    "pdfjs-dist": "$pdfjs-dist",
    "postcss": "8.5.23",
    "sharp": "$sharp"
  },
  "engines": {
    "node": ">=20.9.0"
  }
}
```

Preserve every unrelated package and build setting.

- [ ] **Step 3: Regenerate the lockfile without running package scripts**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
npm ls next @next/env eslint-config-next postcss sharp
```

Expected: Next 16.2.12, PostCSS 8.5.23, sharp 0.35.3, with no duplicate sharp 0.34.x.

- [ ] **Step 4: Verify security and compatibility**

Run:

```bash
npm audit --omit=dev --audit-level=high
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Expected: audit exits 0 and all quality commands pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: patch production dependencies"
```

### Task 3: Align deterministic E2E contracts

**Files:**
- Modify: `e2e/full-journey.spec.ts`
- Modify: `e2e/teacher-pages.spec.ts`

- [ ] **Step 1: Prove the current focused failures**

Run:

```bash
npx playwright test e2e/full-journey.spec.ts e2e/teacher-pages.spec.ts --project=chromium \
  --grep "start-code student|creates an exam through|covers creation entry|keeps presets compact|renders timer|pause button|student table with mock data|demo roster keeps"
```

Expected: strict result-title failures, 5-vs-6 preset mismatch, and mock-data identity failures.

- [ ] **Step 2: Make result heading locators exact**

Replace every assertion of this form:

```ts
await expect(page.getByText("결과 리포트")).toBeVisible();
```

with:

```ts
await expect(page.getByText("결과 리포트", { exact: true })).toBeVisible();
```

- [ ] **Step 3: Align the 45-question preset test**

Use:

```ts
await expect(presetButtons).toHaveCount(6);
for (let index = 0; index < 6; index += 1) {
  const box = await presetButtons.nth(index).boundingBox();
  expect(box?.height).toBeLessThanOrEqual(36);
}
const lastPresetBox = await presetButtons.nth(5).boundingBox();
```

- [ ] **Step 4: Make teacher identity explicit**

Define:

```ts
const MOCKUP_TEACHER_IDENTITY = {
  teacherId: "omr-showcase",
  email: "showcase@example.com",
  displayName: "OMR Showcase",
};
```

Change the helper signature to:

```ts
async function authenticateTeacher(
  page: Page,
  baseURL?: string,
  identity = TEACHER_IDENTITY,
) {
  const token = mintTeacherToken();
  const session = createTeacherSession(token, Date.now(), identity);
  const signedCookie = createSignedTeacherSessionCookie(token, identity);
```

Call it with `MOCKUP_TEACHER_IDENTITY` only in synthetic LIVE and demo-roster tests. Keep normal CRUD tests on `admin`.

- [ ] **Step 5: Verify focused E2E**

Run the Step 1 command again.

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add e2e/full-journey.spec.ts e2e/teacher-pages.spec.ts
git commit -m "test: align e2e fixtures with current product contracts"
```

### Task 4: Stabilize PDF drawing readiness

**Files:**
- Modify: `src/components/PDFViewer.tsx`
- Modify: `e2e/pdf-drawing-toolbar.spec.ts`

- [ ] **Step 1: Reproduce the flaky contract**

Run:

```bash
npx playwright test e2e/pdf-drawing-toolbar.spec.ts --project=chromium \
  --grep "stroke-erase removes" --repeat-each=3
```

Expected: at least one failure where drawing begins before the backing canvas is ready.

- [ ] **Step 2: Expose render readiness**

On the element with `data-testid="pdf-draw-overlay"`, add:

```tsx
data-pdf-ready={pdfRenderReady ? "true" : "false"}
```

Set `pdfRenderReady` false before a page render and true only from the PDF page `onRenderSuccess` path after backing canvas dimensions are non-zero.

- [ ] **Step 3: Wait on the product signal**

Before pointer input, add:

```ts
await expect(overlay).toHaveAttribute("data-pdf-ready", "true");
await expect.poll(async () => overlay.evaluate((element) => {
  const canvas = element.querySelector("canvas");
  return canvas instanceof HTMLCanvasElement
    ? canvas.width * canvas.height
    : 0;
})).toBeGreaterThan(0);
```

- [ ] **Step 4: Verify repeatability**

Run the Step 1 command.

Expected: 3/3 pass in Chromium. Then run the same test under `webkit` and `webkit-ipad`.

- [ ] **Step 5: Commit**

```bash
git add src/components/PDFViewer.tsx e2e/pdf-drawing-toolbar.spec.ts
git commit -m "test: wait for PDF canvas before drawing gestures"
```

### Task 5: Make release gates blocking

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add production audit before install**

Add after `setup-node` in `lint-and-test`:

```yaml
- name: Production dependency audit
  run: npm audit --package-lock-only --omit=dev --audit-level=high
```

- [ ] **Step 2: Add the live database contract job**

Add:

```yaml
supabase-live-contract:
  name: Supabase live security contract
  runs-on: ubuntu-latest
  needs: lint-and-test
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"
    - run: npm ci
    - name: Run schema, RLS, and privilege assertions
      run: npm run test:supabase:live
```

- [ ] **Step 3: Validate workflow syntax and local gates**

Run:

```bash
npm audit --package-lock-only --omit=dev --audit-level=high
npm test
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate releases on audit and database contracts"
```
