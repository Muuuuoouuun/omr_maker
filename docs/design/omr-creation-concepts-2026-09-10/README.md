# 문제·OMR 생성 패널 시안

2026-09-10. 내장 이미지 생성 도구로 생성한 독립 시안 3개입니다. 화면에 표시된 이미지 순서와 아래 번호가 같습니다. 구현 변경은 포함하지 않습니다.

| 표시 순서 | 시안 | 이미지 |
|---|---|---|
| 1 | 동시 편집 워크벤치 | [01-workbench.png](01-workbench.png) |
| 2 | 차근차근 출제 가이드 | [02-guided-editor.png](02-guided-editor.png) |
| 3 | OMR 중심 문항 스튜디오 | [03-omr-studio.png](03-omr-studio.png) |

## 참고 자료

- 현재 `src/app/create/page.tsx`와 `src/components/OMRCardView.tsx`의 편집 기능
- `docs/design-system.md` 및 `src/app/globals.css`의 토큰
- 각 생성에 실제 첨부: `docs/quality/audit-2026-08-05/07-create-settings-mobile.jpg` (저장된 과거 화면), `public/logo.png`
- 요청 크기: 1440 × 1024. 이미지는 UI 탐색용이며 실제 인터랙션이나 정확한 텍스트 렌더링을 검증한 구현물이 아닙니다.

## 생성 프롬프트

### 1

Use case: ui-mockup.
Create realistic, production-quality UI designs with clear hierarchy, strong typography, intentional content, and purposeful spacing. Generate ONE independent desktop web-app screen, not a collage, for the Korean education app OMR Maker. Design direction name: "동시 편집 워크벤치". This is a visual development proposal for an EXISTING teacher question-and-OMR creation editor.

TARGET DIMENSIONS: 1440 x 1024 pixels, landscape. Entire app viewport only, no browser chrome, perspective, device frame, poster captions, or concept numbering. All Korean text must be crisp, correctly spelled and readable. Current date anchor 2026-09-10; avoid unnecessary dates.

INPUT IMAGES: first image is the existing mobile settings screen: use its real product controls and indigo language as grounding, but recompose for desktop; second image is the actual OMR Maker brand mark: use only as a small header logo. Do not reproduce mobile layout or giant warning cards.
Existing code context: /Users/clmagi/Desktop/Projects/omr_maker/src/app/create/page.tsx implements PDF/problem + reference answer PDF, adjustable settings panel, editable OMR preview, 4/5 choices, question count, answer recognition/import, bulk answer/labels, per-question answer and score, unit/concept/difficulty, linked PDF region, advanced subquestions, save draft, export and distribute. Preserve the important workflow, progressively disclose advanced controls. This is NOT AI-generated exercise text and not an analytics dashboard.

DESIGN SYSTEM: white #ffffff surface, soft slate #f8fafc canvas, navy #0f172a text, muted #64748b, hairline #e2e8f0, solid indigo #4f46e5 primary and pale indigo selected states, green only for completion and amber only for missing input. Pretendard-style Korean sans serif, tabular numerals. Body 14–16px, section headings 18px, page title 26px. Inputs/buttons radius 10–12px. No decorative gradients, no nested card maze, only one primary CTA, restrained shadows.

