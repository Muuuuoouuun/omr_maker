import { test, expect, type Page } from "@playwright/test";
import { mintTeacherToken } from "../src/lib/teacherAuth";
import { createSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "../src/lib/teacherServerSession";
import { createTeacherSession, LEGACY_TEACHER_TOKEN_KEY, TEACHER_SESSION_KEY } from "../src/lib/teacherSession";

test.describe.configure({ timeout: 45_000 });

const TEACHER_IDENTITY = {
    teacherId: "admin",
    email: "admin@example.com",
    displayName: "Demo Admin",
};

function cookieOrigin(baseURL?: string): string {
    try {
        return new URL(baseURL || "http://localhost:3003").origin;
    } catch {
        return "http://localhost:3003";
    }
}

// Each test starts with clean storage and a valid teacher session so mocks are deterministic.
async function authenticateTeacher(page: Page, baseURL?: string) {
    const token = mintTeacherToken();
    const session = createTeacherSession(token, Date.now(), TEACHER_IDENTITY);
    const signedCookie = createSignedTeacherSessionCookie(token, TEACHER_IDENTITY);

    if (!signedCookie) {
        throw new Error("Failed to create teacher session cookie for e2e test");
    }

    await page.context().clearCookies();
    await page.context().addCookies([{
        name: TEACHER_SERVER_SESSION_COOKIE,
        value: signedCookie,
        url: cookieOrigin(baseURL),
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
    }]);

    await page.goto("/");
    await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });

    const seedTeacherSession = ({ session, sessionKey, legacyTokenKey }: {
        session: ReturnType<typeof createTeacherSession>;
        sessionKey: string;
        legacyTokenKey: string;
    }) => {
        try {
            window.sessionStorage.setItem(sessionKey, JSON.stringify(session));
            window.sessionStorage.setItem(legacyTokenKey, session.token);
        } catch {}
    };

    await page.evaluate(seedTeacherSession, {
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
        session,
        sessionKey: TEACHER_SESSION_KEY,
    });
    await page.addInitScript(seedTeacherSession, {
        legacyTokenKey: LEGACY_TEACHER_TOKEN_KEY,
        session,
        sessionKey: TEACHER_SESSION_KEY,
    });
}

async function seedStoredRoster(page: Page) {
    await page.addInitScript(({ groups, students }) => {
        window.localStorage.setItem("omr_groups", JSON.stringify(groups));
        window.localStorage.setItem("omr_students", JSON.stringify(students));
    }, {
        groups: [{
            id: "e2e-class-a",
            name: "E2E A반",
            region: "서울",
            count: 2,
            avgScore: 0,
            color: "#4f46e5",
        }],
        students: [
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
        ],
    });
}

test.describe("Teacher dashboard", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("loads and shows quick action tiles", async ({ page }) => {
        await page.goto("/teacher/dashboard");
        await expect(page.getByRole("heading", { name: "분석 센터" })).toBeVisible();
        await expect(page.getByText("빠른 작업", { exact: false })).toBeVisible();
        // 6 quick action tiles
        for (const label of ["시험 제작", "실시간 응시", "학생 관리", "시험 분석", "설정", "요금제"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
    });

    test("quick action live results navigates to /teacher/live", async ({ page }) => {
        await page.goto("/teacher/dashboard");
        await page.getByRole("link", { name: /실시간 응시/ }).click();
        await expect(page).toHaveURL(/\/teacher\/live$/);
        await expect(page.getByRole("heading", { name: "응시 결과 확인" })).toBeVisible();
    });
});

test.describe("Create page label memory", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("remembers label presets and lets teachers hide stale candidates", async ({ page }) => {
        await page.goto("/create");

        const labelCard = page.locator(".create-label-batch-card");
        await expect(labelCard.getByText("문항 라벨 일괄 적용")).toBeVisible();
        await expect(labelCard.getByText(/Demo Admin 최근/)).toBeVisible();

        const hideGrammar = labelCard.getByRole("button", { name: "문법 후보 숨김" });
        await expect(hideGrammar).toBeVisible();
        await hideGrammar.click();
        await expect(hideGrammar).not.toBeVisible();

        await labelCard.getByRole("button", { name: "복구" }).click();
        await expect(labelCard.getByRole("button", { name: "문법 후보 숨김" })).toBeVisible();

        await labelCard.getByPlaceholder("유형/라벨 예: 독해, 어법, 빈칸").fill("현대시");
        await labelCard.getByPlaceholder("단원").fill("문학");
        await labelCard.getByPlaceholder("세부 개념").fill("화자의 태도");
        await labelCard.getByRole("button", { name: "범위 적용" }).click();
        await labelCard.getByRole("button", { name: "기억" }).click();

        const storedMemory = await page.evaluate(() => {
            const key = Object.keys(window.localStorage).find(item => item.startsWith("omr_question_label_settings_v1:"));
            return key ? window.localStorage.getItem(key) : "";
        });
        expect(storedMemory).toContain("현대시");
        expect(storedMemory).toContain("문학");
        expect(storedMemory).toContain("화자의 태도");
    });
});

