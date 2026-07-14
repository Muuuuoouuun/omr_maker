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

    it("keeps the exam creation preview in one card mode without a separate print tab", () => {
        const css = readProjectFile("src/app/globals.css");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const omrPreview = readProjectFile("src/components/OMRPreview.tsx");

        expect(createPage).not.toContain("previewMode");
        expect(createPage).not.toContain("showPaperAnswerKey");
        expect(createPage).not.toContain("인쇄용 (A4)");
        expect(createPage).not.toContain("카드뷰");
        expect(createPage).toContain('aria-label="시험 제목"');
        expect(createPage).toContain('aria-label="빠른 정답 입력"');
        expect(createPage).toContain("create-preview-context-strip");
        expect(createPage).toContain("create-preview-context-meter");
        expect(createPage).toContain("create-mobile-panel-nav");
        expect(createPage).toContain("mobile-panel-${mobileWorkspacePanel}");
        expect(createPage).toContain('role="tablist"');
        expect(createPage).toContain('aria-controls="create-settings-panel"');
        expect(createPage).toContain("create-print-only-sheet");
        expect(createPage).toContain('sheetId="omr-print-sheet"');
        expect(createPage).toContain("isPreviewCollapsed");
        expect(createPage).toContain("is-preview-collapsed");
        expect(createPage).toContain("const PREVIEW_RAIL_WIDTH = 64");
        expect(createPage).toContain("create-preview-collapsed-rail");
        expect(createPage).toContain("OMR 미리보기 접기");
        expect(createPage).toContain("OMR 미리보기 펼치기");
        expect(createPage).toContain("선택 문항");
        expect(createPage).toContain("PDF 영역");
        expect(css).not.toContain(".create-preview-scroll.paper-mode");
        expect(css).toContain(".create-preview-main.is-collapsed");
        expect(css).toContain(".create-workspace");
        expect(css).toContain(".create-workspace.mobile-panel-settings .create-settings-sidebar");
        expect(css).toContain(".create-workspace.mobile-panel-preview .create-preview-main");
        expect(css).toContain("flex-basis 0.22s ease");
        expect(css).toContain(".create-preview-context-grid");
        expect(css).toContain(".create-print-only-sheet");
        expect(css).not.toContain(".omr-sheet--numbers-only");
        expect(omrPreview).not.toContain("printVariant");
        expect(omrPreview).toContain("sheetId?: string");
        expect(omrPreview).toContain("수험번호 마킹란");
        expect(omrPreview).toContain("omr-marker-tl");
        expect(omrPreview).toContain("OMR Maker - Generated Answer Sheet");
    });

    it("allows the creation card preview to shrink into one question column", () => {
        const css = readProjectFile("src/app/globals.css");
        const createPage = readProjectFile("src/app/create/page.tsx");

        expect(createPage).toContain("const PREVIEW_PANE_MIN_WIDTH = 260");
        expect(createPage).toContain("const PREVIEW_RAIL_WIDTH = 64");
        expect(createPage).toContain("flex: `0 0 ${pdfWidth}px`");
        expect(createPage).toContain("createWorkspaceRef.current.getBoundingClientRect().width");
        expect(createPage).toContain("setSidebarWidth(sharedPaneWidth - nextPdfWidth)");
        expect(createPage).toContain("const nextPdfWidth = clampLayoutWidth(");
        expect(createPage).toContain("sharedPaneWidth - nextSidebarWidth");
        expect(createPage).toContain("setPdfWidth(nextPdfWidth)");
        expect(createPage).toContain("isPreviewCollapsed ? PREVIEW_RAIL_WIDTH : PREVIEW_PANE_MIN_WIDTH");
        expect(createPage).toContain("workspaceWidth - sidebarWidth - previewWidth");
        expect(createPage).toContain("workspaceWidth - pdfWidth - previewWidth");
        expect(css).toContain("@container (max-width: 540px)");
        expect(css).toContain(".omr-cardview.is-vertical-numbering .omr-cardview-grid");
        expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
        expect(css).toContain("grid-auto-flow: row");
        expect(css).toContain(".omr-cardview.is-vertical-numbering .q-card-num");
        expect(css).toContain("Plain question number; answered cards still change the number color.");
        expect(css).toContain(".q-card.answered .q-card-num");
        expect(css).toContain("border: 0;");
        expect(css).toContain("color: var(--primary)");
        expect(css).toContain("border-color: transparent");
        expect(css).toContain("background: transparent");
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
        expect(solvePage).toContain("solve-teacher-toggle-label");
        expect(solvePage).toContain('aria-label="선생님 모드"');
        expect(omrCardView).toContain("questionDrawings?: QuestionDrawingSummary[]");
        expect(omrCardView).toContain("q-handwriting-chip");
        expect(omrCardView).toContain("has-handwriting");
        expect(css).toContain(".q-handwriting-chip");
        expect(css).toContain(".solve-omr-pane-handwriting");
    });

    it("keeps toast notifications inside mobile safe areas", () => {
        const toastHost = readProjectFile("src/components/Toast.tsx");

        expect(toastHost).toContain("env(safe-area-inset-left)");
        expect(toastHost).toContain("env(safe-area-inset-right)");
        expect(toastHost).toContain("env(safe-area-inset-bottom)");
        expect(toastHost).toContain("alignItems: 'flex-end'");
        expect(toastHost).toContain("width: 'min(400px, 100%)'");
        expect(toastHost).toContain("minWidth: 'min(280px, 100%)'");
        expect(toastHost).toContain("overflowWrap: 'anywhere'");
        expect(toastHost).toContain("pendingMessages");
        expect(toastHost).toContain("listeners.size === 0");
        expect(toastHost).toContain("pendingMessages.splice(0).forEach(listener)");
    });

    it("keeps decorative motion off on mobile, installed app, and reduced-motion surfaces", () => {
        const css = readProjectFile("src/app/globals.css");

        expect(css).toContain("@media (max-width: 920px)");
        expect(css).toContain("(hover: none) and (pointer: coarse)");
        expect(css).toContain("(display-mode: standalone)");
        expect(css).toContain("(prefers-reduced-motion: reduce)");
        expect(css).toContain('html[data-motion="off"] .orb');
        expect(css).toContain("will-change: auto");
        expect(css).toContain("scroll-behavior: auto !important");
    });

    it("keeps the app install prompt reachable on touch tablets", () => {
        const css = readProjectFile("src/app/globals.css");
        const installPrompt = readProjectFile("src/components/MobileInstallPrompt.tsx");

        expect(installPrompt).toContain('(max-width: 820px), (pointer: coarse)');
        expect(css).not.toContain("@media (min-width: 821px)");
        expect(css).toContain("@media (min-width: 1181px) and (hover: hover) and (pointer: fine)");
        expect(css).toContain("left: max(1rem, env(safe-area-inset-left))");
        expect(css).toContain("right: max(1rem, env(safe-area-inset-right))");
        expect(css).toContain("bottom: max(1rem, env(safe-area-inset-bottom), var(--app-keyboard-inset-bottom))");
        expect(css).toContain('body:has(.home-page[data-home-role="student"]) .mobile-install-prompt');
        expect(css).toContain('body:has(.home-page[data-home-role="teacher"]) .mobile-install-prompt');
        expect(css).toContain(".nav-link");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain("min-width: 2.75rem");
        expect(css).toContain("width: 2.75rem");
        expect(css).toContain("height: 2.75rem");
        expect(installPrompt).toContain("useId");
        expect(installPrompt).toContain("aria-describedby={descriptionId}");
        expect(installPrompt).toContain('aria-live="polite"');
        expect(installPrompt).toContain("id={descriptionId}");
        expect(installPrompt).toContain('pathname === "/pwa-check"');
    });

    it("keeps device QA evidence copyable from the PWA check page", () => {
        const pwaCheck = readProjectFile("src/app/pwa-check/page.tsx");
        const themeToggle = readProjectFile("src/components/ThemeToggle.tsx");

        expect(pwaCheck).toContain("pwa-device-verdict");
        expect(pwaCheck).toContain("pwa-device-report-copy");
        expect(pwaCheck).toContain("pwa-device-report-share");
        expect(pwaCheck).toContain("pwa-device-copy-status");
        expect(pwaCheck).toContain("pwa-device-report");
        expect(pwaCheck).toContain("pwa-device-handoff");
        expect(pwaCheck).toContain("pwa-device-handoff-qr");
        expect(pwaCheck).toContain("pwa-proof-verifier");
        expect(pwaCheck).toContain("pwa-proof-input");
        expect(pwaCheck).toContain("pwa-proof-input-ios");
        expect(pwaCheck).toContain("pwa-proof-slot-${target.platform}");
        expect(pwaCheck).toContain("pwa-proof-result");
        expect(pwaCheck).toContain("pwa-proof-result-android");
        expect(pwaCheck).toContain("pwa-proof-result-ios");
        expect(pwaCheck).toContain("pwa-proof-bundle");
        expect(pwaCheck).toContain("pwa-proof-bundle-copy");
        expect(pwaCheck).toContain("pwa-proof-bundle-share");
        expect(pwaCheck).toContain("pwa-proof-bundle-report");
        expect(pwaCheck).toContain("validateProofReport");
        expect(pwaCheck).toContain("buildDualProofBundle");
        expect(pwaCheck).toContain("OMR Maker PWA dual device proof");
        expect(pwaCheck).toContain("readProofPlatform");
        expect(pwaCheck).toContain("Android/iOS 리포트 통과");
        expect(pwaCheck).toContain("Android/iOS 리포트 미통과");
        expect(pwaCheck).toContain("리포트 통과");
        expect(pwaCheck).toContain("리포트 미통과");
        expect(pwaCheck).toContain("INSTALL_PROOF_STEPS");
        expect(pwaCheck).toContain("pwa-install-proof-guide");
        expect(pwaCheck).toContain("pwa-install-proof-step-${index + 1}");
        expect(pwaCheck).toContain("pwa-install-proof-android");
        expect(pwaCheck).toContain("pwa-install-proof-ios");
        expect(pwaCheck).toContain("실기기 설치 확인");
        expect(pwaCheck).toContain("Android와 iOS 모두 마지막 단계");
        expect(pwaCheck).toContain("홈 화면 아이콘으로 다시 열고 앱 실행 통과 리포트를 복사합니다.");
        expect(pwaCheck).toContain("QRCodeCanvas");
        expect(pwaCheck).toContain("navigator.share");
        expect(pwaCheck).toContain("buildDeviceReport");
        expect(pwaCheck).toContain("OMR Maker PWA device check");
        expect(pwaCheck).toContain("displayMode=");
        expect(pwaCheck).toContain("installedDisplay=");
        expect(pwaCheck).toContain("proofStatus=");
        expect(pwaCheck).toContain("isLocalHandoffHost");
        expect(pwaCheck).toContain('id: "handoff-origin"');
        expect(pwaCheck).toContain("실제 Android/iPhone에서는 배포 HTTPS 링크로 열어야 함");
        expect(pwaCheck).toContain("공유 가능");
        expect(pwaCheck).toContain("로컬 전용");
        expect(pwaCheck).toContain('"--app-viewport-height"');
        expect(pwaCheck).toContain('"--app-keyboard-inset-bottom"');
        expect(pwaCheck).toContain('const OFFLINE_CACHE_REQUIRED_PATHS = ["/", "/pwa-check", "/offline.html", "/logo.png"]');
        expect(pwaCheck).toContain("readViewportHeightSummary");
        expect(pwaCheck).toContain("readKeyboardSafeAreaSummary");
        expect(pwaCheck).toContain("readOfflineCacheSummary");
        expect(pwaCheck).toContain("readRuntimePerformanceSummary");
        expect(pwaCheck).toContain('id: "runtime-performance"');
        expect(pwaCheck).toContain("waitForPwaRuntimeReadiness");
        expect(pwaCheck).toContain('navigator.serviceWorker.addEventListener("controllerchange"');
        expect(pwaCheck).toContain("readStorageSummary");
        expect(pwaCheck).toContain("canUseIndexedDb");
        expect(pwaCheck).toContain("navigator.storage?.estimate");
        expect(pwaCheck).toContain("indexedDB ok");
        expect(pwaCheck).toContain("storage must include IndexedDB availability.");
        expect(pwaCheck).toContain("controller=yes");
        expect(pwaCheck).toContain("service-worker must be controlled by the active PWA worker.");
        expect(pwaCheck).toContain("waitForViewportHeightSync");
        expect(pwaCheck).toContain('id: "viewport-height"');
        expect(pwaCheck).toContain('id: "keyboard-safe-area"');
        expect(pwaCheck).toContain('id: "offline-cache"');
        expect(pwaCheck).toContain("caches.match(path)");
        expect(pwaCheck).toContain("visualViewport?.height");
        expect(pwaCheck).toContain("앱 실행 통과");
        expect(pwaCheck).toContain("설치 실행 전");
        expect(pwaCheck).toContain('minHeight: "2.75rem"');
        expect(pwaCheck).toContain('minWidth: "2.75rem"');
        expect(themeToggle).toContain('size === "small" ? "40px" : "44px"');
        expect(themeToggle).toContain("const btnSize = size === \"small\" ? 40 : 44");
    });

    it("keeps student app chrome controls comfortable on touch devices", () => {
        const homePage = readProjectFile("src/app/page.tsx");
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(homePage).toContain("역할 선택으로");
        expect(homePage).toContain('minHeight: "2.75rem"');
        expect(homePage).toContain('borderRadius: "var(--radius-md)"');
        expect(studentDashboard).toContain("로그아웃");
        expect(studentDashboard).toContain("minHeight: '2.75rem'");
        expect(studentDashboard).toContain("borderRadius: 'var(--radius-md)'");
        expect(css).toContain("display: inline-flex");
        expect(css).toContain("align-items: center");
        expect(css).toContain("min-height: 2.75rem");
    });

    it("keeps teacher app chrome controls comfortable on touch devices", () => {
        const css = readProjectFile("src/app/globals.css");
        const notificationBell = readProjectFile("src/components/NotificationBell.tsx");
        const teacherHeader = readProjectFile("src/components/TeacherHeader.tsx");
        const teacherDashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const teacherLogout = readProjectFile("src/components/TeacherLogoutButton.tsx");
        const playwrightConfig = readProjectFile("playwright.config.ts");
        const teacherMobileE2e = readProjectFile("e2e/teacher-mobile.spec.ts");

        expect(teacherLogout).toContain("const dimension = 44");
        expect(notificationBell).toContain("width: 44, height: 44");
        expect(notificationBell).toContain("minHeight: 44");
        expect(teacherHeader).toContain('className="header teacher-header"');
        expect(teacherHeader).toContain("minHeight: '2.75rem'");
        expect(teacherDashboard).toContain('className="header teacher-header"');
        expect(teacherDashboard).toContain('className="nav-link-live"');
        expect(css).toContain(".teacher-header-actions");
        expect(css).toContain(".teacher-header .nav-link");
        expect(css).toContain(".nav-link-live");
        expect(css).toContain(".create-editor-actions .btn");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain("min-width: 2.75rem");
        expect(playwrightConfig).toContain("teacher-mobile-chrome");
        expect(playwrightConfig).toContain("teacher-tablet-ios-like");
        expect(playwrightConfig).toContain("PLAYWRIGHT_ENABLE_WEBKIT");
        expect(playwrightConfig).toContain("mobile-ios-webkit-pwa");
        expect(playwrightConfig).toContain("tablet-ios-webkit-pwa");
        expect(playwrightConfig).toContain("tablet-ios-webkit-landscape-pwa");
        expect(teacherMobileE2e).toContain("expectTeacherHeaderTouchFriendly");
        expect(teacherMobileE2e).toContain(".create-editor-actions button, .create-editor-actions label");
    });

    it("keeps installed phone and tablet app shells inside safe areas", () => {
        const css = readProjectFile("src/app/globals.css");
        const layout = readProjectFile("src/app/layout.tsx");
        const installPrompt = readProjectFile("src/components/MobileInstallPrompt.tsx");
        const viewportHeightSync = readProjectFile("src/components/ViewportHeightSync.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const pwaCheckPage = readProjectFile("src/app/pwa-check/page.tsx");

        expect(layout).toContain('viewportFit: "cover"');
        expect(layout).not.toContain('interactiveWidget: "resizes-content"');
        expect(layout).toContain("ViewportHeightSync");
        expect(layout).toContain("<ViewportHeightSync />");
        expect(viewportHeightSync).toContain('"interactive-widget=resizes-content"');
        expect(viewportHeightSync).toContain("isIOSLikeDevice");
        expect(viewportHeightSync).toContain('"--app-viewport-height"');
        expect(viewportHeightSync).toContain('"--app-viewport-width"');
        expect(viewportHeightSync).toContain('"--app-visual-viewport-offset-top"');
        expect(viewportHeightSync).toContain('"--app-visual-viewport-offset-left"');
        expect(viewportHeightSync).toContain('"--app-visual-viewport-scale"');
        expect(viewportHeightSync).toContain('"--app-keyboard-inset-bottom"');
        expect(viewportHeightSync).toContain('"data-app-keyboard"');
        expect(viewportHeightSync).toContain("KEYBOARD_OPEN_THRESHOLD");
        expect(viewportHeightSync).toContain("window.visualViewport");
        expect(viewportHeightSync).toContain("window.requestAnimationFrame");
        expect(viewportHeightSync).toContain("scheduleSettledApplyMetrics");
        expect(viewportHeightSync).toContain('window.addEventListener("resize", scheduleApplyMetrics, { passive: true })');
        expect(viewportHeightSync).toContain('visualViewport?.addEventListener("resize", scheduleApplyMetrics, { passive: true })');
        expect(viewportHeightSync).toContain('visualViewport?.addEventListener("scroll", scheduleApplyMetrics, { passive: true })');
        expect(viewportHeightSync).toContain('window.addEventListener("orientationchange", scheduleSettledApplyMetrics)');
        expect(viewportHeightSync).toContain('window.addEventListener("pageshow", scheduleSettledApplyMetrics, { passive: true })');
        expect(viewportHeightSync).toContain('window.removeEventListener("pageshow", scheduleSettledApplyMetrics)');
        expect(viewportHeightSync).toContain('document.addEventListener("visibilitychange", scheduleApplyMetrics)');
        expect(css).toContain("--app-safe-area-top: env(safe-area-inset-top, 0px)");
        expect(css).toContain("--app-safe-area-right: env(safe-area-inset-right, 0px)");
        expect(css).toContain("--app-safe-area-bottom: env(safe-area-inset-bottom, 0px)");
        expect(css).toContain("--app-safe-area-left: env(safe-area-inset-left, 0px)");
        expect(css).toContain("--app-viewport-height: 100dvh");
        expect(css).toContain("--app-viewport-width: 100vw");
        expect(css).toContain("--app-visual-viewport-offset-top: 0px");
        expect(css).toContain("--app-visual-viewport-offset-left: 0px");
        expect(css).toContain("--app-visual-viewport-scale: 1");
        expect(css).toContain("--app-keyboard-inset-bottom: 0px");
        expect(css).toContain("scroll-padding-bottom: max(1rem, var(--app-safe-area-bottom), var(--app-keyboard-inset-bottom))");
        expect(css).toContain("html[data-app-keyboard=\"open\"] .mobile-install-prompt");
        expect(css).toContain("bottom: max(1rem, env(safe-area-inset-bottom), var(--app-keyboard-inset-bottom))");
        expect(css).toContain("min-height: var(--app-viewport-height, 100dvh)");
        expect(css).toContain("@media (display-mode: standalone), (display-mode: fullscreen)");
        expect(css).toContain("min-height: calc(var(--app-viewport-height, 100dvh) - var(--app-safe-area-bottom))");
        expect(css).toContain("padding-right: var(--app-safe-area-right)");
        expect(css).toContain("padding-bottom: var(--app-safe-area-bottom)");
        expect(css).toContain("padding-left: var(--app-safe-area-left)");
        expect(css).toContain("min-height: calc(4.5rem + var(--app-safe-area-top))");
        expect(css).toContain("padding-top: var(--app-safe-area-top)");
        expect(css).toContain("height: var(--app-viewport-height, 100dvh) !important");
        expect(createPage).toContain("height: 'var(--app-viewport-height, 100dvh)'");
        expect(createPage).toContain("calc(var(--app-viewport-height, 100dvh) - 4rem)");
        expect(solvePage).toContain("height: 'var(--app-viewport-height, 100dvh)'");
        expect(solvePage).toContain("minHeight: 'var(--app-viewport-height, 100dvh)'");
        expect(pwaCheckPage).toContain("calc(var(--app-viewport-height, 100dvh) - 3.5rem)");
        expect(css).toContain("display: none !important");
        expect(installPrompt).toContain("(display-mode: fullscreen)");
        expect(installPrompt).toContain("appinstalled");
        expect(installPrompt).toContain('href="/pwa-check"');
        expect(installPrompt).toContain('aria-label="앱 상태 체크"');
        expect(installPrompt).toContain("mobile-install-prompt__actions");
        expect(css).toContain(".mobile-install-prompt__check");
        expect(css).toContain(".mobile-install-prompt__actions");
        expect(css).toContain("grid-template-areas");
        expect(css).toContain("white-space: nowrap");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain("min-width: 2.75rem");
    });

    it("keeps mobile login and PIN inputs keyboard-friendly", () => {
        const homePage = readProjectFile("src/app/page.tsx");
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(homePage).toContain('autoComplete="username"');
        expect(homePage).toContain('autoComplete="current-password"');
        expect(homePage).toContain('autoComplete="name"');
        expect(homePage).toContain('autoComplete="email"');
        expect(homePage).toContain('inputMode="email"');
        expect(homePage).toContain('autoComplete="one-time-code"');
        expect(homePage).toContain('autoCapitalize="characters"');
        expect(homePage).toContain("spellCheck={false}");
        expect(solvePage).toContain('inputMode="numeric"');
        expect(solvePage).toContain('pattern="[0-9]*"');
        expect(solvePage).toContain('autoComplete="one-time-code"');
        expect(solvePage).toContain('autoComplete="name"');
        expect(solvePage).toContain('autoComplete="username"');
        expect(solvePage).toContain('inputMode="email"');
    });

    it("keeps the student solve flow touch friendly on phone and tablet shells", () => {
        const css = readProjectFile("src/app/globals.css");
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const pwaMobileE2e = readProjectFile("e2e/pwa-mobile.spec.ts");

        expect(solvePage).toContain("<ThemeToggle />");
        expect(css).toContain(".solve-brand");
        expect(css).toContain(".solve-brand .brand-logo__text");
        expect(css).toContain("width: 2.75rem !important");
        expect(css).toContain("gap: 0 !important");
        expect(css).toContain(".solve-teacher-toggle");
        expect(css).toContain("min-height: 44px");
        expect(css).toContain(".solve-tab-button");
        expect(css).toContain(".solve-pdf-button");
        expect(css).toContain(".solve-submit-button");
        expect(css).toContain(".solve-omr-rail-button");
        expect(css).toContain("width: 44px");
        expect(css).toContain(".solve-omr-scroll .q-bubble");
        expect(css).toContain("height: 44px");
        expect(pwaMobileE2e).toContain("lets students answer and submit an exam in the phone and tablet app shell");
        expect(pwaMobileE2e).toContain("omr_exam_mobile-qa-exam");
        expect(pwaMobileE2e).toContain("omr_solve_panel_mobile-qa-exam_mobile-qa-student");
        expect(pwaMobileE2e).toContain("문제 4번 보기 3");
        expect(pwaMobileE2e).toContain("score: 100");
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
        // Student login resolves region-scoped groups from the roster (name-based,
        // replacing the old manual group <select>).
        expect(homePage).toContain("buildStudentLoginGroupOptions");
        expect(homePage).toContain("recentStudentSession");
        expect(homePage).toContain("최근 학생");
        expect(homePage).toContain("handleContinueRecentStudent");
        expect(studentDashboard).toContain("연결하지 않은 게스트 기록");
        expect(studentDashboard).toContain("handleMergeGuestIntoCurrentStudent");
        expect(studentDashboard).toContain("previewGuestMerge");
    });

    it("keeps teacher session health visible in operational headers", () => {
        const nextConfig = readProjectFile("next.config.ts");
        const teacherHeader = readProjectFile("src/components/TeacherHeader.tsx");
        const sessionChip = readProjectFile("src/components/TeacherSessionChip.tsx");
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");
        const homePage = readProjectFile("src/app/page.tsx");
        const authMessages = readProjectFile("src/lib/teacherAuthMessages.ts");
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(sessionChip).toContain("buildTeacherSessionDisplay");
        expect(sessionChip).toContain("교사 세션");
        expect(sessionChip).toContain("display.actorLabel");
        expect(sessionChip).toContain("visibilitychange");
        expect(teacherHeader).toContain("<TeacherSessionChip");
        expect(dashboardPage).toContain("<TeacherSessionChip");
        expect(createPage).toContain("<TeacherSessionChip compact");
        expect(homePage).toContain("아이디 또는 이메일");
        expect(homePage).toContain('type="button"');
        expect(homePage).toContain("teacherIdentifier");
        expect(homePage).toContain("saveTeacherSessionWithIdentity");
        expect(homePage).toContain("shouldShowTeacherDeploymentHelp(error)");
        expect(authMessages).toContain("Supabase가 아니라");
        expect(authMessages).toContain("TEACHER_ACCOUNTS");
        expect(homePage).toContain("학생번호 또는 이메일");
        expect(homePage).toContain("계정 ID처럼 사용합니다.");
        expect(homePage).toContain("명단 학생은 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.");
        expect(homePage).toContain("명단 이메일이나 선생님이 알려준 학생번호로 본인 계정을 확인합니다.");
        expect(homePage).toContain("학생 계정 비밀번호처럼 쓰이는 6자리 코드입니다.");
        expect(homePage).toContain('aria-label="이름"');
        expect(homePage).toContain('aria-label="학생번호 또는 이메일"');
        expect(homePage).toContain('aria-label="반 선택"');
        expect(homePage).toContain('aria-label="시작 코드"');
        expect(homePage).toContain("studentLookup");
        expect(homePage).toContain("needsStudentLookup");
        expect(homePage).toContain("동명이인이 있습니다");
        expect(settingsPage).toContain("buildTeacherSessionDisplay");
        expect(settingsPage).toContain("getTeacherDeploymentReadiness");
        expect(settingsPage).toContain("DeploymentReadinessSummary");
        expect(settingsPage).toContain("TEACHER_ACCOUNTS");
        expect(settingsPage).toContain("clearTeacherAuthSession");
        expect(settingsPage).toContain("SECURITY_POSTURE_ITEMS");
        expect(settingsPage).toContain("배포 로그인 진단");
        expect(settingsPage).toContain('aria-label="배포 로그인 진단 새로고침"');
        expect(settingsPage).toContain("교사 계정 ${deploymentReadiness.credentialCount}개");
        expect(settingsPage).toContain("운영 보안 점검");
        expect(settingsPage).toContain("readySecurityItems");
        expect(settingsPage).toContain("운영 준비도");
        expect(settingsPage).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))'");
        expect(settingsPage).toContain("로그인 시도 제한");
        expect(settingsPage).toContain("서버 워크스페이스 준비");
        expect(settingsPage).toContain("SUPABASE_SERVICE_ROLE_KEY");
        expect(settingsPage).toContain("Supabase Auth, 조직 멤버십, production-rls.sql 정책");
        expect(css).toContain(".teacher-session-chip");
        expect(css).toContain(".teacher-session-chip-prefix");
        expect(nextConfig).toContain('allowedDevOrigins: ["127.0.0.1"]');
        expect(nextConfig).toContain('key: "Strict-Transport-Security", value: "max-age=31536000"');
        expect(nextConfig).toContain('key: "Cross-Origin-Opener-Policy", value: "same-origin"');
        expect(nextConfig).toContain('key: "Cross-Origin-Resource-Policy", value: "same-origin"');
        expect(nextConfig).toContain('key: "X-Content-Type-Options", value: "nosniff"');
        expect(nextConfig).toContain('key: "Referrer-Policy", value: "strict-origin-when-cross-origin"');
        expect(nextConfig).toContain('key: "X-Frame-Options", value: "DENY"');
        expect(nextConfig).toContain('key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()"');
    });

    it("keeps the teacher dashboard localized, keyboard reachable, and mobile-table friendly", () => {
        const css = readProjectFile("src/app/globals.css");
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const overview = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const examList = readProjectFile("src/components/dashboard/ExamListBlock.tsx");
        const trendChart = readProjectFile("src/components/dashboard/TrendChart.tsx");

        expect(css).toContain(':where(a, button, input, select, textarea, [role="button"], [tabindex]):focus-visible');
        expect(css).toContain("animation-duration: 0.01ms !important");
        expect(css).toContain(".dashboard-welcome-status");
        expect(css).toContain(".overview-table-hint");
        expect(css).toContain(".overview-exam-summary-table td:first-child");
        expect(css).toContain("position: sticky");

        expect(dashboard).toContain("분석 센터");
        expect(dashboard).toContain('className="dashboard-welcome"');
        expect(dashboard).toContain('className="dashboard-welcome-status"');
        expect(dashboard).toContain("width: 44");
        expect(dashboard).toContain("height: 44");

        expect(overview).toContain('role="tablist"');
        expect(overview).toContain("aria-selected={activeTab === 'ongoing'}");
        expect(overview).toContain('role="region" aria-label="시험 요약 표, 좌우 스크롤 가능" tabIndex={0}');
        expect(overview).toContain('<caption className="sr-only">');
        expect(overview).toContain('<th scope="col">시험명</th>');
        expect(overview).toContain('className="overview-exam-title-button"');
        expect(overview).not.toContain("Quick Action");
        expect(overview).not.toContain("Avg. Score Trend");

        expect(examList).toContain("최근 시험");
        expect(examList).toContain('aria-label={`${exam.title} 시험 상세 보기`}');
        expect(trendChart).toContain('role="img"');
        expect(trendChart).toContain("최신 점수");
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

    it("keeps dashboard statistics exportable as CSV", () => {
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const exportHelper = readProjectFile("src/lib/dashboardStatsExport.ts");

        expect(overviewTab).toContain("buildDashboardStatsCsv");
        expect(overviewTab).toContain("통계 CSV");
        expect(overviewTab).toContain("dashboard-stats-${new Date().toISOString().slice(0, 10)}.csv");
        expect(exportHelper).toContain("OMR Maker 통계 내보내기");
        expect(exportHelper).toContain("시험별 통계");
        expect(exportHelper).toContain("serializeCsvRows");
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
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");

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
        expect(usersPage).toContain("teacher-users-students-grid");
        expect(usersPage).toContain("teacher-users-table-scroll");
        expect(usersPage).toContain("teacher-users-detail-card");
        expect(css).toContain(".teacher-users-students-grid.has-detail");
        expect(css).toContain(".teacher-users-table");
        expect(css).toContain("min-width: 760px");
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
        expect(css).toContain(".create-label-candidate-chip:hover .create-label-candidate-hide");
        expect(css).toContain(".create-label-candidate-chip:focus-within .create-label-candidate-hide");
        expect(css).toContain("top: -7px");
        expect(css).toContain("right: -7px");
        expect(css).toContain(".omr-cardview.is-vertical-numbering .omr-cardview-grid");
    });

    it("keeps answer PDF parsing lazy until the teacher uploads an answer key", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const answerImportModal = readProjectFile("src/components/AnswerImportModal.tsx");

        expect(createPage).toContain('import type { ParsedAnswer } from "@/services/answerParser"');
        expect(createPage).not.toContain('import { ParsedAnswer } from "@/services/answerParser"');
        expect(answerImportModal).toContain("import type { ParsedAnswer } from '@/services/answerParser'");
        expect(answerImportModal).not.toContain("import { parseAnswerKeyPdf");
        expect(answerImportModal).toContain("const { parseAnswerKeyPdf } = await import('@/services/answerParser')");
        expect(answerImportModal).toContain("const { parseAnswerKeyWithGemini } = await import('@/services/answerParser')");
    });

    it("keeps image export tooling lazy until the teacher saves the preview image", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");

        expect(createPage).not.toContain('import html2canvas from "html2canvas"');
        expect(createPage).toContain('const { default: html2canvas } = await import("html2canvas")');
        expect(createPage).toContain("이미지 저장");
        expect(createPage).toContain("이미지 저장 완료");
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
        expect(usersPage).toContain("학생 계정 안내");
        expect(usersPage).toContain("로그인 ID");
        expect(usersPage).toContain("학생에게 이름, 반, 로그인 ID, 시작 코드를 함께 전달하세요.");
        expect(usersPage).toContain("handleCopyStudentLoginInfo");
        expect(usersPage).toContain("student-login-id-value");
        expect(usersPage).toContain("student-login-start-code-value");
        expect(usersPage).toContain("handleIssueStudentStartCode");
        expect(usersPage).toContain("generateStartCode");
        expect(usersPage).toContain("disambiguateRosterStudentId");
        expect(usersPage).toContain("uniqueStudentIdForRoster");
        expect(usersPage).toContain('"id", "name", "email"');
        expect(usersPage).toContain("학생번호 {selected.id}");
        expect(usersPage).toContain("handleCopyStudentId");
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
        const dataReadiness = readProjectFile("src/lib/dataDbReadiness.ts");

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
        expect(dataReadiness).toContain("실사용 RLS 전환 확인");
        expect(dataReadiness).toContain("production-rls.sql");
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
