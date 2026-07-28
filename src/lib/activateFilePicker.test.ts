import { describe, expect, it } from "vitest";
import { activateFilePicker } from "./activateFilePicker";

describe("activateFilePicker", () => {
    it("delegates activation to the native file input", () => {
        const clickCalls: string[] = [];
        const input = {
            click: () => clickCalls.push("clicked"),
        };

        activateFilePicker(input);

        expect(clickCalls).toEqual(["clicked"]);
    });
});
