# 페르소나 평가 기반 개선 기획 (2026-10-01)

> **For agentic workers:** 각 Task는 독립 PR 단위입니다. 체크박스(`- [ ]`)로 진행을 추적합니다.
> 착수 전에 해당 Task의 "PO 결정" 항목이 정해졌는지 확인합니다.
> 결정이 안 된 Task는 기본안(✅ 표시)으로 진행하거나 보류합니다.

**근거:** [`docs/quality/persona-evaluation-2026-10-01.md`](../../quality/persona-evaluation-2026-10-01.md)
- 페르소나 13명(학생 6, 교사 4, 원장 3)의 평가 결과이며 평균은 약 4.5/10입니다.
- 설계 세부는 트랙 A(즉시 수정·풀이 화면), B(학생 진입·재방문), C(채점 신뢰·규모·교사 생산성) 세 갈래로 나눠 코드를 읽고 작성했습니다.

**목표:** 다음 세 가지를 순서대로 해소합니다.
1. 사용 자체를 막는 결함: 폰에서 문제지가 안 보임, 구형 브라우저 크래시, 규모 절벽
2. 첫 진입·재방문 마찰
3. 채점과 숫자에 대한 신뢰 결함

조직 기능(강사 초대, 역할, 조직 대시보드)은 그 다음 분기에 진행합니다.

**원칙**
1. **보안 경계는 약화하지 않습니다.** 서명 세션, 초대 토큰, 서버 재검증, 봉인된 채점 근거(`question_results_*_hash`)는 그대로 둡니다. 새 클라이언트 상태는 편의용일 뿐 권한이 아닙니다.
2. **"초기 100명 운영" 계약(`src/lib/initialOperationsPolicy.ts`)은 PO 결정 없이 상한을 올리지 않습니다.** 대신 상한을 넘었을 때 화면 전체가 무너지지 않게 하고, 넘기 전에 미리 알립니다.
3. **부분 결과를 보여줄 때는 범위를 화면에 명시합니다.** 조용히 잘라내지 않습니다.
4. **화면 문구는 사용자용과 운영자용을 분리합니다.** 교사·학생 화면에 환경변수나 "서버 설정" 문구를 노출하지 않습니다.
5. **스타일은 `docs/design-system.md` 토큰을 씁니다.** 시스템 오류는 `--error`, 채점 오답은 `--grade-red`, 재시험은 `--retake`입니다.
6. **기존 e2e·표면 테스트가 현재 문구나 동작을 고정한 곳은 같은 PR에서 의도적으로 갱신합니다.** 각 Task의 "깨지는 테스트" 목록을 참고합니다.

---

## 단계 요약

| 단계 | 기간(안) | 내용 | 결과 기대 |
|---|---|---|---|
| **Phase 0** | 1주 | 크래시·노출·문구 즉시 수정 (A1, A3, A6~A9, B0, C-xs) | 문제지 표시 크래시 제거, 운영자 문구 비노출 |
| **Phase 1** | 1~2주 | 학생 풀이 화면과 진입 흐름 (A2, A4, A5, B1~B5) | 초보 학생 점수 3~4 → 6+ 목표 |
| **Phase 2** | 2주 | 채점 신뢰와 규모 절벽 1차 (C1-1, C2a, C2b-S, C3a, C4-4①, C4-6, C4-7) | 응시 100건 절벽 제거, 상한 사전 경고 |
| **Phase 3** | 2~3주 | 교사 생산성 (C1-2, C1-3, C2b-M, C4-1A, C4-2, C4-3, C4-5) | 일주일 사용 교사 5 → 7 목표 |
| **Later** | 분기 | 재채점 전체(C3b), 복수정답·주관식(C3c), 플랜 연동 상한(C2c), 조직 기능 | 원장 점수 개선 |

크기 표기는 S(≤1일), M(2~4일), L(1~2주), XL(2주 이상)입니다.

---

## Phase 0 — 즉시 수정

### A1. PDF.js legacy 빌드 통일과 PDF 오류 격리 (M, 최우선)
**원인**
- 앱과 react-pdf가 `pdfjs-dist` 6.2.108의 modern 빌드를 씁니다. 이 빌드는 `Map.prototype.getOrInsertComputed`를 호출하므로, 이 API가 없는 브라우저(예: Chromium 141)에서는 `/solve`와 `/create` PDF 업로드가 통째로 크래시합니다.
- public 워커 두 개도 modern 빌드입니다.
- legacy 빌드는 core-js 폴리필(getOrInsert*, Iterator helpers, Promise.try 등)을 포함합니다. 워커는 별도 전역에서 실행되므로 전역 폴리필만으로는 해결되지 않습니다.
- `solve/[id]/page.tsx:126`의 dynamic PDFViewer 주변에 오류 경계가 없습니다. 그래서 PDF 오류가 OMR 마킹 화면까지 함께 죽입니다.

