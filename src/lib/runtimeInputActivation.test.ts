import { describe, expect, it, vi } from "vitest";
import type { Locator } from "@playwright/test";

const project = vi.hoisted(() => ({ hasTouch: true }));
vi.mock("@playwright/test", () => ({
    expect: vi.fn(),
    test: { info: () => ({ project: { use: { hasTouch: project.hasTouch } } }) },
}));

import { activateControl } from "../../e2e/helpers";

function control(actualHasTouch: boolean) {
    const click = vi.fn(async () => {});
    const tap = vi.fn(async () => {
        if (!actualHasTouch) throw new Error("The page does not support tap");
    });
    return { locator: { click, tap } as unknown as Locator, click, tap };
}

describe("entry helper respects per-test input capability", () => {
    it("uses mouse for the actual desktop override despite a touch project default", async () => {
        project.hasTouch = true;
        const input = control(false);
        await activateControl(input.locator, false);
        expect(input.click).toHaveBeenCalledExactlyOnceWith();
        expect(input.tap).not.toHaveBeenCalled();
    });

    it("uses native touch for the actual touch override despite a mouse project default", async () => {
        project.hasTouch = false;
        const input = control(true);
        await activateControl(input.locator, true);
        expect(input.tap).toHaveBeenCalledExactlyOnceWith();
        expect(input.click).not.toHaveBeenCalled();
    });

    it("propagates the selected native action failure without retrying another input", async () => {
        project.hasTouch = false;
        const input = control(true);
        const failure = new Error("Native input unavailable");
        input.tap.mockRejectedValue(failure);
        await expect(activateControl(input.locator, true)).rejects.toBe(failure);
        expect(input.tap).toHaveBeenCalledExactlyOnceWith();
        expect(input.click).not.toHaveBeenCalled();
    });
});
