import { test, expect, type Page } from "@playwright/test";

// Each test starts with a clean localStorage so mocks are deterministic.
async function clearStorage(page: Page) {
    await page.addInitScript(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });
}

test.describe("Teacher dashboard", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("loads and shows Quick Action tiles", async ({ page }) => {
        await page.goto("/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "Analytics Center" })).toBeVisible();
        await expect(page.getByText("Quick Action", { exact: false })).toBeVisible();
        // 6 Quick Action tiles
        for (const label of ["Create Exam", "Live Results", "Manage Users", "Analytics", "Settings", "Billing"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
    });

    test("Quick Action Live Results navigates to /teacher/live", async ({ page }) => {
        await page.goto("/teacher/dashboard");
        await page.getByRole("link", { name: /Live Results/ }).click();
        await expect(page).toHaveURL(/\/teacher\/live$/);
        await expect(page.getByRole("heading", { name: "실시간 결과" })).toBeVisible();
    });
});

test.describe("Live Results page", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("renders timer, stat tiles, students grid, heatmap", async ({ page }) => {
        await page.goto("/teacher/live");
        await expect(page.getByText("REMAINING TIME")).toBeVisible();
        // Stat labels
        for (const label of ["제출 완료", "응시 중", "미응시", "실시간 평균"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
        await expect(page.getByRole("heading", { name: "학생별 실시간 현황" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "문항별 정답률" })).toBeVisible();
    });

    test("pause button toggles label", async ({ page }) => {
        await page.goto("/teacher/live");
        const pauseBtn = page.getByRole("button", { name: "일시정지" });
        await expect(pauseBtn).toBeVisible();
        await pauseBtn.click();
        await expect(page.getByRole("button", { name: "재개" })).toBeVisible();
    });
});

test.describe("Manage Users page", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("renders tabs and student table with mock data", async ({ page }) => {
        await page.goto("/teacher/users");
        await expect(page.getByRole("heading", { name: "사용자 관리" })).toBeVisible();
        // Wait for hydration (table rows seed from localStorage on mount)
        const rows = page.locator("tbody tr");
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
    });

    test("bulk selection banner appears after checking boxes", async ({ page }) => {
        await page.goto("/teacher/users");
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await firstBox.check();
        await expect(page.getByText(/\d+명 선택됨/)).toBeVisible();
    });

    test("switching to groups tab shows group cards", async ({ page }) => {
        await page.goto("/teacher/users");
        await page.getByRole("button", { name: /반 · 그룹/ }).click();
        await expect(page.getByText("새 반 만들기")).toBeVisible();
    });
});

test.describe("Settings page", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("sidebar + profile section renders", async ({ page }) => {
        await page.goto("/teacher/settings");
        await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
        for (const label of ["프로필", "알림", "시험 기본값", "채점", "API 키", "테마", "보안"]) {
            await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        }
    });

    test("switching section updates panel", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await expect(page.getByText("언제, 어떤 방식으로 알림을 받을지 설정하세요.")).toBeVisible();
    });

    test("backup card shows export/import/reset buttons", async ({ page }) => {
        await page.goto("/teacher/settings");
        await expect(page.getByRole("button", { name: /내보내기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /가져오기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /전체 초기화/ })).toBeVisible();
    });
});

test.describe("Billing page", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    test("shows current plan hero + usage + plan grid + invoices", async ({ page }) => {
        await page.goto("/teacher/billing");
        await expect(page.getByRole("heading", { name: "결제 및 플랜" })).toBeVisible();
        await expect(page.getByText("CURRENT PLAN")).toBeVisible();
        await expect(page.getByRole("heading", { name: "이달 사용량" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "플랜 비교" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "결제 내역" })).toBeVisible();
    });

    test("monthly/yearly toggle changes prices", async ({ page }) => {
        await page.goto("/teacher/billing");
        const yearly = page.getByRole("button", { name: /연간/ });
        await yearly.click();
        // Pro plan yearly = 19000 * 12 * 0.8 = 182400
        await expect(page.getByText("₩182,400")).toBeVisible();
    });
});

test.describe("Global Search", () => {
    test.beforeEach(async ({ page }) => {
        await clearStorage(page);
    });

    // Search lives inside TeacherHeader, which is rendered on the 4 subpages
    // (live/users/settings/billing) — not on /teacher/dashboard.
    // Wait for the header search trigger to appear as a proxy for TeacherHeader
    // (and therefore GlobalSearch) being fully hydrated before pressing Cmd+K.
    test("Cmd+K opens modal and Escape closes", async ({ page }) => {
        await page.goto("/teacher/live");
        await expect(page.getByRole("button", { name: "빠른 검색" })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+K");
        await expect(page.getByPlaceholder(/빠른 검색/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByPlaceholder(/빠른 검색/)).not.toBeVisible();
    });

    test("typing filters results and Enter navigates", async ({ page }) => {
        await page.goto("/teacher/live");
        await expect(page.getByRole("button", { name: "빠른 검색" })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+K");
        await page.getByPlaceholder(/빠른 검색/).fill("결제");
        await expect(page.getByText("결제 및 플랜").first()).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/teacher\/billing/);
    });
});