**변경**
- [x] `next.config.ts` turbopack에 `resolveAlias: { 'pdfjs-dist': { browser: 'pdfjs-dist/legacy/build/pdf.mjs' } }`를 추가합니다. react-pdf 내부 import까지 legacy로 바뀝니다.
  - 빌드 후 chunk에서 `getOrInsertComputed:function` 마커를 확인합니다.
  - 별칭이 서브패스까지 재귀 적용되면 react-pdf 패치(patch-package)로 대체합니다.
- [x] 신규 `src/lib/pdfjsRuntime.ts`(`loadPdfJs()`, `pdfWorkerSrc(version)`)를 만들고, 수동 workerSrc를 설정하던 4곳을 교체합니다.
  - `answerParser.ts:76`, `examAnalysisPdf.client.ts:6`, `create/page.tsx:2111`, `annotatedPdfExport.ts:174`, `PDFViewer.tsx:38`
- [x] `public/pdf.worker.min.mjs`와 `public/react-pdf.worker.min.mjs`의 내용을 legacy 워커로 교체합니다. 파일명은 유지합니다.
  - 워커 URL에 `?v=<ver>-legacy`를 붙입니다.
  - `public/sw.js`의 `CACHE_VERSION`을 v16에서 v17로 올립니다. (PO 결정 A-6)
- [x] 신규 `src/components/PdfPaneBoundary.tsx`를 만듭니다. Next 16.3 `catchError`를 쓰며, 경계를 쓰기 전에 `node_modules/next/dist/docs`에서 API를 확인합니다.
  - 대체 화면 문구: "문제지를 표시하지 못했습니다. 답안 마킹과 제출은 계속할 수 있습니다." + [다시 시도]
  - PDFViewer에 `onLoadError`와 `onRenderError` prop을 추가해 비동기 실패도 같은 카드로 표시합니다.

**테스트**
- [x] `PDFViewer.workerVersion.test.ts`: public 워커의 sha256이 legacy 워커와 같은지 확인합니다.
- [x] `pdfSupplyChainSecurity.test.ts`: `import('pdfjs-dist')`를 직접 쓰거나 워커 경로를 하드코딩한 곳이 없는지 확인합니다.
- [x] `pwaAssets.test.ts`: `omr-maker-v16`을 v17로 갱신합니다.
- [x] 신규 `e2e/pdf-legacy-runtime.spec.ts`: init script와 워커 route에서 `getOrInsert*`를 삭제한 상태로 `/solve`를 열어, canvas가 렌더링되고 pageerror가 0건인지 확인합니다.
- [x] 신규 e2e: 워커가 404일 때도 OMR 마킹과 제출이 되는지 확인합니다.

**위험:** legacy 번들이 약 +58KB 커집니다. dynamic chunk이므로 `npm run build`의 라우트 예산을 확인합니다.

**결과(2026-10-02):** 클라이언트 PDF chunk는 legacy 1벌만 남았습니다(+54.9KB raw / +18.5KB gzip, lazy). `/solve` first-load는 +2.3KB gzip(`next/error`가 Pages `_error`를 함께 가져옴)이며 라우트 예산을 통과합니다. PDF.js는 워커 실패 뒤 같은 페이지 세션에서 워커를 끄므로, 워커 404는 [다시 시도]로 복구되지 않고 카드가 유지됩니다(새로고침 필요).

### A3. 학생 풀이 화면의 "선생님 모드"·"PDF 열기" 노출 정리 (S~M)
**원인:** 교사 미리보기용 토글과 PDF 업로드가 학생에게 항상 보입니다(`solve/[id]/page.tsx:4032-4071`). 교사 인증 다이얼로그를 거치므로 보안 문제는 아니고 UX 노출 문제입니다.

**변경**
- [ ] `shouldOfferTeacherPreview()`가 true일 때만 선생님 모드를 렌더링합니다. 조건은 `hasTeacherSession()` 또는 `?preview=teacher`입니다. (PO 결정 A-2)
- [ ] "PDF 열기"는 첨부 PDF가 없을 때만 보여줍니다. 숨김 input은 유지합니다. 빈 화면 문구는 학생용으로 따로 둡니다. (PO 결정 A-3)

**깨지는 테스트:** `e2e/student-simplification.spec.ts:227-279`, `e2e/ios-mobile-layout.spec.ts:509-518, 633-660`(→ `?preview=teacher`)

### A6. 사용자 문구와 운영자 문구 분리 (S)
- [x] `teacherLoginHelpFor(error, { production })`를 만듭니다.
  - 비밀번호가 틀렸을 때는 환경변수 안내를 붙이지 않습니다.
  - 설정 오류는 프로덕션에서 "지금은 교사 로그인을 사용할 수 없습니다. 학원 관리자에게 문의해주세요."로 보여줍니다.
  - 운영자용 안내는 비프로덕션에서만 보여줍니다.
  - 대상: `src/lib/teacherAuthMessages.ts`, `src/app/page.tsx:1469`
- [x] `teacher/settings/page.tsx:1341`의 환경변수·재배포 안내를 "학원 관리자에게 요청하세요"로 바꿉니다. CLI 안내는 `docs/operator-teacher-provisioning.md`로 옮깁니다.
- [x] `actions/remediation.ts`를 `fail(code, audience)`로 바꿉니다. 학생용 문구는 "보강 정보를 불러오지 못했어요. 잠시 후 다시 시도하고, 계속되면 선생님께 알려주세요."입니다.

