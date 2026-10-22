import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { DEFAULT_SETTINGS } from "../src/lib/appSettings";
import { SETTINGS_STORAGE_KEY } from "../src/lib/geminiApiKey";
import { loginAsTeacher } from "./helpers";

test("settings downloads exclude the personal API key without changing the saved key", async ({ page }) => {
    await loginAsTeacher(page, "/teacher/settings");
    const settings = {
        ...DEFAULT_SETTINGS,
        api: { geminiKey: "synthetic-local-key-do-not-export" },
        examDefaults: { ...DEFAULT_SETTINGS.examDefaults, questions: 35 },
    };
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: SETTINGS_STORAGE_KEY,
        value: settings,
    });
    await page.reload();
    await page.locator("details.settings-backup-disclosure > summary").click();

    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    const download = await downloaded;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const rawBackup = await readFile(downloadPath!, "utf8");
    const backup = JSON.parse(rawBackup);
    expect(rawBackup).not.toContain(settings.api.geminiKey);
    expect(backup.api.geminiKey).toBe("");
    expect(backup.examDefaults.questions).toBe(35);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SETTINGS_STORAGE_KEY);
    expect(stored.api.geminiKey).toBe(settings.api.geminiKey);
});

for (const localKey of ["synthetic-existing-local-key", ""]) {
    test(`settings imports ignore a legacy backup key with ${localKey ? "an existing" : "no"} local key`, async ({ page }) => {
        await loginAsTeacher(page, "/teacher/settings");
        await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
            key: SETTINGS_STORAGE_KEY,
            value: { ...DEFAULT_SETTINGS, api: { geminiKey: localKey } },
        });
        await page.reload();
        await page.locator("details.settings-backup-disclosure > summary").click();
        await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
            name: "legacy-settings.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({
                ...DEFAULT_SETTINGS,
                api: { geminiKey: "synthetic-untrusted-backup-key" },
                examDefaults: { ...DEFAULT_SETTINGS.examDefaults, questions: 45 },
            })),
        });
        await expect(page.getByText("설정 가져오기 완료", { exact: true })).toBeVisible();
        const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SETTINGS_STORAGE_KEY);
        expect(stored.api.geminiKey).toBe(localKey);
        expect(stored.examDefaults.questions).toBe(45);
    });
}
