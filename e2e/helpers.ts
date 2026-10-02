import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { startShowcaseEntryDiagnostics } from "./showcaseEntryDiagnostics";
import { activateByInput } from "./inputActivation";

export async function activateControl(control: Locator) {
    // Emulated phone/tablet contexts must exercise native touch events rather
    // than a mouse-only click. One action; failures are never retried here.
    await activateByInput(control, test.info().project.use.hasTouch === true);
}

export function exactNextActionId(filename: string, exportedName: string, worker: string): string {
    const buildDirectory = process.env.OMR_ISOLATED_E2E === "1" ? ".next-e2e" : ".next";
    const manifestPath = join(process.cwd(), buildDirectory, "dev/server/server-reference-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        node?: Record<string, { filename?: string; exportedName?: string; workers?: Record<string, unknown> }>;
    };
    const matches = Object.entries(manifest.node || {}).filter(([, entry]) => (
        entry.filename === filename && entry.exportedName === exportedName
    ));
    expect(matches, `exact Next action mapping for ${filename}#${exportedName}`).toHaveLength(1);
    const [actionId, entry] = matches[0];
    expect(entry.workers, `${exportedName} worker registration`).toHaveProperty(worker);
    expect(actionId).toMatch(/^[0-9a-f]{42}$/);
    return actionId;
}

export async function resetBrowserState(page: Page, context: BrowserContext) {
    await context.clearCookies();
    await page.goto("/");
    await page.evaluate(() => {
        try { window.localStorage.clear(); } catch {}
        try { window.sessionStorage.clear(); } catch {}
    });
}

