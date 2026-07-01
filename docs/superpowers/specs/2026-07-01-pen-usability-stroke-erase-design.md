# 펜 사용성 개선 & 지우개 획 지우기 — 설계 문서

- 날짜: 2026-07-01
- 브랜치: premier0.1
- 대상 컴포넌트: `src/components/PDFViewer.tsx` (필기 캔버스 단일 컴포넌트)

## 1. 배경 / 목표

학생·교사 필기 캔버스(`PDFViewer.tsx`)에 두 가지 사용성 개선을 추가한다.

1. **펜 사용성 개선 + PC 커서 개편**: PC(마우스)에서 커서가 십자(`crosshair`)가 아니라 실제 필기 도구 모양(펜/형광펜 아이콘, 지우개는 크기 링)으로 보이게 한다.
2. **지우개 획 지우기(stroke erase)**: 기존 부분 지우기(픽셀 마스크)는 유지하면서, 닿은 획 전체를 제거하는 "획 지우기" 모드를 추가한다. 획 지우기는 되돌리기(undo)와 연동된다.

## 2. 현재 구조 (요약)

- 필기 모드: `'click' | 'pen' | 'highlighter' | 'eraser'` (`drawingMode` state).
- 획 저장: `drawings[pageNumber]`는 `string[]`, 각 항목은 JSON `{ mode, color, width, points: {x,y}[] }`. 좌표는 0–1 정규화.
- 지우개: `applyStrokeStyle`에서 `ctx.globalCompositeOperation = 'destination-out'` (픽셀 마스크). 지우개도 하나의 획으로 배열에 append 되어 아래 획을 가림 — 저장된 아래 획 자체는 제거되지 않음.
- 되돌리기: 페이지별 `undoStack` / `redoStack` (`Record<number, string[][]>`). 새 획 완료 시 이전 배열을 undo에 push, redo 클리어.
- 커서(현재, line 854):
  ```
  cursor: canEditDrawing ? (pen|highlighter ? 'crosshair' : eraser ? 'cell' : 'default') : 'default'
  ```
- 포인터: `onPointerDown/Move/Up/Cancel`. `getPos`가 clientXY → 정규화 좌표 반환. `pointerType==='pen'`이면 click 모드에서도 pen으로 승격.

## 3. 설계

### 3.1 커서 전면 개편

| 모드 | 현재 | 변경 후 |
|------|------|---------|
| 펜 | `crosshair` | 펜 아이콘 SVG 커서, 선택한 `penColor`로 tint, hotspot = 촉 끝 |
| 형광펜 | `crosshair` | 형광펜 아이콘 SVG 커서(고정 노랑 계열), hotspot = 촉 끝 |
| 지우개 | `cell` | `cursor: none` + DOM 원형 링 오버레이 (지름 = `eraserWidth` CSS px) |
| 선택(click) | `default` | `default` 유지 |
| 읽기전용 | `default` | `default` 유지 |

**펜/형광펜 커서**
- 32×32 SVG를 `data:image/svg+xml,...` URI로 인코딩. `#`는 반드시 `%23`로, 따옴표/`<`/`>`/공백도 인코딩.
- CSS: `cursor: url("data:...") <hotspotX> <hotspotY>, crosshair` (키워드 폴백 필수).
- hotspot은 아이콘의 필기 촉 픽셀(예: 좌하단 근처)로 지정, 정수 0–31.
- 펜은 `penColor`가 바뀌면 문자열 재생성 → `useMemo([penColor])`.

**지우개 링 오버레이**
- CSS 이미지 커서는 브라우저에서 ~32px 상한이라 `eraserWidth`(최대 42px)를 정확히 표현 불가 → **`containerRef` 내부 절대배치 `div`**로 구현.
- 지름 = `eraserWidth` CSS px. 캔버스 lineWidth가 rect CSS px 기준(ctx transform=dpr)이므로 링 지름 = 화면상 실제 지워지는 크기와 일치. 줌(scale)과 무관하게 일관.
- 위치는 `pointermove`에서 **ref로 style 직접 갱신**(setState 리렌더 없음). `pointerenter`에 표시, `pointerleave`/모드 이탈 시 숨김.
- 시각 구분: **부분 지우기 = 실선(회색) 링**, **획 지우기 = 점선(빨강 tint) 링**.
- `pointer-events: none`, `zIndex`는 캔버스(10)보다 위, 마커(20)보다 아래(예: 15).
- 터치/펜 포인터에서는 커서 개념이 없어 링은 누르는 동안에만 노출되며, 데스크톱 사용성에 초점.

