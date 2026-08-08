import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { growthClassKeyForAttempt } from "@/lib/studentGrowthReport";
import { rosterGroupMatchesStudent, type RosterGroup, type RosterStudent } from "@/lib/rosterStorage";
import { matchRosterStudentForAttempt } from "@/lib/studentResultHub";
import type { Attempt } from "@/types/omr";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

function loadGrowthAttemptContextHelper(): (
    source: Attempt,
    student: RosterStudent | null,
    groups: readonly RosterGroup[],
) => Attempt | null {
    const pageSource = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
    const helperStart = pageSource.indexOf("function enrichGrowthAttemptContext(");
    const helperEndMarker = "\n}\n\nasync function loadTeacherPdfFile";
    const helperEnd = pageSource.indexOf(helperEndMarker, helperStart);
    if (helperStart < 0 || helperEnd < 0) throw new Error("growth attempt context helper not found");
    const helperSource = pageSource.slice(helperStart, helperEnd + 2);
    const compiled = ts.transpileModule(helperSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return runInNewContext(`${compiled}\nenrichGrowthAttemptContext`, { rosterGroupMatchesStudent }) as (
        source: Attempt,
        student: RosterStudent | null,
        groups: readonly RosterGroup[],
    ) => Attempt | null;
}

function stripCssComments(cssSource: string): string {
    return cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractCssBlock(cssSource: string, blockHeader: string): string {
    const css = stripCssComments(cssSource);
    let headerStart = 0;
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let quote: string | null = null;

    for (let index = 0; index < css.length; index += 1) {
        const character = css[index];
        if (quote) {
            if (character === "\\") {
                index += 1;
            } else if (character === quote) {
                quote = null;
            }
            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === "(") {
            parenthesisDepth += 1;
        } else if (character === ")") {
            parenthesisDepth -= 1;
        } else if (character === "[") {
            bracketDepth += 1;
        } else if (character === "]") {
            bracketDepth -= 1;
        } else if (character === ";" && parenthesisDepth === 0 && bracketDepth === 0) {
            headerStart = index + 1;
        } else if (character === "{" && parenthesisDepth === 0 && bracketDepth === 0) {
            const matchedHeader = css.slice(headerStart, index).trim();
            const bodyStart = index + 1;
            let braceDepth = 1;
            let bodyQuote: string | null = null;

            for (index += 1; index < css.length; index += 1) {
                const bodyCharacter = css[index];
                if (bodyQuote) {
                    if (bodyCharacter === "\\") {
                        index += 1;
                    } else if (bodyCharacter === bodyQuote) {
                        bodyQuote = null;
                    }
                    continue;
                }

                if (bodyCharacter === '"' || bodyCharacter === "'") {
                    bodyQuote = bodyCharacter;
                } else if (bodyCharacter === "{") {
                    braceDepth += 1;
                } else if (bodyCharacter === "}") {
                    braceDepth -= 1;
                    if (braceDepth === 0) {
                        if (matchedHeader === blockHeader) return css.slice(bodyStart, index);
                        headerStart = index + 1;
                        break;
                    }
                }
            }

            if (braceDepth !== 0) throw new Error(`Unclosed CSS block: ${matchedHeader}`);
        }
    }

    throw new Error(`CSS block not found: ${blockHeader}`);
}

function extractCustomProperties(cssBlock: string): Record<string, string> {
    const css = stripCssComments(cssBlock);
    const declarations: Record<string, string> = {};
    let depth = 0;
    let declarationStart = 0;

    for (let index = 0; index < css.length; index += 1) {
        const character = css[index];
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) declarationStart = index + 1;
        } else if (character === ";" && depth === 0) {
            const declaration = css.slice(declarationStart, index).trim();
            declarationStart = index + 1;
            const match = declaration.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
            if (!match) continue;

            const [, name, value] = match;
            if (name in declarations) throw new Error(`Duplicate CSS declaration in block: ${name}`);
            declarations[name] = value.trim();
        }
    }

    return declarations;
}

function countCustomPropertyDeclarations(cssSource: string, propertyName: string): number {
    const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return stripCssComments(cssSource).match(new RegExp(`${escapedName}\\s*:`, "g"))?.length ?? 0;
}

function expectEnvOverridesAfterInherited(envSource: string, overrideKeys: readonly string[]): number {
    const inheritedEnvIndex = envSource.indexOf("...process.env");
    expect(inheritedEnvIndex, "webServer.env must inherit process.env before applying test overrides").toBeGreaterThanOrEqual(0);
    for (const key of overrideKeys) {
        const overrideIndex = envSource.indexOf(`${key}: ""`);
        expect(
            overrideIndex,
            `${key} must be explicitly cleared after ...process.env`,
        ).toBeGreaterThan(inheritedEnvIndex);
    }
    return inheritedEnvIndex;
}

