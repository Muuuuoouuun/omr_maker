import { expect, test } from "@playwright/test";

const LEGACY_STUDENT_CODES_KEY = "omr_student_codes";
const LEGACY_RAW_CODE = "LEGACY-RAW-CODE-SECRET";

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
