import { expect, test, type Page } from "@playwright/test";
import { continueSolveEntryIfPresent } from "./helpers";

const EXAM_ID = "solve-submit-confirm-exam";
const QUESTION_COUNT = 12;

async function seedSubmitConfirmSolve(page: Page) {
    await page.addInitScript(({ examId, questionCount }) => {
        if (window.sessionStorage.getItem("solve-submit-confirm-seeded") === "1") return;
        try { window.localStorage.clear(); } catch {}
        const session = {
            studentId: "solve-submit-confirm-student",
            loginId: "solve-submit-confirm-student",
            name: "제출확인학생",
            groupId: "solve-submit-confirm-group",
            groupName: "제출확인반",
            isGuest: false,
            identityType: "temporary",
        };
        const exam = {
            id: examId,
            title: "빈 문항 제출 확인 시험",
            createdAt: "2026-10-01T00:00:00.000Z",
            accessConfig: { type: "public", groupIds: [] },
            questions: Array.from({ length: questionCount }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: 2,
                choices: 5,
                score: 5,
            })),
        };
        window.localStorage.setItem(`omr_exam_${examId}`, JSON.stringify(exam));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
        window.sessionStorage.setItem("solve-submit-confirm-seeded", "1");
    }, { examId: EXAM_ID, questionCount: QUESTION_COUNT });
}

async function openSolve(page: Page) {
    await seedSubmitConfirmSolve(page);
    await page.goto(`/solve/${EXAM_ID}`);
    await continueSolveEntryIfPresent(page);
    await expect(page.getByRole("button", { name: "제출하기" })).toBeVisible({ timeout: 20_000 });
    const expandSheet = page.getByRole("banner").getByRole("button", { name: "답안지 펼치기" });
    if (await expandSheet.isVisible()) await expandSheet.click();
    await expect(page.getByRole("radio", { name: "문제 1번 보기 2" })).toBeVisible();
}

async function answer(page: Page, questionNumbers: number[]) {
    for (const number of questionNumbers) {
        await page.getByRole("radio", { name: `문제 ${number}번 보기 2` }).dispatchEvent("click");
    }
    await expect(page.locator(".solve-progress")).toContainText(`${questionNumbers.length}/${QUESTION_COUNT}`);
}

test.describe("submit confirmation lists blank questions", () => {
    test("names each blank question and jumps to the first one", async ({ page }) => {
        await openSolve(page);
        await answer(page, [1, 2, 4, 5, 6, 8, 9, 10, 11]);

        await page.locator(".solve-submit-button").click();
        const dialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("3, 7, 12번 문항이 비어 있어요. 그대로 제출할까요?");
        await expect(dialog.getByRole("button", { name: "제출하기" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "계속 풀기" })).toHaveCount(0);

        await dialog.getByRole("button", { name: "빈 문항으로 이동" }).click();
        await expect(dialog).toBeHidden();
        const firstBlank = page.getByRole("button", { name: "3번 문항으로 이동" });
        await expect(firstBlank).toHaveAttribute("aria-current", "true");
        await expect(firstBlank).toBeFocused();
        await expect(page.getByRole("radio", { name: "문제 3번 보기 2" })).toBeVisible();
    });

    test("shortens a long blank list after eight numbers", async ({ page }) => {
        await openSolve(page);
        await answer(page, [1, 2]);

        await page.locator(".solve-submit-button").click();
        const dialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(dialog).toContainText("3, 4, 5, 6, 7, 8, 9, 10번 외 2문항이 비어 있어요. 그대로 제출할까요?");
    });

    test("keeps 계속 풀기 when every question is answered", async ({ page }) => {
        await openSolve(page);
        await answer(page, Array.from({ length: QUESTION_COUNT }, (_, index) => index + 1));

        await page.locator(".solve-submit-button").click();
        const dialog = page.getByRole("dialog", { name: "답안 제출" });
        await expect(dialog).toContainText(`전체 ${QUESTION_COUNT}문항 답안을 모두 선택했습니다.`);
        await expect(dialog.getByRole("button", { name: "계속 풀기" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "빈 문항으로 이동" })).toHaveCount(0);
    });
});
