# OMR Maker Figma Product Map Implementation Plan

> **Superseded (2026-07-27).** Tasks 1–7 below assume a Figma MCP connector
> (`whoami` / `create_new_file` / `use_figma`). That connector is unauthenticated
> in this environment, so the plan is not executable as written. The same
> artifact is now built through the Figma Plugin API instead — see
> [`tools/figma-product-map/`](../../../tools/figma-product-map/README.md).
> The content below is still the source of truth for *what* the file contains;
> only the delivery mechanism changed. Step 2 of Task 1 (create the file) is now
> a manual "new design file in Figma desktop" before running the plugin.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 OMR Maker의 웹/PWA 구조, 주요 화면, 사용자 흐름, 디자인 시스템을 하나의 편집 가능한 Figma 디자인 파일로 정리한다.

**Architecture:** 새 Figma Design 파일에 `00 Overview`, `01 Screen Inventory`, `02 User Flows`, `03 Design System` 네 페이지를 만든다. 빈 파일이므로 외부 라이브러리에 의존하지 않고 현재 코드의 토큰을 기반으로 문서용 프레임과 대표 화면을 Auto Layout으로 구성한다.

**Tech Stack:** Figma Design, Figma Plugin API (`use_figma`), OMR Maker Next.js App Router, CSS custom properties, Pretendard/Geist typography

---

### Task 1: Create and inspect the target Figma file

**Files:**
- Reference: `docs/superpowers/specs/2026-07-24-figma-product-map-design.md`
- Reference: `src/app/globals.css`
- Reference: `docs/design-system.md`

- [ ] **Step 1: Resolve the Figma plan**

Run `whoami`. If exactly one plan is returned, use its `key`; otherwise select the plan identified by the user.

- [ ] **Step 2: Create the file**

Call `create_new_file` with:

```json
{
  "fileName": "OMR Maker — Product Map & Screen Inventory",
  "editorType": "design",
  "planKey": "the exact key returned by whoami.plans[0].key"
}
```

Expected: a `file_key` and `file_url`.

- [ ] **Step 3: Inspect the empty file**

Call `use_figma` read-only and return page names, local variables, text styles, and components.

Expected: one empty default page and no reusable local design-system assets.

### Task 2: Establish pages and documentation foundations

**Files:**
- Reference: `docs/design-system.md`
- Reference: `src/app/globals.css`

- [ ] **Step 1: Create four ordered pages**

Create or rename pages to:

```text
00 Overview
01 Screen Inventory
02 User Flows
03 Design System
```

- [ ] **Step 2: Create product-map color variables**

Create a local variable collection named `OMR Maker / Product Map` with light-mode values:

```text
Color/Background  #F8FAFC
Color/Surface     #FFFFFF
Color/Foreground  #0F172A
Color/Muted       #64748B
Color/Border      #E2E8F0
Color/Primary     #4F46E5
Color/Success     #10B981
Color/Warning     #F59E0B
Color/Error       #EF4444
Color/Grade Red   #C02B3C
Color/Retake      #0F766E
```

Set variable scopes explicitly: background/surface colors to frame and shape fills, text colors to text fills, and border to strokes.

- [ ] **Step 3: Create shared section headers**

For each page, add an Auto Layout header containing:

```text
OMR Maker
<page title>
Current implementation map · 2026-07-24
```

Use Pretendard when available; otherwise use the first available Korean-capable sans-serif font returned by Figma.

- [ ] **Step 4: Validate foundations**

Return every created page and header node ID, then capture a screenshot of each page header.

### Task 3: Build `00 Overview`

**Files:**
- Reference: `src/app/**/page.tsx`
- Reference: `capacitor.config.ts`

- [ ] **Step 1: Add platform summary**

Create three connected cards:

```text
Web / Next.js
PWA / Installable web app
iOS & Desktop shells / shared web UI
```

Note that Android is not a separately tracked product surface.

- [ ] **Step 2: Add role summary**

Create role cards for:

```text
Teacher — create, distribute, monitor, grade, analyze
Student — join, solve, submit, review, retake
Shared — authentication, sync, PWA, error recovery
```

- [ ] **Step 3: Add route map**

Map all 16 routes:

```text
/
/create
/groups
/pwa-check
/solve/[id]
/student/dashboard
/student/history
/student/review/[attemptId]
/teacher/attempt/[attemptId]
/teacher/billing
/teacher/dashboard
/teacher/exam/[id]
/teacher/live
/teacher/settings
/teacher/users
/_not-found
```

