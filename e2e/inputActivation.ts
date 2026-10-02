import type { Locator } from "@playwright/test";

export async function activateByInput(
    control: Pick<Locator, "click" | "tap">,
    hasTouch: boolean,
): Promise<void> {
    if (hasTouch) {
        await control.tap();
    } else {
        await control.click();
    }
}
