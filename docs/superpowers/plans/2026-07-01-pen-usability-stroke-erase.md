# 펜 사용성 개선 & 지우개 획 지우기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PC(마우스) 커서를 필기 도구 아이콘/링으로 바꾸고, 지우개에 "부분/획 지우기" 토글을 추가한다. 획 지우기는 닿은 획 전체를 제거하며 되돌리기와 연동된다.

**Architecture:** 순수 기하/커서 로직을 `src/lib/strokeGeometry.ts`·`src/lib/drawingCursors.ts`로 분리해 단위 테스트하고, `src/components/PDFViewer.tsx`가 이를 사용해 커서·툴바 토글·획 지우기·지우개 링 오버레이를 구현한다. 저장 포맷과 `onDrawingsChange` 시그니처는 바뀌지 않는다(하위호환).

**Tech Stack:** Next.js 16, React 19, TypeScript, vitest, lucide-react, Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-07-01-pen-usability-stroke-erase-design.md`

---

## File Structure

- Create: `src/lib/strokeGeometry.ts` — 점-선분 거리, 획 히트 테스트(순수).
- Create: `src/lib/strokeGeometry.test.ts` — 위 함수 단위 테스트.
- Create: `src/lib/drawingCursors.ts` — 펜/형광펜 커서 CSS 문자열 빌더(순수).
- Create: `src/lib/drawingCursors.test.ts` — 인코딩/hotspot/폴백 단위 테스트.
- Modify: `src/components/PDFViewer.tsx` — 커서 적용, `eraserMode` 상태·툴바 토글, 획 지우기 포인터 로직, 지우개 링 오버레이.
- Modify: `src/app/globals.css` — 세그먼트 토글 스타일.

---

## Task 1: 획 지우기 기하 유틸 (strokeGeometry)

**Files:**
- Create: `src/lib/strokeGeometry.ts`
- Test: `src/lib/strokeGeometry.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/strokeGeometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { distanceToSegmentPx, strokeHitTest, type Point } from "./strokeGeometry";