test.describe("Live Results page", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("renders timer, stat tiles, students grid, heatmap", async ({ page }) => {
        await page.goto("/teacher/live");
        await expect(page.getByText("REMAINING TIME")).toBeVisible();
        // Stat labels
        for (const label of ["제출 완료", "응시 중", "미응시", "제출 평균"]) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
        await expect(page.getByRole("heading", { name: "학생별 제출 현황" })).toBeVisible();
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
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("renders tabs and student table with mock data", async ({ page }) => {
        await page.goto("/teacher/users");
        await expect(page.getByRole("heading", { name: "사용자 관리" })).toBeVisible();
        // Wait for hydration (table rows seed from localStorage on mount)
        const rows = page.locator("tbody tr");
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
    });

    test("bulk selection banner appears after checking boxes", async ({ page }) => {
        await seedStoredRoster(page);
        await page.goto("/teacher/users");
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await firstBox.check();
        await expect(page.getByText(/\d+명 선택됨/)).toBeVisible();
    });

    test("demo roster keeps bulk selection locked", async ({ page }) => {
        await page.goto("/teacher/users");
        const firstBox = page.locator('tbody input[type="checkbox"]').first();
        await expect(firstBox).toBeDisabled();
    });

    test("switching to groups tab shows group cards", async ({ page }) => {
        await page.goto("/teacher/users");
        await page.getByRole("button", { name: /반 · 그룹/ }).click();
        await expect(page.getByRole("button", { name: "새 반 만들기" }).first()).toBeVisible();
    });

    test("teacher can create, edit, and delete an empty group", async ({ page }) => {
        await page.goto("/teacher/users?tab=groups");

        await page.getByRole("button", { name: "새 반 만들기" }).first().click();
        const createDialog = page.getByRole("dialog", { name: "새 반 만들기" });
        await expect(createDialog).toBeVisible();
        await page.getByLabel("반 이름").fill("E2E 신규반");
        await page.getByLabel("반 지역").fill("온라인");
        await createDialog.getByRole("button", { name: "만들기", exact: true }).click();

        await expect(page.getByRole("heading", { name: "E2E 신규반" })).toBeVisible();
        await expect(page.getByText("0명 등록 · 온라인")).toBeVisible();

        await page.getByRole("button", { name: "E2E 신규반 편집" }).click();
        const editDialog = page.getByRole("dialog", { name: "반 편집" });
        await expect(editDialog).toBeVisible();
        await page.getByLabel("반 이름").fill("E2E 편집반");
        await page.getByLabel("반 지역").fill("서울");
        await editDialog.getByRole("button", { name: "저장", exact: true }).click();

        await expect(page.getByRole("heading", { name: "E2E 편집반" })).toBeVisible();
        await expect(page.getByText("0명 등록 · 서울")).toBeVisible();

        await page.getByRole("button", { name: "E2E 편집반 삭제" }).click();
        const deleteDialog = page.getByRole("dialog", { name: "반 삭제" });
        await expect(deleteDialog).toBeVisible();
        await deleteDialog.getByRole("button", { name: "반 삭제" }).click();
        await expect(page.getByRole("heading", { name: "E2E 편집반" })).not.toBeVisible();
    });

    test("issued student start code gates the student portal login", async ({ page }) => {
        await seedStoredRoster(page);
        await page.goto("/teacher/users");

        const studentRow = page.locator('tbody tr:has-text("kim.student@example.com")');
        await expect(studentRow).toHaveCount(1);
        await studentRow.click();
        await expect(page.getByText("학생 상세")).toBeVisible();
        await expect(page.getByText("학생 계정 안내")).toBeVisible();
        await expect(page.getByTestId("student-login-id-value")).toHaveText("e2e-class-a::김학생");
        await expect(page.getByTestId("student-login-email-value")).toHaveText("kim.student@example.com");
        await expect(page.getByTestId("student-login-start-code-value")).toHaveText("미발급");
        await expect(page.getByTestId("copy-student-login-credentials")).toBeVisible();
        const studentGridColumnCount = await page.locator(".teacher-users-students-grid.has-detail").evaluate(element =>
            window.getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length
        );
        if ((page.viewportSize()?.width || 0) <= 1024) {
            expect(studentGridColumnCount).toBe(1);
        } else {
            expect(studentGridColumnCount).toBeGreaterThan(1);
        }
        const tableScrollMetrics = await page.locator(".teacher-users-table-scroll").evaluate(element => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }));
        expect(tableScrollMetrics.scrollWidth).toBeGreaterThanOrEqual(tableScrollMetrics.clientWidth);
        const hasAccountGuideBodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(hasAccountGuideBodyOverflow).toBe(false);
        await expect(page.getByTestId("student-start-code-value")).toHaveText("미발급");

        await page.getByTestId("issue-student-start-code").click();
        const issuedCode = (await page.getByTestId("student-start-code-value").innerText()).trim();
        expect(issuedCode).toMatch(/^[A-Z2-9]{6}$/);
        await expect(page.getByTestId("student-login-start-code-value")).toHaveText(issuedCode);

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
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("sidebar + profile section renders", async ({ page }) => {
        await page.goto("/teacher/settings");
        await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
        for (const label of ["프로필", "알림", "시험 기본값", "채점", "API 키", "테마", "보안"]) {
            await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        }
        await expect(page.getByText("프로필 상태")).toBeVisible();
        await expect(page.getByText("로그인 계정과 권한")).toBeVisible();
    });

    test("switching section updates panel", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.getByRole("button", { name: "알림", exact: true }).click();
        await expect(page.getByText("카카오 후보 계산과 실제 발송 연동 상태를 구분해 보여줍니다.")).toBeVisible();
        await expect(page.getByText("카카오 실제 발송")).toBeVisible();
    });

    test("security tab shows deployment login diagnostics", async ({ page }) => {
        await page.goto("/teacher/settings");
        await page.getByRole("button", { name: "보안", exact: true }).click();
        await expect(page.getByText("배포 로그인 진단")).toBeVisible();
        await expect(page.getByText("교사 계정 환경변수")).toBeVisible();
        await expect(page.getByText("Supabase 클라이언트 동기화")).toBeVisible();
        await expect(page.getByRole("button", { name: "배포 로그인 진단 새로고침" })).toBeVisible();
    });

    test("backup card shows export/import/reset buttons", async ({ page }) => {
        await page.goto("/teacher/settings");
        await expect(page.getByRole("button", { name: /내보내기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /가져오기/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /전체 초기화/ })).toBeVisible();
    });
});

test.describe("Billing page", () => {
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
    });

    test("shows current plan hero + usage + plan grid + invoices", async ({ page }) => {
        await page.goto("/teacher/billing");
        await expect(page.getByRole("heading", { name: "결제 및 플랜" })).toBeVisible();
        await expect(page.getByText("CURRENT PLAN")).toBeVisible();
        await expect(page.getByRole("heading", { name: "이달 사용량" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "플랜 비교" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "결제/플랜 기록" })).toBeVisible();
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
    test.beforeEach(async ({ page, baseURL }) => {
        await authenticateTeacher(page, baseURL);
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
