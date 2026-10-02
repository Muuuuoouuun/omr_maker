import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    sameOrigin: false,
    cookieDeletes: [] as string[],
    cookieSets: 0,
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({
        origin: "https://attacker.example",
        host: "omr.example.com",
    }),
    cookies: async () => ({
        get: () => undefined,
        set: () => { controls.cookieSets += 1; },
        delete: (name: string) => { controls.cookieDeletes.push(name); },
    }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => controls.sameOrigin,
}));

import {
    clearStudentServerSession,
    issueGuestSession,
} from "@/app/actions/studentSession";

describe("student session mutation origin guard", () => {
    beforeEach(() => {
        controls.sameOrigin = false;
        controls.cookieDeletes.length = 0;
        controls.cookieSets = 0;
    });

    it("does not mint or replace a guest identity for a cross-origin action", async () => {
        await expect(issueGuestSession("Injected guest")).resolves.toEqual({ ok: false });
        expect(controls.cookieSets).toBe(0);
        expect(controls.cookieDeletes).toEqual([]);
    });

    it("does not log a student out for a cross-origin action", async () => {
        await expect(clearStudentServerSession()).resolves.toEqual({ ok: false });
        expect(controls.cookieDeletes).toEqual([]);
        expect(controls.cookieSets).toBe(0);
    });

    it("keeps the browser identity when the server refuses logout", () => {
        const page = readFileSync(resolve(process.cwd(), "src/app/student/dashboard/page.tsx"), "utf8");
        const start = page.indexOf("const handleLogout = async");
        const end = page.indexOf("if (!user)", start);
        const handler = page.slice(start, end);
        const serverResult = handler.indexOf("await clearStudentServerSession()");
        const refusedGuard = handler.indexOf("if (!logoutResult.ok)", serverResult);

        expect(serverResult).toBeGreaterThan(-1);
        expect(refusedGuard).toBeGreaterThan(serverResult);
        expect(refusedGuard).toBeLessThan(handler.indexOf("clearSession()"));
    });
});