describe("distanceToSegmentPx", () => {
    it("returns 0 for a point on the segment", () => {
        expect(distanceToSegmentPx(5, 0, 0, 0, 10, 0)).toBe(0);
    });

    it("returns perpendicular distance to the segment body", () => {
        expect(distanceToSegmentPx(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    });

    it("clamps to the nearest endpoint when beyond the segment", () => {
        // point is left of A(0,0); nearest is A, distance = 4
        expect(distanceToSegmentPx(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4);
    });

    it("handles a zero-length segment as distance to the point", () => {
        expect(distanceToSegmentPx(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
    });
});

describe("strokeHitTest", () => {
    const line: Point[] = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
    ];

    it("hits when pointer is within radius of a segment", () => {
        expect(strokeHitTest(50, 4, line, 6)).toBe(true);
    });

    it("misses when pointer is outside radius", () => {
        expect(strokeHitTest(50, 20, line, 6)).toBe(false);
    });

    it("early-outs via bounding box for far points", () => {
        expect(strokeHitTest(1000, 1000, line, 6)).toBe(false);
    });

    it("treats a single-point stroke as a dot", () => {
        expect(strokeHitTest(2, 0, [{ x: 0, y: 0 }], 3)).toBe(true);
        expect(strokeHitTest(10, 0, [{ x: 0, y: 0 }], 3)).toBe(false);
    });

    it("returns false for an empty stroke", () => {
        expect(strokeHitTest(0, 0, [], 5)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/strokeGeometry.test.ts`
Expected: FAIL — cannot find module `./strokeGeometry`.

- [ ] **Step 3: Write minimal implementation**

`src/lib/strokeGeometry.ts`:

```ts
export interface Point {
    x: number;
    y: number;
}

/** Shortest distance from point (px,py) to segment (ax,ay)-(bx,by), same units. */
export function distanceToSegmentPx(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

/**
 * True if pointer (pointerX,pointerY) is within radiusPx of any segment of the
 * stroke polyline. Coordinates are in the same (px) space. Uses a bounding-box
 * early-out; a single-point stroke is treated as a dot.
 */
export function strokeHitTest(
    pointerX: number,
    pointerY: number,
    strokePointsPx: Point[],
    radiusPx: number,
): boolean {
    if (strokePointsPx.length === 0) return false;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of strokePointsPx) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
    }
    if (
        pointerX < minX - radiusPx ||
        pointerX > maxX + radiusPx ||
        pointerY < minY - radiusPx ||
        pointerY > maxY + radiusPx
    ) {
        return false;
    }

    if (strokePointsPx.length === 1) {
        const only = strokePointsPx[0];
        return Math.hypot(pointerX - only.x, pointerY - only.y) <= radiusPx;
    }

    for (let i = 0; i < strokePointsPx.length - 1; i++) {
        const a = strokePointsPx[i];
        const b = strokePointsPx[i + 1];
        if (distanceToSegmentPx(pointerX, pointerY, a.x, a.y, b.x, b.y) <= radiusPx) {
            return true;
        }
    }
    return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/strokeGeometry.test.ts`
Expected: PASS (all 10 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strokeGeometry.ts src/lib/strokeGeometry.test.ts
git commit -m "feat: add stroke hit-testing geometry utils"
```

---

## Task 2: 커서 빌더 (drawingCursors)

**Files:**
- Create: `src/lib/drawingCursors.ts`
- Test: `src/lib/drawingCursors.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/drawingCursors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildHighlighterCursor, buildPenCursor } from "./drawingCursors";

describe("buildPenCursor", () => {
    it("embeds the color with # encoded as %23", () => {
        const cursor = buildPenCursor("#ef4444");
        expect(cursor).toContain("%23ef4444");
        expect(cursor).not.toContain("#ef4444");
    });

    it("is an SVG data URI with a hotspot and a keyword fallback", () => {
        const cursor = buildPenCursor("#111827");
        expect(cursor).toContain("data:image/svg+xml,");
        expect(cursor.trim().endsWith(", crosshair")).toBe(true);
        // hotspot: `url(...) X Y, crosshair`
        expect(cursor).toMatch(/\)\s+\d+\s+\d+,\s*crosshair$/);
    });

    it("contains no raw angle brackets (fully URL-encoded)", () => {
        const cursor = buildPenCursor("#16a34a");
        expect(cursor).not.toContain("<");
        expect(cursor).not.toContain(">");
    });
});

describe("buildHighlighterCursor", () => {
    it("is an SVG data URI with a keyword fallback and no raw #", () => {
        const cursor = buildHighlighterCursor();
        expect(cursor).toContain("data:image/svg+xml,");
        expect(cursor.trim().endsWith(", crosshair")).toBe(true);
        expect(cursor).not.toContain("#");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/drawingCursors.test.ts`
Expected: FAIL — cannot find module `./drawingCursors`.

- [ ] **Step 3: Write minimal implementation**

`src/lib/drawingCursors.ts`:

```ts
/** URL-encode an inline SVG for use in a CSS `cursor: url(...)` value. */
function encodeSvg(svg: string): string {
    return svg
        .replace(/"/g, "'")
        .replace(/%/g, "%25")
        .replace(/#/g, "%23")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/ /g, "%20");
}

/**
 * CSS `cursor` value showing a pen glyph tinted with `color`, hotspot at the
 * nib (bottom-left). Falls back to `crosshair`.
 */
export function buildPenCursor(color: string): string {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>` +
        `<path d='M22 3 L29 10 L12 27 L5 27 L5 20 Z' fill='${color}' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>` +
        `<path d='M5 27 L5 23 L9 27 Z' fill='#1f2937'/>` +
        `</svg>`;
    return `url("data:image/svg+xml,${encodeSvg(svg)}") 5 27, crosshair`;
}

/**
 * CSS `cursor` value showing a highlighter glyph, hotspot at the tip.
 * Falls back to `crosshair`.
 */
export function buildHighlighterCursor(): string {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>` +
        `<path d='M23 4 L28 9 L14 23 L8 23 L8 17 Z' fill='rgba(250,204,21,0.95)' stroke='white' stroke-width='1.5' stroke-linejoin='round'/>` +
        `</svg>`;
    return `url("data:image/svg+xml,${encodeSvg(svg)}") 8 23, crosshair`;
}
```

Note: `encodeSvg` replaces `"` with `'` inside the SVG, so the outer `url("...")` double-quotes stay valid. The `#1f2937` nib fill becomes `%231f2937`; `buildHighlighterCursor` uses only `rgba(...)` (no `#`), so the "no raw #" assertion holds.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/drawingCursors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/drawingCursors.ts src/lib/drawingCursors.test.ts
git commit -m "feat: add pen/highlighter cursor builders"
```

---

## Task 3: PDFViewer — 펜/형광펜 커서 적용

**Files:**
- Modify: `src/components/PDFViewer.tsx`

- [ ] **Step 1: Import useMemo and cursor builders**

At `src/components/PDFViewer.tsx:3`, change the React import to include `useMemo`:

```ts
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
```

Add after the lucide-react import block (after line 19, before the worker setup line 21–22):

```ts
import { buildPenCursor, buildHighlighterCursor } from '@/lib/drawingCursors';
```

- [ ] **Step 2: Compute cursor values**

Immediately after `const activeStrokeWidth = ...` block (ends at line 136), add:

```ts
    const penCursor = useMemo(() => buildPenCursor(penColor), [penColor]);
    const highlighterCursor = useMemo(() => buildHighlighterCursor(), []);
    const canvasCursor = !canEditDrawing
        ? 'default'
        : drawingMode === 'pen'
            ? penCursor
            : drawingMode === 'highlighter'
                ? highlighterCursor
                : drawingMode === 'eraser'
                    ? 'none' // ring overlay draws the eraser cursor (Task 6)
                    : 'default';
```

- [ ] **Step 3: Use canvasCursor in the canvas style**

Replace the `cursor:` line in the canvas `style` (currently line 854):

```ts
                                            cursor: canEditDrawing ? (drawingMode === 'pen' || drawingMode === 'highlighter' ? 'crosshair' : drawingMode === 'eraser' ? 'cell' : 'default') : 'default',
```

with:

```ts
                                            cursor: canvasCursor,
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors from `PDFViewer.tsx` (unused `canvasCursor` is now used). Note: `none` for eraser will show no cursor until Task 6 adds the ring — acceptable mid-plan.

- [ ] **Step 5: Commit**

```bash
git add src/components/PDFViewer.tsx
git commit -m "feat: pen/highlighter icon cursors in PDF viewer"
```

---

## Task 4: PDFViewer — 지우개 부분/획 토글 + CSS

**Files:**
- Modify: `src/components/PDFViewer.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add eraserMode state**

After `const [eraserWidth, setEraserWidth] = useState(22);` (line 111), add:

```ts
    const [eraserMode, setEraserMode] = useState<'pixel' | 'stroke'>('stroke');
```

- [ ] **Step 2: Render the segmented toggle in the toolbar**

In the toolbar, immediately AFTER the closing `</div>` of the tool group `role="toolbar"` (the group ends at line 673, `</div>` after the eraser button) and BEFORE the pen color swatches block (`{drawingMode === 'pen' && (` at line 675), insert:

```tsx
                                {drawingMode === 'eraser' && (
                                    <div className="pdf-eraser-toggle" role="group" aria-label="지우개 방식">
                                        <button
                                            type="button"
                                            className={`pdf-seg-button ${eraserMode === 'pixel' ? 'active' : ''}`}
                                            onClick={() => setEraserMode('pixel')}
                                            aria-pressed={eraserMode === 'pixel'}
                                            title="부분 지우기"
                                        >
                                            부분
                                        </button>
                                        <button
                                            type="button"
                                            className={`pdf-seg-button ${eraserMode === 'stroke' ? 'active' : ''}`}
                                            onClick={() => setEraserMode('stroke')}
                                            aria-pressed={eraserMode === 'stroke'}
                                            title="획 지우기 (닿은 획 전체 삭제)"
                                        >
                                            획
                                        </button>
                                    </div>
                                )}
```

- [ ] **Step 3: Add CSS for the toggle**

In `src/app/globals.css`, immediately after the `.pdf-tool-divider { ... }` rule (ends at line 3130), add:

```css
.pdf-eraser-toggle {
  display: inline-flex;
  align-items: center;
  height: 32px;
  border: 1px solid #555;
  border-radius: 8px;
  overflow: hidden;
  flex: 0 0 auto;
}

.pdf-seg-button {
  height: 32px;
  padding: 0 0.6rem;
  background: #222;
  color: white;
  font-size: 0.72rem;
  font-weight: 800;
  border: none;
  transition: background 0.15s, color 0.15s;
}

.pdf-seg-button + .pdf-seg-button {
  border-left: 1px solid #555;
}

.pdf-seg-button:hover {
  background: #33373b;
}

.pdf-seg-button.active {
  background: #4f46e5;
  color: white;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors. (`eraserMode`/`setEraserMode` used; stroke behavior wired in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/components/PDFViewer.tsx src/app/globals.css
git commit -m "feat: eraser pixel/stroke toggle UI"
```

---

## Task 5: PDFViewer — 획 지우기 포인터 로직 + 되돌리기 연동

**Files:**
- Modify: `src/components/PDFViewer.tsx`

- [ ] **Step 1: Import strokeHitTest**

Add to the existing cursor-builder import line (from Task 3):

```ts
import { buildPenCursor, buildHighlighterCursor } from '@/lib/drawingCursors';
import { strokeHitTest } from '@/lib/strokeGeometry';
```

- [ ] **Step 2: Add stroke-erase refs**

After `const activePointerIdRef = useRef<number | null>(null);` (line 121), add:

```ts
    const activeEraserModeRef = useRef<'pixel' | 'stroke'>('stroke');
    const strokeEraseBaselineRef = useRef<string[] | null>(null);
    const strokeEraseChangedRef = useRef<boolean>(false);
    const liveStrokesRef = useRef<string[] | null>(null);
```

- [ ] **Step 3: Add the eraseStrokesAt helper**

Immediately BEFORE `const startDrawing = ...` (line 456), add:

```ts
    const eraseStrokesAt = (pos: DrawPoint) => {
        if (!onDrawingsChange || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const source = liveStrokesRef.current ?? (drawings[pageNumber] || []);
        const pointerX = pos.x * rect.width;
        const pointerY = pos.y * rect.height;
        const baseRadius = eraserWidth / 2;

        const kept: string[] = [];
        let removed = false;
        for (const pathStr of source) {
            let hit = false;
            try {
                const data = JSON.parse(pathStr);
                if (data.mode !== 'eraser' && Array.isArray(data.points) && data.points.length > 0) {
                    const pts = (data.points as DrawPoint[]).map(p => ({
                        x: p.x * rect.width,
                        y: p.y * rect.height,
                    }));
                    const radius = baseRadius + (typeof data.width === 'number' ? data.width / 2 : 1);
                    hit = strokeHitTest(pointerX, pointerY, pts, radius);
                }
            } catch {
                hit = false;
            }
            if (hit) removed = true;
            else kept.push(pathStr);
        }

        if (removed) {
            liveStrokesRef.current = kept;
            strokeEraseChangedRef.current = true;
            onDrawingsChange(pageNumber, kept);
        }
    };
```

- [ ] **Step 4: Branch startDrawing into stroke-erase**

Replace the final two lines of `startDrawing` (currently lines 466–467):

```ts
        if (e.pointerType === 'pen' && drawingMode === 'click') setDrawingMode('pen');
        currentPathRef.current = [getPos(e)];
```

with:

```ts
        if (e.pointerType === 'pen' && drawingMode === 'click') setDrawingMode('pen');

        if (pointerDrawingMode === 'eraser' && eraserMode === 'stroke') {
            activeEraserModeRef.current = 'stroke';
            const baseline = drawings[pageNumber] || [];
            strokeEraseBaselineRef.current = baseline;
            liveStrokesRef.current = baseline;
            strokeEraseChangedRef.current = false;
            const pos = getPos(e);
            currentPathRef.current = [pos];
            eraseStrokesAt(pos);
            return;
        }

        activeEraserModeRef.current = 'pixel';
        currentPathRef.current = [getPos(e)];
```

- [ ] **Step 5: Branch draw into stroke-erase**

In `draw`, immediately after `e.preventDefault();` (line 472) and before `const pos = getPos(e);` (line 474), insert a stroke-erase branch. Replace:

```ts
        e.preventDefault();

        const pos = getPos(e);
        const path = currentPathRef.current;
```

with:

```ts
        e.preventDefault();

        if (activeDrawingModeRef.current === 'eraser' && activeEraserModeRef.current === 'stroke') {
            eraseStrokesAt(getPos(e));
            return;
        }

        const pos = getPos(e);
        const path = currentPathRef.current;
```

- [ ] **Step 6: Branch stopDrawing into stroke-erase**

In `stopDrawing`, immediately after `setIsDrawing(false);` (line 511) and before `const finishedPath = currentPathRef.current;` (line 513), insert:

```ts
        if (activeDrawingModeRef.current === 'eraser' && activeEraserModeRef.current === 'stroke') {
            if (strokeEraseChangedRef.current && strokeEraseBaselineRef.current) {
                const baseline = strokeEraseBaselineRef.current;
                setUndoStack(prev => ({
                    ...prev,
                    [pageNumber]: [...(prev[pageNumber] || []), baseline],
                }));
                setRedoStack(prev => ({
                    ...prev,
                    [pageNumber]: [],
                }));
            }
            strokeEraseBaselineRef.current = null;
            liveStrokesRef.current = null;
            strokeEraseChangedRef.current = false;
            currentPathRef.current = [];
            return;
        }

```

- [ ] **Step 7: Verify it compiles and unit tests still pass**

Run: `npx tsc --noEmit && npx vitest run src/lib`
Expected: no type errors; lib tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/PDFViewer.tsx
git commit -m "feat: stroke-erase removes whole strokes with single-step undo"
```

---

## Task 6: PDFViewer — 지우개 링 오버레이

**Files:**
- Modify: `src/components/PDFViewer.tsx`

- [ ] **Step 1: Add the ring ref**

After `const canvasRef = useRef<HTMLCanvasElement>(null);` (line 128), add:

```ts
    const eraserRingRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 2: Add ring pointer handlers**

Immediately BEFORE `const getPos = ...` (line 540), add:

```ts
    const updateEraserRing = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const ring = eraserRingRef.current;
        if (!ring || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        ring.style.left = `${e.clientX - rect.left}px`;
        ring.style.top = `${e.clientY - rect.top}px`;
        ring.style.display = 'block';
    };

    const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (canEditDrawing && drawingMode === 'eraser') updateEraserRing(e);
        draw(e);
    };

    const handleCanvasPointerEnter = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (canEditDrawing && drawingMode === 'eraser') updateEraserRing(e);
    };

    const handleCanvasPointerLeave = () => {
        if (eraserRingRef.current) eraserRingRef.current.style.display = 'none';
    };
```

- [ ] **Step 3: Wire the canvas handlers**

Replace the canvas's pointer props (currently lines 845–848):

```tsx
                                        onPointerDown={startDrawing}
                                        onPointerMove={draw}
                                        onPointerUp={stopDrawing}
                                        onPointerCancel={stopDrawing}
```

with:

```tsx
                                        onPointerDown={startDrawing}
                                        onPointerMove={handleCanvasPointerMove}
                                        onPointerUp={stopDrawing}
                                        onPointerCancel={stopDrawing}
                                        onPointerEnter={handleCanvasPointerEnter}
                                        onPointerLeave={handleCanvasPointerLeave}
```

- [ ] **Step 4: Render the ring overlay**

Immediately AFTER the closing `/>` of the `<canvas ... />` element and its wrapping `)}` (the `shouldRenderDrawingLayer && (...)` block ends at line 859), insert:

```tsx
                                {canEditDrawing && drawingMode === 'eraser' && (
                                    <div
                                        ref={eraserRingRef}
                                        aria-hidden="true"
                                        style={{
                                            position: 'absolute',
                                            left: 0,
                                            top: 0,
                                            width: `${eraserWidth}px`,
                                            height: `${eraserWidth}px`,
                                            transform: 'translate(-50%, -50%)',
                                            borderRadius: '50%',
                                            border: eraserMode === 'stroke'
                                                ? '1.5px dashed rgba(239,68,68,0.95)'
                                                : '1.5px solid rgba(255,255,255,0.95)',
                                            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
                                            pointerEvents: 'none',
                                            zIndex: 15,
                                            display: 'none',
                                        }}
                                    />
                                )}
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/PDFViewer.tsx
git commit -m "feat: eraser size ring cursor overlay"
```

---

## Task 7: 전체 검증

**Files:** none (verification only)

- [ ] **Step 1: Lint + unit tests + typecheck**

Run: `npm run lint && npx tsc --noEmit && npm run test`
Expected: lint clean; no type errors; all vitest suites PASS (including the two new lib suites). If `src/lib/uiSurface.test.ts` or another surface test fails due to the new toolbar buttons, read the failure and update the expectation to include `부분`/`획` toggle text — do NOT weaken unrelated assertions.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Next.js build succeeds.

- [ ] **Step 3: Manual preview (solve flow)**

Start the dev server (`preview_start` with the project's dev config, or `npm run dev` on port 3003) and open a solve page that renders a PDF with drawing enabled. Verify:
- 펜/형광펜 선택 시 PC 커서가 해당 아이콘(펜은 선택 색) 모양.
- 지우개 선택 시 툴바에 `[부분][획]` 토글 노출, 기본 선택은 `획`. 마우스를 캔버스 위에 올리면 링이 따라오고, `획`은 빨강 점선/`부분`은 흰 실선.
- `획` 모드에서 펜 획 위를 드래그하면 그 획 전체가 사라지고, `Cmd/Ctrl+Z` 한 번으로 드래그 전체가 복원됨.
- `부분` 모드는 기존처럼 픽셀 단위로 지워짐.
- 굵기 슬라이더를 바꾸면 링 크기가 함께 변함.

Capture a screenshot as proof.

- [ ] **Step 4: Final commit (if any doc/fixups)**

```bash
git add -A
git commit -m "chore: finalize pen usability + stroke-erase" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** 커서 개편(§3.1)→Task 3+6; 부분/획 토글(§3.2)→Task 4; 획 지우기+undo(§3.2)→Task 5; 기하/커서 분리(§4)→Task 1+2; 하위호환(§5)→포맷/시그니처 미변경 확인; 테스트(§6)→Task 1/2/7. 모든 스펙 절이 태스크로 매핑됨.
- **Type consistency:** `eraserMode`(`'pixel'|'stroke'`)는 Task 4 상태·Task 5 로직·Task 6 링에서 동일 리터럴 유니온 사용. `strokeHitTest(pointerX,pointerY,Point[],radiusPx)` 시그니처는 Task 1 정의와 Task 5 호출 일치. `DrawPoint`(PDFViewer)와 `Point`(strokeGeometry)는 구조적 호환({x,y}).
- **Placeholders:** 없음 — 모든 코드 스텝에 실제 코드 포함.
