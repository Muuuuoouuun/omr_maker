import { test, expect, type Page } from "@playwright/test";
import { openTeacherPage, resetBrowserState } from "./helpers";

// Each test starts with a clean localStorage so mocks are deterministic.
async function clearStorage(page: Page, context: Parameters<typeof resetBrowserState>[1]) {
    await resetBrowserState(page, context);
}

async function seedStoredRoster(page: Page) {
    await page.evaluate(() => {
        window.localStorage.setItem("omr_groups", JSON.stringify([{
            id: "e2e-class-a",
            name: "E2E A반",
            region: "서울",
            count: 2,
            avgScore: 0,
            color: "#4f46e5",
        }]));
        window.localStorage.setItem("omr_students", JSON.stringify([
            {
                id: "e2e-class-a::김학생",
                name: "김학생",
                email: "kim.student@example.com",
                group: "E2E A반",
                region: "서울",
                avatar: "#4f46e5",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat",
                status: "active",
            },
            {
                id: "e2e-class-a::이학생",
                name: "이학생",
                email: "lee.student@example.com",
                group: "E2E A반",
                region: "서울",
                avatar: "#10b981",
                avgScore: 0,
                examsTaken: 0,
                lastActive: "기록 없음",
                trend: "flat",
                status: "active",
            },
        ]));
    });
}

test.describe("Teacher dashboard", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    test("loads and shows Quick Action tiles", async ({ page }) => {
        await openTeacherPage(page, "/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "Analytics Center" })).toBeVisible();
        await expect(page.getByText("Quick Action", { exact: false })).toBeVisible();
        // 6 Quick Action tiles
        for (const label of ["Create Exam", "Live Results", "Manage Users", "Analytics", "Settings", "Billing"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
    });

    test("Quick Action Live Results navigates to /teacher/live", async ({ page }) => {
        await openTeacherPage(page, "/teacher/dashboard");
        await page.getByRole("link", { name: /Live Results/ }).click();
        await expect(page).toHaveURL(/\/teacher\/live$/);
        await expect(page.getByRole("heading", { name: "응시 결과 확인" })).toBeVisible();
    });
});

test.describe("Live Results page", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    test("renders timer, stat tiles, students grid, heatmap", async ({ page }) => {
        await openTeacherPage(page, "/teacher/live");
        await expect(page.getByText("REMAINING TIME")).toBeVisible();
        // Stat labels
        for (const label of ["제출 완료", "응시 중", "미응시", "제출 평균"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
        await expect(page.getByRole("heading", { name: "학생별 제출 현황" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "문항별 정답률" })).toBeVisible();
    });

    test("pause button toggles label", async ({ page }) => {
        await openTeacherPage(page, "/teacher/live");
        const pauseBtn = page.getByRole("button", { name: "일시정지" });
        await expect(pauseBtn).toBeVisible();
        await pauseBtn.click();
        await expect(page.getByRole("button", { name: "재개" })).toBeVisible();
    });
});

test.describe("Manage Users page", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    test("renders tabs and student table with mock data", async ({ page }) => {
        await openTeacherPage(page, "/teacher/users");
        await expect(page.getByRole("heading", { name: "사용자 관리" })).toBeVisible();
        // Wait for hydration (table rows seed from localStorage on mount)
        const rows = page.locator("tbody tr");
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
    });

    test("bulk selection banner appears after checking boxes", async ({ page }) => {
        await seedStoredRoster(page);
        await openTeacherPage(page, "/teacher/users");
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await firstBox.check();
        await expect(page.getByText(/\d+명 선택됨/)).toBeVisible();
    });

    test("switching to groups tab shows group cards", async ({ page }) => {
        await openTeacherPage(page, "/teacher/users");
        await page.getByRole("button", { name: /반 · 그룹/ }).click();
        await expect(page.getByText("새 반 만들기")).toBeVisible();
    });

    test("issued student start code gates the student portal login", async ({ page }) => {
        await seedStoredRoster(page);
        await openTeacherPage(page, "/teacher/users");

        const studentRow = page.locator('tbody tr:has-text("kim.student@example.com")');
        await expect(studentRow).toHaveCount(1);
        await studentRow.click();
        await expect(page.getByText("학생 상세")).toBeVisible();
        await expect(page.getByTestId("student-start-code-value")).toHaveText("미발급");

        await page.getByTestId("issue-student-start-code").click();
        const issuedCode = (await page.getByTestId("student-start-code-value").innerText()).trim();
        expect(issuedCode).toMatch(/^[A-Z2-9]{6}$/);

        const storedCodes = await page.evaluate(() => JSON.parse(window.localStorage.getItem("omr_student_codes") || "{}"));
        expect(storedCodes["e2e-class-a::김학생"]).toBe(issuedCode);

        await page.goto("/?role=student");
        await expect(page.getByText("학생 포털")).toBeVisible();
        await page.getByLabel("이름").fill("김학생");
        await page.getByLabel("학생번호 또는 이메일").fill("kim.student@example.com");
        await page.getByLabel("반 선택").selectOption("e2e-class-a");
        await expect(page.getByLabel("시작 코드")).toBeVisible();

        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page.getByText("이미 등록된 학생입니다. 선생님이 발급한 시작 코드를 입력해주세요.")).toBeVisible();

        await page.getByLabel("시작 코드").fill(issuedCode);
        await page.getByRole("button", { name: "시험 시작하기" }).click();
        await expect(page).toHaveURL(/\/student\/dashboard$/);

        const session = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("omr_student_session") || "null"));
        expect(session).toMatchObject({
            studentId: "e2e-class-a::김학생",
            loginId: "e2e-class-a::김학생",
            name: "김학생",
            groupId: "e2e-class-a",
            groupName: "E2E A반",
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        });
    });
});

