import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("student guest merge login", () => {
    it("keeps the login-time guest merge local instead of opening canonical browser CRUD", () => {
        const homePage = readFileSync(resolve(process.cwd(), "src/app/page.tsx"), "utf8");

        expect(homePage).toContain("const mergedCount = mergeGuestAttempts(");
        expect(homePage).not.toContain("syncMergedGuestAttempts");
    });
});