### 3.2 지우개 부분/획 토글

- 새 state: `eraserMode: 'pixel' | 'stroke'`, **기본값 `'stroke'`**.
- 지우개 선택 시 툴바에 세그먼트 토글 `[부분 지우기] [획 지우기]` 노출. 기존 `pdf-tool-group`/`pdf-tool-button` 스타일 재사용 + 최소 `globals.css` 추가.
- 굵기 슬라이더는 **두 모드 공통 `eraserWidth`** 사용:
  - 부분 지우기: 칠하는 두께(현행).
  - 획 지우기: 기본 hit 반경(`eraserWidth/2`)로 사용. → 링이 항상 `eraserWidth`를 그대로 표현.

**부분 지우기(pixel)** — 현행 `destination-out` 로직 그대로. 지우개 획을 배열에 append.

**획 지우기(stroke)** — 닿은 획 전체를 `drawings[pageNumber]`에서 제거.
- 히트 판정:
  1. 각 저장 획 파싱, 정규화 points를 `rect.width/height`로 곱해 CSS px 변환.
  2. 포인터 px에서 각 선분까지 최단거리 계산.
  3. 거리 ≤ `eraserWidth/2 + (획 width)/2`이면 삭제 대상.
  4. 각 획 bounding box로 조기 컷(성능).
- 대상 제외: `mode === 'eraser'` 획은 획 지우기 대상에서 제외("지우기를 지우기" 혼란 방지).
- **되돌리기 연동(요청: "되돌리기의 일부 기능")**:
  - `pointerdown`(stroke) 시 현재 배열을 `strokeEraseBaselineRef`에 스냅샷, `changed=false`.
  - 드래그 중 매치되는 획을 즉시 제거하고 `onDrawingsChange` 호출(화면 즉시 반영). stale closure 방지를 위해 드래그 중 작업 배열은 `liveStrokesRef`로 유지·갱신.
  - `pointerup` 시 변화가 있었으면 baseline을 `undoStack`에 **1회 push**, `redoStack` 클리어. → 한 드래그 = 한 undo 스텝.

### 3.3 포인터 핸들러 흐름 변경

- 통합 move 핸들러: 상단에서 (지우개 모드면) 링 위치 갱신 → 이후 기존 그리기/획지우기 분기.
- `startDrawing`: `drawingMode==='eraser' && eraserMode==='stroke'`면 픽셀 그리기 대신 stroke-erase 경로(baseline 스냅샷 + 첫 히트 처리).
- `draw`(move): stroke-erase면 히트한 획 제거, 아니면 현행 픽셀/펜 렌더.
- `stopDrawing`: stroke-erase면 undo push(변화 시), 아니면 현행 획 저장.
- 펜 포인터 승격(`pointerType==='pen'`) 로직 유지.

## 4. 코드 구조 & 분리

순수 함수를 분리해 단위 테스트(TDD) 가능하게 한다.

- `src/lib/strokeGeometry.ts`
  - `distanceToSegmentPx(px, ax, ay, bx, by): number` — 점-선분 최단거리.
  - `strokeHitTest(pointerPx, strokePointsPx, radiusPx): boolean` — 획 히트 여부(bbox 조기 컷 포함).
  - 입력은 px 좌표(정규화→px 변환은 호출측에서 rect로).
- `src/lib/drawingCursors.ts`
  - `buildPenCursor(color): string` — 펜 커서 CSS 값(인코딩·hotspot 포함, 키워드 폴백).
  - `buildHighlighterCursor(): string` — 형광펜 커서 CSS 값.
- `src/components/PDFViewer.tsx`
  - 위 함수 사용, `eraserMode` state, 링 오버레이 DOM/ref, 툴바 토글 렌더.
