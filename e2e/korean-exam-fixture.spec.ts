import { expect, test, type Page } from "@playwright/test";

const FIXTURE_EXAM = "[샘플] 2025학년도 수능 국어 언어와 매체";
const liveFixtureEnabled = process.env.RUN_KOREAN_EXAM_FIXTURE_E2E === "1";

async function loginTeacher(page: Page) {
    await page.goto("/?role=teacher");
    await page.getByRole("textbox", { name: "아이디 또는 이메일" }).fill("teacher1");
    await page.getByRole("textbox", { name: "비밀번호" }).fill("teacher1234");
    await page.getByRole("button", { name: "대시보드 입장" }).click();
    await expect(page).toHaveURL(/\/teacher\/dashboard$/, { timeout: 15_000 });
}

async function loginStudent(page: Page, student: {
    name: string;
    loginId: string;
    code: string;
}) {
    await page.goto("/?role=student&workspace=teacher_sharedqa");
    await page.getByRole("textbox", { name: "이름", exact: true }).fill(student.name);
    await page.getByRole("textbox", { name: "학생번호 또는 이메일" }).fill(student.loginId);
    await page.getByRole("combobox", { name: "반 선택" }).selectOption({ label: "테스트반 · 서울" });
    await page.getByRole("textbox", { name: "시작 코드" }).fill(student.code);
    await page.getByRole("button", { name: "시험 시작하기" }).click();
    await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
}

test.describe("live Korean exam Supabase fixture", () => {
    test.skip(!liveFixtureEnabled, "Set RUN_KOREAN_EXAM_FIXTURE_E2E=1 for the shared QA workspace.");

    test("teacher sees three distributed exams and three submissions", async ({ page }) => {
        await loginTeacher(page);

        await expect(page.getByLabel("데이터 동기화 상태")).toContainText("최신 데이터", { timeout: 20_000 });
        await expect(page.getByText("시험 3개, 제출 3건, 문항 135개 기준입니다.")).toBeVisible();
        await expect(page.getByText(FIXTURE_EXAM, { exact: true }).first()).toBeVisible();
        await expect(page.getByText("85점", { exact: true })).toBeVisible();
    });

    test("student 1 sees returned feedback, handwriting, and wrong-answer retake", async ({ page }) => {
        await loginStudent(page, { name: "학생 1", loginId: "student1", code: "ABC234" });

        await expect(page.getByText("76%", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
        await page.getByRole("link", { name: "복습", exact: true }).click();
        await expect(page.getByRole("heading", { name: FIXTURE_EXAM })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("교사 피드백", { exact: true })).toBeVisible();
        await expect(page.getByText("풀이 필기", { exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "오답만", exact: true })).toHaveAttribute("href", /questions=3%2C8%2C13%2C16%2C21%2C25%2C36%2C45/);
        await expect(page.getByText("problem.pdf", { exact: true })).toBeVisible({ timeout: 20_000 });
    });

    test("student 2 sees a 94-point result and a three-question retake", async ({ page }) => {
        await loginStudent(page, { name: "학생 2", loginId: "student2", code: "BCD345" });

        await expect(page.getByText("94%", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
        await page.getByRole("link", { name: "복습", exact: true }).click();
        await expect(page.getByText("오답", { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("link", { name: "오답만", exact: true })).toHaveAttribute("href", /questions=2%2C9%2C37/);
    });

    test("student 3 can open the private PDF, enter an answer, and use handwriting tools", async ({ page }) => {
        await loginStudent(page, { name: "학생 3", loginId: "student3", code: "CDE456" });

        await expect(page.getByText("미완료 과제").first()).toContainText("3", { timeout: 20_000 });
        await page.getByRole("link", { name: "시작", exact: true }).first().click();
        await page.getByRole("button", { name: "학생으로 시험 보기", exact: true }).click();
        await expect(page.getByText("problem.pdf", { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("toolbar", { name: "PDF 필기 도구" })).toBeVisible();
        await page.getByRole("button", { name: "답안지 펼치기", exact: true }).click();
        await page.getByRole("radio", { name: "문제 1번 보기 3", exact: true }).click();
        await expect(page.getByRole("radio", { name: "문제 1번 보기 3", exact: true })).toBeChecked();
    });
});
