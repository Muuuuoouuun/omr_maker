import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { continueSolveEntryIfPresent, loginAsShowcaseTeacher, loginAsTeacher } from "./helpers";

const STUDENT_NAME = "김모바일학생";
const PENDING_EXAM_TITLE = "여름방학을 앞두고 차근차근 준비하는 국어 독해와 문법 종합 진단 평가";
const COMPLETED_EXAM_TITLE = "긴 지문을 끝까지 읽고 핵심 근거를 찾아내는 국어 독해 성장 확인 평가";
const STUDENT_ATTEMPT_ID = "iphone-student-attempt";
const TEACHER_EXAM_ID = "iphone-teacher-detail-exam";
const TEACHER_EXAM_TITLE = "아이폰에서도 긴 시험 제목과 운영 상태를 놓치지 않는 국어 독해 종합 진단 평가";
const TEACHER_STUDENT_NAME = "김모바일레이아웃확인학생";
const CREATE_EXAM_ID = "iphone-create-actions-exam";
const SOLVE_EXAM_ID = "iphone-solve-controls-exam";
const SOLVE_STUDENT_ID = "iphone-solve-student";

const SAMPLE_PDF_DATA_URL = (() => {
    const bytes = readFileSync(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    return `data:application/pdf;base64,${bytes.toString("base64")}`;
})();

async function expectNoDocumentHorizontalOverflow(page: Page) {
    const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
        ),
    }));

    expect(
        dimensions.scrollWidth,
        `document width ${dimensions.scrollWidth}px exceeded the ${dimensions.clientWidth}px viewport`,
    ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectMinimumTouchTarget(locator: Locator) {
    await expect(locator).toBeVisible();
    await expect.poll(async () => {
        const box = await locator.boundingBox();
        return box ? Math.min(box.width, box.height) : 0;
    }, { message: "touch target did not settle at a minimum 44px square bound" }).toBeGreaterThanOrEqual(44);
}

async function expectWithinViewport(locator: Locator, page: Page) {
    await expect(locator).toBeVisible();
    const [box, viewportWidth] = await Promise.all([
        locator.boundingBox(),
        page.evaluate(() => document.documentElement.clientWidth),
    ]);
    const tolerance = 1;

    expect(box, "control did not have a rendered bounding box").not.toBeNull();
    expect(box?.x ?? Number.NEGATIVE_INFINITY, "control extended beyond the viewport's left edge")
        .toBeGreaterThanOrEqual(-tolerance);
    expect((box?.x ?? 0) + (box?.width ?? 0), "control extended beyond the viewport's right edge")
        .toBeLessThanOrEqual(viewportWidth + tolerance);
}

async function expectWithinVisualViewport(locator: Locator, page: Page) {
    await expect(locator).toBeVisible();
    const [box, visualViewport] = await Promise.all([
        locator.boundingBox(),
        page.evaluate(() => ({
            left: window.visualViewport?.offsetLeft || 0,
            top: window.visualViewport?.offsetTop || 0,
            width: window.visualViewport?.width || document.documentElement.clientWidth,
            height: window.visualViewport?.height || document.documentElement.clientHeight,
        })),
    ]);
    const tolerance = 1;

    expect(box, "control did not have a rendered bounding box").not.toBeNull();
    expect(box?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(visualViewport.left - tolerance);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(visualViewport.left + visualViewport.width + tolerance);
    expect(box?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(visualViewport.top - tolerance);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(visualViewport.top + visualViewport.height + tolerance);
}

async function expectWithinConfiguredSafeInlineBounds(locator: Locator, page: Page) {
    const [box, bounds] = await Promise.all([
        locator.boundingBox(),
        page.evaluate(() => {
            const rootStyle = window.getComputedStyle(document.documentElement);
            return {
                left: Number.parseFloat(rootStyle.getPropertyValue("--app-safe-area-left")) || 0,
                right: Number.parseFloat(rootStyle.getPropertyValue("--app-safe-area-right")) || 0,
                width: document.documentElement.clientWidth,
            };
        }),
    ]);
    const tolerance = 1;

    expect(box, "safe-area control did not have a rendered bounding box").not.toBeNull();
    expect(box?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(bounds.left - tolerance);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(bounds.width - bounds.right + tolerance);
}

async function expectWithinConfiguredAppViewport(locator: Locator, page: Page, includeSafeInsets = false) {
    await expect(locator).toBeVisible();
    const [box, viewport] = await Promise.all([
        locator.boundingBox(),
        page.evaluate(({ safe }) => {
            const style = window.getComputedStyle(document.documentElement);
            const value = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
            const offsetLeft = value("--app-visual-viewport-offset-left");
            const offsetTop = value("--app-visual-viewport-offset-top");
            const safeLeft = safe ? value("--app-safe-area-left") : 0;
            const safeRight = safe ? value("--app-safe-area-right") : 0;
            const safeTop = safe ? value("--app-safe-area-top") : 0;
            const safeBottom = safe ? value("--app-safe-area-bottom") : 0;
            return {
                left: offsetLeft + safeLeft,
                right: offsetLeft + value("--app-viewport-width") - safeRight,
                top: offsetTop + safeTop,
                bottom: offsetTop + value("--app-viewport-height") - safeBottom,
            };
        }, { safe: includeSafeInsets }),
    ]);
    const tolerance = 1;

    expect(box, "synchronized viewport control did not have a rendered bounding box").not.toBeNull();
    expect(box?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(viewport.left - tolerance);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.right + tolerance);
    expect(box?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(viewport.top - tolerance);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.bottom + tolerance);
}

async function configureKeyboardViewport(page: Page, targetHeight: number) {
    const browserViewport = page.viewportSize();
    expect(browserViewport).not.toBeNull();
    await page.evaluate(({ height, width, targetHeight }) => {
        const root = document.documentElement;
        root.dataset.appKeyboard = "open";
        root.style.setProperty("--app-viewport-height", `${targetHeight}px`);
        root.style.setProperty("--app-viewport-width", `${width - 24}px`);
        root.style.setProperty("--app-visual-viewport-offset-top", "10px");
        root.style.setProperty("--app-visual-viewport-offset-left", "12px");
        root.style.setProperty("--app-safe-area-top", "6px");
        root.style.setProperty("--app-safe-area-right", "8px");
        root.style.setProperty("--app-safe-area-bottom", "12px");
        root.style.setProperty("--app-safe-area-left", "8px");
        root.style.setProperty("--app-keyboard-inset-bottom", `${Math.max(180, height - targetHeight - 10)}px`);
    }, { ...browserViewport!, targetHeight });
}

async function expectCopyWrapsWithoutClipping(locator: Locator) {
    await expect(locator).toBeVisible();
    const metrics = await locator.evaluate(element => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        return {
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            whiteSpace: style.whiteSpace,
        };
    });

    expect(metrics.scrollWidth, "long copy was clipped horizontally").toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.whiteSpace).not.toBe("nowrap");
}

async function expectAbove(primary: Locator, secondary: Locator) {
    await expect.poll(async () => {
        const [primaryBox, secondaryBox] = await Promise.all([
            primary.boundingBox(),
            secondary.boundingBox(),
        ]);
        if (!primaryBox || !secondaryBox) return false;
        return primaryBox.y < secondaryBox.y;
    }, { message: "primary action did not settle before secondary content" }).toBe(true);
}

async function expectPrecedesInDom(before: Locator, after: Locator) {
    await expect(before).toBeVisible();
    await expect(after).toBeVisible();
    const afterElement = await after.elementHandle();
    if (!afterElement) {
        throw new Error("expected the later task-flow element to exist");
    }
    const precedes = await before.evaluate((beforeElement, afterElement) => (
        !!(beforeElement.compareDocumentPosition(afterElement) & Node.DOCUMENT_POSITION_FOLLOWING)
    ), afterElement);

    expect(precedes, "task flow DOM order did not match its visual/read order").toBe(true);
}

async function readCountdownSeconds(locator: Locator) {
    const text = (await locator.textContent())?.trim() || "";
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    expect(match, `expected MM:SS countdown, received "${text}"`).not.toBeNull();
    return Number(match?.[1] || 0) * 60 + Number(match?.[2] || 0);
}

async function seedStudentTaskFlow(page: Page) {
    await page.addInitScript(({ attemptId, completedTitle, pendingTitle, studentName }) => {
        const session = {
            createdAt: "2026-08-05T00:00:00.000Z",
            groupId: "iphone-mobile-class",
            groupName: "아이폰 모바일 학습반",
            identityType: "temporary",
            isGuest: false,
            loginId: "iphone-mobile-student",
            name: studentName,
            studentId: "iphone-mobile-student",
        };
        const pendingExam = {
            id: "iphone-pending-exam",
            title: pendingTitle,
            createdAt: "2026-08-05T00:00:00.000Z",
            durationMin: 35,
            accessConfig: { type: "public", groupIds: [] },
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50, label: "긴 글 독해" },
                { id: 2, number: 2, answer: 3, choices: 4, score: 50, label: "문법" },
            ],
        };
        const completedExam = {
            id: "iphone-completed-exam",
            title: completedTitle,
            createdAt: "2026-08-01T00:00:00.000Z",
            durationMin: 40,
            accessConfig: { type: "public", groupIds: [] },
            questions: [
                {
                    id: 11,
                    number: 1,
                    answer: 2,
                    choices: 4,
                    score: 50,
                    label: "내용 이해와 중심 생각 찾기",
                    explanation: "문단마다 반복되는 핵심 표현을 연결하면 글쓴이의 중심 생각을 자연스럽게 찾을 수 있습니다.",
                },
                {
                    id: 12,
                    number: 2,
                    answer: 4,
                    choices: 4,
                    score: 50,
                    label: "근거 추론",
                    explanation: "선택지의 표현과 본문의 근거 문장을 차례로 비교해 가장 직접적으로 뒷받침되는 답을 고릅니다.",
                },
            ],
        };
        const attempt = {
            id: attemptId,
            examId: completedExam.id,
            examTitle: completedExam.title,
            studentName,
            studentId: session.studentId,
            studentProfileId: session.studentId,
            groupId: session.groupId,
            groupName: session.groupName,
            startedAt: "2026-08-04T09:00:00.000Z",
            finishedAt: "2026-08-04T09:32:00.000Z",
            score: 50,
            totalScore: 100,
            answers: { 11: 2, 12: 1 },
            questionTimings: [
                { questionId: 11, questionNumber: 1, totalTimeSec: 125, visitCount: 1 },
                { questionId: 12, questionNumber: 2, totalTimeSec: 310, visitCount: 2 },
            ],
            status: "completed",
        };

        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
        window.localStorage.setItem(`omr_exam_${pendingExam.id}`, JSON.stringify(pendingExam));
        window.localStorage.setItem(`omr_exam_${completedExam.id}`, JSON.stringify(completedExam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, {
        attemptId: STUDENT_ATTEMPT_ID,
        completedTitle: COMPLETED_EXAM_TITLE,
        pendingTitle: PENDING_EXAM_TITLE,
        studentName: STUDENT_NAME,
    });
}

async function seedTeacherExamDetail(page: Page) {
    await page.addInitScript(({ examId, examTitle, studentName }) => {
        const exam = {
            id: examId,
            title: examTitle,
            organizationId: "default",
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
            durationMin: 45,
            accessConfig: { type: "public", groupIds: [] },
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50, label: "중심 내용" },
                { id: 2, number: 2, answer: 4, choices: 4, score: 50, label: "근거 추론" },
            ],
        };
        const attempt = {
            id: "iphone-teacher-detail-attempt",
            examId,
            examTitle,
            organizationId: "default",
            studentName,
            studentId: "iphone-teacher-detail-student",
            startedAt: "2026-08-05T09:00:00.000Z",
            finishedAt: "2026-08-05T09:34:00.000Z",
            score: 50,
            totalScore: 100,
            answers: { 1: 2, 2: 1 },
            status: "completed",
        };

        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
    }, {
        examId: TEACHER_EXAM_ID,
        examTitle: TEACHER_EXAM_TITLE,
        studentName: TEACHER_STUDENT_NAME,
    });
}

async function seedCreateExam(page: Page) {
    await page.addInitScript(({ examId }) => {
        const questions = Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            number: index + 1,
            answer: (index % 4) + 1,
            choices: 4,
            score: 10,
            label: `긴 국어 독해 개념 확인 ${index + 1}`,
            tags: { concept: `핵심 개념 ${index + 1}` },
        }));
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify({
            id: examId,
            title: "아이폰 안전영역과 키보드에서도 작업을 마칠 수 있는 국어 종합 평가",
            organizationId: "default",
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
            durationMin: 40,
            accessConfig: { type: "public", groupIds: [] },
            questions,
        }));
    }, { examId: CREATE_EXAM_ID });
}

