import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function exactNextActionId(filename: string, exportedName: string, worker: string): string {
    const manifestPath = join(process.cwd(), ".next/dev/server/server-reference-manifest.json");
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

export async function loginAsTeacher(page: Page, nextPath = "/teacher/dashboard") {
    await page.goto(`/?role=teacher&next=${encodeURIComponent(nextPath)}`);
    await expect(page.getByPlaceholder("admin 또는 teacher@example.com")).toBeVisible();
    await page.getByPlaceholder("admin 또는 teacher@example.com").fill("admin");
    await page.getByPlaceholder("비밀번호 입력").fill("admin123");
    await page.getByRole("button", { name: "대시보드 입장" }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(nextPath)}(?:[?#].*)?$`), { timeout: 15_000 });
}

export async function loginAsShowcaseTeacher(page: Page) {
    await page.goto("/?role=teacher");
    await page.getByRole("button", { name: "데모 계정으로 둘러보기" }).click();
    await expect(page).toHaveURL(/\/teacher\/dashboard\?showcase=1(?:#.*)?$/, { timeout: 15_000 });
    // The URL changes before the showcase dashboard's dynamic overview chunk
    // has finished rendering. Replacing that navigation immediately can abort
    // the chunk request in WebKit and surface a false application runtime error.
    await expect(page.getByRole("region", { name: "데모 계정 대시보드 개요" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
}

export async function openTeacherPage(page: Page, path: string) {
    await loginAsTeacher(page, path);
}
