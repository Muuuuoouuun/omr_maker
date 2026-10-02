import { expect, test, type Page } from "@playwright/test";
import { resetBrowserState } from "./helpers";

test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "local guest fixture must never target an external server");

const STUDENT_ID = "todo-sections-student";
// 2026-10-01 (목) 12:00 KST
const NOW = "2026-10-01T03:00:00.000Z";

type SeedExam = { id: string; startAt?: string; endAt?: string };

async function seedDashboard(page: Page, exams: SeedExam[]) {
    await page.addInitScript(({ studentId, seeds }) => {
        const session = {
            studentId,
            loginId: `guest-${studentId}`,
            name: "할일 학생",
            groupId: "todo-sections-group",
            groupName: "할일반",
            isGuest: true,
            guestId: studentId,
            identityType: "guest",
        };
        for (const seed of seeds) {
            window.localStorage.setItem(`omr_exam_${seed.id}`, JSON.stringify({
                id: seed.id,
                title: `${seed.id} 시험`,
                createdAt: "2026-09-01T00:00:00.000Z",
                ...(seed.startAt ? { startAt: seed.startAt } : {}),
                ...(seed.endAt ? { endAt: seed.endAt } : {}),
                accessConfig: { type: "public", groupIds: [] },
                questions: [{ id: 1, number: 1, answer: 1, choices: 5, score: 10 }],
            }));
        }
        window.localStorage.setItem("omr_attempts", "[]");
        window.localStorage.setItem("omr_guest_id", studentId);
        window.localStorage.setItem("omr_student_session_backup", JSON.stringify(session));
        window.sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    }, { studentId: STUDENT_ID, seeds: exams });
}

const rowIds = (page: Page, section: string) => page
    .locator(`[data-assignment-section="${section}"] [data-testid="student-assignment-row"]`)
    .evaluateAll(rows => rows.map(row => row.getAttribute("data-assignment-id")));

test("student todo list splits open, scheduled, and closed exams with KST deadlines", async ({ page, context }) => {
    await page.clock.install({ time: new Date(NOW) });
    await resetBrowserState(page, context);
    const started = "2026-09-30T00:00:00.000Z";
    await seedDashboard(page, [
        { id: "open-no-deadline", startAt: started },
        { id: "open-later", startAt: started, endAt: "2026-10-12T03:00:00.000Z" },
        { id: "open-week", startAt: started, endAt: "2026-10-03T14:59:00.000Z" },
        { id: "open-tomorrow", startAt: started, endAt: "2026-10-02T09:00:00.000Z" },
        { id: "open-today", startAt: started, endAt: "2026-10-01T09:00:00.000Z" },
        { id: "scheduled-later", startAt: "2026-10-05T00:00:00.000Z", endAt: "2026-10-06T00:00:00.000Z" },
        { id: "scheduled-sooner", startAt: "2026-10-03T00:00:00.000Z", endAt: "2026-10-04T00:00:00.000Z" },
        { id: "closed-long-ago", startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-10T00:00:00.000Z" },
        { id: "closed-yesterday", startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T09:00:00.000Z" },
    ]);
    await page.goto("/student/dashboard");

    const headline = page.locator(".student-dashboard-headline");
    await expect(headline).toHaveText("지금 풀 수 있는 시험이 5개 있어요. 그중 1개는 오늘 마감이에요.");
    await expect(page.locator(".student-assignment-open-count")).toHaveText("5");
    await expect(page.getByRole("link", { name: "지난 기록 보기 →" })).toHaveAttribute("href", "/student/history");

    const open = page.locator('[data-assignment-section="open"]');
    await expect(open.getByRole("heading", { name: /^지금 풀 수 있어요\s*5$/ })).toBeVisible();
    expect(await rowIds(page, "open")).toEqual([
        "open-today",
        "open-tomorrow",
        "open-week",
        "open-later",
        "open-no-deadline",
    ]);
    const meta = (id: string) => page.locator(`[data-assignment-id="${id}"] .student-assignment-meta`);
    await expect(meta("open-today").locator(".status-pill.is-warning")).toHaveText("오늘 18:00 마감");
    await expect(meta("open-tomorrow")).toContainText("내일 18:00 마감");
    await expect(meta("open-week")).toContainText("10/3(토) 23:59 마감 · D-2");
    await expect(meta("open-later")).toContainText("10/12(월) 마감");
    await expect(meta("open-no-deadline")).not.toContainText("마감");
    await expect(open.getByRole("link", { name: "시작" })).toHaveCount(5);

    const scheduled = page.locator('[data-assignment-section="scheduled"]');
    await expect(scheduled.getByRole("heading", { name: /^예정\s*2$/ })).toBeVisible();
    expect(await rowIds(page, "scheduled")).toEqual(["scheduled-sooner", "scheduled-later"]);
    await expect(meta("scheduled-sooner")).toContainText("10/3(토) 09:00 시작");
    await expect(scheduled.getByRole("link")).toHaveCount(0);

    const closed = page.locator('details[data-assignment-section="closed"]');
    await expect(closed).not.toHaveAttribute("open", "");
    await expect(closed.locator("summary")).toContainText(/마감된 과제\s*2/);
    await expect(page.locator('[data-assignment-id="closed-yesterday"]')).toBeHidden();
    await closed.locator("summary").click();
    expect(await rowIds(page, "closed")).toEqual(["closed-yesterday", "closed-long-ago"]);
    await expect(closed.getByText("미응시 마감", { exact: true })).toHaveCount(2);
    await expect(closed.locator('a[href^="/solve/"]')).toHaveCount(0);
});

test("student headline names the next start when nothing is open yet", async ({ page, context }) => {
    await page.clock.install({ time: new Date(NOW) });
    await resetBrowserState(page, context);
    await seedDashboard(page, [
        { id: "starts-saturday", startAt: "2026-10-03T00:00:00.000Z", endAt: "2026-10-04T00:00:00.000Z" },
        { id: "already-closed", startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-09-30T09:00:00.000Z" },
    ]);
    await page.goto("/student/dashboard");

    await expect(page.locator(".student-dashboard-headline")).toHaveText("다음 시험은 10/3(토) 09:00에 시작해요.");
    await expect(page.locator(".student-assignment-open-count")).toHaveCount(0);
    await expect(page.locator('[data-assignment-section="open"]')).toHaveCount(0);
    await expect(page.locator('[data-assignment-section="scheduled"] [data-assignment-id="starts-saturday"]')).toBeVisible();
    await expect(page.locator('details[data-assignment-section="closed"]')).toContainText(/마감된 과제\s*1/);
});