LAYOUT AND HIERARCHY:
A tidy white header 72px high: small authentic logo and "OMR Maker", breadcrumb "시험 만들기", editable title "고1 국어 · 독서 평가". Right has quiet text "초안 저장됨", secondary "초안 저장", solid indigo "저장하고 배포하기". Utility overflow hides secondary exports.
Below, compact exam metadata strip: "20문항", "5지선다", "100점", "40분" with an "시험 기본 설정" link. No KPI cards.
Main workspace is a full-width three-pane editor with slim vertical draggable separators: large left PDF pane about 520px, middle 470px contextual settings, right 410px live OMR preview. No wrapper card enclosing app.
LEFT: white pane toolbar "문제지" active / "참고 답지", document filename "고1_국어_독서.pdf", discreet page control "3 / 5", zoom "100%". Cool grey PDF canvas with a realistic white Korean reading-test page. Show questions 11 and 12, question 12 outlined indigo and small "12번" anchor. Plausible short text: "다음 글의 중심 생각으로 가장 적절한 것은?" Korean prose, 5 numbered choices; a restrained selected area rectangle, never overlaid decorative annotations. Bottom small contextual action "PDF 위치 매칭".
MIDDLE: section heading "문항 편집", inline tabs "정답·배점" active / "분류" / "고급". Compact horizontal question navigator showing 9,10,11,12,13,14 with 12 indigo active. Beneath large clear heading "12번 문항", quiet "PDF 3쪽 연결됨". Main controls grouped with spacing: label "정답" then five large circular controls 1 2 3 4 5 with 3 filled indigo; label "배점" with "5 점" numeric input and quick choices 2 3 4 5 with 5 active. A divider, then light rows: "유형  독해", "단원  독서", "난이도  표준", using compact dropdown fields. Two collapsed disclosure rows "세부 문항 설정" and "문항 영역 보정". At bottom of middle pane understated previous/next controls and "정답 입력 후 다음 문항으로" switch. Keep enough breathing room; do not show unrelated global configuration forms.
RIGHT: "OMR 미리보기" heading and tiny expand/collapse control. One concise progress label "정답 18 / 20" and thin 90% bar. Below a compact clean continuous OMR list 1–20, each row with question number, exactly five bubbles labeled 1–5, one marked answer per completed row, and "5점". 12 row is selected with indigo pale background and option3 marked. Rows7 and16 have NO marked answer, subtle amber dot, and tiny "미입력"; all others complete. 20 questions at5points =100point total. No student response marks: this is teacher answer-key editing.
BOTTOM: calm status strip under workspace "미입력 2문항 · 7번, 16번" with quiet link "미입력으로 이동". Keep primary action in header only. One clear flow: inspect question → set answer and score → see OMR update.

Prefer alignment, whitespace and subtle dividers before borders and shadows. Focused single working screen, no marketing, no decorative photos, no extra tabs/badges/metrics merely to advertise features. Essential product details should feel believable and ready for frontend implementation.

### 2

Use case: ui-mockup.
Create realistic, production-quality UI designs with clear hierarchy, strong typography, intentional content, and purposeful spacing. Generate ONE independent desktop screen for Korean teacher web application OMR Maker. Design direction: "차근차근 출제 가이드". This is an evolved question/OMR creation panel, with guided task stages and rapid answer entry. This is NOT a dashboard, marketing page, or AI exercise generator.

Target dimensions: 1440 x 1024 pixels. Output app screen only, front-on, natural viewport. No device frame, browser chrome, external annotations, concept numbering, multi-image collage, or visual warping. Current date anchor 2026-09-10; no unnecessary dates.
Reference image1: actual existing mobile settings UI, used for product identity and controls, not mobile layout. Reference image2: actual OMR Maker logo, use as a small brand mark only.
Source code grounding: /Users/clmagi/Desktop/Projects/omr_maker/src/app/create/page.tsx supports PDF/answer PDF registration, custom question count, 4/5 choices, answer import/recognition, continuous answer input, score and label bulk assignment, per-question PDF links, OMR preview, draft save and distribution. Surface the core using progressive disclosure.

Visual language from existing design tokens: primary indigo #4f46e5, white #ffffff, very pale slate #f8fafc, navy #0f172a, muted slate #64748b, borders #e2e8f0. Pretendard Korean sans-serif with tabular numerals. Body14–16px; 28px main heading. A calm spacious flat interface, no decorative gradients, no cards inside cards, no excessive badges. The contrast with a three-pane editor is structural: a clear stage bar across the top, a generous answer-entry table as hero, and a quiet compact preview on the right.

COMPOSITION:
Header 70px: small real logo, "OMR Maker", breadcrumb "시험 만들기"; right quiet "초안 저장됨" and secondary "초안 저장" button, overflow icon.
Below header an airy horizontal three-stage process: "시험 기본" completed with check, "정답·배점" indigo active, "검토·배포" upcoming; use subtle connecting lines and readable labels, no giant step cards.
Main content begins at y200 with "정답과 배점을 입력하세요" and supporting line "정답을 가져오거나 아래 표에서 바로 입력할 수 있어요." Slightly smaller editable exam title "고1 국어 · 독서 평가". Workspace has two content areas on a common white base with a single vertical divider, left about900px and right about420px.

