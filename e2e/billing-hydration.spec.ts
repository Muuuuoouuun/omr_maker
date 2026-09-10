import { expect, test } from "@playwright/test";
import { getPaymentProviderReadiness } from "../src/lib/paymentProvider";
import { loginAsTeacher } from "./helpers";

test("billing preserves the configured provider across server render and browser hydration", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await loginAsTeacher(page);
    await page.goto("/teacher/billing");
    await expect(page.getByRole("heading", { name: "결제 및 플랜", exact: true })).toBeVisible();
    await page.locator("details.billing-operations-details > summary").click();
    await expect(page.getByText(getPaymentProviderReadiness().label, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /연간/ }).click();
    await expect(page.getByText("₩182,400")).toBeVisible();
    expect(pageErrors).toEqual([]);
});
