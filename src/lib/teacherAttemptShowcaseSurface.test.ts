import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
    join(process.cwd(), "src/app/teacher/attempt/[attemptId]/page.tsx"),
    "utf8",
);

describe("teacher showcase attempt surface", () => {
    it("resolves the selected demo result without falling through to canonical storage", () => {
        expect(pageSource).toContain("resolveDemoAttemptDetail(readTeacherSession(), id)");
        expect(pageSource).toContain("setPeerAttempts(demoDetail.peerAttempts)");
        expect(pageSource).toContain("setExam(demoDetail.exam)");
    });
});