LEFT HERO:
A compact utility row, secondary outlined "정답 가져오기", text link "정답 연속 입력", and right "기본 배점 5점" with quiet "일괄 적용". Attached source shown as one thin row with file icon "고1_국어_독서.pdf", text action "문제지 보기"; do not show a full-size PDF viewer.
Below a segmented filter "전체 20" selected and "미입력 2", with small note "18 / 20 정답 입력".
A beautifully spaced editable table, one continuous surface with subtle row separators and column headers "문항", "정답", "배점", "유형", "PDF".
Show rows1–10 exactly once at about45px each. Each row has question number, five circular answer bubbles explicitly labeled1 2 3 4 5, compact numeric score field "5", type "독해", and small PDF link icon. Answers for1–10 are respectively 2,4,1,5,3,2,blank,1,4,2. Row7 is selected with pale amber tint and empty five answer controls, plus tiny "미입력". Other rows have one indigo-filled answer. Never show checks as answers. Small page navigation beneath table: "1–10 / 20문항", previous/next chevrons. Keep large click targets; no keyboard-tip clutter.

RIGHT PREVIEW:
Small heading "OMR 미리보기" with text "학생 화면" active / "정답 표시" toggle off, so this is the blank student sheet distinct from the answer-entry table.
A restrained realistic upright paper preview on a pale slate backdrop, with very subtle shadow. Paper heading "고1 국어 · 독서 평가", metadata "20문항 · 100점", thin fields for "이름" and "반". Show exactly20 numbered question rows, in two vertical groups1–10 and11–20. Each row has five EMPTY marking bubbles because it is the student view. Use 14px legible text where possible, keep paper spacious and unclipped. Below preview a tiny collapsed row "OMR 표시 설정". No analytics or decorative charts.

BOTTOM fixed white action footer separated with a fine border:
left secondary "이전", center amber small info icon and "7번, 16번 정답을 확인해 주세요", right the ONE solid indigo primary button "OMR 확인하기" with right arrow.
Data consistent:20 questions, five choices,5points each, total100points; only7and16 missing,18answered. No claim of ready to distribute while incomplete. Main action opens review.
This frame should instantly communicate a teacher-friendly sequence and efficient tabular editing with confidence in the output. Prefer spacing, alignment, typography and dividers over enclosing every section in cards. No extraneous metrics, features, navigation or ornament. Do not reproduce a screenshot literally: transform its existing controls into this distinctly guided desktop experience.

### 3

Use case: ui-mockup.
Create realistic, production-quality UI designs with clear hierarchy, strong typography, intentional content, and purposeful spacing. Generate ONE independent polished desktop UI screen for the existing Korean teacher application OMR Maker. Design direction name: "OMR 중심 문항 스튜디오". User task is to develop the question-and-OMR creation panel. This direction puts the editable OMR itself at the center, with a contextual question inspector that follows the selected item.

TARGET DIMENSIONS:1440 x1024 pixels, natural landscape desktop app viewport. No external poster title, concept numbering, browser or device frame, camera perspective, collage, or clipped controls. Current date anchor2026-09-10; avoid dates.
Input image1: actual existing mobile settings screen, product context and indigo design language reference only; recompose entirely for desktop. Input image2: authentic OMR Maker logo to use at small header size only.
Current code source /Users/clmagi/Desktop/Projects/omr_maker/src/app/create/page.tsx: PDF registration/reference answer PDF, custom question count4/5choice, answer recognition/import, bulk label and score, per-question answer/score/PDF region/unit/difficulty, subquestions, editable OMRCardView, draft save/export/distribution. Do not invent AI exercise generation, student statistics, business metrics or collaboration chat.

