import { expect, test, type Page } from "@playwright/test";
import { resetBrowserState } from "./helpers";

const GROUP_ID = "guard-class";
const GROUP_NAME = "가드반";
const ROSTER_NAME = "김 학생";
const ROSTER_ID = `${GROUP_ID}::${ROSTER_NAME}`;

async function seedRoster(page: Page) {
    await page.evaluate((seed) => {
        window.localStorage.setItem("omr_groups", JSON.stringify([
            { id: seed.groupId, name: seed.groupName, region: "서울", count: 1, avgScore: 0, color: "#4f46e5" },
            { id: "empty-class", name: "명단없는반", region: "서울", count: 0, avgScore: 0, color: "#ec4899" },
        ]));
        window.localStorage.setItem("omr_students", JSON.stringify([{
            id: seed.rosterId, name: seed.rosterName, email: "guard.student@example.com", group: seed.groupName,
            region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active",
        }]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
    }, { groupId: GROUP_ID, groupName: GROUP_NAME, rosterId: ROSTER_ID, rosterName: ROSTER_NAME });
}

async function storedCodeKeys(page: Page): Promise<string[]> {
    return page.evaluate(() => Object.keys(JSON.parse(window.localStorage.getItem("omr_student_codes") || "{}")).sort());
}

test.describe("student login form (local roster)", () => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "local roster login runs only against the isolated dev server");

    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
        await seedRoster(page);
    });

    test("shows all four fields up front and marks the student number required for a roster class", async ({ page }) => {
        await page.goto("/?role=student");
        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        const form = page.locator(".student-account-login-form");
        for (const label of ["이름", "반 선택", "학생번호 또는 이메일", "시작 코드"]) {
            await expect(form.getByLabel(label, { exact: true })).toBeVisible();
        }
        const boxes = await Promise.all(["#student-name", "#student-group", "#student-lookup", "#student-start-code"]
            .map(async selector => (await page.locator(selector).boundingBox())!.y));
        expect([...boxes].sort((a, b) => a - b)).toEqual(boxes);
        await expect(form.getByText("처음 로그인한다면 비워두세요. 로그인하면 새 코드를 알려드려요.")).toBeVisible();

        const lookupLabel = page.locator('label[for="student-lookup"]');
        await expect(lookupLabel.getByText("필수", { exact: true })).toHaveCount(0);
        await page.getByLabel("반 선택").selectOption(GROUP_ID);
        await expect(lookupLabel.getByText("필수", { exact: true })).toBeVisible();
        await page.getByLabel("반 선택").selectOption("empty-class");
        await expect(lookupLabel.getByText("필수", { exact: true })).toHaveCount(0);
    });

    test("a name typo in a roster class suggests the roster name instead of creating a new student", async ({ page }) => {
        await page.goto("/?role=student");
        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        const codesBefore = await storedCodeKeys(page);

        await page.getByLabel("이름").fill("김학생");
        await page.getByLabel("반 선택").selectOption(GROUP_ID);
        await page.getByRole("button", { name: "시험 시작하기" }).click();

        const guard = page.locator(".student-roster-name-guard");
        await expect(guard).toContainText("‘김학생’을(를) 이 반 명단에서 찾지 못했어요.");
        await expect(guard).toContainText("혹시 ‘김 학생’인가요?");
        await expect(page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" })).toHaveCount(0);
        await expect(page).toHaveURL(/\/\?role=student$/);
        expect(await storedCodeKeys(page)).toEqual(codesBefore);
        expect(await page.evaluate(() => window.sessionStorage.getItem("omr_student_session"))).toBeNull();

        await guard.getByRole("button", { name: "이 이름으로 바꾸기" }).click();
        await expect(page.getByLabel("이름")).toHaveValue(ROSTER_NAME);
        await expect(guard).toHaveCount(0);

        // The roster student is then asked for their student number, not given a new identity.
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("이 반 명단에 있는 학생이에요. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.")).toBeVisible();
        expect(await storedCodeKeys(page)).toEqual(codesBefore);
    });

    test("outside production a confirmed unrostered name still starts as a new student", async ({ page }) => {
        await page.goto("/?role=student");
        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        await page.getByLabel("이름").fill("최새학생");
        await page.getByLabel("반 선택").selectOption(GROUP_ID);
        await page.getByRole("button", { name: "시험 시작하기" }).click();

        const guard = page.locator(".student-roster-name-guard");
        await expect(guard).toContainText("‘최새학생’을(를) 이 반 명단에서 찾지 못했어요.");
        await expect(guard).not.toContainText("혹시");
        await guard.getByRole("button", { name: "명단에 없는 새 학생으로 시작" }).click();
        await expect(page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" })).toHaveCount(0);
        await guard.getByRole("button", { name: "새 학생으로 시작하기" }).click();

        const issuedCodeDialog = page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" });
        await expect(issuedCodeDialog).toBeVisible();
        expect(await storedCodeKeys(page)).toContain(`${GROUP_ID}::최새학생`);
    });
});