**깨지는 테스트:** `teacherAuthMessages.test.ts:12-29`, `persistenceIntegration.test.ts:131`

### A7. 학생 기록 "최근 흐름" 방향과 내비게이션 (S)
- [x] `student/history/page.tsx:167-170`: 순수 함수 `recentScoreTrend()`로 과거 → 최신 순을 만들고, 라벨을 "최근 흐름 (이전 → 최근)"으로 바꿉니다.
- [x] 헤더(213-221)에 "대시보드" 링크와 `aria-current`를 추가합니다.

### A8. 빠른 정답 입력과 문항 수 안내 (S)
- [ ] 신규 `src/lib/fastAnswerInput.ts`: `-`(필요 시 `0`, `.`)를 빈 답으로 보고 자리를 유지합니다. 지금은 `create/page.tsx:2839-2857`에서 `-`가 지워지면서 뒤 정답이 한 칸씩 당겨집니다. (PO 결정 A-5)
- [ ] 문항 수 51 이상: 토스트 대신 입력 칸 아래에 inline 메시지를 띄웁니다. 기본안은 50으로 고정하고 "최대 50문항까지 만들 수 있어 50으로 맞췄습니다"라고 안내하는 것입니다. (PO 결정 A-1)

### A9. README의 로컬 교사 로그인 안내 (S)
- [ ] dev 기본값 `provisioned_only`는 의도된 보안 기본값이므로 유지합니다.
- [ ] README 18줄과 `.env.example`에 "Supabase 미설정 로컬에서 admin/admin123을 쓰려면 `OMR_TEACHER_IDENTITY_MODE=self_service`"를 명시합니다.

### B0. 서버 로그인 결과의 identityType 전달 버그 (S)
**원인:** 서버가 `registered`로 서명한 학생을 `src/app/page.tsx:694`가 `identityType: "temporary"`로 저장합니다. 그래서 로그인 직후 대시보드의 "선생님이 배정한 오답 보강 →" 링크(`dashboard/page.tsx:790`)가 보이지 않습니다.

**변경**
- [x] `IssuedStudentIdentity`에 `identityType`을 추가합니다(`actions/studentSession.ts` 약 365, 530행).
- [x] `page.tsx:694`에서 그 값을 그대로 씁니다. 서버는 클라이언트가 보낸 identityType을 신뢰하지 않으므로 보안 영향이 없습니다.

### C-xs. 기타 문구 (XS)
- [ ] `create/page.tsx:2506`의 충돌 토스트가 존재하지 않는 "복제본으로 저장"을 안내합니다. "새로고침해 서버본과 비교해주세요"로 바꿉니다.

---

## Phase 1 — 학생 풀이 화면과 진입 흐름

### A2. 폰·태블릿 풀이 레이아웃 (L, e2e 기하 검증 많음)
**원인 (320×568 기준)**
- `globals.css:10333-10350`의 `.solve-omr-pane { min-height: 260px }` 때문에 PDF 영역이 151px로 줄어듭니다.
- 휴대폰 툴바는 세로로 쌓여(`globals.css:9365-9373`) 200px 이상이 됩니다.
- 그 결과 `.pdf-viewer-scroll`이 0px이 됩니다.
- 하단 페이지 툴바(`PDFViewer.tsx:1541-1566`)는 상단 툴바와 기능이 중복됩니다.

**변경**
- [ ] ≤768px 압축 툴바를 한 줄(44px)로 만듭니다: `[◀ n/N ▶] [−/+] [필기 ▾]`.
  - 필기 도구는 PDF 위에 뜨는 팝오버로 옮겨 레이아웃 높이를 차지하지 않게 합니다.
  - 파일명과 하단 툴바는 ≤768px에서 숨깁니다.
- [ ] OMR 영역은 `flex: 0 1 clamp(168px, 36dvh, 320px)`, PDF 영역은 `min-height: 45%`로 둡니다.
- [ ] OMR을 접으면 기존 rail 퀵카드를 하단 56px peek 바로 재사용합니다. 첫 진입 상태는 PO 결정 A-4입니다.
- [ ] 태블릿 600~1180px: 툴바에 `overflow-x: auto`를 줍니다. 가로 모드에서 PDF 좌측이 잘리는 문제(x=-307)는 Playwright 기하 프로브로 먼저 재현한 뒤 고칩니다.
  - 후보 원인: `PDFViewer.tsx:281`에서 폭에서 64를 빼는 계산, 316-327행의 focus 스크롤이 OMR 패널 폭을 고려하지 않는 문제.
- 헤더 3행(157px)은 e2e가 고정하고 있으므로 이번 범위에서 손대지 않습니다.

