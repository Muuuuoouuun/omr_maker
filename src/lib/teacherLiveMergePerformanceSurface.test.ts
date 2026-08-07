import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("teacher live merge performance surface", () => {
    it("indexes detailed attempts once instead of scanning them for every student", () => {
        const source = readFileSync(path.join(root, "src/app/teacher/live/page.tsx"), "utf8");
        const mergeBlock = source.slice(
            source.indexOf("const students = useMemo<LiveStudent[]>"),
            source.indexOf("// Reset the countdown"),
        );

        expect(mergeBlock).toContain("const attemptById = new Map(");
        expect(mergeBlock).toContain("attemptById.get(student.id)");
        expect(mergeBlock).not.toContain("answerDetailedAttempts.find(");
    });
});