async function seedSolveExam(page: Page) {
    await page.addInitScript(({ examId, pdfData, studentId }) => {
        const session = {
            createdAt: "2026-08-05T00:00:00.000Z",
            groupId: "iphone-solve-class",
            groupName: "아이폰 풀이반",
            identityType: "temporary",
            isGuest: false,
            loginId: studentId,
            name: "김아이폰풀이학생",
            studentId,
        };
        const exam = {
            id: examId,
            title: "아이폰에서도 긴 시험 제목과 PDF 도구를 놓치지 않는 국어 종합 평가",
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
            durationMin: 35,
            pdfData,
            accessConfig: { type: "public", groupIds: [] },
            questions: Array.from({ length: 4 }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: (index % 4) + 1,
                choices: 4,
                score: 25,
                label: `긴 지문 핵심 근거 찾기 ${index + 1}`,
            })),
        };

        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, {
        examId: SOLVE_EXAM_ID,
        pdfData: SAMPLE_PDF_DATA_URL,
        studentId: SOLVE_STUDENT_ID,
    });
}

test.describe("iPhone WebKit mobile layout", () => {
    test("create completion actions and panel tabs respect safe bounds and keyboard flow", async ({ page }) => {
        await seedCreateExam(page);
        await loginAsTeacher(page, `/create?edit=${CREATE_EXAM_ID}`);

        const actions = page.getByRole("group", { name: "출제 완료 작업" });
        const primaryAction = actions.getByRole("button", { name: "저장하고 배포하기" });
        const draftAction = actions.getByRole("button", { name: "초안 저장" });
        const tabs = page.getByRole("tablist", { name: "출제 작업 화면" }).getByRole("tab");
        await expect(page.getByLabel("시험 제목")).toHaveValue(/아이폰 안전영역/);
        await page.evaluate(() => {
            document.documentElement.style.setProperty("--app-safe-area-left", "22px");
            document.documentElement.style.setProperty("--app-safe-area-right", "18px");
            document.documentElement.style.setProperty("--app-safe-area-bottom", "24px");
        });

        await expectWithinVisualViewport(actions, page);
        await expectWithinConfiguredSafeInlineBounds(actions, page);
        const safeBottomGap = await actions.evaluate(element => {
            const box = element.getBoundingClientRect();
            const rootStyle = window.getComputedStyle(document.documentElement);
            const viewportBottom = (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || document.documentElement.clientHeight);
            const safeBottom = Number.parseFloat(rootStyle.getPropertyValue("--app-safe-area-bottom")) || 0;
            return { gap: viewportBottom - box.bottom, safeBottom };
        });
        expect(safeBottomGap.gap).toBeGreaterThanOrEqual(safeBottomGap.safeBottom - 1);
        await expectMinimumTouchTarget(primaryAction);
        await expectMinimumTouchTarget(draftAction);
        await expect.poll(async () => {
            const [primaryBox, draftBox] = await Promise.all([primaryAction.boundingBox(), draftAction.boundingBox()]);
            return !!primaryBox && !!draftBox && primaryBox.width > draftBox.width;
        }, { message: "the publish action did not retain stronger mobile hierarchy than draft save" }).toBe(true);
        await expectPrecedesInDom(primaryAction, draftAction);

        await expect(tabs).toHaveCount(3);
        for (let index = 0; index < 3; index += 1) {
            await expectMinimumTouchTarget(tabs.nth(index));
            await expectWithinViewport(tabs.nth(index), page);
        }

        await tabs.getByText("설정", { exact: true }).click();
        const titleInput = page.getByLabel("시험 제목");
        await titleInput.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
            const root = document.documentElement;
            root.dataset.appKeyboard = "open";
            root.style.setProperty("--app-keyboard-inset-bottom", "180px");
            root.style.setProperty("--app-viewport-height", "420px");
        });
        await expect.poll(() => actions.evaluate(element => window.getComputedStyle(element).position), {
            message: "mobile completion actions did not return to normal flow while the keyboard was open",
        }).toBe("static");
        await titleInput.scrollIntoViewIfNeeded();
        const [inputBox, actionsBox] = await Promise.all([titleInput.boundingBox(), actions.boundingBox()]);
        expect(inputBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(
            (inputBox?.y ?? 0) + (inputBox?.height ?? 0) <= (actionsBox?.y ?? 0)
            || (actionsBox?.y ?? 0) + (actionsBox?.height ?? 0) <= (inputBox?.y ?? 0),
            "completion actions covered the focused create input",
        ).toBe(true);
        await actions.scrollIntoViewIfNeeded();
        const keyboardViewportMetrics = await actions.evaluate(element => ({
            bottom: element.getBoundingClientRect().bottom,
            appViewportHeight: Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height")),
        }));
        expect(keyboardViewportMetrics.bottom).toBeLessThanOrEqual(keyboardViewportMetrics.appViewportHeight + 1);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("distribution overlay fits the synchronized viewport and preserves dialog focus semantics", async ({ page }) => {
        await seedCreateExam(page);
        await loginAsTeacher(page, `/create?edit=${CREATE_EXAM_ID}`);

        const trigger = page.getByRole("group", { name: "출제 완료 작업" })
            .getByRole("button", { name: "저장하고 배포하기" });
        await expect(page.getByLabel("시험 제목")).toHaveValue(/아이폰 안전영역/);
        await page.evaluate(() => {
            const root = document.documentElement;
            root.style.setProperty("--app-viewport-height", "420px");
            root.style.setProperty("--app-safe-area-top", "14px");
            root.style.setProperty("--app-safe-area-bottom", "16px");
        });
        await trigger.click();

        const dialog = page.getByRole("dialog", { name: "시험 배포하기" });
        const close = dialog.getByRole("button", { name: "닫기" });
        const body = dialog.locator(".distribute-dialog-body");
        await expect(dialog).toBeVisible();
        await expect(close).toBeFocused();
        const metrics = await dialog.evaluate(element => {
            const box = element.getBoundingClientRect();
            const bodyElement = element.querySelector<HTMLElement>(".distribute-dialog-body");
            return {
                top: box.top,
                bottom: box.bottom,
                height: box.height,
                appViewportHeight: Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height")),
                bodyClientHeight: bodyElement?.clientHeight || 0,
                bodyScrollHeight: bodyElement?.scrollHeight || 0,
                bodyOverflowY: bodyElement ? window.getComputedStyle(bodyElement).overflowY : "",
            };
        });
        expect(metrics.top).toBeGreaterThanOrEqual(14 - 1);
        expect(metrics.bottom).toBeLessThanOrEqual(metrics.appViewportHeight - 16 + 1);
        expect(metrics.height).toBeLessThanOrEqual(metrics.appViewportHeight - 14 - 16 + 1);
        expect(metrics.bodyOverflowY).toBe("auto");
        expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight);
        await expectCopyWrapsWithoutClipping(body.getByText(/문제지 PDF가 없으면/));
        await expectNoDocumentHorizontalOverflow(page);

        await close.press("Shift+Tab");
        await expect(dialog.locator(":focus")).not.toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
    });

    test("seeded solve route keeps solve and PDF controls reachable without overflow", async ({ page }) => {
        await seedSolveExam(page);
        await page.goto(`/solve/${SOLVE_EXAM_ID}`);
        await continueSolveEntryIfPresent(page);

        await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });
        await expectCopyWrapsWithoutClipping(page.locator(".solve-title"));
        const toolsDisclosure = page.locator(".solve-tools-disclosure");
        const toolsSummary = toolsDisclosure.locator(":scope > summary");
        await expect(toolsSummary).toHaveText("도구");
        await expectMinimumTouchTarget(toolsSummary);
        await expectWithinViewport(toolsSummary, page);
        await toolsSummary.focus();
        await expect(toolsSummary).toBeFocused();
        await toolsSummary.press("Enter");
        await expect(toolsDisclosure).toHaveJSProperty("open", true);
        const toolsPanel = toolsDisclosure.locator(".solve-tools-panel");
        const pdfOpenButton = toolsPanel.getByRole("button", { name: "PDF 열기", exact: true });
        await expectMinimumTouchTarget(pdfOpenButton);
        await expectWithinViewport(pdfOpenButton, page);
        await pdfOpenButton.focus();
        await expect(pdfOpenButton).toBeFocused();
        const fileChooserPromise = page.waitForEvent("filechooser");
        await pdfOpenButton.press("Enter");
        await fileChooserPromise;
        const solveControls = [
            pdfOpenButton,
            page.locator(".solve-controls").getByRole("button", { name: "답안지 접기" }),
            page.locator(".solve-controls").getByRole("button", { name: "제출하기" }),
        ];
        for (const control of solveControls) {
            await control.scrollIntoViewIfNeeded();
            await expectMinimumTouchTarget(control);
            await expectWithinViewport(control, page);
        }

        const pdfToolbar = page.locator(".pdf-viewer-toolbar");
        await expect(pdfToolbar).toBeVisible({ timeout: 20_000 });
        const pdfControls = page.locator(".pdf-viewer-controls button");
        const pdfControlCount = await pdfControls.count();
        expect(pdfControlCount).toBeGreaterThanOrEqual(4);
        for (let index = 0; index < pdfControlCount; index += 1) {
            const control = pdfControls.nth(index);
            await control.scrollIntoViewIfNeeded();
            await expectMinimumTouchTarget(control);
            await expectWithinViewport(control, page);
        }
        const pageInput = page.locator(".pdf-viewer-controls input[type='text']");
        await pageInput.scrollIntoViewIfNeeded();
        await expectMinimumTouchTarget(pageInput);
        await expectWithinViewport(pageInput, page);
        await expectWithinVisualViewport(pdfToolbar, page);
        await expectNoDocumentHorizontalOverflow(page);
    });

    for (const appViewportHeight of [300, 260]) {
        test(`solve controls remain settled after answer focus in a ${appViewportHeight}px keyboard viewport`, async ({ page }) => {
            await seedSolveExam(page);
            await page.goto(`/solve/${SOLVE_EXAM_ID}`);
            await continueSolveEntryIfPresent(page);
            await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });

            await configureKeyboardViewport(page, appViewportHeight);

            const solvePage = page.locator(".solve-page");
            const controls = page.locator(".solve-controls");
            const submit = controls.getByRole("button", { name: "제출하기" });
            const body = page.locator(".solve-body");
            await expectWithinConfiguredAppViewport(controls, page, true);
            await expectWithinConfiguredAppViewport(submit, page, true);

            const firstAnswer = page.getByRole("radio", { name: "문제 1번 보기 1" });
            await firstAnswer.focus();
            await firstAnswer.scrollIntoViewIfNeeded();
            await expect(firstAnswer).toBeFocused();
            await expectMinimumTouchTarget(firstAnswer);
            await expectWithinConfiguredAppViewport(firstAnswer, page, true);

            // Re-check completion controls after focus/scroll: WebKit can
            // programmatically scroll overflow:hidden ancestors even though the
            // user has no way to scroll them back into place.
            await expectWithinConfiguredAppViewport(controls, page, true);
            await expectWithinConfiguredAppViewport(submit, page, true);
            const [controlsBox, bodyBox, solveScrollTop] = await Promise.all([
                controls.boundingBox(),
                body.boundingBox(),
                solvePage.evaluate(element => element.scrollTop),
            ]);
            expect(controlsBox).not.toBeNull();
            expect(bodyBox).not.toBeNull();
            expect(bodyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect(bodyBox?.y ?? 0).toBeGreaterThanOrEqual((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0) - 1);
            expect(solveScrollTop).toBe(0);
            await expectWithinConfiguredAppViewport(body, page);
            await expectNoDocumentHorizontalOverflow(page);
        });
    }

    for (const appViewportHeight of [300, 260]) {
        test(`PDF page input remains editable in a ${appViewportHeight}px keyboard viewport`, async ({ page }) => {
            await seedSolveExam(page);
            await page.goto(`/solve/${SOLVE_EXAM_ID}`);
            await continueSolveEntryIfPresent(page);
            await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });

            const pageInput = page.locator(".pdf-viewer-controls input[type='text']");
            await expect(pageInput).toHaveValue("1", { timeout: 20_000 });
            await pageInput.focus();
            await expect(pageInput).toBeFocused();

            await configureKeyboardViewport(page, appViewportHeight);

            await expect(pageInput).toBeFocused();
            await pageInput.scrollIntoViewIfNeeded();
            await expectMinimumTouchTarget(pageInput);
            await expectWithinConfiguredAppViewport(pageInput, page, true);

            await pageInput.fill("999");
            await pageInput.press("Enter");
            await expect(pageInput).toHaveValue("1");
            await expect(pageInput).toBeFocused();

            const solvePage = page.locator(".solve-page");
            const controls = page.locator(".solve-controls");
            const submit = controls.getByRole("button", { name: "제출하기" });
            const [pdfPaneBox, pageInputBox] = await Promise.all([
                page.locator(".solve-pdf-pane").boundingBox(),
                pageInput.boundingBox(),
            ]);
            expect(pdfPaneBox).not.toBeNull();
            expect(pageInputBox).not.toBeNull();
            expect(pdfPaneBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect(pageInputBox?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual((pdfPaneBox?.y ?? 0) - 1);
            expect((pageInputBox?.y ?? 0) + (pageInputBox?.height ?? 0))
                .toBeLessThanOrEqual((pdfPaneBox?.y ?? 0) + (pdfPaneBox?.height ?? 0) + 1);
            await expectWithinConfiguredAppViewport(controls, page, true);
            await expectWithinConfiguredAppViewport(submit, page, true);
            expect(await solvePage.evaluate(element => element.scrollTop)).toBe(0);
            await expectNoDocumentHorizontalOverflow(page);
        });
    }

    test("teacher solve preview shows both PDF tabs without horizontal control scrolling", async ({ page }) => {
        await seedSolveExam(page);
        await page.goto(`/solve/${SOLVE_EXAM_ID}`);
        await continueSolveEntryIfPresent(page);
        await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });

        const toolsDisclosure = page.locator(".solve-tools-disclosure");
        const toolsSummary = toolsDisclosure.locator(":scope > summary");
        await toolsSummary.click();
        const toolsPanel = toolsDisclosure.locator(".solve-tools-panel");
        await toolsPanel.getByLabel("선생님 모드").click();
        const authDialog = page.getByRole("dialog", { name: "선생님 모드 인증" });
        await expect(authDialog).toBeVisible();
        await authDialog.getByPlaceholder("아이디 또는 이메일").fill("admin");
        await authDialog.getByPlaceholder("비밀번호").fill("admin123");
        await authDialog.getByRole("button", { name: "인증" }).click();
        await expect(authDialog).toBeHidden({ timeout: 15_000 });

        if (!(await toolsDisclosure.evaluate(element => (element as HTMLDetailsElement).open))) {
            await toolsSummary.click();
        }
        const problemTab = toolsPanel.getByRole("button", { name: "문제지" });
        const answerTab = toolsPanel.getByRole("button", { name: "정답/해설" });
        await expect(problemTab).toBeVisible();
        await expect(answerTab).toBeVisible();
        await expectMinimumTouchTarget(problemTab);
        await expectMinimumTouchTarget(answerTab);
        await expectWithinViewport(problemTab, page);
        await expectWithinViewport(answerTab, page);
        const controlOverflow = await toolsPanel.evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowX: window.getComputedStyle(element).overflowX,
        }));
        expect(controlOverflow.scrollWidth).toBeLessThanOrEqual(controlOverflow.clientWidth + 1);
        expect(controlOverflow.overflowX).not.toBe("auto");
        expect(controlOverflow.overflowX).not.toBe("scroll");
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("public role selection fits the viewport and provides a usable touch target", async ({ page }) => {
        await page.goto("/");

        await expect(page.getByRole("heading", { name: "OMR Maker" })).toBeVisible();
        const studentRole = page.getByRole("button", {
            name: /학생 배정된 시험에 참여하고 결과를 확인하세요\. 시작하기/,
        });
        const teacherRole = page.getByRole("button", {
            name: /교사 시험을 출제하고 배포하며 학생 성취도를 분석하세요\. 대시보드/,
        });
        await expect(studentRole).toBeVisible();
        await expect(teacherRole).toBeVisible();

        await expectNoDocumentHorizontalOverflow(page);
        for (const role of [studentRole, teacherRole]) {
            await expectMinimumTouchTarget(role);
        }
    });

    test("teacher login keeps long Korean feedback and form actions inside the viewport", async ({ page }) => {
        await page.goto("/?role=teacher");

        const loginCard = page.locator(".home-login-card");
        const loginForm = page.getByRole("form", { name: "교사 로그인" });
        await expect(loginCard).toBeVisible();
        await loginForm.getByRole("button", { name: "대시보드 입장" }).click();
        await expect(loginForm.getByRole("alert")).toContainText("아이디와 비밀번호를 모두 입력해주세요.");

        await expectNoDocumentHorizontalOverflow(page);
        for (const control of [
            loginCard.getByRole("button", { name: "역할 선택으로" }),
            loginForm.getByLabel("아이디 또는 이메일"),
            loginForm.getByLabel("비밀번호"),
            loginForm.getByRole("button", { name: "대시보드 입장" }),
            loginCard.getByRole("button", { name: "데모 계정으로 둘러보기" }),
        ]) {
            await expectMinimumTouchTarget(control);
            await expectWithinViewport(control, page);
        }
    });

    test("authenticated teacher header keeps primary actions visible and moves live monitoring into the account menu", async ({ page }) => {
        await loginAsTeacher(page);

        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        const actions = page.locator(".teacher-header-actions");
        await expect(actions).toBeVisible();
        const interactiveActions = actions.locator(":scope > button:visible, :scope > a:visible, :scope > div > button:visible");
        const actionCount = await interactiveActions.count();
        expect(actionCount).toBeGreaterThan(0);

        await expectNoDocumentHorizontalOverflow(page);
        for (let index = 0; index < actionCount; index += 1) {
            await expectMinimumTouchTarget(interactiveActions.nth(index));
            await expectWithinViewport(interactiveActions.nth(index), page);
        }

        const accountMenuTrigger = actions.getByRole("button", { name: "교사 계정 메뉴" });
        await accountMenuTrigger.click();
        const liveMenuItem = page.getByRole("menu", { name: "교사 계정" })
            .getByRole("menuitem", { name: "실시간 모니터링" });
        await expect(liveMenuItem).toBeVisible();
        await expectMinimumTouchTarget(liveMenuItem);
        await expectWithinViewport(liveMenuItem, page);
        await expect(liveMenuItem).toHaveAttribute("href", "/teacher/live");
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("teacher dashboard leads from context and demo state into KPIs and one primary analysis action", async ({ page }) => {
        await loginAsShowcaseTeacher(page);

        const title = page.getByRole("heading", { name: /김하늘 선생님/ });
        const state = page.getByRole("status", { name: "데모 데이터 안내" });
        const firstKpi = page.getByRole("button", { name: /진행 중 시험.*진행 시험 분석/ });
        const primaryAction = page.getByRole("button", { name: /함수의 극한 정답률 58%/ });
        const secondarySection = page.getByRole("heading", { name: "최근 시험" });

        for (const element of [title, state, firstKpi, primaryAction]) {
            await expectWithinViewport(element, page);
        }
        await expectPrecedesInDom(title, state);
        await expectPrecedesInDom(state, firstKpi);
        await expectPrecedesInDom(firstKpi, primaryAction);
        await expectPrecedesInDom(primaryAction, secondarySection);
        await expectMinimumTouchTarget(firstKpi);
        await expectMinimumTouchTarget(primaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("teacher users puts roster state and KPI cards before mobile actions and student cards", async ({ page }) => {
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/users");

        const title = page.getByRole("heading", { name: "사용자 관리" });
        const state = page.getByRole("status", { name: "데모 명단 안내" });
        const summary = page.getByRole("region", { name: "명단 핵심 지표" });
        const actions = page.getByRole("group", { name: "명단 작업" });
        const primaryAction = actions.getByRole("button", { name: "학생 추가" });
        const secondaryAction = actions.getByRole("button", { name: "CSV 업로드" });
        const firstCard = page.getByTestId("teacher-users-mobile-card").first();

        await expect(page.locator(".teacher-users-table-scroll")).toBeHidden();
        for (const element of [title, state, summary, primaryAction, secondaryAction, firstCard]) {
            await expectWithinViewport(element, page);
        }
        await expectPrecedesInDom(title, state);
        await expectPrecedesInDom(state, summary);
        await expectPrecedesInDom(summary, primaryAction);
        await expectPrecedesInDom(primaryAction, secondaryAction);
        await expectPrecedesInDom(secondaryAction, firstCard);
        await expectMinimumTouchTarget(primaryAction);
        await expectMinimumTouchTarget(secondaryAction);
        await expectMinimumTouchTarget(firstCard.getByRole("button", { name: "김민준 상세 보기" }));
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("teacher live keeps factual status and KPI results before its stacked control group", async ({ page }) => {
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/live");

        const title = page.getByRole("heading", { name: "응시 결과 확인" });
        const state = page.getByRole("status", { name: "데모 실시간 데이터 안내" });
        const timer = page.getByText("REMAINING TIME", { exact: true });
        const summary = page.locator(".live-summary-rail");
        const actions = page.getByRole("region", { name: "실시간 시험 작업" });
        const primaryAction = actions.getByRole("button", { name: "화면 갱신 일시정지" });
        const secondaryAction = actions.getByRole("button", { name: "+5분 연장" });

        for (const element of [title, state, timer, summary, primaryAction, secondaryAction]) {
            await expectWithinViewport(element, page);
        }
        await expectPrecedesInDom(title, state);
        await expectPrecedesInDom(state, timer);
        await expectPrecedesInDom(timer, summary);
        await expectPrecedesInDom(summary, primaryAction);
        await expectPrecedesInDom(primaryAction, secondaryAction);
        await expectMinimumTouchTarget(primaryAction);
        await expectMinimumTouchTarget(secondaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("teacher live pause stops data refresh without freezing or resuming a stale countdown", async ({ page }) => {
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/live");

        const timer = page.locator(".numeric-emphasis");
        const actions = page.getByRole("region", { name: "실시간 시험 작업" });
        const pause = actions.getByRole("button", { name: "화면 갱신 일시정지" });
        await expect.poll(() => readCountdownSeconds(timer), { timeout: 5_000 }).toBeGreaterThan(0);
        const beforePause = await readCountdownSeconds(timer);

        await pause.click();
        await expect(actions.getByRole("button", { name: "화면 갱신 재개" })).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => readCountdownSeconds(timer), {
            message: "countdown froze while only screen data refresh was paused",
            timeout: 4_000,
        }).toBeLessThan(beforePause);

        const whilePaused = await readCountdownSeconds(timer);
        const resume = actions.getByRole("button", { name: "화면 갱신 재개" });
        await resume.click();
        expect(await readCountdownSeconds(timer), "resume jumped back to a stale countdown").toBeLessThanOrEqual(whilePaused);
        await expect(actions.getByRole("button", { name: "화면 갱신 일시정지" })).toHaveAttribute("aria-pressed", "false");
    });

    test("teacher live force-finish dialog traps focus, closes with Escape, and restores its trigger", async ({ page }) => {
        await loginAsShowcaseTeacher(page);
        await page.goto("/teacher/live");

        const actions = page.getByRole("region", { name: "실시간 시험 작업" });
        const trigger = actions.getByRole("button", { name: "종료 처리" });
        await trigger.click();

        const dialog = page.getByRole("dialog", { name: "응시 종료 처리 확인" });
        const cancel = dialog.getByRole("button", { name: "취소" });
        const confirm = dialog.getByRole("button", { name: "지금 종료" });
        await expect(dialog).toBeVisible();
        await expect(cancel).toBeFocused();
        await cancel.press("Shift+Tab");
        await expect(confirm).toBeFocused();
        await confirm.press("Tab");
        await expect(cancel).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
    });

    test("real teacher live empty state keeps truthful context and its primary action in view", async ({ page }) => {
        await loginAsTeacher(page, "/teacher/live");

        const title = page.getByRole("heading", { name: "응시 결과 확인" });
        const state = page.getByText("진행 중인 시험이 없습니다", { exact: true });
        const primaryAction = page.getByRole("link", { name: "시험 만들기" });
        for (const element of [title, state, primaryAction]) {
            await expectWithinViewport(element, page);
        }
        await expectPrecedesInDom(title, state);
        await expectPrecedesInDom(state, primaryAction);
        await expectMinimumTouchTarget(primaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("teacher exam detail wraps long context and result names before mobile result actions", async ({ page }) => {
        await seedTeacherExamDetail(page);
        await loginAsTeacher(page, `/teacher/exam/${TEACHER_EXAM_ID}`);

        const title = page.getByRole("heading", { name: TEACHER_EXAM_TITLE });
        const summary = page.getByRole("region", { name: "시험 결과 요약" });
        const actions = page.getByRole("group", { name: "시험 상세 작업" });
        const primaryAction = actions.getByRole("link", { name: "분석 보기" });
        const secondaryAction = actions.getByRole("link", { name: "실시간 모니터링" });
        const card = page.getByTestId("teacher-exam-mobile-result-card");
        const studentName = card.getByText(TEACHER_STUDENT_NAME, { exact: true });
        const resultAction = card.getByRole("link", { name: `${TEACHER_STUDENT_NAME} 결과 보기` });

        await expect(page.locator(".teacher-exam-results-table")).toBeHidden();
        for (const element of [title, summary, primaryAction, secondaryAction, studentName, resultAction]) {
            await expectWithinViewport(element, page);
        }
        await expectCopyWrapsWithoutClipping(title);
        await expectCopyWrapsWithoutClipping(studentName);
        await expectPrecedesInDom(title, summary);
        await expectPrecedesInDom(summary, primaryAction);
        await expectPrecedesInDom(primaryAction, secondaryAction);
        await expectPrecedesInDom(secondaryAction, card);
        await expectMinimumTouchTarget(primaryAction);
        await expectMinimumTouchTarget(secondaryAction);
        await expectMinimumTouchTarget(resultAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("student dashboard puts identity, status, and the next exam before history", async ({ page }) => {
        await seedStudentTaskFlow(page);
        await page.goto("/student/dashboard");

        const identity = page.getByRole("heading", { name: `${STUDENT_NAME}님,` });
        const status = page.getByText("오늘 1개의 시험이 기다리고 있어요.");
        const pendingTitle = page.getByText(PENDING_EXAM_TITLE, { exact: true });
        const primaryAction = page.getByRole("link", { name: "시작" });
        const historyAction = page.getByRole("link", { name: /나의 원시험 평균/ });

        for (const element of [identity, status, pendingTitle, primaryAction]) {
            await expectWithinViewport(element, page);
        }
        await expectCopyWrapsWithoutClipping(pendingTitle);
        await expectPrecedesInDom(primaryAction, historyAction);
        await expectAbove(primaryAction, historyAction);
        await expectMinimumTouchTarget(primaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("student history leads with identity and the latest review action", async ({ page }) => {
        await seedStudentTaskFlow(page);
        await page.goto("/student/history");

        const identity = page.getByText(`${STUDENT_NAME} · 아이폰 모바일 학습반`, { exact: true });
        const status = page.getByText("응시 완료 1회 · 재시험 회복 0회", { exact: true });
        const completedTitle = page.getByRole("heading", { name: COMPLETED_EXAM_TITLE });
        const primaryAction = page.locator(`a[href="/student/review/${STUDENT_ATTEMPT_ID}"]`);
        const secondarySummary = page.getByRole("region", { name: "시험 기록 요약" });

        for (const element of [identity, status, completedTitle, primaryAction]) {
            await expectWithinViewport(element, page);
        }
        await expectCopyWrapsWithoutClipping(completedTitle);
        await expectPrecedesInDom(primaryAction, secondarySummary);
        await expectAbove(primaryAction, secondarySummary);
        await expectMinimumTouchTarget(primaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });

    test("student review keeps score, recovery action, and long question copy in the task flow", async ({ page }) => {
        await seedStudentTaskFlow(page);
        await page.goto(`/student/review/${STUDENT_ATTEMPT_ID}`);

        const title = page.getByRole("heading", { name: COMPLETED_EXAM_TITLE });
        const status = page.getByText("50 / 100점", { exact: true });
        const primaryAction = page.getByRole("link", { name: "오답만" });
        const supportDisclosure = page.getByText("질문/해설", { exact: true });
        const longQuestionCopy = page.getByText("#내용 이해와 중심 생각 찾기", { exact: true });
        const answerWorkbench = page.locator(".student-review-content");

        for (const element of [title, status, primaryAction, longQuestionCopy]) {
            await expectWithinViewport(element, page);
        }
        await expectCopyWrapsWithoutClipping(title);
        await expectCopyWrapsWithoutClipping(longQuestionCopy);
        await expectPrecedesInDom(answerWorkbench, primaryAction);
        await expectPrecedesInDom(primaryAction, supportDisclosure);
        await expectAbove(primaryAction, supportDisclosure);
        await expectMinimumTouchTarget(primaryAction);
        await expectNoDocumentHorizontalOverflow(page);
    });
});