**테스트**
- [ ] 신규: `.pdf-viewer-scroll` 높이가 320×568에서 140px 이상, 393×727에서 뷰포트의 30% 이상인지 확인합니다.
- [ ] 신규: 필기 팝오버를 열어도 PDF 높이가 변하지 않는지 확인합니다.
- [ ] 신규: 태블릿 가로 1180×820과 1024×768에서 페이지 좌측이 잘리지 않고 툴바 끝까지 보이는지 확인합니다.
- [ ] 유지할 기존 테스트: `tablet-layout.spec.ts:213-216`(OMR이 PDF 아래 in-flow), `ios-mobile-layout.spec.ts:547-620`(키보드), `design93Surface.test.ts:99`

### A4. 폰·태블릿 세로의 저장 상태 표시 (S)
- [ ] `.solve-autosave{display:none}` 규칙(`globals.css:9179`, `:9486`)을 필기 상태 칩에만 적용되게 범위를 줄입니다.
- [ ] 상태 행에 `StatusPill` sm 크기로 저장 / 저장 실패 / 오프라인 칩을 둡니다. `aria-live="polite"`를 쓰고 `role="status"`는 쓰지 않습니다.
- [ ] `saveDraftSnapshot`의 catch에서 상태를 `failed`로 바꿉니다.

### A5. 오프라인 배너와 안전한 결과 화면 이동 (M)
- [ ] 신규 `src/lib/useNetworkStatus.ts`를 `useSyncExternalStore`로 만듭니다.
- [ ] 오프라인이면 배너를 띄웁니다: "오프라인 · 답안은 이 기기에 저장되고 있어요. 연결되면 자동으로 이어집니다." (`--warning`)
- [ ] `navigateToReview()` helper를 만들고 6곳의 `router.push('/student/review/…')`(1286, 1306, 2150, 2684, 3133, 3344)를 교체합니다.
  - 오프라인이면 `review_waiting_online` 상태로 두고 온라인이 되면 이동합니다. Chrome 공룡 화면이 뜨지 않게 하려는 것입니다.
  - `submissionProgress.ts`에 문구를 추가합니다.
- [ ] e2e: `setOffline(true)`면 배너와 오프라인 칩이 뜨고, 제출 후에도 URL이 `/solve/`에 머물러야 합니다. 복귀하면 이동해야 합니다.

### B1. 학생 로그인 폼 (M)
- [ ] 이름 → 반 → 학생번호/이메일 → 시작 코드의 4칸을 처음부터 표시합니다. 서버 모드이거나 명단이 있는 반이면 "필수" 표시를 미리 붙입니다.
- [ ] 문구를 바꿉니다. 서버 문구는 어느 칸이 틀렸는지 밝히지 않습니다(열거 방지 유지).
  - 로컬 코드 불일치: "시작 코드가 맞지 않아요. 6자리를 다시 확인해주세요(O·I·0·1은 쓰지 않아요). 잊었다면 선생님에게 재발급을 요청하세요."
  - 서버 invalid: "입력한 정보와 일치하는 학생을 찾지 못했어요. 이름 띄어쓰기, 반, 학생번호(또는 이메일), 시작 코드를 다시 확인해주세요."
- [ ] 로컬 모드에서 이름 오타가 새 학생을 자동 생성하지 않게 막습니다.
  - `resolveLocalRosterNameGuard()`: NFC 정규화, 공백 제거, 소문자로 비교합니다.
  - 일치하지 않으면 "혹시 ‘학생 1’인가요?"라고 제안합니다.
  - "명단에 없는 새 학생으로 시작" 버튼은 비프로덕션에서만 보여줍니다.
- 서버의 이름 매칭 규칙은 바꾸지 않습니다. (PO 결정 B-4)

**깨지는 테스트:** `uiSurface.test.ts:965`, `textEncodingSurface.test.ts:117`, `e2e/full-journey.spec.ts:585,669,673,716`

### B2. 시험 입장 확인 팝업 축소 (M)
- [ ] 신규 `src/lib/solveEntryIntent.ts`: sessionStorage에 한 번용 진입 의도를 저장합니다. 120초 TTL이고 examId와 studentId에 묶입니다.
  - 기록 시점: 대시보드의 "시작", 로그인 직후 `next=/solve/…`로 이동할 때
- [ ] 자동 입장: 기존 재시험 skip effect(`solve/[id]/page.tsx:2516-2535`)를 일반화합니다. 서버 재검증(`continueEntryAsStudent` → `openStudentExam`)은 그대로 거칩니다. PIN 시험은 PIN 화면이 우선합니다.
- [ ] 링크로 직접 열면 팝업을 유지하되 정리합니다.
  - "현재 로그인: OOO · A반" + [학생으로 시험 보기]
  - "내가 아니에요"를 누르면 서버 쿠키와 로컬 세션을 먼저 지운 뒤 로그인 화면으로 이동합니다.
  - 게스트 입력은 `<details>` 안으로 접습니다.
- [ ] 게스트 기본 이름을 `DEFAULT_GUEST_NAME = "게스트"`로 바꿉니다. 과거 "Guest Student"는 표시할 때만 매핑합니다.
- [ ] × 버튼: 로그인 상태면 `/student/dashboard`, 아니면 `/?role=student`로 보냅니다.

