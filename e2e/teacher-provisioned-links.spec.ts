import { expect, test } from "@playwright/test";

test.describe.configure({ retries: 0 });

test.describe("provisioned-only legacy teacher links", () => {
    for (const tokenParameter of ["teacherResetToken", "teacherVerifyToken"] as const) {
        test(`routes ${tokenParameter} to operator recovery without invoking an account action`, async ({ page }) => {
            const accountActionRequests: string[] = [];
            page.on("request", request => {
                if (request.method() === "POST" && request.headers()["next-action"]) {
                    accountActionRequests.push(request.url());
                }
            });

            await page.goto(`/?${tokenParameter}=private-legacy-token&role=student&next=%2Fteacher%2Fsettings`);

            await expect(page.getByText("교사 포털", { exact: true })).toBeVisible();
            await expect(page.getByRole("form", { name: "교사 로그인" })).toBeVisible();
            await expect(page.getByText(
                "현재 운영 모드에서는 이 링크를 사용할 수 없습니다. 운영자에게 계정 또는 비밀번호 재발급을 요청해주세요.",
                { exact: true },
            )).toBeVisible();
            await expect(page.getByRole("button", { name: "교사 계정 만들기" })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "비밀번호 재설정" })).toHaveCount(0);
            await expect(page.getByRole("heading", { name: "교사", exact: true })).toHaveCount(0);
            await expect(page.getByRole("heading", { name: "학생", exact: true })).toHaveCount(0);
            await expect(page).toHaveURL(url => {
                const current = new URL(url);
                return !current.searchParams.has("teacherResetToken")
                    && !current.searchParams.has("teacherVerifyToken")
                    && current.searchParams.get("role") === "teacher"
                    && current.searchParams.get("next") === "/teacher/settings";
            });
            await page.waitForTimeout(100);
            expect(accountActionRequests).toEqual([]);
        });
    }

    test("treats an empty legacy token parameter as an unusable operator-recovery link", async ({ page }) => {
        await page.goto("/?teacherResetToken=&next=%2Fteacher%2Fsettings");

        await expect(page.getByText("교사 포털", { exact: true })).toBeVisible();
        await expect(page.getByText(
            "현재 운영 모드에서는 이 링크를 사용할 수 없습니다. 운영자에게 계정 또는 비밀번호 재발급을 요청해주세요.",
            { exact: true },
        )).toBeVisible();
        await expect(page).toHaveURL(url => {
            const current = new URL(url);
            return !current.searchParams.has("teacherResetToken")
                && current.searchParams.get("role") === "teacher"
                && current.searchParams.get("next") === "/teacher/settings";
        });
    });
});
