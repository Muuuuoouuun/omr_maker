import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("service UI surface", () => {
    it("keeps premium scrollbars on the app, PDF viewer, and dense panels", () => {
        const css = readProjectFile("src/app/globals.css");
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(css).toContain("body::-webkit-scrollbar");
        expect(css).toContain(".scroll-custom::-webkit-scrollbar-thumb");
        expect(css).toContain(".pdf-viewer-scroll");
        expect(css).toContain("scrollbar-gutter: stable both-edges");
        expect(pdfViewer).toContain('className="pdf-viewer-scroll scroll-custom"');
        expect(createPage).toContain("scroll-custom create-settings-sidebar");
        expect(createPage).toContain("create-settings-sticky-summary");
        expect(css).toContain(".create-settings-sticky-summary");
        expect(createPage).toContain("scroll-custom create-preview-scroll");
        expect(solvePage).toContain("scroll-custom solve-omr-scroll");
    });

    it("keeps the exam creation preview in real paper and OMR answer-sheet modes", () => {
        const css = readProjectFile("src/app/globals.css");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const omrPreview = readProjectFile("src/components/OMRPreview.tsx");

        expect(createPage).toContain("previewMode === 'paper'");
        expect(createPage).toContain("인쇄용 (A4)");
        expect(createPage).toContain("create-paper-frame-toolbar");
        expect(createPage).toContain("A4 가로");
        expect(createPage).toContain("create-preview-context-strip");
        expect(createPage).toContain("create-preview-context-meter");
        expect(createPage).toContain("isPreviewCollapsed");
        expect(createPage).toContain("create-preview-collapsed-rail");
        expect(createPage).toContain("OMR 미리보기 접기");
        expect(createPage).toContain("OMR 미리보기 펼치기");
        expect(createPage).toContain("선택 문항");
        expect(createPage).toContain("PDF 영역");
        expect(css).toContain(".create-preview-scroll.paper-mode");
        expect(css).toContain(".create-preview-main.is-collapsed");
        expect(css).toContain(".create-preview-context-grid");
        expect(css).toContain(".create-paper-frame .omr-sheet::before");
        expect(css).toContain(".create-paper-frame-toolbar span");
        expect(omrPreview).toContain("수험번호 마킹란");
        expect(omrPreview).toContain("omr-marker-tl");
        expect(omrPreview).toContain("OMR Maker - Generated Answer Sheet");
    });

    it("keeps existing distribution access settings when reopening the share flow", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const distributeModal = readProjectFile("src/components/DistributeModal.tsx");

        expect(createPage).toContain("initialAccessConfig={loadedExam?.accessConfig}");
        expect(distributeModal).toContain("initialAccessConfig?: AccessConfig");
        expect(distributeModal).toContain("const wasOpenRef = useRef(false)");
        expect(distributeModal).toContain("if (wasOpenRef.current)");
        expect(distributeModal).toContain("wasOpenRef.current = true");
        expect(distributeModal).toContain("const initialType = initialAccessConfig?.type === 'group' ? 'group' : 'public'");
        expect(distributeModal).toContain("setAccessType(initialType)");
        expect(distributeModal).toContain("setSelectedGroups(initialType === 'group' ? [...(initialAccessConfig?.groupIds || [])] : [])");
        expect(distributeModal).toContain('setPin(initialType === \'public\' ? normalizeExamPin(initialAccessConfig?.pin || "") : "")');
        expect(distributeModal).toContain("summarizeDistributionTargets");
        expect(distributeModal).toContain("formatRegionScopedLabel(g.name, g.region)");
        expect(distributeModal).toContain("그룹 배포 대상 요약");
        expect(distributeModal).toContain("명단 기준 대상");
        expect(distributeModal).toContain("미응시/카카오 후보 산정");
    });

    it("keeps tablet handwriting usable with stylus-first input and finger scrolling", () => {
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");

        expect(pdfViewer).toContain("activeDrawingModeRef");
        expect(pdfViewer).toContain("e.pointerType === 'pen' && drawingMode === 'click'");
        expect(pdfViewer).toContain("if (e.pointerType === 'touch' && !fingerDrawingEnabled) return false");
        expect(pdfViewer).toContain("setDrawingMode('pen')");
        expect(pdfViewer).toContain("pointerEvents: canEditDrawing ? 'auto' : 'none'");
        expect(pdfViewer).toContain("touchAction: fingerDrawingEnabled ? 'none' : 'pan-x pan-y pinch-zoom'");
    });

    it("keeps student handwriting visible as question-linked OMR status while solving", () => {
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const omrCardView = readProjectFile("src/components/OMRCardView.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(solvePage).toContain("const activeQuestionDrawings = summarizeQuestionDrawings(activeExamQuestions, drawings)");
        expect(solvePage).toContain("questionDrawings={activeQuestionDrawings}");
        expect(solvePage).toContain("solve-omr-pane-handwriting");
        expect(omrCardView).toContain("questionDrawings?: QuestionDrawingSummary[]");
        expect(omrCardView).toContain("q-handwriting-chip");
        expect(omrCardView).toContain("has-handwriting");
        expect(css).toContain(".q-handwriting-chip");
        expect(css).toContain(".solve-omr-pane-handwriting");
    });

    it("shows a recoverable student-facing error when a solve link cannot load an exam", () => {
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(solvePage).toContain("SolveLoadErrorCard");
        expect(solvePage).toContain("시험을 찾을 수 없습니다");
        expect(solvePage).toContain("시험 데이터를 읽지 못했습니다");
        expect(solvePage).toContain('Link href="/?role=student"');
    });

    it("keeps guest attempt merging visible and idempotent in the student flow", () => {
        const homePage = readProjectFile("src/app/page.tsx");
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const storage = readProjectFile("src/utils/storage.ts");

        expect(storage).toContain("previewGuestMerge");
        expect(storage).toContain("isGuestAttemptMergeable");
        expect(homePage).toContain("게스트 기록 연결 예정");
        expect(homePage).toContain("formatRegionScopedLabel(g.name, g.region)");
        expect(homePage).toContain("recentStudentSession");
        expect(homePage).toContain("최근 학생");
        expect(homePage).toContain("handleContinueRecentStudent");
        expect(studentDashboard).toContain("연결하지 않은 게스트 기록");
        expect(studentDashboard).toContain("handleMergeGuestIntoCurrentStudent");
        expect(studentDashboard).toContain("previewGuestMerge");
    });

    it("keeps teacher session health visible in operational headers", () => {
        const teacherHeader = readProjectFile("src/components/TeacherHeader.tsx");
        const sessionChip = readProjectFile("src/components/TeacherSessionChip.tsx");
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(sessionChip).toContain("buildTeacherSessionDisplay");
        expect(sessionChip).toContain("교사 세션");
        expect(sessionChip).toContain("visibilitychange");
        expect(teacherHeader).toContain("<TeacherSessionChip");
        expect(dashboardPage).toContain("<TeacherSessionChip");
        expect(createPage).toContain("<TeacherSessionChip compact");
        expect(settingsPage).toContain("buildTeacherSessionDisplay");
        expect(css).toContain(".teacher-session-chip");
        expect(css).toContain(".teacher-session-chip-prefix");
    });

    it("keeps billing local-plan changes clear until real payment integration exists", () => {
        const billingPage = readProjectFile("src/app/teacher/billing/page.tsx");
        const paymentProvider = readProjectFile("src/lib/paymentProvider.ts");
        const globalSearch = readProjectFile("src/components/GlobalSearch.tsx");
        const notificationBell = readProjectFile("src/components/NotificationBell.tsx");

        expect(billingPage).toContain("실결제 미연동");
        expect(billingPage).toContain("로컬 플랜 변경 기록");
        expect(billingPage).toContain("다음 사용 주기");
        expect(billingPage).toContain("결제/플랜 기록");
        expect(billingPage).toContain("기록 금액");
        expect(billingPage).toContain("프리미엄 기능 상태");
        expect(billingPage).toContain("사용량·권한 서비스 점검");
        expect(billingPage).toContain("buildBillingPlanHealth");
        expect(billingPage).toContain("잠긴 프리미엄 기능");
        expect(billingPage).toContain("lockedEntitlementSummary");
        expect(billingPage).toContain("Pro 이상에서 제출 후 원본 보관");
        expect(billingPage).toContain("getPlanEntitlementViews");
        expect(billingPage).toContain("getPaymentProviderReadiness");
        expect(billingPage).toContain("getPaymentProviderRolloutReadiness");
        expect(billingPage).toContain("결제 provider 상태");
        expect(billingPage).toContain("canRecordLocalPlanChange");
        expect(paymentProvider).toContain("공개키 확인");
        expect(paymentProvider).toContain("공개키 필요");
        expect(billingPage).not.toContain("다음 결제");
        expect(billingPage).not.toContain('title="영수증 다운로드"');
        expect(billingPage).not.toContain("Visa •••• 4242");
        expect(globalSearch).toContain("결제/플랜 기록");
        expect(globalSearch).not.toContain("인보이스");
        expect(notificationBell).toContain("createLocalPlanCycleReminder");
        expect(notificationBell).not.toContain("자동 결제");
        expect(billingPage).toContain("토스페이먼츠");
        expect(billingPage).toContain("네이버페이");
        expect(billingPage).toContain("카카오페이");
    });

    it("keeps premium analytics actions gated by the current plan", () => {
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const examAnalyticsTab = readProjectFile("src/components/dashboard/tabs/ExamAnalyticsTab.tsx");
        const studentAnalyticsTab = readProjectFile("src/components/dashboard/tabs/StudentAnalyticsTab.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const premiumGate = readProjectFile("src/components/PremiumFeatureGate.tsx");

        expect(dashboardPage).toContain("getCurrentPlan");
        expect(examAnalyticsTab).toContain("resolveExamSelectionInputValue");
        expect(dashboardPage).toContain("loadRosterSnapshot(localStorage)");
        expect(dashboardPage).toContain("summarizePersistenceHealth([examResult, attemptResult, rosterResult])");
        expect(dashboardPage).toContain("rosterStudents: shouldSeedDemo ? undefined : loadedRosterStudents");
        expect(dashboardPage).toContain("dashboardAnalysisActions");
        expect(dashboardPage).toContain('aria-label="분석 다음 조치"');
        expect(dashboardPage).toContain("시험 출제하기");
        expect(dashboardPage).toContain("데이터 다시 확인");
        expect(dashboardPage).toContain("문항 결과 복구");
        expect(dashboardPage).toContain("시험 메타 보강");
        expect(dashboardPage).toContain("시험 분석 보기");
        expect(dashboardPage).toContain("학생 성취도 보기");
        expect(dashboardPage).toContain("rosterStudents={rosterStudents}");
        expect(dashboardPage).toContain("rosterGroups={rosterGroups}");
        expect(dashboardPage).toContain("currentPlan={currentPlan}");
        expect(dashboardPage).toContain("NotificationBell");
        expect(examAnalyticsTab).toContain("advancedAnalyticsEnabled");
        expect(examAnalyticsTab).toContain("retakeAssignmentsEnabled");
        expect(examAnalyticsTab).toContain("시험 분석 지역 필터");
        expect(examAnalyticsTab).toContain("filterAttemptsByRegion");
        expect(examAnalyticsTab).toContain("formatRegionScopedLabel");
        expect(examAnalyticsTab).toContain("resolveScopedSelection");
        expect(examAnalyticsTab).toContain("setSelectedClassKey(\"\")");
        expect(examAnalyticsTab).toContain("setSelectedStudentKey(\"\")");
        expect(examAnalyticsTab).toContain("rosterGroups: scopedRosterGroups");
        expect(examAnalyticsTab).toContain("rosterStudents: scopedRosterStudents");
        expect(examAnalyticsTab).toContain("참여율");
        expect(examAnalyticsTab).toContain("미응시");
        expect(examAnalyticsTab).toContain("buildKakaoNotificationCandidates");
        expect(examAnalyticsTab).toContain("setKakaoCandidateReview");
        expect(examAnalyticsTab).toContain("summarizeKakaoCandidateReviews");
        expect(examAnalyticsTab).toContain("queueKakaoDispatchSimulation");
        expect(examAnalyticsTab).toContain("summarizeKakaoDispatchLogs");
        expect(examAnalyticsTab).toContain("updateKakaoDispatchLogStatus");
        expect(examAnalyticsTab).toContain("getKakaoProviderReadiness");
        expect(examAnalyticsTab).toContain("카카오 provider 상태");
        expect(examAnalyticsTab).toContain("카카오 후보 검토");
        expect(examAnalyticsTab).toContain("발송 전 후보만 정리합니다");
        expect(examAnalyticsTab).toContain("발송 준비");
        expect(examAnalyticsTab).toContain("발송 대기 기록");
        expect(examAnalyticsTab).toContain("발송 완료 기록");
        expect(examAnalyticsTab).toContain("발송 실패 기록");
        expect(examAnalyticsTab).toContain("발송 취소 기록");
        expect(examAnalyticsTab).toContain("보류");
        expect(examAnalyticsTab).toContain("제외");
        expect(examAnalyticsTab).toContain("후보 검토");
        expect(examAnalyticsTab).toContain("고급 분석 잠금");
        expect(examAnalyticsTab).toContain("PremiumActionLink");
        expect(studentAnalyticsTab).toContain("학생 분석 지역 필터");
        expect(studentAnalyticsTab).toContain("filterAttemptsByRegion");
        expect(studentAnalyticsTab).toContain("regionNameForAttempt");
        expect(studentAnalyticsTab).toContain("resolveScopedSelection");
        expect(studentAnalyticsTab).toContain("setSelectedStudentKey(\"\")");
        expect(studentAnalyticsTab).toContain("학생별 액션 잠금");
        expect(studentAnalyticsTab).toContain("remindersEnabled");
        expect(studentAnalyticsTab).toContain("retakeAssignmentsEnabled");
        expect(usersPage).toContain("studentGrowthReportsEnabled");
        expect(usersPage).toContain("advancedAnalyticsEnabled");
        expect(usersPage).toContain("성장 리포트 Pro");
        expect(usersPage).toContain("반별 리포트 Pro");
        expect(usersPage).toContain("학생 성장 리포트는 Pro 기능입니다");
        expect(teacherAttemptPage).toContain("pdfExportEnabled");
        expect(teacherAttemptPage).toContain("PDF 리포트 Pro");
        expect(teacherAttemptPage).toContain("window.print()");
        expect(premiumGate).toContain('href="/teacher/billing"');
        expect(premiumGate).toContain("requiredPlan");
        expect(premiumGate).toContain("Pro 필요");
    });

    it("keeps the dashboard overview bento grid usable on mobile", () => {
        const css = readProjectFile("src/app/globals.css");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");

        expect(overviewTab).toContain("overview-quick-actions-grid");
        expect(overviewTab).toContain("overview-exam-summary-card");
        expect(overviewTab).toContain("overview-stats-stack");
        expect(overviewTab).toContain("overview-recent-exams-card");
        expect(css).toContain(".bento-card");
        expect(css).toContain("min-width: 0");
        expect(css).toContain("grid-template-columns: minmax(0, 1fr) !important");
        expect(css).toContain(".bento-grid > *");
        expect(css).toContain(".overview-exam-summary-card");
        expect(css).toContain(".overview-stats-stack");
        expect(css).toContain(".overview-recent-exams-card");
        expect(css).toContain(".bento-grid > .bento-card");
        expect(css).toContain(".overview-quick-actions-grid");
        expect(css).toContain("repeat(2, minmax(0, 1fr)) !important");
    });

    it("keeps original exam achievement separate from retake recovery in student-facing analytics", () => {
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const studentHistory = readProjectFile("src/app/student/history/page.tsx");
        const studentAnalyticsTab = readProjectFile("src/components/dashboard/tabs/StudentAnalyticsTab.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");

        expect(studentDashboard).toContain("나의 원시험 평균");
        expect(studentDashboard).toContain("완료한 원시험");
        expect(studentDashboard).toContain("retakeAttemptsOnly(myAttempts)");
        expect(studentHistory).toContain("원시험 응시");
        expect(studentHistory).toContain("재시험 회복");
        expect(studentHistory).toContain("재시험 {attempt.retake.questionIds.length}문항");
        expect(studentAnalyticsTab).toContain("원시험 점수 추이");
        expect(studentAnalyticsTab).toContain("재시험 회복 기록");
        expect(studentAnalyticsTab).toContain("studentBaseAttempts");
        expect(usersPage).toContain("원시험 평균");
        expect(usersPage).toContain("profile.retakeAttemptCount");
    });

    it("keeps 5-choice exams as the visible default while preserving explicit 4-choice support", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");

        expect(createPage).toContain("useState<4 | 5>(DEFAULT_CHOICE_COUNT)");
        expect(createPage.indexOf("handleDefaultChoicesChange(5)")).toBeLessThan(createPage.indexOf("handleDefaultChoicesChange(4)"));
        expect(settingsPage.indexOf("<option value={5}>5지선다</option>")).toBeLessThan(settingsPage.indexOf("<option value={4}>4지선다</option>"));
    });

    it("keeps exam creation service readiness visible before distribution", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const readiness = readProjectFile("src/lib/examServiceReadiness.ts");

        expect(createPage).toContain("buildExamServiceReadiness");
        expect(createPage).toContain("운영 점검");
        expect(createPage).toContain("serviceReadiness.canOpenDistribution");
        expect(createPage).toContain("serviceReadiness.items.map");
        expect(createPage).toContain("setLoadedExam(examData)");
        expect(createPage).toContain("setQuestions(questionsWithRegions)");
        expect(createPage).toContain("router.replace(`/create?edit=${id}`");
        expect(readiness).toContain("저장 기준");
        expect(readiness).toContain("정답키");
        expect(readiness).toContain("문제지 PDF");
        expect(readiness).toContain("배포 설정");
        expect(readiness).toContain("canPublish");
    });

    it("shows question DB readiness without requiring per-question image assets", () => {
        const examAnalyticsTab = readProjectFile("src/components/dashboard/tabs/ExamAnalyticsTab.tsx");

        expect(examAnalyticsTab).toContain("문항 DB 준비 상태");
        expect(examAnalyticsTab).toContain("canonical ID, 유형 태그, PDF 영역");
        expect(examAnalyticsTab).toContain("프리미어 문항 이미지 DB");
        expect(examAnalyticsTab).toContain("Canonical question rows");
    });

    it("keeps PDF question region calibration visible in exam creation", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");

        expect(createPage).toContain("문항 영역 보정");
        expect(createPage).toContain("handleReinferQuestionRegions");
        expect(createPage).toContain("handleClearSelectedPdfLink");
        expect(createPage).toContain("handleClearAllPdfRegions");
        expect(createPage).toContain("region: region");
        expect(pdfViewer).toContain("interface MarkerRegion");
        expect(pdfViewer).toContain("title={`문항 영역 ${marker.label}번`}");
        expect(pdfViewer).toContain("marker.region.width");
    });

    it("keeps exam PDF upload recoverable and question labeling quick in creation", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");
        const omrCardView = readProjectFile("src/components/OMRCardView.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(createPage).toContain('const PDF_ACCEPT = "application/pdf,.pdf"');
        expect(createPage).toContain("handleProblemPdfFile");
        expect(createPage).toContain("handleAnswerKeyPdfFile");
        expect(createPage).toContain("문항 빠른 세팅");
        expect(createPage).toContain("create-question-quick-card");
        expect(createPage).toContain("questionChoiceCount");
        expect(createPage).toContain("문항 라벨 일괄 적용");
        expect(createPage).toContain("applyBatchLabels");
        expect(createPage).toContain('numberingLayout="vertical"');
        expect(pdfViewer).toContain("function isPdfUploadFile(file: File): boolean");
        expect(pdfViewer).toContain("onLoadError={handleDocumentLoadError}");
        expect(omrCardView).toContain('numberingLayout?: "grid" | "vertical"');
        expect(css).toContain(".create-question-answer-buttons");
        expect(css).toContain(".create-label-batch-card");
        expect(css).toContain(".omr-cardview.is-vertical-numbering .omr-cardview-grid");
    });

    it("keeps tablet solving usable with a collapsible right-side quick OMR rail", () => {
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(solvePage).toContain("solve-omr-quick-card");
        expect(solvePage).toContain("quickAnswerQuestion");
        expect(solvePage).toContain("quickAnswerChoiceCount");
        expect(solvePage).toContain("solve-omr-quick-bubble");
        expect(solvePage).toContain("nextQuickTarget");
        expect(solvePage).toContain("solve-omr-quick-handwriting");
        expect(css).toContain(".solve-omr-rail.is-collapsed");
        expect(css).toContain(".solve-omr-quick-card");
        expect(css).toContain(".solve-omr-quick-bubble.is-marked");
        expect(css).toContain("@media (min-width: 641px) and (max-width: 1180px)");
    });

    it("keeps Kakao notifications planned without implying live sending", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");
        const notificationBell = readProjectFile("src/components/NotificationBell.tsx");

        expect(settingsPage).toContain("카카오 알림 준비");
        expect(settingsPage).toContain("카카오 발송 대상 후보");
        expect(overviewTab).toContain("카카오 알림 연동 전");
        expect(overviewTab).not.toContain("전송했습니다");
        expect(overviewTab).not.toContain("알람 발송 완료");
        expect(usersPage).toContain("카카오 초대 기록");
        expect(usersPage).toContain("초대 기록 추가됨");
        expect(usersPage).toContain("시작 코드");
        expect(usersPage).toContain("handleIssueStudentStartCode");
        expect(usersPage).toContain("generateStartCode");
        expect(notificationBell).toContain("buildKakaoNotificationCandidates");
        expect(notificationBell).toContain("카카오 발송 후보 대기");
        expect(notificationBell).toContain("classRetakeRecommendationCount");
        expect(notificationBell).toContain("반별 재시험");
        expect(notificationBell).toContain("발송 전");
        expect(notificationBell).not.toContain("발송했습니다");
        expect(notificationBell).not.toContain("카카오 발송 완료");
        expect(usersPage).not.toContain("초대 발송됨");
        expect(usersPage).not.toContain("이메일로 초대");
        expect(usersPage).not.toContain("메시지 전송됨");
    });

    it("keeps settings data DB readiness tied to shared storage sources", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");

        expect(settingsPage).toContain("데이터 · DB");
        expect(settingsPage).toContain("DataDbSection");
        expect(settingsPage).toContain("buildDataDbReadiness");
        expect(settingsPage).toContain("loadExams()");
        expect(settingsPage).toContain("loadAttempts()");
        expect(settingsPage).toContain("loadRosterSnapshot(window.localStorage)");
        expect(settingsPage).toContain("readRosterTombstones(window.localStorage)");
        expect(settingsPage).toContain('aria-label="데이터 DB 상태 새로고침"');
        expect(settingsPage).toContain("원격 동기화 세부 상태");
        expect(settingsPage).toContain("summary.syncSources");
        expect(settingsPage).toContain('sourceLabel: "시험"');
        expect(settingsPage).toContain('sourceLabel: "제출"');
        expect(settingsPage).toContain('sourceLabel: "명단"');
        expect(settingsPage).toContain("보관 표시");
        expect(settingsPage).toContain("재시도 대기");
    });

    it("marks dashboard demo data as demo-only", () => {
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(dashboardPage).toContain('type DashboardDataMode = "real" | "demo"');
        expect(dashboardPage).toContain("데모 데이터 모드");
        expect(dashboardPage).toContain('aria-label="데모 데이터 안내"');
        expect(dashboardPage).toContain("summarizeAnalyticsDataHealth");
        expect(dashboardPage).toContain("buildQuestionResultRepairPlan");
        expect(dashboardPage).toContain("handleRepairAnalyticsData");
        expect(dashboardPage).toContain("handleRefreshDashboardData");
        expect(dashboardPage).toContain("isRefreshingDashboardData");
        expect(dashboardPage).toContain('aria-label="동기화 다시 확인"');
        expect(dashboardPage).toContain("동기화 확인 완료");
        expect(dashboardPage).toContain("문항 결과 자동 복구");
        expect(dashboardPage).toContain("복구 대상 미리보기");
        expect(dashboardPage).toContain("자동 복구 제외");
        expect(dashboardPage).toContain("skippedOrphanAttemptCount");
        expect(dashboardPage).toContain("skippedInProgressAttemptCount");
        expect(dashboardPage).toContain('aria-label="분석 데이터 상태"');
        expect(dashboardPage).toContain("dashboard-data-health");
        expect(css).toContain(".dashboard-data-health");
        expect(dashboardPage).toContain("metrics.trendData.length === 0 && shouldSeedDemo");
        expect(dashboardPage).not.toContain("metrics.trendData.length === 0 && shouldUseDemoData()");
    });

    it("keeps roster demo data display-only", () => {
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");

        expect(usersPage).toContain('type RosterDataMode = "real" | "demo"');
        expect(usersPage).toContain("hasStoredRosterData(localStorage)");
        expect(usersPage).toContain("function isLegacyDemoRosterSnapshot");
        expect(usersPage).toContain("localStorage.removeItem(key)");
        expect(usersPage).toContain("const storedStudents = readRosterStudents(localStorage)");
        expect(usersPage).toContain("loadRosterSnapshot(localStorage)");
        expect(usersPage).toContain("const nextStudents = useDemoRoster ? [] : rosterResult.students");
        expect(usersPage).toContain("saveRosterSnapshot(localStorage");
        expect(usersPage).toContain("데모 명단 모드");
        expect(usersPage).toContain('aria-label="데모 명단 안내"');
        expect(usersPage).toContain("const rosterStudents = isDemoRoster ? MOCK_STUDENTS : students");
        expect(usersPage).toContain("const rosterInvites = isDemoRoster ? MOCK_INVITES : invites");
        expect(usersPage).toContain("buildRegionalLearningScopes");
        expect(usersPage).toContain("지역별 현황");
        expect(usersPage).toContain("학생 지역 필터");
        expect(usersPage).toContain('"name", "email", "group", "region"');
        expect(usersPage).toContain("WeaknessRetakeLink");
        expect(usersPage).toContain("buildRetakeHref");
        expect(usersPage).not.toContain("readRosterStudents(localStorage, fallbackStudents)");
        expect(usersPage).not.toContain("Math.random");
        expect(usersPage).not.toContain("classin.app/join");
    });

    it("keeps live synthetic data scoped to demo mode", () => {
        const livePage = readProjectFile("src/app/teacher/live/page.tsx");

        expect(livePage).toContain('type LiveDataMode = "real" | "demo"');
        expect(livePage).toContain("function resolveLiveExamData");
        expect(livePage).toContain('return { exams: loaded, mode: "real" }');
        expect(livePage).toContain("const isDemoLive = liveDataMode === \"demo\"");
        expect(livePage).toContain("allowSynthetic: isDemoLive");
        expect(livePage).toContain("saveAttempt(attempt)");
        expect(livePage).toContain("forceCompleteLiveAttempt");
        expect(livePage).toContain("카카오 알림 연동 전");
        expect(livePage).toContain("데모 실시간 모드");
        expect(livePage).toContain("응시 결과 확인");
        expect(livePage).toContain("학생별 제출 현황");
        expect(livePage).toContain('aria-label="데모 실시간 데이터 안내"');
        expect(livePage).not.toContain("allowSynthetic: shouldUseDemoData()");
        expect(livePage).not.toContain("!hasExam || !shouldUseDemoData()");
        expect(livePage).not.toContain("독려 알림을 발송했습니다");
        expect(livePage).not.toContain("학생들의 시험 진행 상황을 실시간으로 모니터링하세요.");
        expect(livePage).not.toContain("Math.random");
    });
});
