import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("shared-device logout atomicity", () => {
    it("keeps the teacher browser session when server cookie deletion fails", () => {
        const component = source("src/components/TeacherLogoutButton.tsx");
        const serverDelete = component.indexOf("await clearTeacherAuthSession()");
        const clientDelete = component.indexOf("clearTeacherSession()", serverDelete);
        expect(serverDelete).toBeGreaterThan(-1);
        expect(clientDelete).toBeGreaterThan(serverDelete);
        expect(component.slice(serverDelete, clientDelete)).toContain("if (!result.success)");
        expect(component).toContain("서버 세션이 남아 있을 수 있습니다");
    });

    it("keeps the student browser session when server cookie deletion fails", () => {
        const page = source("src/app/student/dashboard/page.tsx");
        const serverDelete = page.indexOf("await clearStudentServerSession()");
        const clientDelete = page.indexOf("clearSession()", serverDelete);
        expect(serverDelete).toBeGreaterThan(-1);
        expect(clientDelete).toBeGreaterThan(serverDelete);
        expect(page.slice(serverDelete, clientDelete)).toContain("if (!result.ok)");
    });
});