**깨지는 테스트:** `e2e/korean-exam-fixture.spec.ts:67`, `e2e/student-dashboard-load-state.spec.ts:66`

### B3. 세션 만료·재방문·원래 위치 복귀 (M, 토큰 보존까지 하면 L)
- [ ] 대시보드 상태에 `expired`를 추가합니다.
  - 제목: "로그인 시간이 끝났어요"
  - 본문: "보안을 위해 12시간이 지나면 다시 확인해요. 시작 코드만 다시 입력하면 이어서 할 수 있어요."
  - CTA: 비프로덕션은 `next=`가 붙은 "다시 로그인", 프로덕션은 "초대 링크를 다시 열기" 안내와 [다시 확인]
- [ ] 신규 `src/lib/studentReturnHint.ts`: opt-in일 때만 이름과 반을 30일 기억합니다. 시작 코드와 토큰은 절대 저장하지 않습니다.
  - 로그인 폼은 이 값을 미리 채우고 시작 코드 칸에 포커스합니다.
  - 배너: "OOO님, 다시 오셨네요"
- [ ] 홈의 "최근 학생 · 이어가기"는 이동 전에 `refreshStudentSession()`으로 세션을 확인합니다.
- [ ] 체크박스 문구를 "이 기기에서 로그인 유지"에서 **"이 기기에서 내 정보 기억하기"**로 바꿉니다. 실제 동작과 맞추기 위해서입니다.
- [ ] `normalizeStudentRedirectPath`는 `/solve/`와 `/student/`만 허용하므로 open redirect 위험이 없습니다. 모든 학생 로그인 링크에 `next=`를 붙입니다.
- (PO 결정 B-1, B-2, B-3)

**주의:** `studentSessionRecoveryFlow.test.ts:106`이 대시보드에 `href="/?role=student"`가 없는지 단언합니다. 링크는 helper로만 생성합니다.

### B4. 학생 대시보드 "할 일" 정리 (M)
- [ ] `useMonotonicAssignmentTime`를 `useAssignmentClock.ts`로 옮겨 대시보드에서 한 번만 계산하고 공유합니다. prop이 없으면 기존처럼 내부에서 계산합니다.
- [ ] `presentTodoAssignments()`로 할 일을 나눕니다.
  - "지금 풀 수 있어요": 마감 임박 순
  - "예정": 시작 빠른 순
  - "마감된 과제": `<details>`로 접어 둠
- [ ] 마감 표시를 KST 기준으로 합니다: "오늘 18:00 마감", "내일 …", "10/3(금) 23:59 마감 · D-2"
- [ ] 헤드라인을 바꿉니다. 대상은 `dashboard/page.tsx:783`입니다.
  - 응시 가능한 시험이 있으면: "지금 풀 수 있는 시험이 n개 있어요."
  - 없으면: "다음 시험은 …에 시작해요."
- [ ] 완료 카드에서는 상태 칩을 없애고 "완료 · 10/1 제출"만 보여줍니다.
- [ ] "나의 원시험 평균"을 "내 평균 점수"(보조 문구 "재시험 제외")로 바꾸고, "지난 기록 보기 →" 링크를 항상 노출합니다.

**깨지는 테스트:** `assignmentLifecycleSurface.test.ts:100-110`, `uiSurface.test.ts:1877`, `e2e/student-assignment-lifecycle.spec.ts:122-150`, `e2e/ios-mobile-layout.spec.ts:913,916`, `e2e/pwa-mobile.spec.ts:438`, `e2e/student-dashboard-load-state.spec.ts`, `e2e/korean-exam-fixture.spec.ts:65`

### B5. 제출 확인·복습·재시험 결과 (S~M)
- [ ] 제출 확인창에 빈 문항 번호를 보여줍니다: "3, 7, 12번 문항이 비어 있어요." 8개를 넘으면 "외 N문항"으로 줄입니다. 보조 버튼은 "빈 문항으로 이동"입니다.
- [ ] 복습 화면:
  - 첫 오답이나 미응답을 기본으로 선택합니다.
  - 탭 이름을 "오답·미응답 n"으로 바꿉니다. 요약 숫자와 맞추기 위해서입니다.
  - 만점이면 "다음 오답 →"을 숨기고 "모두 맞혔어요"를 보여줍니다.
- [ ] 재시험 결과에서 "회복 성공! 🚀"를 없애고 "다시 맞힘" 계열 표현으로 바꿉니다. 근거는 `docs/remediation-management.md`의 "정답 수정은 독립적인 유형 숙달의 증거로 간주하지 않는다"입니다.
  - 안내 문구: "같은 문제를 해설을 본 뒤 다시 맞힌 결과예요. 실력이 늘었는지는 비슷한 유형의 새 문제로 확인해보세요."

**깨지는 테스트:** `e2e/ios-mobile-layout.spec.ts:961,982-986`, `e2e/student-simplification.spec.ts:320`

---

## Phase 2 — 채점 신뢰와 규모 절벽 1차