test.describe("Settings page", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    test("sidebar + profile section renders", async ({ page }) => {
        await openTeacherPage(page, "/teacher/settings");
        await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
        for (const label of ["프로필", "알림", "시험 기본값", "채점", "API 키", "테마", "보안"]) {
            await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        }
    });

    test("switching section updates panel", async ({ page }) => {
        await openTeacherPage(page, "/teacher/settings");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await expect(page.getByText("카카오 우선 채널을 기준으로 알림 대상을 관리합니다.")).toBeVisible();
    });

    test("backup card shows export/import/reset buttons", async ({ page }) => {
        await openTeacherPage(page, "/teacher/settings");
        await expect(page.getByRole("button", { name: /내보내기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /가져오기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /전체 초기화/ })).toBeVisible();
    });
});

test.describe("Billing page", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    test("shows current plan hero + usage + plan grid + invoices", async ({ page }) => {
        await openTeacherPage(page, "/teacher/billing");
        await expect(page.getByRole("heading", { name: "결제 및 플랜" })).toBeVisible();
        await expect(page.getByText("CURRENT PLAN")).toBeVisible();
        await expect(page.getByRole("heading", { name: "이달 사용량" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "플랜 비교" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "결제/플랜 기록" })).toBeVisible();
    });

    test("monthly/yearly toggle changes prices", async ({ page }) => {
        await openTeacherPage(page, "/teacher/billing");
        const yearly = page.getByRole("button", { name: /연간/ });
        await yearly.click();
        // Pro plan yearly = 19000 * 12 * 0.8 = 182400
        await expect(page.getByText("₩182,400")).toBeVisible();
    });
});

test.describe("Global Search", () => {
    test.beforeEach(async ({ page, context }) => {
        await clearStorage(page, context);
    });

    // Search lives inside TeacherHeader, which is rendered on the 4 subpages
    // (live/users/settings/billing) — not on /teacher/dashboard.
    // Wait for the header search trigger to appear as a proxy for TeacherHeader
    // (and therefore GlobalSearch) being fully hydrated before pressing Cmd+K.
    test("Cmd+K opens modal and Escape closes", async ({ page }) => {
        await openTeacherPage(page, "/teacher/live");
        await expect(page.getByRole("button", { name: "빠른 검색" })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+K");
        await expect(page.getByPlaceholder(/빠른 검색/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByPlaceholder(/빠른 검색/)).not.toBeVisible();
    });

    test("typing filters results and Enter navigates", async ({ page }) => {
        await openTeacherPage(page, "/teacher/live");
        await expect(page.getByRole("button", { name: "빠른 검색" })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+K");
        await page.getByPlaceholder(/빠른 검색/).fill("결제");
        await expect(page.getByText("결제 및 플랜").first()).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/teacher\/billing/);
    });
});
