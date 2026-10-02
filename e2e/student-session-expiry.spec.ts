import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resetBrowserState } from "./helpers";

const GROUP_ID = "return-class";
const GROUP_NAME = "재방문반";
const STUDENT_NAME = "박재방문";
const STUDENT_ID = `${GROUP_ID}::${STUDENT_NAME}`;
const EXAM_ID = "session-expiry-exam";
const EXAM_TITLE = "세션 만료 복귀 시험";
const HINT_KEY = "omr_student_return_hint_v1";
const STUDENT_COOKIE = "omr_student_server_session";

async function seedClassAndExam(page: Page) {
    await page.evaluate((seed) => {
        window.localStorage.setItem("omr_groups", JSON.stringify([{
            id: seed.groupId, name: seed.groupName, region: "서울", count: 0, avgScore: 0, color: "#4f46e5",
        }]));
        window.localStorage.setItem("omr_students", JSON.stringify([]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem(`omr_exam_${seed.examId}`, JSON.stringify({
            id: seed.examId,
            title: seed.examTitle,
            createdAt: "2026-10-01T00:00:00.000Z",
            durationMin: 30,
            accessConfig: { type: "public", groupIds: [] },
            questions: [1, 2, 3].map(number => ({ id: number, number, answer: 2, choices: 5, score: 10 })),
        }));
    }, { groupId: GROUP_ID, groupName: GROUP_NAME, examId: EXAM_ID, examTitle: EXAM_TITLE });
}

/**
 * The isolated dev server has no Supabase gateway, so student actions answer
 * "degraded_local" even without a cookie. Once the cookie is gone, answer the
 * way the production boundary does: unauthenticated.
 */
async function simulateServerSessionBoundary(page: Page) {
    await page.route("**/*", async route => {
        const request = route.request();
        const isAction = request.method() === "POST" && !!request.headers()["next-action"];
        const hasStudentCookie = (request.headers().cookie || "").includes(`${STUDENT_COOKIE}=`);
        if (!isAction || hasStudentCookie) {
            await route.continue();
            return;
        }
        const response = await route.fetch();
        const body = await response.text();
        await route.fulfill({ response, body: body.replaceAll('"degraded_local"', '"unauthenticated"') });
    });
}

async function rememberedLogin(page: Page): Promise<string> {
    await page.goto("/?role=student");
    await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
    await page.getByLabel("이름").fill(STUDENT_NAME);
    await page.getByLabel("반 선택").selectOption(GROUP_ID);
    await page.getByLabel("이 기기에서 내 정보 기억하기").check();
    await page.getByRole("button", { name: "시험 시작하기" }).click();
    const issuedCodeDialog = page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" });
    await expect(issuedCodeDialog).toBeVisible();
    await issuedCodeDialog.getByRole("button", { name: "저장했어요, 계속" }).click();
    await expect(page).toHaveURL(/\/student\/dashboard$/);

    const code = await page.evaluate((studentId) => (
        JSON.parse(window.localStorage.getItem("omr_student_codes") || "{}")[studentId] as string
    ), STUDENT_ID);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const rawHint = await page.evaluate((key) => window.localStorage.getItem(key), HINT_KEY);
    expect(JSON.parse(rawHint || "null")).toMatchObject({ name: STUDENT_NAME, groupId: GROUP_ID, groupName: GROUP_NAME });
    // Name and class only: never the start code, the student id or the cookie.
    expect(rawHint).not.toContain(code);
    expect(rawHint).not.toContain(STUDENT_ID);
    return code;
}

async function expireServerSession(context: BrowserContext) {
    await context.clearCookies();
    expect((await context.cookies()).some(cookie => cookie.name === STUDENT_COOKIE)).toBe(false);
}

async function reenterStartCode(page: Page, code: string) {
    await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
    await expect(page.getByText(`${STUDENT_NAME}님, 다시 오셨네요. 시작 코드를 입력하면 이어서 할 수 있어요.`)).toBeVisible();
    await expect(page.getByLabel("이름")).toHaveValue(STUDENT_NAME);
    await expect(page.getByLabel("반 선택")).toHaveValue(GROUP_ID);
    await expect(page.getByLabel("시작 코드")).toBeFocused();
    await expect(page.getByLabel("이 기기에서 내 정보 기억하기")).toBeChecked();
    await page.getByLabel("시작 코드").fill(code);
    await page.getByRole("button", { name: "시험 시작하기" }).click();
}

test.describe("student session expiry and return", () => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "the session boundary simulation runs only against the isolated dev server");

    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
        await seedClassAndExam(page);
    });

    test("an expired dashboard session explains itself and re-login returns to the dashboard", async ({ page, context }) => {
        const code = await rememberedLogin(page);
        await expireServerSession(context);
        await simulateServerSessionBoundary(page);

        await page.goto("/student/dashboard");
        await expect(page.getByRole("heading", { name: "로그인 시간이 끝났어요" })).toBeVisible();
        await expect(page.getByText("보안을 위해 12시간이 지나면 다시 확인해요. 시작 코드만 다시 입력하면 이어서 할 수 있어요.")).toBeVisible();
        await expect(page.getByRole("heading", { name: "학생 로그인이 필요합니다" })).toHaveCount(0);

        await page.getByRole("link", { name: "다시 로그인" }).click();
        await expect(page).toHaveURL(/\/\?role=student&reason=expired&next=%2Fstudent%2Fdashboard$/);
        await reenterStartCode(page, code);

        await expect(page).toHaveURL(/\/student\/dashboard$/);
        await expect(page.getByRole("heading", { name: `${STUDENT_NAME}님,` })).toBeVisible();
    });

    test("an expired session on an exam link returns to that exam after re-login", async ({ page, context }) => {
        const code = await rememberedLogin(page);
        await expireServerSession(context);
        await simulateServerSessionBoundary(page);

        await page.goto(`/solve/${EXAM_ID}`);
        await expect(page.getByRole("heading", { name: "세션을 확인하지 못했습니다" })).toBeVisible();
        await page.getByRole("link", { name: "다시 로그인" }).click();
        await expect(page).toHaveURL(new RegExp(`/\\?role=student&reason=expired&next=%2Fsolve%2F${EXAM_ID}$`));
        await reenterStartCode(page, code);

        await expect(page).toHaveURL(new RegExp(`/solve/${EXAM_ID}$`));
        await expect(page.getByText(EXAM_TITLE).first()).toBeVisible();
    });

    test("recent student 이어가기 checks the server first and falls back to a pre-filled login", async ({ page, context }) => {
        const code = await rememberedLogin(page);
        await expireServerSession(context);

        await page.goto("/");
        await page.getByRole("button", { name: "이어가기" }).click();
        await reenterStartCode(page, code);
        await expect(page).toHaveURL(/\/student\/dashboard$/);
    });

    test("다른 학생이에요 forgets the remembered name and class", async ({ page, context }) => {
        await rememberedLogin(page);
        await expireServerSession(context);

        await page.goto("/?role=student&reason=expired&next=%2Fstudent%2Fdashboard");
        await expect(page.getByLabel("이름")).toHaveValue(STUDENT_NAME);
        await page.getByRole("button", { name: "다른 학생이에요" }).click();
        await expect(page.getByLabel("이름")).toHaveValue("");
        await expect(page.getByLabel("반 선택")).toHaveValue("");
        expect(await page.evaluate((key) => window.localStorage.getItem(key), HINT_KEY)).toBeNull();
    });

    test("logout forgets the remembered name and class", async ({ page }) => {
        await rememberedLogin(page);
        await page.getByRole("button", { name: "로그아웃", exact: true }).click();
        await expect(page).toHaveURL(/\/$/);
        expect(await page.evaluate((key) => window.localStorage.getItem(key), HINT_KEY)).toBeNull();
    });
});
