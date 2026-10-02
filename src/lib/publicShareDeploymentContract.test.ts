import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public student share deployment contract", () => {
    it("documents the canonical public origin required for cross-device invite links", () => {
        const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
        expect(example).toContain("NEXT_PUBLIC_SHARE_BASE_URL=https://omr.example.com");
    });
});
