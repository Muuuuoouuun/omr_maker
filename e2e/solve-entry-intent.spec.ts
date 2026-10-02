import { expect, test, type Page } from "@playwright/test";
import { resetBrowserState } from "./helpers";

const EXAM_ID = "solve-entry-intent-exam";
const EXAM_TITLE = "입장 확인 생략 시험";
const GROUP_ID = "entry-class";
const GROUP_NAME = "입장반";
const STUDENT_NAME = "입장학생";
const STUDENT_ID = `${GROUP_ID}::${STUDENT_NAME}`;
const ENTRY_DIALOG = "시험 입장 확인";

/** Records every entry dialog that ever mounts, so a one-frame flash also fails. */
async function watchEntryDialogs(page: Page) {
    await page.addInitScript((dialogName) => {
        const w = window as typeof window & { __entryDialogSeen?: number };
        w.__entryDialogSeen = 0;
        const observer = new MutationObserver(() => {
            const found = [...document.querySelectorAll('[role="dialog"]')]
                .some(element => element.textContent?.includes(dialogName));
            if (found) w.__entryDialogSeen = (w.__entryDialogSeen || 0) + 1;
        });
        const start = () => observer.observe(document.documentElement, { childList: true, subtree: true });
        if (document.documentElement) start();
        else document.addEventListener("DOMContentLoaded", start);
    }, ENTRY_DIALOG);
}

async function entryDialogSeenCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as typeof window & { __entryDialogSeen?: number }).__entryDialogSeen || 0);
}

async function seedExamAndRoster(page: Page) {
    await page.evaluate((seed) => {
        window.localStorage.setItem("omr_groups", JSON.stringify([{
            id: seed.groupId, name: seed.groupName, region: "서울", count: 1, avgScore: 0, color: "#4f46e5",
        }]));
        window.localStorage.setItem("omr_students", JSON.stringify([{
            id: seed.studentId, name: seed.studentName, email: "entry.student@example.com", group: seed.groupName,
            region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active",
        }]));
        window.localStorage.setItem("omr_attempts", JSON.stringify([]));
        window.localStorage.setItem(`omr_exam_${seed.examId}`, JSON.stringify({
            id: seed.examId,
            title: seed.examTitle,
            createdAt: "2026-10-01T00:00:00.000Z",
            durationMin: 35,
            accessConfig: { type: "public", groupIds: [] },
            questions: [1, 2, 3].map(number => ({ id: number, number, answer: 2, choices: 5, score: 10 })),
        }));
    }, {
        examId: EXAM_ID, examTitle: EXAM_TITLE, groupId: GROUP_ID, groupName: GROUP_NAME,
        studentId: STUDENT_ID, studentName: STUDENT_NAME,
    });
}

async function loginStudent(page: Page, nextPath?: string) {
    await page.goto(nextPath ? `/?role=student&next=${encodeURIComponent(nextPath)}` : "/?role=student");
    await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
    await page.getByLabel("이름").fill(STUDENT_NAME);
    await page.getByLabel("학생번호 또는 이메일").fill("entry.student@example.com");
    await page.getByLabel("반 선택").selectOption(GROUP_ID);
    await page.getByRole("button", { name: "시험 시작하기" }).click();
    const issuedCodeDialog = page.getByRole("dialog", { name: "시작 코드가 발급되었습니다" });
    await expect(issuedCodeDialog).toBeVisible();
    await issuedCodeDialog.getByRole("button", { name: "저장했어요, 계속" }).click();
}

async function studentCookie(page: Page) {
    const cookies = await page.context().cookies();
    return cookies.find(cookie => cookie.name === "omr_student_server_session");
}