### C1-1. 시험별 분석 스냅샷 로딩 (M)
**원인**
- `src/app/actions/teacherAttempts.ts:70`에서 `RICH_ATTEMPT_LIMIT = 100`입니다. 조직 전체의 eligible 응시가 100건을 넘으면 **모든 시험**의 문항 분석이 unavailable이 됩니다(`:195-207`).
- 대시보드(`teacher/dashboard/page.tsx:508`)는 `examId` 없이 스냅샷을 요청합니다. 서버 액션은 이미 `examId?`를 지원하는데 클라이언트가 쓰지 않는 것이 문제입니다.

**변경**
- [ ] 대시보드에 시험별 `Map` 캐시를 두고, 선택한 시험 기준으로 요청합니다. 탭 전체를 막는 게이트(1832, 1843행)는 제거합니다.
- [ ] `ExamAnalyticsTab`에 `onSelectedExamIdChange` prop과 상태별 문구를 추가합니다.
  - 불러오는 중
  - "이 시험 제출이 상세 분석 한도(100건)를 넘었습니다"
  - 확인 실패 + 다시 시도
- [ ] `examId`가 있으면 `loadTeacherExamWithGateway(examId)`를 씁니다. 시험 250개 목록 상한과 분리됩니다.

**테스트:** `canonicalReadActionContract.test.ts`(조직 195건이어도 해당 시험 30건이면 ready), `ExamAnalyticsReportOverview.test.tsx:499`, e2e `teacher-canonical-load-state.spec.ts`

### C2a. 상한 정직성: 쓰기 대칭 가드, 용량 게이지, 80% 경보, 요금제 문구 (M)
**원인**
- 명단 저장 RPC는 Pro 300명과 Academy 무제한을 허용합니다.
- 그런데 읽기 RPC(`202608060017_roster_snapshot_cas.sql:43,55`)는 `limit 101`이라, 101명째부터 명단 화면 전체가 실패합니다.
- 요금제 문구(`src/utils/plans.ts:105,117`)도 이 실제 상한과 맞지 않습니다.

**변경**
- [ ] 명단 저장 서버 액션에서 실효 한도(`min(플랜, INITIAL_OPERATIONS_LIMITS)`)를 넘으면 `capacity_exceeded`로 거절하고 구체적인 문구를 보여줍니다.
- [ ] CSV 가져오기 미리보기에서도 한도 초과를 미리 표시합니다.
- [ ] `loadTeacherCapacityUsage()` 액션을 만듭니다. `count: exact, head: true`로 학생, 반, 수강, 시험, 응시 수를 셉니다.
  - 결제 화면과 설정 화면에 "초기 운영 지원 범위" 카드를 둡니다.
- [ ] `resolveCapacityWarnings()`로 80% 이상이면 대시보드와 명단 화면 상단에 배너를 띄웁니다.
- [ ] 요금제 문구를 고칩니다. (PO 결정 C-1)

### C2b-S. 안전한 부분 저하 (S)
- [ ] 학생 로그인 수강 조회(`actions/studentSession.ts:442-463`): 반 전체를 `limit 101`로 읽지 않고, 이름이 같은 후보 프로필 ID로만 `.in()` 조회합니다. 그러면 반 인원이 101명을 넘어도 로그인이 실패하지 않습니다.
- [ ] 실시간 화면 카탈로그(`teacher/live/page.tsx:366-375`): 명단 로드 실패를 화면 전체 실패로 처리하지 않고, 이름 없이 응시 정보만 표시합니다.

### C3a. 정답 편집 시 경고 (S)
- [ ] `/create` 편집 모드에서 `getTeacherCanonicalAttemptAggregate({examId})`로 제출 수와 진행 중 세션 수를 조회합니다.
- [ ] `diffAnswerKeyChanges(before, after)`로 정답, 배점, 문항 추가·삭제를 감지합니다. 바뀐 상태로 저장하면 확인 모달을 띄웁니다.
  - 문구: "이미 제출한 학생 N명의 점수는 바뀌지 않습니다. 진행 중인 M명도 시작 시점 정답으로 채점됩니다. 변경은 이후 응시자에게만 적용됩니다."

### C4-4①. "미응시자 전체 알람 발송" 버튼 연결 (S)
- [ ] 지금은 토스트만 띄웁니다(`OverviewTab.tsx:399-413`, `live/page.tsx:801-812`).
- [ ] 버튼 이름을 "학습 알림에서 미응시자 확인·발송"으로 바꾸고 `/teacher/reminders?examId=`로 연결합니다. 미리보기를 자동 실행하고, 설정이나 권한이 없으면 이유를 보여줍니다.

### C4-6. /create 탭별 초안 슬롯 (S)
- [ ] `create/createPageHelpers.ts:3`의 단일 키 `…:new`를 탭별 `new:<uuid>` 키로 바꿉니다(sessionStorage에 고정).
- [ ] 진입 시 "복구 가능한 초안 N개"를 보여줍니다.
- [ ] 같은 시험을 다른 탭에서 편집 중이면 `BroadcastChannel`로 감지해 경고합니다.

### C4-7. 교사 로그인 전역 rate limit (S)
**원인:** `actions/auth.ts:128-135`가 성공한 시도까지 모두 전역 버킷 하나(500회/10분)에서 `consume`합니다. 누군가 500번만 시도하면 전체 교사 로그인이 10분간 막힐 수 있습니다.