export async function continueSolveEntryIfPresent(page: Page) {
    await page.waitForFunction(() => (
        document.body.innerText.includes("시험 입장 확인")
        || !!document.querySelector(".solve-body")
    ), null, { timeout: 5_000 }).catch(() => {});

    const entryDialog = page.getByRole("dialog", { name: "시험 입장 확인" });
    if (!(await entryDialog.isVisible().catch(() => false))) return;

    const studentButton = entryDialog.getByRole("button", { name: "학생으로 시험 보기" });
    if (await studentButton.isVisible().catch(() => false)) {
        await studentButton.click();
    } else {
        await entryDialog.getByRole("button", { name: "게스트로 시험 보기" }).click();
    }
    await expect(entryDialog).toBeHidden({ timeout: 10_000 });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function teacherLoginFixture() {
    const environment = test.info().config.webServer?.env;
    const identifier = environment?.TEACHER_LOGIN_ID;
    const password = environment?.TEACHER_PASSWORD;
    if (!identifier?.trim() || !password?.trim()) {
        throw new Error("Teacher UI login requires a single Playwright webServer with non-blank TEACHER_LOGIN_ID and TEACHER_PASSWORD fixture values.");
    }
    return { identifier, password };
}

export async function loginAsTeacher(page: Page, nextPath = "/teacher/dashboard") {
    const { identifier, password } = teacherLoginFixture();
    await page.goto(`/?role=teacher&next=${encodeURIComponent(nextPath)}`);
    // The server-rendered form is inert until React hydration completes. Wait
    // for that product signal before entering credentials or submitting.
    const submitButton = page.getByRole("button", { name: "대시보드 입장" });
    await expect(submitButton).toBeEnabled({ timeout: 30_000 });
    await page.locator("#teacher-identifier").fill(identifier);
    await page.getByPlaceholder("비밀번호 입력").fill(password);
    await activateControl(submitButton);
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(nextPath)}(?:[?#].*)?$`), { timeout: 25_000 });
}

let showcaseDiagnosticSequence = 0;
const showcaseDiagnosticProjects = new Set([
    "ios-se-webkit", "ios-standard-webkit", "ios-max-webkit",
    "mobile-ios-webkit-pwa", "tablet-ios-webkit-pwa", "tablet-ios-webkit-landscape-pwa",
    "mobile-ios-webkit-teacher", "tablet-ios-webkit-teacher", "tablet-ios-webkit-landscape-teacher",
]);

function showcaseDiagnosticScenario(title: string): string {
    if (title === "teacher live pause stops data refresh without freezing or resuming a stale countdown") return "live-pause";
    if (title === "connects dashboard metrics to the next analysis action") return "metrics-next-action";
    if (title === "progressively reveals showcase exam results on a 390px phone") return "progressive-results";
    if (title === "keeps mobile roster search and detail actions clear of data-source toasts") return "roster-toast";
    return "other";
}

export async function loginAsShowcaseTeacher(page: Page) {
    const diagnostics = process.env.OMR_SHOWCASE_ENTRY_DIAGNOSTICS === "1"
        ? startShowcaseEntryDiagnostics(page) : null;
    let outcome: "passed" | "failed" = "failed";
    try {
        diagnostics?.stage("before-goto");
        await page.goto("/?role=teacher");
        diagnostics?.stage("home-loaded");
        // The server-rendered button remains disabled until its React handler is
        // hydrated, so a cold WebKit worker cannot silently discard the click.
        const showcaseButton = page.getByRole("button", { name: "데모 계정으로 둘러보기" });
        await expect(showcaseButton).toBeEnabled({ timeout: 30_000 });
        diagnostics?.stage("button-enabled");
        if (diagnostics) {
            // Observe native delivery without dispatching, replaying, or
            // preventing any input. Fixed booleans contain no form values.
            try {
                await showcaseButton.evaluate(button => {
                    for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "click"] as const) {
                        const key = `data-omr-diagnostic-${type}`;
                        button.setAttribute(key, "0");
                        button.addEventListener(type, () => button.setAttribute(key, "1"), { once: true, capture: true, passive: true });
                    }
                });
            } catch {
                console.warn("Showcase input delivery could not be observed.");
            }
        }
        await activateControl(showcaseButton);
        diagnostics?.stage("clicked");
        await expect(page).toHaveURL(/\/teacher\/dashboard\?showcase=1(?:#.*)?$/, { timeout: 25_000 });
        diagnostics?.stage("dashboard-url");
        // The URL changes before the showcase dashboard's dynamic overview chunk
        // has finished rendering. Replacing that navigation immediately can abort
        // the chunk request in WebKit and surface a false application runtime error.
        // CI traces show Linux WebKit needing over 30s for this dev-mode chunk.
        const overviewTimeout = page.context().browser()?.browserType().name() === "webkit" ? 45_000 : 30_000;
        await expect(page.getByRole("region", { name: "데모 계정 대시보드 개요" })).toBeVisible({ timeout: overviewTimeout });
        diagnostics?.stage("overview-visible");
        await page.waitForLoadState("networkidle");
        diagnostics?.stage("network-idle");
        outcome = "passed";
    } finally {
        if (diagnostics) {
            // Emit only the recorder's allowlisted schema. Never export browser
            // traces, auth headers/bodies, storage, or arbitrary test errors.
            try {
                const report = await diagnostics.finish(outcome);
                const info = test.info();
                const phase = process.env.OMR_SHOWCASE_ENTRY_PHASE === "repeat" ? "repeat" : "suite";
                const testKey = createHash("sha256").update(info.testId).digest("hex").slice(0, 16);
                const directory = join(process.cwd(), "showcase-entry-diagnostics");
                mkdirSync(directory, { recursive: true });
                const file = `${phase}-${testKey}-${info.repeatEachIndex}-${info.retry}-${showcaseDiagnosticSequence++}.json`;
                writeFileSync(join(directory, file), JSON.stringify({
                    testKey,
                    phase,
                    project: showcaseDiagnosticProjects.has(info.project.name) ? info.project.name : "other",
                    scenario: showcaseDiagnosticScenario(info.title),
                    inputMethod: info.project.use.hasTouch === true ? "touch" : "mouse",
                    repeatEachIndex: info.repeatEachIndex,
                    retry: info.retry,
                    report,
                }));
            } catch {
                // A diagnostic error must never replace the original assertion.
                console.warn("Showcase entry diagnostics could not be saved.");
            }
        }
    }
}

export async function openTeacherPage(page: Page, path: string) {
    await loginAsTeacher(page, path);
}