test.describe("solve entry confirmation only where the choice was not made", () => {
    test.beforeEach(async ({ page, context }) => {
        await resetBrowserState(page, context);
        await seedExamAndRoster(page);
    });

    test("dashboard 시작 opens the exam with no entry dialog and shows the time limit on the card", async ({ page }) => {
        await loginStudent(page);
        await expect(page).toHaveURL(/\/student\/dashboard$/);
        const row = page.getByTestId("student-assignment-row").filter({ hasText: EXAM_TITLE });
        await expect(row).toContainText("제한 시간 35분");

        await watchEntryDialogs(page);
        await page.reload();
        const start = page.getByTestId("student-assignment-row").filter({ hasText: EXAM_TITLE }).getByRole("link", { name: "시작" });
        await expect(start).toBeVisible();
        await start.click();

        await expect(page).toHaveURL(new RegExp(`/solve/${EXAM_ID}`));
        await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await entryDialogSeenCount(page)).toBe(0);
        // One-shot: the intent is gone once used.
        expect(await page.evaluate(() => window.sessionStorage.getItem("omr_solve_entry_intent_v1"))).toBeNull();
    });

    test("logging in with next= set to the exam opens it directly", async ({ page }) => {
        await watchEntryDialogs(page);
        await loginStudent(page, `/solve/${EXAM_ID}`);
        await expect(page).toHaveURL(new RegExp(`/solve/${EXAM_ID}`));
        await expect(page.locator(".solve-body")).toBeVisible({ timeout: 20_000 });
        expect(await entryDialogSeenCount(page)).toBe(0);
    });

    test("a direct link still confirms who is logged in, and 내가 아니에요 signs out before the login page", async ({ page }) => {
        await loginStudent(page);
        await expect(page).toHaveURL(/\/student\/dashboard$/);
        expect(await studentCookie(page)).toBeTruthy();

        await page.goto(`/solve/${EXAM_ID}`);
        const dialog = page.getByRole("dialog", { name: ENTRY_DIALOG });
        await expect(dialog).toBeVisible({ timeout: 20_000 });
        await expect(dialog).toContainText(`현재 로그인: ${STUDENT_NAME}`);
        await expect(dialog).toContainText("3문항 · 제한 시간 35분");
        await expect(dialog.getByRole("button", { name: "학생으로 시험 보기" })).toBeVisible();
        // Guest entry is folded away while a student is logged in.
        await expect(dialog.getByRole("button", { name: "게스트로 시험 보기" })).toBeHidden();
        await dialog.getByText("게스트로 보기", { exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "게스트 이름" })).toHaveAttribute("placeholder", "이름 (선생님 화면에 표시돼요)");

        await dialog.getByRole("button", { name: "내가 아니에요 · 다른 학생으로 로그인" }).click();
        await expect(page).toHaveURL(new RegExp(`/\\?role=student&next=${encodeURIComponent(`/solve/${EXAM_ID}`)}`));
        await expect(page.getByRole("heading", { name: "학습 시작" })).toBeVisible();
        expect(await studentCookie(page)).toBeUndefined();
        expect(await page.evaluate(() => window.sessionStorage.getItem("omr_student_session"))).toBeNull();
        // Without the cookie the login page must not bounce back to the exam.
        await page.waitForTimeout(1_500);
        await expect(page).not.toHaveURL(/\/solve\//);
    });

    test("closing the entry dialog returns a logged-in student to the dashboard", async ({ page }) => {
        await loginStudent(page);
        await expect(page).toHaveURL(/\/student\/dashboard$/);
        await page.goto(`/solve/${EXAM_ID}`);
        const dialog = page.getByRole("dialog", { name: ENTRY_DIALOG });
        await expect(dialog).toBeVisible({ timeout: 20_000 });
        await dialog.getByRole("button", { name: "닫기" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);
    });

    test("closing the entry dialog without a login returns to the student home", async ({ page }) => {
        await page.goto(`/solve/${EXAM_ID}`);
        const dialog = page.getByRole("dialog", { name: ENTRY_DIALOG });
        await expect(dialog).toBeVisible({ timeout: 20_000 });
        await expect(dialog.getByRole("button", { name: "게스트로 시험 보기" })).toBeVisible();
        await expect(dialog.getByRole("link", { name: "학생 로그인으로 보기" })).toBeVisible();
        await dialog.getByRole("button", { name: "닫기" }).click();
        await expect(page).toHaveURL(/\/\?role=student$/);
    });
});