Existing design tokens: white#ffffff and pale slate#f8fafc, text#0f172a, secondary#64748b, borders#e2e8f0, primary#4f46e5, pale indigo selection. Green only completion and amber only pending. Pretendard Korean UI sans serif14–16px, headings24–28px, tabular numerals. Buttons/inputs10–12px radius. Restrained modern professional teacher software. Fine dividers and generous spacing; no gratuitous gradients, nested card containers, marketing ornament, or analytics.

PRIMARY COMPOSITION:
A restrained white top header72px: real small logo with "OMR Maker"; breadcrumb "시험 만들기"; exam name "고1 국어 · 독서 평가"; right "초안 저장됨", quiet "초안 저장" and one solid indigo primary "저장하고 배포하기", overflow icon.
Below header a full-width workspace toolbar, y72–140: left segmented switch "OMR 편집" active and "문제지"; next summary "20문항 · 5지선다 · 100점"; right secondary "정답 가져오기", a small eye icon "학생 미리보기". No stepper and no permanent large PDF pane.
Main content y140–955: broad editable OMR surface occupying left~950px, fixed contextual inspector right~425px, single slim vertical dividing line. Both flat app surfaces, no surrounding app card.

LEFT MAIN OMR CANVAS:
Title area on the page, not in a card: strong "정답을 클릭해서 완성하세요" and subtle "문항을 선택하면 세부 설정이 열립니다." Small right progress "18 / 20 입력" and a fine90% progress line.
Below a thin filter row "전체 문항" active / "미입력 2" and quiet "일괄 편집". Then the hero: an elegant two-column continuous OMR editing list, not twenty rounded tiles. Left column exactly1–10 top to bottom, right column exactly11–20 top to bottom; each question appears ONCE. Each row about60px high, with question number in bold, five circles of equal size labeled1,2,3,4,5, exactly one indigo-filled answer for completed rows, far-right small "5점" with subtle line-link icon underneath or beside it. Crisp consistent columns, generous clickable circles, 1px row separators. 12 row on right column second row is selected, pale lavender fill and slim indigo accent at left, answer3filled. Rows7and16 have five unfilled bubbles and a tiny amber "미입력"; all others complete.
Exact marked answer sequence for questions1–20:2,4,1,5,3,2,blank,1,4,2,5,3,1,4,2,blank,3,5,1,4.
The list is designed as an editing canvas with large bubble controls, not a miniature printable sheet, and not a student results table. Ensure lower rows10and20 are fully visible and not cropped.

RIGHT CONTEXTUAL INSPECTOR:
At top heading "12번 문항", little previous/next chevrons. A short subline "PDF 3쪽 연결됨".
Immediately below a visually realistic crop of just the selected Korean reading question on white paper with very subtle grey edge, about350pxwide and230pxtall. Show question number12, concise prompt "다음 글의 중심 생각으로 가장 적절한 것은?", a short four-line paragraph on reading, and five short choices. This is a source PDF excerpt only, not a full PDF sheet squeezed down. Under the crop quiet text action "문제지에서 보기".
Then divider and essential controls: "정답" with five clear circles,3filledindigo, and "배점" with numeric input "5 점" on the same horizontal row if space allows.
Below minimal property rows "유형  독해", "단원  독서", "난이도  표준". One collapsed disclosure "세부 문항·영역 설정". Bottom quiet toggle row "입력 후 다음 문항으로". No global exam settings mixed into this contextual inspector.
PDF choice3 should be "좋은 독서는 사고의 폭을 넓혀 준다." to be consistent with selected answer3. Other choices short and believable. Avoid dense paragraphs or illegible fake text.

BOTTOM:
Full-width white status bar with hairline top: left amber small dot "미입력 2문항 · 7번, 16번", adjacent subtle action "미입력으로 이동"; right quiet "시험 기본 설정". Primary CTA exists only at top.
All20questions have5points so total100.18answered,7and16pending. Show no "배포 준비 완료" while pending.
This is one coherent screen focused on direct answer editing and contextual inspection, with OMR visually dominant and a useful excerpt panel. Prioritize spacing, grouping, alignment and typography before tints/borders/shadows. Keep the familiar product identity but make the workflow dramatically more focused. One primary action, only essential supporting content, no feature inventory.

