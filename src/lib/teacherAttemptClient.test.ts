import { describe, expect, it, vi } from "vitest";
import {
    loadTeacherAttemptWithDeps,
    loadTeacherAttemptsWithDeps,
    saveTeacherAttemptWithDeps,
} from "./teacherAttemptClient";
import type { Attempt } from "@/types/omr";

function attempt(id: string, finishedAt = "2026-07-01T00:00:00.000Z"): Attempt {
    return {
        id,
        examId: "e1",
        examTitle: "e1",
        studentName: "학생",
        answers: {},
        score: 0,
        totalScore: 0,
        startedAt: finishedAt,
        finishedAt,
        status: "completed",
    } as Attempt;
}

describe("loadTeacherAttemptsWithDeps", () => {
    it("merges server attempts with local-only drafts on ok", async () => {
        const loadExistingFull = vi.fn();
        const result = await loadTeacherAttemptsWithDeps({
            server: async () => ({ status: "ok", attempts: [attempt("srv", "2026-07-10T00:00:00.000Z")] }),
            readLocalAttempts: () => [attempt("srv"), attempt("local", "2026-07-05T00:00:00.000Z")],
            loadExistingFull,
        });
        expect(result.source).toBe("server");
        expect(result.items.map(a => a.id)).toEqual(["srv", "local"]);
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("reads only the on-device cache on denied (no publishable path)", async () => {
        const loadExistingFull = vi.fn();
        const result = await loadTeacherAttemptsWithDeps({
            server: async () => ({ status: "denied" }),
            readLocalAttempts: () => [attempt("cached")],
            loadExistingFull,
        });
        expect(result.source).toBe("local");
        expect(result.remoteError).toBe("server_denied");
        expect(result.items.map(a => a.id)).toEqual(["cached"]);
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("uses the existing local + publishable path on degraded_local", async () => {
        const loadExistingFull = vi.fn(async () => ({ items: [attempt("legacy")], remoteLoaded: true }));
        const result = await loadTeacherAttemptsWithDeps({
            server: async () => ({ status: "degraded_local" }),
            readLocalAttempts: () => [],
            loadExistingFull,
        });
        expect(loadExistingFull).toHaveBeenCalledOnce();
        expect(result.items.map(a => a.id)).toEqual(["legacy"]);
    });
});

describe("loadTeacherAttemptWithDeps", () => {
    it("returns the server attempt on ok", async () => {
        const result = await loadTeacherAttemptWithDeps("a1", {
            server: async () => ({ status: "ok", attempt: attempt("a1") }),
            readLocalAttempt: () => null,
            loadExistingFull: async () => null,
        });
        expect(result?.id).toBe("a1");
    });

    it("reads the local draft on not_found", async () => {
        const result = await loadTeacherAttemptWithDeps("draft", {
            server: async () => ({ status: "not_found" }),
            readLocalAttempt: (id) => attempt(id),
            loadExistingFull: vi.fn(),
        });
        expect(result?.id).toBe("draft");
    });

    it("falls back to the existing loader on degraded_local", async () => {
        const loadExistingFull = vi.fn(async () => attempt("legacy"));
        await loadTeacherAttemptWithDeps("a1", {
            server: async () => ({ status: "degraded_local" }),
            readLocalAttempt: () => null,
            loadExistingFull,
        });
        expect(loadExistingFull).toHaveBeenCalledOnce();
    });
});

describe("saveTeacherAttemptWithDeps", () => {
    it("reports remoteSaved and caches locally on ok", async () => {
        const saveLocal = vi.fn(() => true);
        const saveExistingFull = vi.fn();
        const result = await saveTeacherAttemptWithDeps(attempt("a1"), {
            server: async () => ({ status: "ok", attempt: attempt("a1") }),
            saveLocal,
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: true });
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("keeps the edit on-device but reports no remote save on denied", async () => {
        const saveExistingFull = vi.fn();
        const result = await saveTeacherAttemptWithDeps(attempt("a1"), {
            server: async () => ({ status: "denied" }),
            saveLocal: vi.fn(() => true),
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: false, remoteError: "server_denied" });
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("delegates to the existing save on degraded_local", async () => {
        const saveExistingFull = vi.fn(async () => ({ localSaved: true, remoteSaved: true }));
        await saveTeacherAttemptWithDeps(attempt("a1"), {
            server: async () => ({ status: "degraded_local" }),
            saveLocal: vi.fn(() => true),
            saveExistingFull,
        });
        expect(saveExistingFull).toHaveBeenCalledOnce();
    });

    it("keeps the edit on-device when the server throws (offline)", async () => {
        const saveExistingFull = vi.fn(async () => ({ localSaved: true, remoteSaved: false }));
        await saveTeacherAttemptWithDeps(attempt("a1"), {
            server: async () => { throw new Error("network"); },
            saveLocal: vi.fn(() => true),
            saveExistingFull,
        });
        // A thrown server call is treated as degraded_local -> existing path.
        expect(saveExistingFull).toHaveBeenCalledOnce();
    });
});
