import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const createPage = readFileSync(new URL("../app/create/page.tsx", import.meta.url), "utf8");

describe("Korean exam creation surface", () => {
    it("offers the standard 45-question Korean exam size", () => {
        expect(createPage).toContain("[20, 25, 30, 40, 45, 50]");
        expect(createPage).toContain("gridTemplateColumns: 'repeat(6, minmax(0, 2.15rem))'");
    });
});
