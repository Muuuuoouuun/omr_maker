import { expect, test } from "@playwright/test";

const LEGACY_STUDENT_CODES_KEY = "omr_student_codes";
const LEGACY_RAW_CODE = "LEGACY-RAW-CODE-SECRET";

test("production nonce CSP blocks injected inline scripts and preserves page interaction", async ({ page, request }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error" && !/Content Security Policy|violates.*script-src|Refused to execute.*script/i.test(message.text())) {
            consoleErrors.push(message.text());
        }
    });
    // Parser-inserted HTML models an actual injection. Scripts created from
    // Playwright's privileged evaluate context can inherit strict-dynamic trust.
    await page.route("**/?role=student", async route => {
        const original = await route.fetch();
        await route.fulfill({
            response: original,
            body: (await original.text()).replace("</head>", "<script>window.__injectedCspScript = true</script></head>"),
        });
    });
    const response = await page.goto("/?role=student");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("OMR Maker");
    const policy = response!.headers()["content-security-policy"];
    const scripts = policy.split(';').find(value => value.trim().startsWith('script-src'))!;
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
    const nonce = scripts.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const freshResponse = await request.get("/");
    expect(freshResponse.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
    expect(await page.evaluate(() => (window as typeof window & { __injectedCspScript?: boolean }).__injectedCspScript)).toBeUndefined();
    await page.getByRole("button", { name: "역할 선택으로", exact: true }).click();
    await page.getByRole("button", { name: /교사.*대시보드/ }).click();
    await expect(page.getByRole("button", { name: "데모 계정으로 둘러보기" })).toBeVisible();
    await page.screenshot({ path: `/tmp/omr-security-${testInfo.project.name}.png` });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test("production readiness rejects unauthenticated callers without exposing configuration", async ({ request }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");
    const response = await request.get("/api/readyz");
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.json()).toEqual({ status: "unauthorized" });
});

test("production health exposes the exact immutable build without cache", async ({ request }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");
    const expectedBuild = process.env.OMR_PRODUCTION_EXPECTED_BUILD;
    expect(expectedBuild).toMatch(/^[a-f0-9]{40}$/);
    const response = await request.get("/api/healthz", { headers: { accept: "application/json" } });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json() as unknown;
    expect(body).toMatchObject({ status: "alive", build: expectedBuild });
});

test("production static assets use immutable same-origin delivery", async ({ request }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");
    const documentResponse = await request.get("/?role=student", { headers: { accept: "text/html" } });
    expect(documentResponse.status()).toBe(200);
    const document = await documentResponse.text();
    const scriptPath = document.match(/<script[^>]+src="([^"?]*\/_next\/static\/[^"?]+\.js)["?]/)?.[1];
    expect(scriptPath).toMatch(/^\/_next\/static\/[A-Za-z0-9._\/-]+\.js$/);
    const assetResponse = await request.get(scriptPath!);
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()["content-type"]).toContain("javascript");
    expect(assetResponse.headers()["cache-control"]).toMatch(/max-age=31536000.*immutable/);
});

test("production showcase button preserves exact read-only mockup authority", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");
    await page.goto("/?role=teacher");
    await page.getByRole("button", { name: "데모 계정으로 둘러보기" }).click();
    await expect(page).toHaveURL(/\/teacher\/dashboard\?showcase=1$/, { timeout: 15_000 });
    const session = await page.evaluate(() => JSON.parse(
        window.sessionStorage.getItem("omr_teacher_session") || "null",
    ));
    expect(session).toMatchObject({
        teacherId: "omr-showcase",
        sessionAuthority: "mockup",
        email: "demo@omrmaker.kr",
        displayName: "김하늘 선생님",
        plan: "academy",
    });
    expect(session).not.toHaveProperty("organizationId");
    expect(session).not.toHaveProperty("memberRole");
    expect(session).not.toHaveProperty("accountSessionGeneration");
    await page.goto("/create");
    await expect(page).toHaveURL(/\/teacher\/dashboard\?showcase=1$/, { timeout: 15_000 });
});

test("production root boot scrubs legacy student start codes without reading or displaying them", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("prod-"), "Production-build security contract.");

    await page.addInitScript(({ key, rawCode }) => {
        window.localStorage.setItem(key, JSON.stringify({ "legacy-student": rawCode }));
        const originalGetItem = Storage.prototype.getItem;
        const instrumentation = window as typeof window & {
            __legacyStudentCodeReads: number;
            __readLegacyStudentCodeValue: () => string | null;
        };
        instrumentation.__legacyStudentCodeReads = 0;
        instrumentation.__readLegacyStudentCodeValue = () => originalGetItem.call(window.localStorage, key);
        Storage.prototype.getItem = function instrumentedGetItem(storageKey: string) {
            if (storageKey === key) instrumentation.__legacyStudentCodeReads += 1;
            return originalGetItem.call(this, storageKey);
        };
    }, { key: LEGACY_STUDENT_CODES_KEY, rawCode: LEGACY_RAW_CODE });

    await page.goto("/?role=student");
    await page.waitForFunction(() => {
        const instrumentation = window as typeof window & {
            __readLegacyStudentCodeValue: () => string | null;
        };
        return instrumentation.__readLegacyStudentCodeValue() === null;
    });

    const storageState = await page.evaluate(() => {
        const instrumentation = window as typeof window & {
            __legacyStudentCodeReads: number;
            __readLegacyStudentCodeValue: () => string | null;
        };
        return {
            reads: instrumentation.__legacyStudentCodeReads,
            value: instrumentation.__readLegacyStudentCodeValue(),
        };
    });
    expect(storageState).toEqual({ reads: 0, value: null });
    await expect(page.getByText(LEGACY_RAW_CODE, { exact: false })).toHaveCount(0);
});
