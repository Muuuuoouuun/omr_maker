import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const usersPage = () => readFileSync(join(process.cwd(), "src/app/teacher/users/page.tsx"), "utf8");

describe("roster UI integrity guards", () => {
    it("moves class and region together", () => {
        const source = usersPage();
        expect(source).toContain("group: targetGroup.name, region: targetGroup.region");
        expect(source).not.toContain("applyRegion ? { region: targetGroup.region }");
        expect(source).toContain("selectedGroup?.region?.trim() || data.region.trim()");
    });

    it("keeps the student form open when a mutation is rejected", () => {
        const source = usersPage();
        expect(source).toContain("const saved = editingStudent");
        expect(source).toContain("if (!saved) return false");
        expect(source).toContain("onSubmit: (data: StudentFormData) => Promise<boolean>");
    });

    it("traps modal focus, closes on Escape, and restores the trigger", () => {
        const source = usersPage();
        expect(source).toContain("event.key === 'Escape'");
        expect(source).toContain("event.key !== 'Tab'");
        expect(source).toContain("previouslyFocusedRef.current?.focus()");
        expect(source).toContain("tabIndex={-1}");
    });
});