Group routes by Public, Teacher, Student, and System.

- [ ] **Step 4: Add state legend**

Add chips for Default, Loading, Empty, Error, Complete, Locked, and Offline.

- [ ] **Step 5: Validate Overview**

Return all created node IDs and capture the full Overview page screenshot.

### Task 4: Build `01 Screen Inventory`

**Files:**
- Reference: `src/app/**/page.tsx`
- Reference: `src/components/TeacherHeader.tsx`
- Reference: `src/components/dashboard/StatusPill.tsx`
- Reference: `src/components/dashboard/StatCard.tsx`

- [ ] **Step 1: Create route inventory cards**

Create one card per route with:

```text
Screen title
Route
Primary role
Core purpose
Representative states
Source path
```

- [ ] **Step 2: Build an editable desktop representative**

Create a 1440px teacher dashboard frame containing a header, four KPI cards, assignment/exam list region, analytics region, and status pills. Use Auto Layout and product-map variables.

- [ ] **Step 3: Build an editable mobile representative**

Create a 390px student review frame containing a compact header, score summary, answer status list, feedback area, and retake action.

- [ ] **Step 4: Label responsive behavior**

Annotate breakpoints:

```text
Desktop 1440
Tablet 1024
Mobile 390
```

Call out wrapped teacher header actions and the three-column tablet KPI rail.

- [ ] **Step 5: Validate Inventory**

Return all inventory and representative-frame node IDs. Capture screenshots of the full inventory, desktop representative, and mobile representative.

### Task 5: Build `02 User Flows`

**Files:**
- Reference: `src/app/create/page.tsx`
- Reference: `src/app/solve/[id]/page.tsx`
- Reference: `src/app/student/review/[attemptId]/page.tsx`

- [ ] **Step 1: Build teacher flow**

Connect:

```text
Create exam → Configure & save → Distribute → Live monitor → Attempt detail → Analytics & feedback
```

- [ ] **Step 2: Build student flow**

Connect:

```text
Join → Verify access/PIN → Solve → Submit → Review → Retake incorrect questions
```

- [ ] **Step 3: Build operational recovery flow**

Connect:

```text
Session check → Local/remote sync → Retry queue → Recovery or actionable error
```

- [ ] **Step 4: Add decision branches**

Add decision diamonds for PIN required, exam window closed, offline, premium locked, and missing data.

- [ ] **Step 5: Validate flows**

Return all flow node IDs and capture the full User Flows page.

### Task 6: Build `03 Design System`

**Files:**
- Reference: `docs/design-system.md`
- Reference: `src/app/globals.css`
- Reference: `src/components/dashboard/StatusPill.tsx`
- Reference: `src/components/dashboard/StatCard.tsx`

- [ ] **Step 1: Build color and typography sections**

Show semantic swatches and usage notes. Add Pretendard Korean text samples and Geist/tabular-number metric samples.

- [ ] **Step 2: Build foundations**

Document:

```text
Type scale: micro, caption, label, body-sm, heading-sm/md/lg, metric
Radius: 8, 12, 16, 24, full
Elevation: sm, md, lg, xl
Motion: fast, base, smooth, spring
```

- [ ] **Step 3: Build reusable UI examples**

Create editable examples for buttons, inputs, cards, StatusPill tones, StatCard, tabs, modal shell, and teacher header.

- [ ] **Step 4: Add implementation references**

Attach source-path labels to each example and distinguish system error red from grading red.

- [ ] **Step 5: Validate Design System**

Return all created node IDs and capture the full Design System page.

### Task 7: Final validation and handoff

**Files:**
- Verify: `docs/superpowers/specs/2026-07-24-figma-product-map-design.md`

- [ ] **Step 1: Inspect file metadata**

Verify exactly four ordered pages and confirm each contains a titled top-level wrapper frame.

- [ ] **Step 2: Verify route coverage**

Programmatically collect all route text nodes and compare them to the 16-route checklist.

- [ ] **Step 3: Verify editable representatives**

Confirm the teacher desktop and student mobile frames use Auto Layout and contain no overlapping child bounds.

- [ ] **Step 4: Capture final screenshots**

Capture one screenshot per page plus close-ups of the desktop and mobile representatives.

- [ ] **Step 5: Deliver**

Return the Figma URL, page summary, validation result, and any source screens that could not be captured because the local runtime was unavailable.
