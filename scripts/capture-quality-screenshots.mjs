import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.QUALITY_SCREENSHOT_BASE_URL || "http://localhost:3003";
const outputDirectory = path.join(process.cwd(), "docs/quality/screenshots");

async function enterTeacherDemo(page) {
    await page.goto(baseURL);
    await page.getByRole("button", { name: /교사/ }).click();
    await page.getByRole("button", { name: "데모 계정으로 둘러보기" }).click();
    await page.waitForURL(/\/teacher\/dashboard/);
    await page.getByRole("heading", { name: /분석 센터|선생님/ }).first().waitFor();
}

async function captureTeacherSurfaces(browser) {
    const context = await browser.newContext({
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await enterTeacherDemo(page);
    await page.waitForTimeout(250);
    await page.screenshot({
        path: path.join(outputDirectory, "teacher-dashboard-desktop.png"),
        fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/create`);
    await page.getByRole("tab", { name: /^설정/ }).click();
    await page.getByLabel("시험 제목").fill("모바일 품질 검토 시험");
    await page.screenshot({
        path: path.join(outputDirectory, "create-mobile.png"),
        fullPage: true,
    });

    const pdfBytes = await readFile(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    await page.evaluate(({ pdfData }) => {
        const teacherSession = JSON.parse(sessionStorage.getItem("omr_teacher_session") || "null");
        const identityKey = String(
            teacherSession?.teacherId || teacherSession?.email || teacherSession?.displayName || "",
        ).trim().toLowerCase();
        let hash = 0x811c9dc5;
        for (let index = 0; index < identityKey.length; index += 1) {
            hash ^= identityKey.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        const organizationId = teacherSession?.organizationId
            || (identityKey ? `teacher_${(hash >>> 0).toString(36).padStart(7, "0")}` : "");
        if (!organizationId) throw new Error("Teacher showcase session is missing an organization scope");
        const exam = {
            id: "quality-review-exam",
            organizationId,
            title: "품질 검토 결과 시험",
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
            pdfData,
            accessConfig: { type: "public" },
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50, label: "개념" },
                { id: 2, number: 2, answer: 4, choices: 4, score: 50, label: "응용" },
            ],
        };
        const attempt = {
            id: "quality-review-attempt",
            examId: exam.id,
            organizationId,
            examTitle: exam.title,
            studentName: "검토 학생",
            studentId: "quality-review-student",
            studentProfileId: "quality-review-student",
            groupId: "quality-review-group",
            groupName: "품질 검토반",
            startedAt: "2026-07-29T00:00:00.000Z",
            finishedAt: "2026-07-29T00:10:00.000Z",
            score: 50,
            totalScore: 100,
            answers: { 1: 2, 2: 1 },
            status: "completed",
            handwritingArchived: true,
            handwritingPlan: "pro",
            questionDrawings: [{ questionId: 2, questionNumber: 2, page: 1, strokeCount: 1 }],
            studentQuestions: [{
                questionId: 2,
                questionNumber: 2,
                body: "2번 오답 근거를 알려주세요.",
                createdAt: "2026-07-29T00:11:00.000Z",
                status: "queued",
            }],
        };
        localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
        localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
    }, { pdfData: `data:application/pdf;base64,${pdfBytes.toString("base64")}` });
    await page.goto(`${baseURL}/teacher/attempt/quality-review-attempt`);
    await page.getByRole("heading", { name: "검토 학생" }).waitFor();
    await page.getByRole("tab", { name: "답안" }).waitFor();
    await page.screenshot({
        path: path.join(outputDirectory, "review-mobile.png"),
        fullPage: true,
    });
    await context.close();
}

async function captureSolveSurface(browser) {
    const context = await browser.newContext({ viewport: { width: 834, height: 1112 } });
    const pdfBytes = await readFile(path.join(process.cwd(), "e2e/fixtures/sample-problem.pdf"));
    await context.addInitScript(({ pdfData }) => {
        const exam = {
            id: "quality-solve-exam",
            title: "태블릿 품질 검토 시험",
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
            durationMin: 30,
            pdfData,
            accessConfig: { type: "public" },
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 25 },
                { id: 2, number: 2, answer: 4, choices: 4, score: 25 },
                { id: 3, number: 3, answer: 1, choices: 5, score: 25 },
                { id: 4, number: 4, answer: 3, choices: 5, score: 25 },
            ],
        };
        localStorage.setItem(`omr_exam_${exam.id}`, JSON.stringify(exam));
    }, { pdfData: `data:application/pdf;base64,${pdfBytes.toString("base64")}` });
    const page = await context.newPage();
    await page.goto(`${baseURL}/solve/quality-solve-exam`);
    const dialog = page.getByRole("dialog", { name: "시험 입장 확인" });
    await dialog.getByRole("textbox", { name: "게스트 이름" }).fill("검토 학생");
    await dialog.getByRole("button", { name: "게스트로 시험 보기" }).click();
    const rail = page.locator(".solve-omr-rail-button");
    await rail.waitFor();
    await rail.click();
    await page.locator(".solve-omr-scroll .omr-cardview-title").waitFor();
    await page.locator("#solve-omr-pane").evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    });
    await page.screenshot({
        path: path.join(outputDirectory, "solve-tablet.png"),
        fullPage: true,
    });
    await context.close();
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    await captureTeacherSurfaces(browser);
    await captureSolveSurface(browser);
} finally {
    await browser.close();
}

console.log(`Quality screenshots captured in ${outputDirectory}`);
