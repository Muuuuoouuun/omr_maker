import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("production guest entry fallback surface", () => {
    it("does not persist an empty device-only guest from the home entry", () => {
        const page = source("src/app/page.tsx");
        const start = page.indexOf("const startGuestSession");
        const end = page.indexOf("const handleGuest =", start);
        const action = page.slice(start, end);
        const fallback = action.indexOf("getOrCreateGuestId()");
        const emptyGuard = action.indexOf("if (!guestId)", fallback + 1);

        expect(fallback).toBeGreaterThan(-1);
        expect(emptyGuard).toBeGreaterThan(fallback);
        expect(emptyGuard).toBeLessThan(action.indexOf("saveSession(session)"));
        expect(action.slice(emptyGuard, action.indexOf("const session", emptyGuard)))
            .toContain("return");
    });

    it("stops solve entry when a signed guest cannot be issued in production", () => {
        const page = source("src/app/solve/[id]/page.tsx");
        const start = page.indexOf("const createGuestSubmitter");
        const end = page.indexOf("const beginConfirmedEntry", start);
        const factory = page.slice(start, end);
        const fallback = factory.indexOf("getOrCreateGuestId()");
        const emptyGuard = factory.indexOf("if (!guestId)", fallback + 1);

        expect(factory).toContain("Promise<StudentSession | null>");
        expect(fallback).toBeGreaterThan(-1);
        expect(emptyGuard).toBeGreaterThan(fallback);
        expect(emptyGuard).toBeLessThan(factory.indexOf("saveSession(submitter)"));
        expect(factory.slice(emptyGuard, factory.indexOf("const submitter", emptyGuard)))
            .toContain("return null");

        expect(page).toContain("if (!submitter) return;");
    });
});
