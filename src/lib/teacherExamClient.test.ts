import { describe, expect, it, vi } from "vitest";
import {
    classifyTeacherServerStatus,
    deleteTeacherExamWithDeps,
    loadTeacherExamWithDeps,
    loadTeacherExamsWithDeps,
    saveTeacherExamWithDeps,
} from "./teacherExamClient";
import type { Exam } from "@/types/omr";

function exam(id: string, updatedAt = "2026-07-01T00:00:00.000Z"): Exam {
    return {
        id,
        title: id,
        questions: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt,
    } as Exam;
}

describe("classifyTeacherServerStatus", () => {
    it("trusts the server only on ok", () => {
        expect(classifyTeacherServerStatus("ok")).toBe("server");
    });
    it("keeps the publishable-key path only on degraded_local", () => {
        expect(classifyTeacherServerStatus("degraded_local")).toBe("degraded_fallback");
    });
    it("never revives the publishable-key path on a denial or error", () => {
        for (const status of ["denied", "unauthenticated", "not_found", "error", "weird"]) {
            expect(classifyTeacherServerStatus(status)).toBe("local_only");
        }
    });
});

describe("loadTeacherExamsWithDeps", () => {
    it("returns server exams merged with local-only drafts and caches each", async () => {
        const cache = vi.fn();
        const loadExistingFull = vi.fn();
        const result = await loadTeacherExamsWithDeps({
            server: async () => ({ status: "ok", exams: [exam("srv", "2026-07-10T00:00:00.000Z")] }),
            readLocalExams: () => [exam("srv", "2026-07-01T00:00:00.000Z"), exam("local-draft", "2026-07-05T00:00:00.000Z")],
            cacheExam: cache,
            loadExistingFull,
        });
        expect(result.source).toBe("server");
        expect(result.remoteLoaded).toBe(true);
        expect(result.items.map(e => e.id)).toEqual(["srv", "local-draft"]);
        expect(cache).toHaveBeenCalledTimes(1);
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("falls back to the on-device cache on denied without touching the publishable path", async () => {
        const loadExistingFull = vi.fn();
        const result = await loadTeacherExamsWithDeps({
            server: async () => ({ status: "denied" }),
            readLocalExams: () => [exam("cached")],
            cacheExam: vi.fn(),
            loadExistingFull,
        });
        expect(result.source).toBe("local");
        expect(result.remoteLoaded).toBe(false);
        expect(result.remoteError).toBe("server_denied");
        expect(result.items.map(e => e.id)).toEqual(["cached"]);
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("uses the existing local + publishable path on degraded_local", async () => {
        const loadExistingFull = vi.fn(async () => ({ items: [exam("legacy")], remoteLoaded: true }));
        const result = await loadTeacherExamsWithDeps({
            server: async () => ({ status: "degraded_local" }),
            readLocalExams: () => [],
            cacheExam: vi.fn(),
            loadExistingFull,
        });
        expect(loadExistingFull).toHaveBeenCalledOnce();
        expect(result.items.map(e => e.id)).toEqual(["legacy"]);
    });

    it("uses the existing path when the server action throws (offline)", async () => {
        const loadExistingFull = vi.fn(async () => ({ items: [exam("legacy")], remoteLoaded: false }));
        const result = await loadTeacherExamsWithDeps({
            server: async () => { throw new Error("network"); },
            readLocalExams: () => [],
            cacheExam: vi.fn(),
            loadExistingFull,
        });
        expect(loadExistingFull).toHaveBeenCalledOnce();
        expect(result.items.map(e => e.id)).toEqual(["legacy"]);
    });
});

describe("loadTeacherExamWithDeps", () => {
    it("returns and caches the server exam on ok", async () => {
        const cache = vi.fn();
        const result = await loadTeacherExamWithDeps("e1", {
            server: async () => ({ status: "ok", exam: exam("e1") }),
            readLocalExam: () => null,
            cacheExam: cache,
            loadExistingFull: async () => null,
        });
        expect(result?.id).toBe("e1");
        expect(cache).toHaveBeenCalledOnce();
    });

    it("reads the local draft on not_found", async () => {
        const result = await loadTeacherExamWithDeps("draft", {
            server: async () => ({ status: "not_found" }),
            readLocalExam: (id) => exam(id),
            cacheExam: vi.fn(),
            loadExistingFull: vi.fn(),
        });
        expect(result?.id).toBe("draft");
    });
});

describe("saveTeacherExamWithDeps", () => {
    it("marks remoteSaved on ok and caches locally", async () => {
        const saveLocal = vi.fn(() => true);
        const saveExistingFull = vi.fn();
        const result = await saveTeacherExamWithDeps(exam("e1"), {
            server: async () => ({ status: "ok", exam: exam("e1") }),
            saveLocal,
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: true });
        expect(saveLocal).toHaveBeenCalledOnce();
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("keeps the draft on-device but reports no remote save on denied (fail-closed, no publishable write)", async () => {
        const saveLocal = vi.fn(() => true);
        const saveExistingFull = vi.fn();
        const result = await saveTeacherExamWithDeps(exam("e1"), {
            server: async () => ({ status: "denied" }),
            saveLocal,
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: false, remoteError: "server_denied" });
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("delegates to the existing save on degraded_local", async () => {
        const saveExistingFull = vi.fn(async () => ({ localSaved: true, remoteSaved: true }));
        await saveTeacherExamWithDeps(exam("e1"), {
            server: async () => ({ status: "degraded_local" }),
            saveLocal: vi.fn(() => true),
            saveExistingFull,
        });
        expect(saveExistingFull).toHaveBeenCalledOnce();
    });
});

describe("deleteTeacherExamWithDeps", () => {
    it("deletes locally and reports remoteSaved on ok", async () => {
        const deleteLocal = vi.fn(() => true);
        const deleteExistingFull = vi.fn();
        const result = await deleteTeacherExamWithDeps("e1", {
            server: async () => ({ status: "ok" }),
            deleteLocal,
            deleteExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: true });
        expect(deleteExistingFull).not.toHaveBeenCalled();
    });

    it("delegates to the existing delete on degraded_local", async () => {
        const deleteExistingFull = vi.fn(async () => ({ localSaved: true, remoteSaved: true }));
        await deleteTeacherExamWithDeps("e1", {
            server: async () => ({ status: "degraded_local" }),
            deleteLocal: vi.fn(() => true),
            deleteExistingFull,
        });
        expect(deleteExistingFull).toHaveBeenCalledOnce();
    });
});