**변경**
- [ ] 전역 버킷은 시작할 때 `check`만 하고, 실패했을 때만 `failure`로 기록합니다.
- [ ] 신뢰할 수 있는 프록시 헤더 환경변수가 설정되어 있으면 IP별 버킷을 추가합니다.

---

## Phase 3 — 교사 생산성

| ID | 내용 | 크기 |
|---|---|---|
| C1-2 | 상세 응시를 `.in("id", chunk)`로 묶어 조회(N+1 제거), 시험 범위 상한을 따로 정의(기본 300, PO 결정 C-3) | M |
| C1-3 | 학생별 탭을 "최근 시험 창" 방식으로 부분 저하, 화면에 "최근 시험 K개 기준" 표시 | M |
| C2b-M | 실시간 세션 100건 초과 시 일부만 표시하고 overflow 배너. 시험 목록은 보관하지 않은 시험만 250개 상한 적용 | M |
| C4-1A | 시험 복제(문항, 정답, 배점, 태그만, PDF 제외). 단일 RPC `omr_duplicate_exam_v1`이 쿼터 예약까지 원자적으로 처리. `teacherExamMutationSurface.test.ts`의 "removes duplication" 테스트는 의도적으로 개정 (PO 결정 C-5) | M |
| C4-2 | "성적표 CSV" 신설: 이름, 반, 학번, 점수, 문항별 응답·O/X, 한국어 헤더, KST. owner/admin/teacher만 사용, 감사 로그 기록. 기존 해시 CSV는 "익명 통계 CSV"로 이름 변경 (PO 결정 C-6) | M |
| C4-3 | 명단 CSV: 한글 헤더 별칭, 이메일 선택화(이름·반·지역으로 대조, 동명이인은 충돌 흐름으로), 학부모 연락처를 알림 연락처로 저장, 한국어 양식 다운로드 (PO 결정 C-7) | M |
| C4-5 | `canTeacherRolePerform(role, action)` 매트릭스. 조교는 조회, 질문 답변, 서술형 검토만 허용 (PO 결정 C-10). 강사 초대 기능 전에 반드시 필요 | S~M |

---

## Later — 분기 단위

- **C3b 재채점 (L):** 봉인된 제출 근거는 그대로 둡니다. 정정 규칙을 append-only로 쌓는 `omr_exam_grading_revisions`를 둡니다.
  - 규칙 종류: `replace_key`, `accept_additional`, `all_correct`, `void`
  - 응시별 실효 점수 `omr_attempt_effective_grades`를 둡니다.
  - SQL과 TS가 같은 규칙 함수를 씁니다(golden vector 동치 테스트).
  - 미리보기 RPC와 적용 RPC(CAS 포함, 감사 로그), 학생용 정정 안내 배너를 둡니다.
  - 점수를 읽는 곳 약 10곳을 `resolveAttemptGrading` 한 곳으로 모읍니다.
  - (PO 결정 C-4)
- **C3c 복수정답 / 주관식:**
  - 출제 시점 복수정답(L): `acceptedAnswers?: number[]`를 덧붙이는 방식으로 추가하고, evidence는 v2로 올립니다. 이미 제출된 시험은 C3b의 `accept_additional`로 해결됩니다.
  - 주관식(XL): 자동 채점은 XL입니다. 기존 subQuestion과 교사 판정 흐름을 재사용하면 L입니다. (PO 결정 C-9)
  - "2개 고르시오" 복수선택형은 범위에서 제외합니다.
- **C2c 플랜 연동 상한과 페이지네이션 (XL):** 명단을 행 단위 mutation과 keyset 방식으로 바꾸고, `effectiveOperationsLimits(plan)`을 도입하며, 300명 기준 부하·복구 증거를 다시 확보합니다. (PO 결정 C-2)
- **C4-4② 알림 즉시 발송 (M):** 중복 방지, 정숙 시간, dry_run 표시를 포함합니다. (PO 결정 C-8)
- **C4-1B PDF 포함 복제 (M~L).**
- **조직 기능**
  1. 권한 매트릭스와 감사 로그 헬퍼
  2. 강사 초대(owner 단일 provisioning 계약 확장)
  3. 구성원·역할 UI와 감사 로그 뷰어
  4. 조직 대시보드(C1-2, C2c 이후)
- **학생용 성장 화면**, 학생 마감 알림, 문항 은행, XLSX와 구글시트 연동, 종이 OMR 사진 채점은 페르소나 평가의 "더 원하는 점"에 있습니다. 위 단계가 끝난 뒤 다시 우선순위를 정합니다.

---

## 결정 기록 (2026-10-02)