describe("service UI surface", () => {
    it("extracts exact CSS scopes without accepting comments, nesting, or selector prefixes", () => {
        const fixture = `
            /* :root { --token: commented; } */
            :root { --token: base; }
            @media (prefers-reduced-motion: reduce) {
                :root { --token: reduced; }
            }
            html[data-motion="off"] .orb { --token: wrong-selector; }
        `;
        const prefixedSelectorFixture = `
            .scope :root { --token: prefixed-root; }
            .scope html[data-motion="off"] { --token: prefixed-motion-control; }
        `;

        expect(extractCustomProperties(extractCssBlock(fixture, ":root"))).toEqual({
            "--token": "base",
        });
        expect(
            extractCustomProperties(
                extractCssBlock(
                    extractCssBlock(fixture, "@media (prefers-reduced-motion: reduce)"),
                    ":root",
                ),
            ),
        ).toEqual({ "--token": "reduced" });
        expect(countCustomPropertyDeclarations(fixture, "--token")).toBe(3);
        expect(() => extractCssBlock(fixture, 'html[data-motion="off"]')).toThrow(
            'CSS block not found: html[data-motion="off"]',
        );
        expect(() => extractCssBlock(prefixedSelectorFixture, ":root")).toThrow(
            "CSS block not found: :root",
        );
        expect(() => extractCssBlock(prefixedSelectorFixture, 'html[data-motion="off"]')).toThrow(
            'CSS block not found: html[data-motion="off"]',
        );
    });

    it("defines exact Balanced base tokens once in the opening root", () => {
        const css = readProjectFile("src/app/globals.css");
        const uncommentedCss = stripCssComments(css);
        const baseTokens = {
            "--space-related": "1rem",
            "--space-card": "1.5rem",
            "--space-section": "2.5rem",
            "--motion-hover": "160ms",
            "--motion-panel": "210ms",
            "--motion-distance": "0.375rem",
            "--ease-balanced": "cubic-bezier(0.2, 0.8, 0.2, 1)",
            "--type-body-min": "1rem",
            "--type-caption-min": "0.8125rem",
            "--text-body-min": "1rem",
            "--text-caption-min": "0.8125rem",
            "--shadow-action": "0 8px 18px color-mix(in srgb, var(--primary) 20%, transparent)",
        } as const;
        const openingRootDeclarations = extractCustomProperties(extractCssBlock(css, ":root"));

        expect(uncommentedCss.trimStart().startsWith(":root")).toBe(true);
        for (const [propertyName, expectedValue] of Object.entries(baseTokens)) {
            expect(openingRootDeclarations[propertyName], propertyName).toBe(expectedValue);
        }

        for (const propertyName of Object.keys(baseTokens)) {
            const expectedCount = propertyName.startsWith("--motion-") ? 3 : 1;
            expect(
                countCustomPropertyDeclarations(css, propertyName),
                `${propertyName} global declaration count`,
            ).toBe(expectedCount);
        }
    });

    it("disables Balanced motion tokens for both motion controls", () => {
        const css = readProjectFile("src/app/globals.css");
        const reducedMotionMedia = extractCssBlock(css, "@media (prefers-reduced-motion: reduce)");
        const expectedOverrides = {
            "--motion-hover": "1ms",
            "--motion-panel": "1ms",
            "--motion-distance": "0rem",
        };

        expect(
            extractCustomProperties(extractCssBlock(reducedMotionMedia, ":root")),
        ).toEqual(expectedOverrides);
        expect(
            extractCustomProperties(extractCssBlock(css, 'html[data-motion="off"]')),
        ).toEqual(expectedOverrides);
    });

    it("targets actual dialog panels with the Balanced enter animation", () => {
        const css = readProjectFile("src/app/globals.css");
        const answerImportModal = readProjectFile("src/components/AnswerImportModal.tsx");
        const createPage = readProjectFile("src/app/create/page.tsx");

        expect(answerImportModal).toContain('className="balanced-dialog-panel"');
        expect(createPage).toContain('className="balanced-dialog-panel"');
        expect(css).toContain("@keyframes balancedDialogEnter");
        expect(css).toContain(".balanced-dialog-panel");
        expect(css).not.toMatch(/(?:^|\n)\[role="dialog"\]\s*\{/);
    });

    it("gives the active landing content one main structure and role-level headings", () => {
        const homePage = readProjectFile("src/app/page.tsx");

        expect(homePage.match(/<main(?:\s|>)/g) ?? []).toHaveLength(1);
        expect(homePage.match(/<\/main>/g) ?? []).toHaveLength(1);
        expect(homePage).toContain('<main id="main-content" className="landing-main">');
        expect(homePage).toMatch(/<h1[^>]*>/);
        expect(homePage).toContain("환영합니다");
        expect(homePage).toContain("학습 시작");
    });

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
        expect(createPage).toContain("const PREVIEW_SCALE_REFERENCE_WIDTH = 460");
        expect(createPage).toContain("const PREVIEW_RAIL_WIDTH = 64");
        expect(createPage).toContain("const previewPaneRef = useRef<HTMLElement>(null)");
        expect(createPage).toContain("new ResizeObserver(syncPreviewScale)");
        expect(createPage).toContain("paneWidth / PREVIEW_SCALE_REFERENCE_WIDTH");
        expect(createPage).toContain("create-preview-scaled-surface");
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
        expect(css).toContain("zoom: var(--create-preview-scale)");
        expect(css).toContain("--create-preview-content-width");
        expect(css).toContain("container-name: create-settings");
        expect(css).toContain("@container create-settings (max-width: 360px)");
        expect(css).toContain("grid-template-columns: repeat(3, minmax(44px, 1fr))");
        expect(css).toContain("grid-template-columns: auto auto minmax(0, 1fr)");
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
        expect(distributeModal).toContain("initialAccessConfig?.type === 'targeted' ? 'student'");
        expect(distributeModal).toContain("setAccessType(initialType)");
        expect(distributeModal).toContain("setSelectedGroups(initialType === 'group' ? [...(initialAccessConfig?.groupIds || [])] : [])");
        expect(distributeModal).toContain('setPin(initialType === \'public\' ? normalizeExamPin(initialAccessConfig?.pin || "") : "")');
        expect(distributeModal).toContain("summarizeDistributionTargets");
        expect(distributeModal).toContain("formatRegionScopedLabel(g.name, g.region)");
        expect(distributeModal).toContain("그룹 배포 대상 요약");
        expect(distributeModal).toContain("명단 기준 대상");
        expect(distributeModal).toContain("미응시/카카오 후보 산정");
        expect(distributeModal).toContain('role="dialog"');
        expect(distributeModal).toContain('aria-modal="true"');
        expect(distributeModal).toContain("aria-labelledby={dialogTitleId}");
        expect(distributeModal).toContain("useDialogFocus(isOpen, onClose)");
        expect(createPage).toContain("distributeTriggerRef.current = event.currentTarget");
        expect(createPage).toContain("trigger.focus({ preventScroll: true })");
    });

    it("keeps teacher result sorting keyboard accessible and exposes sort state", () => {
        const examDetail = readProjectFile("src/app/teacher/exam/[id]/page.tsx");
        expect(examDetail).toContain('aria-sort={sortAria("name")}');
        expect(examDetail).toContain('aria-sort={sortAria("percent")}');
        expect(examDetail).toContain('aria-sort={sortAria("finishedAt")}');
        expect(examDetail).toContain('type="button"');
        expect(examDetail).toContain('sortableHeader("name", "학생")');
        expect(examDetail).not.toContain('<h3 style={{ fontSize: \'1.1rem\', fontWeight: 700 }}>Student Results</h3>');
    });

    it("keeps tablet handwriting usable with stylus-first input and finger scrolling", () => {
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");

        expect(pdfViewer).toContain("activeDrawingModeRef");
        expect(pdfViewer).toContain("e.pointerType === 'pen' && drawingMode === 'click'");
        expect(pdfViewer).toContain("if (e.pointerType === 'touch' && !fingerDrawingEnabled) return false");
        expect(pdfViewer).toContain("setDrawingMode('pen')");
        expect(pdfViewer).toContain("pointerEvents: canEditDrawing ? 'auto' : 'none'");
        expect(pdfViewer).toContain("touchAction: fingerDrawingEnabled && drawingMode !== 'click' ? 'none' : 'pan-x pan-y pinch-zoom'");
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

    it("keeps submission progress visible until the review page opens", () => {
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(solvePage).toContain("SubmissionProgressOverlay");
        expect(solvePage).toContain('role={allowsRetry ? "dialog" : "status"}');
        expect(solvePage).toContain("aria-modal={allowsRetry || undefined}");
        expect(solvePage).toContain('aria-live="polite"');
        expect(solvePage).toContain("SUBMISSION_DELAY_NOTICE_MS");
        expect(solvePage).toContain('setSubmissionProgress("saving_handwriting")');
        expect(solvePage).toContain('setSubmissionProgress("opening_review")');
    });

    it("exposes OMR answers as keyboard-operable radio groups", () => {
        const omrCardView = readProjectFile("src/components/OMRCardView.tsx");
        const homePage = readProjectFile("src/app/page.tsx");

        expect(omrCardView).toContain('role="radiogroup"');
        expect(omrCardView).toContain('role="radio"');
        expect(omrCardView).toContain("aria-checked={isMarked}");
        expect(omrCardView).toContain("tabIndex={isMarked || (!isAnswered && i === 0) ? 0 : -1}");
        expect(omrCardView).toContain('event.key === "ArrowLeft"');
        expect(omrCardView).toContain('event.key === "Home"');
        expect(omrCardView).toContain('role="progressbar"');
        expect(omrCardView).toContain("aria-valuenow={answeredCount}");
        expect(omrCardView).toContain("q-card-select-button");
        expect(homePage).toContain('aria-label={teacherAccountFormLabel}');
        expect(homePage).toContain('htmlFor="teacher-identifier"');
        expect(homePage).toContain('htmlFor="teacher-password"');
        expect(homePage).toContain('id="teacher-login-feedback"');
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
        const layout = readProjectFile("src/app/layout.tsx");

        expect(css).toContain("@media (max-width: 920px)");
        expect(css).toContain("(hover: none) and (pointer: coarse)");
        expect(css).toContain("(display-mode: standalone)");
        expect(css).toContain("(prefers-reduced-motion: reduce)");
        expect(css).toContain('html[data-motion="off"] .orb');
        expect(css).toContain("will-change: auto");
        expect(css).toContain("scroll-behavior: auto !important");
        expect(css).toContain("animation-duration: 0.01ms !important");
        expect(css).toContain("transition-duration: 0.01ms !important");
        expect(layout).toContain("localStorage.getItem('omr_settings')");
        expect(layout).toContain("root.setAttribute('data-motion', appTheme.motion === false ? 'off' : 'on')");
        expect(layout).toContain("root.style.setProperty('--primary-dark', palette[1])");
    });

    it("keeps responsive solve and PDF selectors aligned with rendered class names", () => {
        const css = readProjectFile("src/app/globals.css");
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");

        for (const className of ["solve-timer", "solve-progress", "solve-controls"]) {
            expect(solvePage).toContain(`className="${className}"`);
            expect(css).toContain(`.${className}`);
        }
        for (const className of ["pdf-viewer-file", "pdf-viewer-controls", "pdf-viewer-drawing-tools", "pdf-viewer-page-wrap"]) {
            expect(pdfViewer).toContain(`className="${className}"`);
            expect(css).toContain(`.${className}`);
        }
        expect(css).not.toContain(".solve-timer-pill");
        expect(css).not.toContain(".solve-header-actions");
        expect(css).not.toContain(".pdf-toolbar-controls");
        expect(css).not.toContain(".pdf-page-shell");
    });

    it("connects dashboard numbers to contextual explanations and next actions", () => {
        const mockupOverview = readProjectFile("src/components/dashboard/MockupOverview.tsx");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const statCard = readProjectFile("src/components/dashboard/StatCard.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(mockupOverview).toContain("직전 시험보다");
        expect(mockupOverview).toContain("최근 시험 참여율");
        expect(mockupOverview).toContain("점수 원인 보기");
        expect(mockupOverview).toContain("학생별 성취 보기");
        expect(mockupOverview).toContain("미응시·이탈 확인");
        expect(mockupOverview).toContain('className="mockup-metric-action"');
        expect(overviewTab).toContain("오늘의 우선 조치");
        expect(overviewTab).toContain("미응시·문항 분석");
        expect(overviewTab).toContain("onNavigateToStudentAnalytics");
        expect(statCard).toContain('className="stat-card-action"');
        expect(css).toContain(".overview-action-brief");
        expect(css).toContain(".mockup-metric-change.is-negative");
        expect(css).toMatch(/\.mockup-dashboard-shell\s*\{[\s\S]*?--text: #10203b;[\s\S]*?color: var\(--foreground\);/);
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
        expect(themeToggle).toContain('width: "44px"');
        expect(themeToggle).toContain("const btnSize = 44");
    });

    it("keeps the PWA verdict and preflight visible while progressively disclosing advanced diagnostics", () => {
        const pwaCheck = readProjectFile("src/app/pwa-check/page.tsx");
        const verdictIndex = pwaCheck.indexOf('data-testid="pwa-device-verdict"');
        const preflightIndex = pwaCheck.indexOf('data-testid="pwa-preflight-checklist"');
        const diagnosticsIndex = pwaCheck.indexOf('data-testid="pwa-advanced-diagnostics"');
        const installIndex = pwaCheck.indexOf('data-testid="pwa-install-proof-guide"');
        const handoffIndex = pwaCheck.indexOf('data-testid="pwa-device-handoff"');
        const proofIndex = pwaCheck.indexOf('data-testid="pwa-proof-verifier"');

        expect(pwaCheck).toContain("<details");
        expect(pwaCheck).toContain("<summary");
        expect(pwaCheck).toContain('data-testid="pwa-advanced-diagnostics-summary"');
        expect(pwaCheck).toContain("설치·전달·증빙 진단");
        expect(verdictIndex).toBeGreaterThan(-1);
        expect(preflightIndex).toBeGreaterThan(verdictIndex);
        expect(diagnosticsIndex).toBeGreaterThan(preflightIndex);
        expect(installIndex).toBeGreaterThan(diagnosticsIndex);
        expect(handoffIndex).toBeGreaterThan(installIndex);
        expect(proofIndex).toBeGreaterThan(handoffIndex);
        expect(pwaCheck.slice(diagnosticsIndex, installIndex)).not.toContain(" open=");
    });

    it("promotes only PWA checks needing attention and collapses passed checks behind an honest count", () => {
        const pwaCheck = readProjectFile("src/app/pwa-check/page.tsx");

        expect(pwaCheck).toContain('snapshot.checks.filter(check => check.tone !== "pass")');
        expect(pwaCheck).toContain('snapshot.checks.filter(check => check.tone === "pass")');
        expect(pwaCheck).toContain('data-testid="pwa-passed-checks"');
        expect(pwaCheck).toContain('data-testid="pwa-passed-checks-summary"');
        expect(pwaCheck).toContain("{passedChecks.length}개 항목 통과");
        expect(pwaCheck).toContain("passedChecks.map(check => <CheckRow key={check.id} check={check} />)");

        const passedDisclosureIndex = pwaCheck.indexOf('data-testid="pwa-passed-checks"');
        const advancedDiagnosticsIndex = pwaCheck.indexOf('data-testid="pwa-advanced-diagnostics"');
        expect(passedDisclosureIndex).toBeGreaterThan(-1);
        expect(advancedDiagnosticsIndex).toBeGreaterThan(passedDisclosureIndex);
        expect(pwaCheck.slice(passedDisclosureIndex, advancedDiagnosticsIndex)).not.toContain(" open=");
    });

    it("keeps student app chrome controls comfortable on touch devices", () => {
        const homePage = readProjectFile("src/app/page.tsx");
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(homePage).toContain("역할 선택으로");
        expect(homePage).toContain('priorityLabel="역할 선택 홈으로"');
        expect(homePage).toContain('className="home-role-home-link"');
        expect(homePage).toContain('router.replace("/")');
        expect(homePage).toContain('minHeight: "2.75rem"');
        expect(homePage).toContain('borderRadius: "var(--radius-md)"');
        expect(studentDashboard).toContain("로그아웃");
        expect(studentDashboard).toContain("minHeight: '2.75rem'");
        expect(studentDashboard).toContain("borderRadius: 'var(--radius-md)'");
        expect(css).toContain("display: inline-flex");
        expect(css).toContain("align-items: center");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain(".home-logo");
        expect(css).toContain("margin-inline: auto");
        expect(css).toContain(".home-role-home-link");
    });

    it("stacks the student dashboard mobile header without truncating identity actions", () => {
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(studentDashboard).toContain('student-dashboard-group-label${user.isGuest ? " is-redundant" : ""}');
        expect(studentDashboard).toContain('className="student-dashboard-login-id"');
        expect(studentDashboard).toContain('className="student-dashboard-controls"');
        expect(css).toContain(".student-dashboard-brand");
        expect(css).toContain(".student-dashboard-identity");
        expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
        expect(css).toContain(".student-dashboard-group-label.is-redundant");
        expect(css).toContain("display: none");
        expect(css).toContain(".student-dashboard-login-id");
        expect(css).toContain("overflow-wrap: anywhere");
        expect(css).toContain(".student-dashboard-controls");
        expect(css).toContain("flex-shrink: 0");
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
        expect(teacherHeader).toContain("minHeight: 44");
        expect(teacherHeader).toContain('className="teacher-header-live-action"');
        expect(teacherHeader).toContain('aria-label="교사 계정 메뉴"');
        // The dashboard used to carry its own copy of this header; it now gets
        // the chrome (and these touch targets) through the shared TeacherHeader.
        expect(teacherDashboard).toContain("<TeacherHeader");
        expect(css).toContain(".teacher-header-actions");
        expect(teacherHeader).toContain(".teacher-header-live-action { display: none !important; }");
        expect(css).toContain(".create-editor-actions .btn");
        expect(css).toContain("min-height: 2.75rem");
        expect(css).toContain("min-width: 2.75rem");
        expect(playwrightConfig).toContain("teacher-mobile-chrome");
        expect(playwrightConfig).toContain("teacher-tablet-ios-like");
        expect(playwrightConfig).toContain("PLAYWRIGHT_ENABLE_WEBKIT");
        expect(playwrightConfig).toContain("mobile-ios-webkit-pwa");
        expect(playwrightConfig).toContain("tablet-ios-webkit-pwa");
        expect(playwrightConfig).toContain("tablet-ios-webkit-landscape-pwa");
        expect(playwrightConfig).toContain("mobile-ios-webkit-teacher");
        expect(playwrightConfig).toContain("tablet-ios-webkit-teacher");
        expect(playwrightConfig).toContain("tablet-ios-webkit-landscape-teacher");
        expect(teacherMobileE2e).toContain("expectTeacherHeaderTouchFriendly");
        expect(teacherMobileE2e).toContain("exposes a labeled, error-connected teacher login form");
        expect(teacherMobileE2e).toContain("문제 1번 편집");
        expect(teacherMobileE2e).toContain(".create-editor-actions button, .create-editor-actions label");
    });

    it("pins the Playwright-owned billing plan simulation without Supabase", () => {
        const playwrightConfig = readProjectFile("playwright.config.ts");
        const webServerEnv = playwrightConfig.match(
            /webServer:[\s\S]*?env:\s*{([\s\S]*?)\n\s{8}},\n\s{4}},\n}\);/,
        )?.[1];

        expect(webServerEnv).toBeDefined();
        const supabaseOverrideKeys = [
            "NEXT_PUBLIC_SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY",
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "OMR_SUPABASE_SERVICE_ROLE_KEY",
        ] as const;
        const reorderedFixture = 'NEXT_PUBLIC_SUPABASE_URL: "",\n...process.env,';
        expect(() => expectEnvOverridesAfterInherited(
            reorderedFixture,
            ["NEXT_PUBLIC_SUPABASE_URL"],
        )).toThrow("NEXT_PUBLIC_SUPABASE_URL must be explicitly cleared after ...process.env");
        const inheritedEnvIndex = expectEnvOverridesAfterInherited(webServerEnv || "", supabaseOverrideKeys);
        expect(webServerEnv?.indexOf('OMR_PLAN_DEV_SIMULATION: "1"')).toBeGreaterThan(inheritedEnvIndex);
        expect(webServerEnv?.indexOf('OMR_DEV_PLAN: "free"')).toBeGreaterThan(inheritedEnvIndex);
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
        expect(viewportHeightSync).toContain('"virtualKeyboard" in window.navigator');
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

        expect(homePage).toContain('autoComplete={teacherAccountMode === "login" ? "username" : "email"}');
        expect(homePage).toContain('autoComplete={teacherAccountMode === "login" ? "current-password" : "new-password"}');
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
        expect(pwaMobileE2e).toContain("startsWithFloatingRail");
        expect(pwaMobileE2e).toContain("toHaveClass(/is-collapsed/)");
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

    it("keeps guest recovery visible and merges only server-acknowledged rows", () => {
        const homePage = readProjectFile("src/app/page.tsx");
        const studentDashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const recoveryPanel = readProjectFile("src/components/StudentGuestRecoveryPanel.tsx");
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
        expect(studentDashboard).toContain("<StudentGuestRecoveryPanel");
        expect(studentDashboard).toContain("previewGuestMerge");
        expect(recoveryPanel).toContain("미검증 로컬 기록 복구");
        expect(recoveryPanel).toContain("acknowledgedAttemptIds");
        expect(recoveryPanel).not.toContain("handleMergeGuestIntoCurrentStudent");
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
        // Dashboard renders the chip through the shared TeacherHeader.
        expect(dashboardPage).toContain("<TeacherHeader");
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
        expect(settingsPage).toContain("SECURITY_INTEGRATION_ITEMS");
        expect(settingsPage).toContain("현재 미지원입니다.");
        expect(settingsPage).toContain("연동 전");
        expect(settingsPage).not.toContain('<Toggle checked={value.twoFactor}');
        expect(settingsPage).not.toContain('<Toggle checked={value.loginAlerts}');
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
        expect(nextConfig).toContain('poweredByHeader: false');
        expect(nextConfig).toContain('Permissions-Policy');
        expect(nextConfig).toContain('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        expect(nextConfig).toContain('Strict-Transport-Security');
        expect(nextConfig).toContain('key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains"');
        expect(nextConfig).toContain('key: "Cross-Origin-Opener-Policy", value: "same-origin"');
        expect(nextConfig).toContain('key: "Cross-Origin-Resource-Policy", value: "same-origin"');
        expect(nextConfig).toContain('key: "X-Content-Type-Options", value: "nosniff"');
        expect(nextConfig).toContain('key: "Referrer-Policy", value: "strict-origin-when-cross-origin"');
        expect(nextConfig).toContain('key: "X-Frame-Options", value: "DENY"');
        expect(nextConfig).toContain('key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()"');
    });

    it("protects server-funded AI answer analysis with origin, teacher session, and rate limits", () => {
        const analyzeAction = readProjectFile("src/app/actions/analyzeKey.ts");
        expect(analyzeAction).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(analyzeAction).toContain("authorizeTeacherAiActionRequest");
        expect(analyzeAction.indexOf("await requireTeacherAiAccess()"))
            .toBeLessThan(analyzeAction.indexOf("validateAnswerImageParts(imageParts)"));
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
        expect(overview).toContain('aria-label={`${exam.title} 분석 보기`}');
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
        expect(billingPage).toContain("로컬 플랜 변경 기록");
        expect(billingPage).toContain("플랜 표시 가격");
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
        expect(paymentProvider).toContain("checkout 서버 연동 필요");
        expect(billingPage).toContain("결제 완료 내역이나 영수증이 아닙니다.");
        expect(billingPage).toContain("BILLING_PLAN_FEATURES");
        expect(billingPage).toContain("buildBillingFeatureView");
        expect(billingPage).toContain("getServerPlanSnapshot");
        expect(billingPage).toContain("서버 플랜 확인됨");
        expect(billingPage).toContain("권한 확인 불가 · Free 안전 모드");
        expect(billingPage).toContain("서버 플랜과 기능 권한은 변경되지 않았습니다.");
        expect(billingPage).not.toContain("readInitialPlan");
        expect(billingPage).not.toContain("setCurrentPlan");
        expect(billingPage).toContain("Academy 준비 중");
        expect(billingPage).toContain("조직 관리 기능이 실제 제공되기 전에는 Academy로 변경할 수 없습니다.");
        expect(billingPage).not.toContain("MOCK_INVOICES");
        expect(billingPage).not.toContain("<Receipt");
        expect(billingPage).not.toContain("다음 결제");
        expect(billingPage).not.toContain('title="영수증 다운로드"');
        expect(billingPage).not.toContain("Visa •••• 4242");
        expect(globalSearch).toContain("결제/플랜 기록");
        expect(globalSearch).not.toContain("인보이스");
        expect(notificationBell).not.toContain("createLocalPlanCycleReminder");
        expect(notificationBell).not.toContain("auto-plan-renewal");
        expect(notificationBell).not.toContain("자동 결제");
        expect(billingPage).toContain("토스페이먼츠");
        expect(billingPage).toContain("네이버페이");
        expect(billingPage).toContain("카카오페이");
    });

    it("subtracts secondary billing detail on phones without hiding the current and Pro comparison", () => {
        const billingPage = readProjectFile("src/app/teacher/billing/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(billingPage).toContain('className="bento-card billing-current-plan-card"');
        expect(billingPage).toContain('className="billing-current-plan-main"');
        expect(billingPage).toContain('className="plans-grid"');
        expect(billingPage).toContain('className="billing-academy-disclosure"');
        expect(billingPage).toContain("billing-academy-disclosure-content");
        expect(billingPage).toContain('className="bento-card billing-invoices-card billing-history-disclosure"');
        expect(billingPage).toContain('className="billing-history-disclosure-content"');
        expect(billingPage).toContain('className="billing-mobile-disclosure-action"');
        expect(billingPage).not.toContain('<details open className="billing-academy-disclosure"');
        expect(billingPage).not.toContain('<details open className="bento-card billing-invoices-card billing-history-disclosure"');

        expect(css).toContain("@media (max-width: 640px)");
        expect(css).toContain(".billing-current-plan-card");
        expect(css).toContain(".billing-academy-disclosure > summary");
        expect(css).toContain(".billing-history-disclosure > summary");
        expect(css).toContain(".billing-academy-disclosure:not([open]) > .billing-academy-disclosure-content");
        expect(css).toContain(".billing-history-disclosure:not([open]) > .billing-history-disclosure-content");
        expect(css).toContain("[open] > summary .billing-mobile-disclosure-action::after");
        expect(css).toContain("overflow-x: hidden");
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
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const premiumGate = readProjectFile("src/components/PremiumFeatureGate.tsx");

        expect(dashboardPage).toContain("useServerPlan");
        expect(examAnalyticsTab).toContain("resolveExamSelectionInputValue");
        expect(dashboardPage).toContain("loadTeacherRosterSnapshot(localStorage)");
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
        expect(dashboardPage).toContain('currentPlan={isMockupAccount ? "academy" : currentPlan}');
        // The bell reaches the dashboard through the shared TeacherHeader.
        expect(readProjectFile("src/components/TeacherHeader.tsx")).toContain("NotificationBell");
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
        expect(examAnalyticsTab).toContain("saveKakaoCandidateReview");
        expect(examAnalyticsTab).toContain("summarizeKakaoCandidateReviews");
        expect(examAnalyticsTab).toContain("queueKakaoDispatchSimulation");
        expect(examAnalyticsTab).toContain("summarizeKakaoDispatchLogs");
        expect(examAnalyticsTab).toContain("updateKakaoDispatchLogStatus");
        expect(examAnalyticsTab).toContain("getKakaoProviderReadiness");
        expect(examAnalyticsTab).toContain("카카오 provider 상태");
        expect(examAnalyticsTab).toContain("카카오 후보 검토");
        expect(examAnalyticsTab).toContain("발송 전 후보만 정리합니다");
        expect(examAnalyticsTab).toContain("후보 준비");
        expect(examAnalyticsTab).toContain("큐 대기 기록");
        expect(examAnalyticsTab).toContain("시뮬레이션 완료 기록");
        expect(examAnalyticsTab).toContain("시뮬레이션 실패 기록");
        expect(examAnalyticsTab).toContain("시뮬레이션 취소 기록");
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
        expect(reportPanel).toContain("인쇄/PDF 저장 Pro");
        expect(reportPanel).toContain("현재 학생 리포트 인쇄 또는 PDF 저장");
        expect(reportPanel).toContain("window.print()");
        expect(premiumGate).toContain('href="/teacher/billing"');
        expect(premiumGate).toContain("requiredPlan");
        expect(premiumGate).toContain("Pro 필요");
    });

    it("wires the canonical teacher attempt route to the student result hub", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain("parseStudentResultView");
        expect(teacherAttemptPage).toContain("buildStudentAttemptSeries");
        expect(teacherAttemptPage).toContain("StudentResultHeader");
        expect(teacherAttemptPage).toContain("StudentResultTabs");
        expect(teacherAttemptPage).toContain("loadTeacherAttempts(found.examId)");
    });

    it("renders dedicated answer and analytics panels only for their active result views", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain('import AnswersPanel from "@/components/teacher/student-results/AnswersPanel";');
        expect(teacherAttemptPage).toContain('import AnalyticsPanel from "@/components/teacher/student-results/AnalyticsPanel";');
        expect(teacherAttemptPage).toMatch(/activeView === ["']answers["'][\s\S]*?<AnswersPanel/);
        expect(teacherAttemptPage).toMatch(/activeView === ["']analytics["'][\s\S]*?<AnalyticsPanel/);
        expect(teacherAttemptPage).toMatch(/activeView === ["']handwriting["'][\s\S]*?<HandwritingPanel/);
        expect(teacherAttemptPage).toMatch(/activeView === ["']report["'][\s\S]*?<ReportPanel/);
    });

    it("renders the report view through a dedicated report panel", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain('import ReportPanel from "@/components/teacher/student-results/ReportPanel";');
        expect(teacherAttemptPage).toMatch(/activeView === ["']report["'][\s\S]*?<ReportPanel/);
    });

    it("keeps the dense student report in the editorial context-to-history order", () => {
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const orderedMarkers = [
            "report-summary-title",
            "report-score-title",
            "report-headline-title",
            "<StudentGrowthReport",
            "report-weakness-title",
            "report-feedback-title",
            "report-history-title",
        ];

        let previousIndex = -1;
        for (const marker of orderedMarkers) {
            const index = reportPanel.indexOf(marker, previousIndex + 1);
            expect(index, `${marker} section`).toBeGreaterThan(previousIndex);
            previousIndex = index;
        }
    });

    it("loads cumulative result sources lazily with stable roster matching and route guards", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain('if (activeView !== "report") return;');
        expect(teacherAttemptPage).not.toContain('activeView !== "report" && activeView !== "analytics"');
        expect(teacherAttemptPage).toContain("cumulativeLoadingAttemptRef.current === targetAttemptId");
        expect(teacherAttemptPage).toContain("cumulativeSettledAttemptIdRef.current === targetAttemptId");
        expect(teacherAttemptPage).toContain("Promise.all([");
        expect(teacherAttemptPage).toContain("loadTeacherAttempts()");
        expect(teacherAttemptPage).toContain("loadTeacherExams()");
        expect(teacherAttemptPage).toContain("loadTeacherRosterSnapshot(window.localStorage)");
        expect(teacherAttemptPage).toContain("matchRosterStudentForAttempt(attempt, rosterResult.students)");
        expect(teacherAttemptPage).toContain("setCumulativeAttempts(attemptResult.items)");
        expect(teacherAttemptPage).toContain("groups: rosterResult.groups");
        expect(teacherAttemptPage).toContain("activeAttemptIdRef.current !== targetAttemptId");
        expect(teacherAttemptPage).not.toContain("student.name === attempt.studentName");
    });

    it("uses the complete demo dashboard cohort for growth comparisons", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const demoDetailIndex = teacherAttemptPage.indexOf("resolveDemoAttemptDetail(readTeacherSession(), targetAttemptId");
        const demoCohortIndex = teacherAttemptPage.indexOf("buildDemoDashboardData", demoDetailIndex);
        const remoteLoadIndex = teacherAttemptPage.indexOf("const [attemptResult, examResult, rosterResult]", demoCohortIndex);
        const demoBranch = teacherAttemptPage.slice(demoCohortIndex, remoteLoadIndex);

        expect(demoDetailIndex).toBeGreaterThan(-1);
        expect(demoCohortIndex).toBeGreaterThan(demoDetailIndex);
        expect(remoteLoadIndex).toBeGreaterThan(demoCohortIndex);
        expect(demoBranch).toContain("setCumulativeAttempts(demoCohort.attempts)");
        expect(demoBranch).toContain("setCumulativeExams(demoCohort.exams)");
        expect(demoBranch).toContain("students: demoCohort.rosterStudents");
        expect(demoBranch).toContain("groups: demoCohort.rosterGroups");
        expect(demoBranch).not.toContain("...demoDetail.cumulativeAttempts");
        expect(demoBranch).not.toContain("...demoDetail.peerAttempts");
    });

    it("keeps analytics focused on current-exam diagnostics without duplicated growth", () => {
        const analyticsPanel = readProjectFile("src/components/teacher/student-results/AnalyticsPanel.tsx");
        const currentExamIndex = analyticsPanel.indexOf("오답·미응답·유형 분석");

        expect(currentExamIndex).toBeGreaterThan(-1);
        expect(analyticsPanel).not.toContain("CumulativeGrowthPanel");
        expect(analyticsPanel).not.toContain("cumulativeStatus");
        expect(analyticsPanel).not.toContain("studentGrowthReportsEnabled");
    });

    it("scopes printing to the dedicated report and removes the legacy detail branch", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const studentResultCss = readProjectFile("src/components/teacher/student-results/StudentResultHub.module.css");
        const globals = readProjectFile("src/app/globals.css");

        expect(reportPanel).toContain("student-result-report-print-root");
        expect(reportPanel).toContain("onClick={() => window.print()}");
        expect(studentResultCss).toContain("@media print");
        expect(globals).toContain(".student-result-report-print-root *");
        expect(studentResultCss).toContain(".reportPrintRoot");
        expect(studentResultCss).toContain(".screenOnly");
        expect(teacherAttemptPage).not.toContain("const PDFViewer = dynamic");
        expect(teacherAttemptPage).not.toContain(") : false ? (");
        expect(teacherAttemptPage).not.toContain("function SmallStat");
        expect(teacherAttemptPage).not.toContain("function QuestionResultRow");
        expect(teacherAttemptPage).not.toContain("function AllQuestionRow");
    });

    it("maps cumulative source health into growth report states and skips locked-plan loads", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const analyticsPanel = readProjectFile("src/components/teacher/student-results/AnalyticsPanel.tsx");

        expect(teacherAttemptPage).toContain("if (!studentGrowthReportsEnabled) return;");
        expect(teacherAttemptPage).toContain("attemptResult.remoteError");
        expect(teacherAttemptPage).toContain("examResult.remoteError");
        expect(teacherAttemptPage).toContain("rosterResult.remoteError");
        expect(teacherAttemptPage).toContain("resolveTeacherCollectionGroupCompleteness");
        expect(teacherAttemptPage).toContain("setCumulativeStatus(attemptCompleteness)");
        expect(teacherAttemptPage).toContain("const retryCumulativeLoad = useCallback");
        expect(reportPanel).toContain("<StudentGrowthReport");
        expect(reportPanel).toContain("onRetry={onRetryCumulative}");
        expect(analyticsPanel).not.toContain("CumulativeGrowthPanel");
    });

    it("uses the shared completeness policy for cumulative growth data", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const loaderStart = teacherAttemptPage.indexOf("const [attemptResult, examResult, rosterResult]");
        const loaderEnd = teacherAttemptPage.indexOf("} catch", loaderStart);
        const loaderBlock = teacherAttemptPage.slice(loaderStart, loaderEnd);

        expect(loaderBlock).toContain("resolveTeacherCollectionGroupCompleteness([");
        expect(loaderBlock).toContain("...attemptResult");
        expect(loaderBlock).toContain("...examResult");
        expect(loaderBlock).toContain("...rosterResult");
        expect(loaderBlock).toContain("items: [...rosterResult.students, ...rosterResult.groups]");
        expect(loaderBlock).toContain("setCumulativeStatus(attemptCompleteness)");
        expect(loaderBlock).toContain("일부 자료는 서버 동기화 전 로컬 저장본 기준입니다.");
        expect(loaderBlock).not.toContain("서버 동기화 전 로컬 제출 기준입니다.");
        expect(loaderBlock).not.toContain("if (attemptResult.remotePartial)");
    });

    it("keeps mixed exam or roster failures retryable ahead of partial pagination", () => {
        const collectionClient = readProjectFile("src/lib/teacherAttemptClient.ts");
        const resolverStart = collectionClient.indexOf("export function resolveTeacherAttemptCollectionCompleteness");
        const resolverEnd = collectionClient.indexOf("export async function loadTeacherActiveAttemptSessions", resolverStart);
        const resolverBlock = collectionClient.slice(resolverStart, resolverEnd);

        expect(resolverBlock.indexOf("input.remoteError")).toBeLessThan(resolverBlock.indexOf("input.remotePartial"));
        expect(resolverBlock).toContain('hasUsableItems ? "stale" : "error"');
        expect(resolverBlock).toContain('hasUsableItems ? "partial" : "error"');
    });

    it("retains cohort attempts for growth while filtering only the personal insight", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain("matchRosterStudentForAttempt(attempt, rosterResult.students)");
        expect(teacherAttemptPage).toContain("setCumulativeAttempts(attemptResult.items)");
        expect(teacherAttemptPage).toContain("filterCumulativeAttemptsForStudent(");
        expect(teacherAttemptPage).toContain("cumulativeRoster.students,");
        expect(teacherAttemptPage).toContain("rosterStudent,");
        expect(teacherAttemptPage).toContain("buildStudentProfileInsight(");
        expect(teacherAttemptPage).not.toContain("rosterResult.students.find(student => attemptMatchesStudentProfile");
    });

    it("scopes personal cumulative attempts and exam metadata to the active organization", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const insightIndex = teacherAttemptPage.indexOf("const cumulativeInsight = useMemo");
        const growthIndex = teacherAttemptPage.indexOf("const growthAttempts = useMemo", insightIndex);
        const insightBlock = teacherAttemptPage.slice(insightIndex, growthIndex);

        expect(insightBlock).toContain("activeOrganizationId || attempt.organizationId");
        expect(insightBlock).toContain("buildCumulativeExamMap(");
        expect(insightBlock).not.toContain("new Map(cumulativeExams.map");
    });

    it("preserves unresolved growth candidates for explicit omission accounting", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const growthReport = readProjectFile("src/components/teacher/student-results/StudentGrowthReport.tsx");
        const growthAttemptsIndex = teacherAttemptPage.indexOf("const growthAttempts = useMemo");
        const selectedGrowthIndex = teacherAttemptPage.indexOf("const selectedGrowthAttempt = useMemo", growthAttemptsIndex);
        const growthBlock = teacherAttemptPage.slice(growthAttemptsIndex, selectedGrowthIndex);

        expect(growthBlock).toContain("markUnresolvedGrowthAttempt(candidate)");
        expect(growthBlock).not.toContain("candidate is Attempt => candidate !== null");
        expect(growthReport).toContain("<GrowthOmissionNotice count={model.omittedCount}");
    });

    it("builds one class-scoped growth model from the complete cohort", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const modelCalls = teacherAttemptPage.match(/buildStudentGrowthReport\(/g) ?? [];

        expect(modelCalls).toHaveLength(1);
        expect(teacherAttemptPage).toContain("growthClassKeyForAttempt(selectedGrowthAttempt)");
        expect(teacherAttemptPage).toContain("selectedOrganizationId: activeOrganizationId || attempt.organizationId");
        expect(teacherAttemptPage).toContain("attempts: growthAttempts");
        expect(teacherAttemptPage).toContain("exams: cumulativeExams");
        expect(teacherAttemptPage).toContain("growthReportState={growthReportState}");
    });

    it("keeps an empty growth model when omitted records need disclosure", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const stateIndex = teacherAttemptPage.indexOf("const growthReportState = useMemo");
        const labelIndex = teacherAttemptPage.indexOf("const selectedAttemptLabel = useMemo");
        const stateBlock = teacherAttemptPage.slice(stateIndex, labelIndex);

        expect(stateBlock).toContain("growthReportModel.omittedCount === 0");
        expect(stateBlock).toContain("model: growthReportModel");
    });

    it("does not treat unrelated omissions as evidence that a partial collection includes the selected attempt", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const stateIndex = teacherAttemptPage.indexOf("const growthReportState = useMemo");
        const labelIndex = teacherAttemptPage.indexOf("const selectedAttemptLabel = useMemo");
        const stateBlock = teacherAttemptPage.slice(stateIndex, labelIndex);
        const partialIndex = stateBlock.indexOf('cumulativeStatus === "partial"');
        const unlinkedIndex = stateBlock.indexOf("if (!selectedGrowthAttempt)", partialIndex);
        const partialBlock = stateBlock.slice(partialIndex, unlinkedIndex);

        expect(partialBlock).toContain("!growthReportModel.selectedAttemptIncluded");
        expect(partialBlock).not.toContain("growthReportModel.rows.length === 0 && growthReportModel.omittedCount === 0");
    });

    it("prefers the active workspace organization over a legacy attempt fallback", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const modelIndex = teacherAttemptPage.indexOf("buildStudentGrowthReport({");
        const modelBlock = teacherAttemptPage.slice(modelIndex, modelIndex + 700);

        expect(teacherAttemptPage).toContain("setActiveOrganizationId(workspaceOrganizationId || null)");
        expect(modelBlock).toContain("selectedOrganizationId: activeOrganizationId || attempt.organizationId");
        expect(modelBlock).not.toContain("cumulativeExams.find");
        expect(modelBlock).not.toContain("growthAttempts.find");
    });

    it("enriches legacy cohort rows with matched roster classes before growth modeling", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const growthAttemptsIndex = teacherAttemptPage.indexOf("const growthAttempts = useMemo");
        const growthModelIndex = teacherAttemptPage.indexOf("const growthReportModel = useMemo");
        const modelIndex = teacherAttemptPage.indexOf("buildStudentGrowthReport({");
        const identityBlock = teacherAttemptPage.slice(growthModelIndex, modelIndex + 900);

        expect(growthAttemptsIndex).toBeGreaterThan(-1);
        expect(growthModelIndex).toBeGreaterThan(growthAttemptsIndex);
        expect(modelIndex).toBeGreaterThan(growthAttemptsIndex);
        expect(teacherAttemptPage).toContain("rosterGroupMatchesStudent");
        expect(teacherAttemptPage).toContain("studentProfileId: student.id.trim()");
        expect(identityBlock.indexOf("rosterStudent?.id")).toBeGreaterThan(-1);
        expect(identityBlock.indexOf("rosterStudent?.id")).toBeLessThan(identityBlock.indexOf("attempt.studentName"));
        expect(identityBlock).toContain("selectedClassKey: growthClassKeyForAttempt(selectedGrowthAttempt)");
        expect(identityBlock).toContain("attempts: growthAttempts");
        expect(identityBlock).not.toContain("attempts: cumulativeAttempts");
    });

    it("isolates identical legacy group names by roster region without overwriting snapshots", () => {
        const enrichGrowthAttemptContext = loadGrowthAttemptContextHelper();
        const rosterStudent = (id: string, region: string): RosterStudent => ({
            id,
            name: id,
            email: `${id}@example.com`,
            group: "심화반",
            region,
            avatar: "#fff",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "",
            trend: "flat",
            status: "active",
        });
        const rosterGroup = (id: string, region: string): RosterGroup => ({
            id,
            name: "심화반",
            region,
            count: 1,
            avgScore: 0,
            color: "#fff",
        });
        const seoulStudent = rosterStudent("student-seoul", "서울");
        const busanStudent = rosterStudent("student-busan", "부산");
        const groups = [rosterGroup("group-seoul", "서울"), rosterGroup("group-busan", "부산")];
        const legacySource = (id: string, studentName: string): Attempt => ({
            id,
            studentName,
            groupName: "심화반",
        } as Attempt);

        const seoul = enrichGrowthAttemptContext(legacySource("a-seoul", "서울 학생"), seoulStudent, groups);
        const busan = enrichGrowthAttemptContext(legacySource("a-busan", "부산 학생"), busanStudent, groups);
        if (!seoul || !busan) throw new Error("matched legacy attempts must be enriched");

        expect(seoul.groupName).toBe("심화반");
        expect(busan.groupName).toBe("심화반");
        expect(seoul.groupId).toBe("group-seoul");
        expect(busan.groupId).toBe("group-busan");
        expect(seoul.regionName).toBe("서울");
        expect(busan.regionName).toBe("부산");
        expect(growthClassKeyForAttempt(seoul)).not.toBe(growthClassKeyForAttempt(busan));

        const snapshotted = legacySource("snapshot", "기존 학생");
        Object.assign(snapshotted, {
            classId: "class-original",
            groupId: "group-original",
            regionId: "region-original",
            regionName: "기존 지역",
        });
        const preserved = enrichGrowthAttemptContext(snapshotted, seoulStudent, groups);
        if (!preserved) throw new Error("authoritative snapshots must be preserved");
        expect(preserved).toMatchObject({
            classId: "class-original",
            groupId: "group-original",
            groupName: "심화반",
            regionId: "region-original",
            regionName: "기존 지역",
        });
    });

    it("drops ambiguous unscoped legacy rows instead of merging two regional students", () => {
        const enrichGrowthAttemptContext = loadGrowthAttemptContextHelper();
        const rosterStudent = (id: string, region: string): RosterStudent => ({
            id,
            name: "동명이인",
            email: `${id}@example.com`,
            group: "심화반",
            region,
            avatar: "#fff",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "",
            trend: "flat",
            status: "active",
        });
        const students = [rosterStudent("student-seoul", "서울"), rosterStudent("student-busan", "부산")];
        const groups: RosterGroup[] = [
            { id: "group-seoul", name: "심화반", region: "서울", count: 1, avgScore: 0, color: "#fff" },
            { id: "group-busan", name: "심화반", region: "부산", count: 1, avgScore: 0, color: "#fff" },
        ];
        const ambiguousRows = ["ambiguous-a", "ambiguous-b"].map(id => ({
            id,
            studentName: "동명이인",
            groupName: "심화반",
        } as Attempt));

        const resolvedRows = ambiguousRows
            .map(row => enrichGrowthAttemptContext(
                row,
                matchRosterStudentForAttempt(row, students),
                groups,
            ))
            .filter((row): row is Attempt => row !== null);

        expect(ambiguousRows.map(row => matchRosterStudentForAttempt(row, students))).toEqual([null, null]);
        expect(resolvedRows).toEqual([]);

        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        expect(teacherAttemptPage).toContain("markUnresolvedGrowthAttempt(candidate)");
        expect(teacherAttemptPage).not.toContain(".filter((candidate): candidate is Attempt => candidate !== null)");
        expect(teacherAttemptPage).toContain("학생·반 연결 정보가 부족해 성장 데이터를 비교할 수 없습니다.");
    });

    it("keeps stale source failures retryable ahead of clean unlinked empty state", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const stateStart = teacherAttemptPage.indexOf("const growthReportState = useMemo<StudentGrowthReportState>");
        const stateEnd = teacherAttemptPage.indexOf("const selectedAttemptLabel = useMemo", stateStart);
        const stateBlock = teacherAttemptPage.slice(stateStart, stateEnd);
        const staleFailureIndex = stateBlock.indexOf('cumulativeStatus === "stale" && cumulativeError && (!selectedGrowthAttempt || !growthReportModel)');
        const partialFailureIndex = stateBlock.indexOf('cumulativeStatus === "partial"');
        const unlinkedEmptyIndex = stateBlock.indexOf("if (!selectedGrowthAttempt)");

        expect(stateStart).toBeGreaterThan(-1);
        expect(stateEnd).toBeGreaterThan(stateStart);
        expect(staleFailureIndex).toBeGreaterThan(-1);
        expect(partialFailureIndex).toBeGreaterThan(staleFailureIndex);
        expect(unlinkedEmptyIndex).toBeGreaterThan(partialFailureIndex);
        expect(stateBlock.slice(staleFailureIndex, unlinkedEmptyIndex)).toContain('status: "error", message: cumulativeError');
        expect(stateBlock.slice(partialFailureIndex, unlinkedEmptyIndex)).toContain('message: cumulativeError || "일부 데이터만 불러와 선택한 응시의 성장 이력을 확인할 수 없습니다."');

        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        expect(reportPanel).toMatch(/growthReportState\.status === "error"[\s\S]*role="alert"[\s\S]*onClick=\{onRetryCumulative\}/);
    });

    it("keeps cumulative data and the rendered attempt keyed to the current route", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(teacherAttemptPage).toContain("attempt.id !== id");
        expect(teacherAttemptPage).toContain("cumulativeAttemptId === attempt.id");
        expect(teacherAttemptPage).toContain("setCumulativeAttemptId(targetAttemptId)");
        expect(teacherAttemptPage).toContain("setCumulativeAttemptId(null)");
    });

    it("guards A-to-B-to-A cumulative requests with a monotonic generation", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const generationStartIndex = teacherAttemptPage.indexOf("const requestGeneration = ++cumulativeLoadGenerationRef.current");
        const requestGuardIndex = teacherAttemptPage.indexOf("const isCurrentCumulativeRequest = () =>");
        const demoCommitIndex = teacherAttemptPage.indexOf("setCumulativeAttempts(", requestGuardIndex);
        const remoteCommitIndex = teacherAttemptPage.indexOf("setCumulativeAttempts(attemptResult.items)");
        const finalizerIndex = teacherAttemptPage.indexOf("if (isCurrentCumulativeRequest() && cumulativeLoadingAttemptRef.current === targetAttemptId)");

        expect(teacherAttemptPage).toContain("const cumulativeLoadGenerationRef = useRef(0)");
        expect(generationStartIndex).toBeGreaterThan(-1);
        expect(requestGuardIndex).toBeGreaterThan(generationStartIndex);
        expect(demoCommitIndex).toBeGreaterThan(requestGuardIndex);
        expect(remoteCommitIndex).toBeGreaterThan(demoCommitIndex);
        expect(finalizerIndex).toBeGreaterThan(remoteCommitIndex);
        expect(teacherAttemptPage.match(/if \(!isCurrentCumulativeRequest\(\)\) return;/g) ?? []).toHaveLength(3);
        expect(teacherAttemptPage).toMatch(/cumulativeLoadGenerationRef\.current \+= 1;[\s\S]*setCumulativeAttempts\(\[\]\)/);
    });

    it("defines the actual global print cascade and a forced light report palette", () => {
        const globals = readProjectFile("src/app/globals.css");
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const studentResultCss = readProjectFile("src/components/teacher/student-results/StudentResultHub.module.css");

        expect(reportPanel).toContain("student-result-report-print-root");
        expect(reportPanel).toContain("student-result-report-screen-only");
        expect(globals).toMatch(/body:has\(\.teacher-attempt-page\) \*\s*\{[^}]*visibility:\s*hidden !important;/);
        expect(globals).toContain(".student-result-report-print-root,");
        expect(globals).toContain(".student-result-report-print-root *");
        expect(globals).toContain("color-scheme: light;");
        expect(globals).toContain("--foreground: #0f172a;");
        expect(globals).toContain("--surface: #fff;");
        expect(globals).not.toContain("body:has(.teacher-attempt-page) * {\n    visibility: visible !important;");
        expect(studentResultCss).not.toMatch(/\.reportPrintRoot\s*\{[^}]*position:\s*absolute;/);
    });

    it("does not present locked, loading, failed, or incomplete history as empty", () => {
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");
        const historyIndex = reportPanel.indexOf('id="report-history-title"');
        const historyBlock = reportPanel.slice(historyIndex, historyIndex + 5_000);

        expect(historyIndex).toBeGreaterThan(-1);
        expect(historyBlock).toContain("!studentGrowthReportsEnabled");
        expect(historyBlock).toContain('growthReportState.status === "idle" || growthReportState.status === "loading"');
        expect(historyBlock).toContain('growthReportState.status === "error"');
        expect(historyBlock).toContain('growthReportState.status === "stale"');
        expect(historyBlock).toContain('growthReportState.status === "partial"');
        expect(historyBlock).toContain('growthReportState.status === "empty"');
        expect(historyBlock.match(/onClick=\{onRetryCumulative\}/g) ?? []).toHaveLength(2);
        expect(historyBlock).toContain("상세 이력을 학생 명단과 연결할 수 없습니다.");
        expect(historyBlock).toContain("reportCumulativeInsight?.attempts.length");
    });

    it("distinguishes unavailable report calculations from a calculated empty result", () => {
        const reportPanel = readProjectFile("src/components/teacher/student-results/ReportPanel.tsx");

        expect(reportPanel).toContain("시험 정보를 불러오지 못해 오답과 약점을 계산할 수 없습니다.");
        expect(reportPanel).toContain("analytics ? (");
        const unavailableHeadlineIndex = reportPanel.indexOf("const headline = !hasGradableScore");
        const retakeHeadlineIndex = reportPanel.indexOf("retakeScoreDelta", unavailableHeadlineIndex);
        expect(unavailableHeadlineIndex).toBeGreaterThan(-1);
        expect(retakeHeadlineIndex).toBeGreaterThan(unavailableHeadlineIndex);
        expect(reportPanel).toContain("채점 가능한 문항이 없어 점수와 비교 지표를 표시하지 않습니다.");
        expect(reportPanel).toContain('hasGradableScore ? `${scorePercent}%` : "미채점"');
        expect(reportPanel).toContain("제출 당시 저장된 점수");
        expect(reportPanel).toContain("문항 분석은 시험 정보를 불러온 뒤 확인할 수 있습니다.");
    });

    it("keeps student result panel inputs and small status text readable in both themes", () => {
        const answersPanel = readProjectFile("src/components/teacher/student-results/AnswersPanel.tsx");
        const analyticsPanel = readProjectFile("src/components/teacher/student-results/AnalyticsPanel.tsx");
        const studentResultCss = readProjectFile("src/components/teacher/student-results/StudentResultHub.module.css");

        expect(answersPanel).toContain("className={styles.replyTextarea}");
        expect(studentResultCss).toMatch(/\.replyTextarea\s*\{[^}]*color:\s*#0f172a;[^}]*background:\s*#fff;/);
        expect(studentResultCss).toMatch(/\.replyTextarea::placeholder\s*\{[^}]*color:\s*#64748b;/);
        expect(answersPanel).toContain('correct: { label: "정답", color: "var(--text-success)" }');
        expect(answersPanel).toContain('wrong: { label: "오답", color: "var(--text-error)" }');
        expect(answersPanel).toContain('tone="warning"');
        expect(answersPanel).toContain('"var(--text-warning)"');
        expect(answersPanel).toContain('textColor="var(--text-success)"');
        expect(answersPanel).toContain('textColor="var(--text-error)"');
        expect(answersPanel).toContain('fontSize: "0.72rem", color: "var(--foreground)"');
        expect(answersPanel).toContain('color: "#047857"');
        expect(analyticsPanel).toContain('const accent = result.status === "unanswered" ? "var(--foreground)" : "var(--text-error)";');
        expect(studentResultCss).toMatch(/\.countBadge\s*\{[^}]*color:\s*var\(--text-primary\);/);
        expect(studentResultCss).toMatch(/\.signalChip\s*\{[^}]*color:\s*var\(--text-error\);/);
    });

    it("deep-links result entry points to the intended hub views", () => {
        const examPage = readProjectFile("src/app/teacher/exam/[id]/page.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");
        const analytics = readProjectFile("src/components/dashboard/tabs/StudentAnalyticsTab.tsx");

        expect(examPage).toContain("학생 결과 보기");
        expect(examPage).toContain('buildStudentResultHref(attempt.id, "answers")');
        expect(examPage).toContain("필기 저장됨");
        expect(usersPage).toContain('buildStudentResultHref(a.id, "handwriting")');
        expect(usersPage).toContain('buildStudentResultHref(attempt.id, "report")');
        expect(usersPage).toContain('buildStudentResultHref(latestStableAttempt.id, "report")');
        expect(analytics).toContain('buildStudentResultHref(detail.attemptId, "analytics")');
        expect(analytics).toContain("결과 분석");

        const handwritingLink = usersPage.slice(
            usersPage.indexOf('buildStudentResultHref(a.id, "handwriting")'),
            usersPage.indexOf('</NextLink>', usersPage.indexOf('buildStudentResultHref(a.id, "handwriting")')),
        );
        const modalReportLink = usersPage.slice(
            usersPage.indexOf('buildStudentResultHref(attempt.id, "report")'),
            usersPage.indexOf('</NextLink>', usersPage.indexOf('buildStudentResultHref(attempt.id, "report")')),
        );
        expect(handwritingLink).toContain("minHeight: 44");
        expect(modalReportLink).toContain("minHeight: 44");

        const selectedActionStart = usersPage.indexOf("<div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>");
        const selectedActions = usersPage.slice(
            selectedActionStart,
            usersPage.indexOf("{tab === \"groups\"", usersPage.indexOf("{latestStableAttempt ? (")),
        );
        expect(selectedActions).toContain('buildStudentResultHref(latestStableAttempt.id, "report")');
        expect(selectedActions).toContain("studentGrowthReportsEnabled &&");
        expect(selectedActions).toContain("onClick={handleOpenDetail}");
        expect(selectedActions).toContain("성장 분석");
        expect(selectedActions).toContain("flexWrap: 'wrap'");
    });

    it("resets route-scoped student result state while preserving peer attempts on load failure", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const loaderStart = teacherAttemptPage.indexOf("const loadTeacherAttempt = async () => {");
        const authCheck = teacherAttemptPage.indexOf("if (!hasTeacherAccess())", loaderStart);
        const resetBlock = teacherAttemptPage.slice(loaderStart, authCheck);

        for (const reset of [
            'setDetailLoadStatus("loading");',
            "setAccessDenied(false);",
            "setAttempt(null);",
            "setExam(null);",
            "setDrawings(undefined);",
            "setPdfFile(null);",
            'setHandwritingStatus("idle");',
            "setFeedback(null);",
            'setFeedbackSummary("");',
            "setFeedbackPolicy(DEFAULT_FEEDBACK_DOWNLOAD_POLICY);",
            "setTeacherMarkupDrawings({});",
            'setFeedbackViewMode("student");',
            'setFeedbackNotice("");',
            "setFeedbackSaving(false);",
            "setAnswerDrafts({});",
            "setSavingAnswerFor(null);",
            "setCumulativeAttempts([]);",
            "setCumulativeExams([]);",
            "setRosterStudent(null);",
            'setCumulativeStatus("idle");',
            'setCumulativeError("");',
            "setSubQuestionFilter('needs_review');",
            "setSavingSubQuestionKey(null);",
        ]) {
            expect(resetBlock).toContain(reset);
        }
        expect(resetBlock).not.toContain("setPeerAttempts");
        expect(teacherAttemptPage).toContain('if (detailResult.status === "not_found") {');
        expect(teacherAttemptPage).toContain('if (detailResult.status === "service_unavailable") {');
        expect(teacherAttemptPage).toContain("if (cancelled) return;\n\n                const parsedExam");
        expect(teacherAttemptPage).toContain(".catch(() => undefined);");
        expect(teacherAttemptPage).not.toContain("setPeerAttempts([])");
    });

    it("keeps one student result heading and insets the legacy tab panel", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const studentResultCss = readProjectFile("src/components/teacher/student-results/StudentResultHub.module.css");

        expect(teacherAttemptPage).not.toContain("{attempt.studentName}</h1>");
        expect(studentResultCss).toMatch(/\.panel\s*\{[^}]*padding:/);
    });

    it("guards student result mutations by route and keeps the current attempt in its series", () => {
        const teacherAttemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
        const mutationRanges = [
            ["const saveFeedback = async", "if (accessDenied)"],
            ["const setSubQuestionReviewed = async", "const handleAnswerQuestion = async"],
            ["const handleAnswerQuestion = async", "const handleDownloadHandwriting ="],
        ] as const;

        expect(teacherAttemptPage).toContain("const activeAttemptIdRef = useRef(id);");
        expect(teacherAttemptPage).toContain("activeAttemptIdRef.current = id;");
        for (const [startMarker, endMarker] of mutationRanges) {
            const start = teacherAttemptPage.indexOf(startMarker);
            const end = teacherAttemptPage.indexOf(endMarker, start);
            const mutation = teacherAttemptPage.slice(start, end);
            expect(mutation).toContain("const targetAttemptId = attempt.id;");
            expect(mutation).toContain("activeAttemptIdRef.current !== targetAttemptId");
            expect(mutation).toMatch(/finally\s*\{[^}]*activeAttemptIdRef\.current === targetAttemptId/);
        }
        expect(teacherAttemptPage).toContain("mergeSelectedAttemptIntoPeers(attempt, peerAttempts)");
        expect(teacherAttemptPage).toContain("const series = buildStudentAttemptSeries(");
        expect(teacherAttemptPage).toContain("return series.length > 0 ? series : buildStudentAttemptSeries(attempt, [attempt], examById);");
    });

    it("keeps the dashboard overview bento grid usable on mobile", () => {
        const css = readProjectFile("src/app/globals.css");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");

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
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");

        expect(studentDashboard).toContain("나의 원시험 평균");
        expect(studentDashboard).toContain("완료한 원시험");
        expect(studentDashboard).toContain("attempt => !attempt.retakeSourceAttemptId");
        expect(studentDashboard).toContain("attempt => !!attempt.retakeSourceAttemptId");
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
        expect(createPage).toContain("setLoadedExam(persistedExam)");
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
        const css = readProjectFile("src/app/globals.css");

        expect(createPage).toContain("문항 영역 보정");
        expect(createPage).toContain("handleReinferQuestionRegions");
        expect(createPage).toContain("handleClearSelectedPdfLink");
        expect(createPage).toContain("handleClearAllPdfRegions");
        expect(createPage).toContain("region: region");
        expect(createPage).toContain("AUTO_DETECT_TIMEOUT_MS = 90_000");
        expect(createPage).toContain("handleStopAutoDetectLocations");
        expect(createPage).toContain("create-auto-detect-notice");
        expect(pdfViewer).toContain("interface MarkerRegion");
        expect(pdfViewer).toContain("marker.kind === 'passage' ? `공통 지문 영역 ${marker.label}` : `문항 영역 ${marker.label}번`");
        expect(pdfViewer).toContain("marker.region.width");
        expect(css).toContain(".create-auto-detect-notice");
    });

    it("keeps exam PDF upload recoverable and question labeling quick in creation", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const pdfViewer = readProjectFile("src/components/PDFViewer.tsx");
        const omrCardView = readProjectFile("src/components/OMRCardView.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(createPage).toContain('const PDF_ACCEPT = "application/pdf,.pdf"');
        expect(createPage).toContain("handleProblemPdfFile");
        expect(createPage).toContain("handleAnswerKeyPdfFile");
        expect(createPage).toContain("<UploadCloud size={16}");
        expect(createPage).toContain("문항 빠른 세팅");
        expect(createPage).toContain("create-question-quick-card");
        expect(createPage).toContain("questionChoiceCount");
        expect(createPage).toContain("문항 라벨 일괄 적용");
        expect(createPage).toContain("applyBatchLabels");
        expect(createPage).toContain('numberingLayout="vertical"');
        expect(pdfViewer).toContain("function isPdfUploadFile(file: File): boolean");
        expect(pdfViewer).toContain("onLoadError={handleDocumentLoadError}");
        expect(pdfViewer).toContain("pdf-upload-empty");
        expect(pdfViewer).toContain("UploadCloud");
        expect(omrCardView).toContain('numberingLayout?: "grid" | "vertical"');
        expect(css).toContain(".create-question-answer-buttons");
        expect(css).toContain(".pdf-upload-empty");
        expect(css).toContain(".create-label-batch-card");
        expect(css).toContain(".create-label-candidate-chip:hover .create-label-candidate-hide");
        expect(css).toContain(".create-label-candidate-chip:focus-within .create-label-candidate-hide");
        expect(css).toContain("top: -10px");
        expect(css).toContain("right: -10px");
        expect(css).toContain(".omr-cardview.is-vertical-numbering .omr-cardview-grid");
    });

    it("keeps answer PDF parsing lazy until the teacher uploads an answer key", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const answerImportModal = readProjectFile("src/components/AnswerImportModal.tsx");

        expect(createPage).toContain('const AnswerImportModal = dynamic(() => import("@/components/AnswerImportModal")');
        expect(createPage).not.toMatch(/^\s*import\s+.+\s+from\s+["']@\/components\/AnswerImportModal["'];?\s*$/m);
        expect(createPage).toContain('import { activateFilePicker } from "@/lib/activateFilePicker"');
        expect(answerImportModal).toContain("import { activateFilePicker } from '@/lib/activateFilePicker'");
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

    it("keeps tablet and desktop solving on a compact floating OMR rail", () => {
        const solvePage = readProjectFile("src/app/solve/[id]/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(solvePage).toContain("solve-omr-quick-card");
        expect(solvePage).toContain("quickAnswerQuestion");
        expect(solvePage).toContain("quickAnswerChoiceCount");
        expect(solvePage).toContain("solve-omr-quick-bubble");
        expect(solvePage).toContain("nextQuickTarget");
        expect(solvePage).toContain("solve-omr-quick-handwriting");
        expect(solvePage).toContain('window.matchMedia("(min-width: 600px)").matches');
        expect(solvePage).toContain("setIsOMRCollapsed(true)");
        expect(css).toContain(".solve-omr-rail.is-collapsed");
        expect(css).toContain(".solve-omr-quick-card");
        expect(css).toContain(".solve-omr-quick-bubble.is-marked");
        expect(css).toContain("@media (min-width: 600px) and (max-width: 1180px)");
        expect(css).toContain("overflow: clip !important");
        expect(css).toContain("--solve-omr-pane-backdrop: blur(18px) saturate(140%)");
        expect(css).toContain("width: clamp(280px, 32vw, 320px) !important");
        expect(css).toContain("transform: translateX(calc(100% + 1.5rem))");
        expect(css).toContain("@media (min-width: 1181px)");
        expect(css).toContain("width: clamp(300px, 28vw, 380px) !important");
        expect(css).toContain("transform: translateX(calc(100% + 2rem))");
    });

    it("keeps review correct, wrong, and unanswered summary cards compact", () => {
        const css = readProjectFile("src/app/globals.css");
        const reviewPage = readProjectFile("src/app/student/review/[attemptId]/page.tsx");
        const pwaMobileE2e = readProjectFile("e2e/pwa-mobile.spec.ts");

        expect(reviewPage).toContain('className="student-review-stat-grid"');
        expect(css).toContain(".student-review-stat-grid {\n  align-self: start;");
        expect(pwaMobileE2e).toContain("reviewStatSizing.gridHeight");
        expect(pwaMobileE2e).toContain("reviewStatSizing.cardHeight + 2");
    });

    it("keeps student review reading order aligned without CSS reordering on phones", () => {
        const css = readProjectFile("src/app/globals.css");
        const pwaMobileE2e = readProjectFile("e2e/pwa-mobile.spec.ts");

        expect(css).toContain('"summary content"');
        expect(css).toContain('"secondary content"');
        expect(css).not.toContain("display: contents");
        expect(css).not.toMatch(/\.student-review-(?:content|side-card|next-action)\s*{\s*order\s*:/);
        expect(pwaMobileE2e).toContain("expect(reviewFlow.contentTop).toBeLessThan(reviewFlow.secondaryTop)");
    });

    it("keeps Kakao notifications planned without implying live sending", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");
        const notificationBell = readProjectFile("src/components/NotificationBell.tsx");

        expect(settingsPage).toContain("NOTIFICATION_STATUS_ITEMS");
        expect(settingsPage).toContain("앱 내 카카오 발송 후보");
        expect(settingsPage).toContain("카카오 실제 발송");
        expect(settingsPage).toContain("실제 전송 설정을 활성화할 수 없습니다");
        expect(settingsPage).not.toContain('<Toggle checked={value.email}');
        expect(settingsPage).not.toContain('<Toggle checked={value.push}');
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

    it("shows the real grading behavior without non-functional policy controls", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");

        expect(settingsPage).toContain("GRADING_STATUS_ITEMS");
        expect(settingsPage).toContain("객관식 자동 채점");
        expect(settingsPage).toContain("문항별 배점 합산");
        expect(settingsPage).toContain("오답 감점·부분 점수");
        expect(settingsPage).toContain("실제 점수 계산이 바뀌지 않는 항목은 제공하지 않습니다");
        expect(settingsPage).not.toContain('<Toggle checked={value.negative}');
        expect(settingsPage).not.toContain('<Toggle checked={value.partial}');
        expect(settingsPage).not.toContain('<Toggle checked={value.autoRelease}');
    });

    it("does not present browser-only profile values as a live teacher profile", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");

        expect(settingsPage).toContain("PROFILE_STATUS_ITEMS");
        expect(settingsPage).toContain("로그인 계정과 권한");
        expect(settingsPage).toContain("이름·소속·담당 과목");
        expect(settingsPage).toContain("작동하지 않는 로컬 프로필 편집은 제공하지 않습니다");
        expect(settingsPage).not.toContain('label="공개 프로필"');
        expect(settingsPage).not.toContain("이미지 변경</button>");
    });

    it("previews theme edits without persisting them before save", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const applyThemeSource = settingsPage.slice(
            settingsPage.indexOf("function applyTheme"),
            settingsPage.indexOf("function persistThemeMode"),
        );

        expect(applyThemeSource).not.toContain("localStorage.setItem");
        expect(settingsPage).toContain('if (key === "theme") persistThemeMode(next.theme)');
        expect(settingsPage).toContain("persistThemeMode(DEFAULT_SETTINGS.theme)");
        expect(settingsPage).toContain("persistThemeMode(merged.theme)");
        expect(settingsPage).not.toContain('<Field label="밀도">');
    });

    it("keeps settings data DB readiness tied to shared storage sources", () => {
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const dataReadiness = readProjectFile("src/lib/dataDbReadiness.ts");

        expect(settingsPage).toContain("데이터 · DB");
        expect(settingsPage).toContain("DataDbSection");
        expect(settingsPage).toContain("buildDataDbReadiness");
        expect(settingsPage).toContain("loadTeacherExams()");
        expect(settingsPage).toContain("loadTeacherAttemptSummaries()");
        expect(settingsPage).toContain("loadTeacherRosterSnapshot(window.localStorage)");
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
        expect(dashboardPage).not.toContain("allowDemoData");
    });

    it("keeps roster demo data display-only", () => {
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx")
            // The tab bodies, modals, and leaf components this test inspects were
            // extracted verbatim under components/teacher/users (Phase 2
            // decomposition); the user-visible surface is the page plus its parts.
            + readProjectFile("src/components/teacher/users/parts.tsx")
            + readProjectFile("src/components/teacher/users/GroupsTab.tsx")
            + readProjectFile("src/components/teacher/users/InvitesTab.tsx");

        expect(usersPage).toContain('type RosterDataMode = "real" | "demo"');
        expect(usersPage).toContain("hasStoredRosterData(localStorage)");
        expect(usersPage).toContain("function isLegacyDemoRosterSnapshot");
        expect(usersPage).toContain("localStorage.removeItem(key)");
        expect(usersPage).toContain("const storedStudents = readRosterStudents(localStorage)");
        expect(usersPage).toContain("loadTeacherRosterSnapshot(localStorage)");
        expect(usersPage).toContain("const nextStudents = useDemoRoster ? [] : rosterResult.students");
        expect(usersPage).toContain("saveTeacherRosterSnapshot(localStorage");
        expect(usersPage).toContain("데모 명단 모드");
        expect(usersPage).toContain('aria-label="데모 명단 안내"');
        expect(usersPage).toContain("const rosterStudents = isDemoRoster ? MOCK_STUDENTS : students");
        expect(usersPage).toContain("const rosterInvites = isDemoRoster ? MOCK_INVITES : invites");
        expect(usersPage).toContain("buildRegionalLearningScopes");
        expect(usersPage).toContain("전체 지역");
        expect(usersPage).toContain("학생 지역 필터");
        expect(usersPage).toContain('"name", "email", "group", "region"');
        expect(usersPage).toContain("WeaknessRetakeLink");
        expect(usersPage).toContain("buildRetakeHref");
        expect(usersPage).not.toContain("readRosterStudents(localStorage, fallbackStudents)");
        expect(usersPage).not.toContain("Math.random");
        expect(usersPage).not.toContain("classin.app/join");
        expect(usersPage).toContain("shouldUseDemoData(readTeacherSession())");
    });

    it("keeps live synthetic data scoped to demo mode", () => {
        const livePage = readProjectFile("src/app/teacher/live/page.tsx");

        expect(livePage).toContain('type LiveDataMode = "real" | "demo"');
        expect(livePage).toContain("function resolveLiveExamData");
        expect(livePage).toContain('return { exams: loaded, mode: "real" }');
        expect(livePage).toContain("const isDemoLive = liveDataMode === \"demo\"");
        expect(livePage).toContain("allowSynthetic: isDemoLive");
        expect(livePage).toContain("forceFinishTeacherAttempts(targets, finishedAt)");
        expect(livePage).not.toMatch(/\bsaveTeacherAttempt\(/);
        expect(livePage).not.toContain("forceCompleteLiveAttempt");
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
        expect(livePage).toContain("shouldUseDemoData(readTeacherSession())");
    });

    it("keeps the live force-finish confirmation inside the shared dialog focus lifecycle", () => {
        const livePage = readProjectFile("src/app/teacher/live/page.tsx");

        expect(livePage).toContain('import { useDialogFocus } from "@/hooks/useDialogFocus"');
        expect(livePage).toContain("const dialogRef = useDialogFocus(true, onCancel)");
        expect(livePage).toContain("ref={dialogRef}");
        expect(livePage).toContain('tabIndex={-1}');
    });

    it("keeps warning, print, and view-switching affordances accessible", () => {
        const createPage = readProjectFile("src/app/create/page.tsx");
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");
        const settingsPage = readProjectFile("src/app/teacher/settings/page.tsx");
        const livePage = readProjectFile("src/app/teacher/live/page.tsx");
        const studentDashboardPage = readProjectFile("src/app/student/dashboard/page.tsx");
        const historyPage = readProjectFile("src/app/student/history/page.tsx");
        const groupsTab = readProjectFile("src/components/teacher/users/GroupsTab.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(createPage).toContain("const hasValidationIssues = validationSummary.errors.length > 0 || validationSummary.warnings.length > 0");
        expect(createPage).toContain("{hasValidationIssues && <div className=\"create-design-check-compact\"");
        expect(createPage).toContain("validationSummary.warnings.length > 0 ? '경고 확인'");
        expect(dashboardPage).toContain('role="group" aria-label="대시보드 보기"');
        expect(dashboardPage).toContain("aria-pressed={activeTab === 'overview'}");
        expect(dashboardPage).not.toContain('role="tab"');
        expect(usersPage).toContain('role="group" aria-label="명단 보기"');
        expect(usersPage).toContain("aria-pressed={tab === t.key}");
        expect(usersPage).not.toContain('role="tab"');
        expect(css).toContain(".student-review-page details:not([open]) > :not(summary)");
        expect(css).toContain(".student-review-page details > summary::marker");
        expect(css).not.toContain(".student-review-page details > summary {\n    display: none !important;");
        expect(settingsPage).toContain('className="bento-card settings-section-nav"');
        expect(livePage).toContain("classifyTeacherLiveExamPhase");
        expect(livePage).toContain("teacherLiveExamPresentation");
        expect(livePage).toContain('aria-label={isScreenRefreshPaused ? "화면 갱신 재개" : "화면 갱신 일시정지"}');
        expect(livePage).toContain('aria-pressed={isScreenRefreshPaused}');
        expect(livePage).toContain("교사 화면의 자동 갱신만 멈춥니다. 학생 응시와 시험 시간은 계속됩니다.");
        expect(livePage).toContain("var(--warning)");
        expect(livePage).toContain("var(--grade-red)");
        expect(livePage).toContain("var(--error)");
        expect(livePage.match(/<PlusCircle size=\{18\} \/> 시험 만들기/g)).toHaveLength(1);
        expect(studentDashboardPage).toContain('className="student-guest-merge-disclosure"');
        expect(historyPage).toContain('className="student-history-empty-state"');
        expect(groupsTab).toContain("teacher-groups-empty-state");
        expect(settingsPage).toContain(".settings-section-nav");
        expect(css).toContain(".student-dashboard-header");
    });
});