- `src/app/globals.css`
  - 세그먼트 토글 최소 스타일(활성/비활성).

## 5. 데이터 / 하위호환

- 저장 포맷(`PdfDrawings = Record<number, string[]>`, 획 JSON 스키마) **변경 없음**.
- `onDrawingsChange(page, paths)` 시그니처 **변경 없음** — 획 지우기도 필터된 `string[]`를 그대로 전달.
- `solve/[id]/page.tsx`, `student/review/[attemptId]/page.tsx`, IndexedDB 저장 로직 **변경 없음**.
- 읽기전용(`readOnlyDrawings`) 경로 영향 없음(커서/툴바는 `canEditDrawing`에서만).

## 6. 테스트

- 단위(vitest):
  - `strokeGeometry`: 선분 위/근처/먼 점, 끝점, 반경 경계, bbox 컷 케이스.
  - `drawingCursors`: 반환 문자열에 `%23`(색 인코딩) 포함, hotspot 좌표, 폴백 키워드 존재.
- 회귀: 기존 `uiSurface.test.ts` 등 필기 툴바 관련 서페이스 테스트가 깨지지 않는지 확인, 필요 시 토글 버튼 반영.
- E2E(Playwright, `e2e/pdf-drawing-toolbar.spec.ts`): 지우개 선택 시 `부분/획` 토글 노출·기본 `획`·토글 전환·툴 전환 시 숨김, 펜 커서가 SVG data-URI(`url(...image/svg...)`)·지우개 커서 `none`, 그리고 **획 지우기 제스처 → 획 삭제 → Cmd/Ctrl+Z 복원**을 오버레이 캔버스 픽셀 카운트로 검증(합성 포인터 이벤트 사용). 선택자는 `data-testid`(`pdf-draw-overlay`, `pdf-eraser-ring`)로 안정화.

## 7. 엣지 케이스

- 획 지우기 드래그가 아무 획도 안 건드리면 undo push 없음.
- 한 드래그에서 여러 획 삭제 → undo 1회로 전부 복원.
- 빈 페이지에서 획 지우기 → 무동작.
- 줌 변경 중 링 크기 = `eraserWidth` 유지(화면 px 기준).
- 색 커스텀 피커로 임의 색 선택 시에도 펜 커서 tint 반영.
- Safari SVG 커서: 인코딩/사이즈 명시 + 키워드 폴백으로 안전.

## 8. 범위 밖 (YAGNI)

- 획 지우기 hit 반경 별도 슬라이더(당분간 `eraserWidth` 재사용).
- 지우개 마스크 획 자체의 획 지우기.
- 압력(pressure) 기반 굵기.
- 획 지우기 hover 시 삭제 예정 획 하이라이트(링으로 충분, 추후 개선 여지).

## 9. 접근성 (Accessibility)

- **포커스 표시**: 모든 필기 툴 버튼(`.pdf-tool-button`), 색상 스와치(`.pdf-color-swatch`), 그리고 `부분/획` 토글(`.pdf-seg-button`)에 `:focus-visible` 아웃라인 제공 → 키보드/스위치 사용자가 현재 포커스를 인지 가능.
- **토글 라벨**: `부분/획` 버튼은 시각 라벨이 한 글자라 의미가 모호 → 각 버튼에 명시적 `aria-label`(`"획 지우기: 닿은 획 전체 삭제"` / `"부분 지우기"`) 부여. `role="group" aria-label="지우개 방식"` 유지, `aria-pressed`로 현재 모드 안내. (마우스 전용 `title`에만 의존하지 않음.)
- **범위 밖(추후 개선 여지)**: 토글의 roving-tabindex/화살표 키 네비게이션(현재 Tab+Enter로 조작 가능), 툴 버튼 접근명에 역할 접미사(`'펜 도구'` 등), 터치에서 지우개 링을 pointerdown 시 즉시 노출, 스크린리더용 획 삭제 실시간 안내.
- **성능**: 획 지우기 드래그는 시작 시 각 획을 1회만 파싱해 캐시(`eraseDragStrokesRef`) → pointermove마다 전체 재파싱 제거(밀도 높은 페이지의 잭 방지).