- 실행 범위: **Phase 0 + Phase 1**을 먼저 구현합니다. Phase 2 이후는 Phase 1 재평가 뒤 착수합니다.
- C-1 요금제 문구: **각주 추가**(300명/무제한 유지 + "초기 운영 기간: 조직당 학생 100명 · 누적 시험 250개" + 용량 게이지). Phase 2 C2a에서 반영합니다.
- B-1 학생 세션: **로그인 후 12시간 고정**을 유지합니다. 만료 화면, 자동 채움, 체크박스 문구 정정으로 대응합니다.
- A-4 폰 첫 진입 OMR: **펼침 유지**(툴바 압축과 PDF 최소 높이로 해결).
- 나머지 항목은 아래 ✅ 기본안으로 진행합니다.

## PO 결정 사항

✅는 결정이 없을 때 진행할 기본안입니다.

**트랙 A**
- A-1. 문항 수 51 이상 입력 시: ✅ 50으로 고정하고 inline 안내 / 이전 값으로 되돌리고 안내. 50 상한 자체를 올릴지도 함께 결정합니다.
- A-2. 교사 미리보기 진입 방식: ✅ 교사 세션 감지 + `?preview=teacher` / 교사 화면에 "학생 화면 미리보기" 버튼 추가
- A-3. 학생 "PDF 열기": ✅ 첨부 PDF가 없는 시험에서만 노출 / 완전 제거
- A-4. 폰 첫 진입 시 OMR: ✅ 펼침 유지 / 높이 640px 이하에서는 peek 바로 시작(e2e 다수 수정 필요)
- A-5. 빠른 정답 입력의 빈칸 기호: ✅ `-`만 / `-`, `0`, `.` 모두 허용
- A-6. SW 캐시를 v17로 올려 기존 PWA 사용자 캐시를 한 번 비우기: ✅ 동의 / 보류

**트랙 B**
- B-1. 학생 서버 세션 12시간: ✅ 로그인 후 고정 / 마지막 활동 후 12시간으로 연장(보안 검토 필요)
- B-2. 프로덕션 재로그인: ✅ 초대 링크 재전송 안내 강화 / opt-in 학생에 한해 초대 토큰을 로컬에 보관(보안 검토 필요)
- B-3. 재방문 힌트에 저장할 정보: ✅ 이름과 반만 / 학생번호·이메일까지
- B-4. 서버 로그인에서 이름 공백 정규화(신원 매칭 규칙 변경): ✅ 이번 범위에서 제외 / 포함
- B-5. 완료 카드에 점수 표시: ✅ 표시 안 함 / 교사의 점수 공개 설정을 따름
- B-6. 교사 화면과 history의 "재시험 회복" 용어 통일: ✅ 이번에는 학생 리뷰만 / 전체 통일
- B-7. 제한 시간이 있는 시험의 대시보드 "시작": ✅ 카드에 제한 시간을 표시하고 바로 시작 / 안내 화면 한 번 거치기
- B-8. 게스트 이름: ✅ 기본값 "게스트" / 필수 입력

**트랙 C**
- C-1. 요금제 문구: ✅ 300명/무제한은 유지하고 "초기 운영 기간: 조직당 학생 100명 · 누적 시험 250개" 각주 추가 / 초기 운영 기간에는 모든 유료 플랜을 "학생 100명"으로 표기
- C-2. 초기 100명 계약의 해제 시점과, 300명 부하·복구 증거의 요구 수준
- C-3. 시험 하나당 상세 분석 상한: ✅ 300 / 플랜별 차등
- C-4. 재채점 정책: 전원 정답 처리 시 미응답자 포함 여부, 무효 문항의 총점 처리(제외 또는 재분배), 학생에게 자동 공개할지, 적용 가능한 역할
- C-5. 복제 범위: ✅ PDF 제외(A)로 먼저 출시 / PDF 포함(B) 필수
- C-6. 성적표 CSV: ✅ owner/admin/teacher만, 감사 로그 기록, 학번 포함·연락처 제외 / 기타
- C-7. 명단 CSV에서 같은 반 동명이인: ✅ 충돌 흐름에서 수동 판정 / 거부
- C-8. 알림 즉시 발송 허용 여부, 정숙 시간, 1일 발송 상한
- C-9. 주관식: ✅ 교사 판정형(subQuestion 재사용) 먼저 / 자동 채점(정규화 규칙)
- C-10. 조교 권한: ✅ 조회, 질문 답변, 서술형 검토만 / 강제 종료나 재시험 발급까지 허용

---

## 검증 게이트 (모든 PR 공통)

- `npx tsc --noEmit`
- `npm run lint`
- `npm test` (vitest)
- 변경한 영역의 Playwright spec. UI 변경이면 `ios-mobile-layout`, `tablet-layout`, `student-simplification`, `full-journey`를 포함합니다.
- PDF·번들 관련 변경은 `npm run build`(postbuild 라우트 예산)를 통과해야 합니다.
- 마이그레이션이 있는 Task는 추가로 다음을 갱신합니다.
  - `supabase/production-server-boundary.sql` allowlist와 RLS
  - `supabase/live-test-assertions.sql`
  - `npm run test:supabase:live`
- 완료 판정: 페르소나 재평가를 돌려 해당 단계의 목표 점수를 확인합니다. Phase 1 이후 학생 초보 그룹, Phase 3 이후 교사 일주일 그룹을 다시 평가합니다.
