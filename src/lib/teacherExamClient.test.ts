import { beforeEach, describe, expect, it, vi } from "vitest";

const actionMocks = vi.hoisted(() => ({
    list: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
}));
const persistenceMocks = vi.hoisted(() => ({
    deleteLocalExam: vi.fn(),
    loadExam: vi.fn(),
    loadExams: vi.fn(),
    readLocalExams: vi.fn(),
    saveExam: vi.fn(),
    saveLocalExam: vi.fn(),
    saveLocalExams: vi.fn(),
}));

vi.mock("@/app/actions/teacherExam", () => ({
    listTeacherCanonicalExams: actionMocks.list,
    loadTeacherCanonicalExam: actionMocks.load,
    saveTeacherCanonicalExam: actionMocks.save,
    deleteTeacherCanonicalExam: actionMocks.remove,
}));
vi.mock("@/lib/omrPersistence", () => persistenceMocks);

import {
    loadTeacherExamDetail,
    loadTeacherExams,
    saveTeacherExamMutation,
} from "./teacherExamClient";

const exam = {
    id: "exam-detail",
    title: "Detail exam",
    questions: [],
    createdAt: "2026-08-04T00:00:00.000Z",
};

beforeEach(() => {
    vi.clearAllMocks();
    persistenceMocks.readLocalExams.mockReturnValue([{ id: "prior-account" }]);
    persistenceMocks.loadExams.mockResolvedValue({
        items: [{ id: "local-development" }],
        remoteLoaded: false,
    });
    persistenceMocks.saveExam.mockResolvedValue({ localSaved: true, remoteSaved: false });
    persistenceMocks.loadExam.mockResolvedValue(null);
});

describe("teacher exam read fallback", () => {
    it("fails closed instead of returning prior-account cache when the authenticated server read fails", async () => {
        actionMocks.list.mockResolvedValue({ status: "service_unavailable", error: "offline" });

        await expect(loadTeacherExams()).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteError: "offline",
        });
        expect(persistenceMocks.readLocalExams).not.toHaveBeenCalled();
    });

    it("keeps the explicitly local-only development flow", async () => {
        actionMocks.list.mockResolvedValue({ status: "local_only" });

        await expect(loadTeacherExams()).resolves.toMatchObject({
            items: [{ id: "local-development" }],
            remoteLoaded: false,
        });
        expect(persistenceMocks.loadExams).toHaveBeenCalledTimes(1);
    });

    it("adds the active workspace scope when saving in local-only development", async () => {
        const exam = { id: "local-development", title: "Local exam", questions: [], createdAt: "2026-08-04T00:00:00.000Z" };
        actionMocks.save.mockResolvedValue({ status: "local_only" });

        await expect(saveTeacherExamMutation(exam)).resolves.toEqual({ ok: true, localOnly: true });
        expect(persistenceMocks.saveExam).toHaveBeenCalledWith(exam);
        expect(persistenceMocks.saveLocalExam).not.toHaveBeenCalled();
    });

    it("preserves canonical not-found for the teacher detail surface", async () => {
        actionMocks.load.mockResolvedValue({ status: "not_found" });

        await expect(loadTeacherExamDetail("missing")).resolves.toEqual({ status: "not_found" });
    });

    it("preserves unauthorized and service-unavailable detail failures", async () => {
        actionMocks.load.mockResolvedValueOnce({ status: "unauthorized" });
        await expect(loadTeacherExamDetail("exam-detail")).resolves.toEqual({
            status: "unauthorized",
            error: "Teacher server session is missing",
        });

        actionMocks.load.mockResolvedValueOnce({ status: "service_unavailable", error: "gateway offline" });
        await expect(loadTeacherExamDetail("exam-detail")).resolves.toEqual({
            status: "service_unavailable",
            error: "gateway offline",
        });
    });

    it("keeps the explicit local-only detail flow without broadening real-account fallback", async () => {
        actionMocks.load.mockResolvedValue({ status: "local_only" });
        persistenceMocks.loadExam.mockResolvedValue(exam);

        await expect(loadTeacherExamDetail("exam-detail")).resolves.toEqual({
            status: "loaded",
            exam,
            source: "local",
        });
    });
});
