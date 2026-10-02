import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exam } from "@/types/omr";

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
const premiumMocks = vi.hoisted(() => ({
    authorizeAdvancedQuestionDesign: vi.fn(),
    authorizeExamCreation: vi.fn(),
    releaseExamCreationAuthorization: vi.fn(),
}));
const blobMocks = vi.hoisted(() => ({ copyStoredData: vi.fn(), deleteStoredData: vi.fn() }));

vi.mock("@/app/actions/teacherExam", () => ({
    listTeacherCanonicalExams: actionMocks.list,
    loadTeacherCanonicalExam: actionMocks.load,
    saveTeacherCanonicalExam: actionMocks.save,
    deleteTeacherCanonicalExam: actionMocks.remove,
}));
vi.mock("@/lib/omrPersistence", () => persistenceMocks);
vi.mock("@/app/actions/premiumAccess", () => premiumMocks);
vi.mock("@/utils/blobStore", () => blobMocks);

import {
    loadTeacherExamDetail,
    loadTeacherExams,
    saveTeacherExamMutation,
} from "./teacherExamClient";
import * as teacherExamClient from "./teacherExamClient";

const exam = {
    id: "exam-detail",
    title: "Detail exam",
    questions: [],
    createdAt: "2026-08-04T00:00:00.000Z",
};

const collectionMeta = {
    organizationId: "org-1",
    loadedAt: "2026-08-09T01:02:03.000Z",
    rawCount: 1,
    parsedCount: 1,
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
    premiumMocks.authorizeAdvancedQuestionDesign.mockResolvedValue({ ok: true });
    premiumMocks.authorizeExamCreation.mockResolvedValue({ ok: true });
    premiumMocks.releaseExamCreationAuthorization.mockResolvedValue({ ok: true, released: true });
    blobMocks.copyStoredData.mockImplementation(async (ref: unknown) => ref);
});

describe("teacher exam read fallback", () => {
    it("returns and caches the canonical next revision after a save", async () => {
        const canonical = {
            ...exam,
            revision: 2,
            updatedAt: "2026-08-06T05:06:07.000Z",
        };
        actionMocks.save.mockResolvedValue({ status: "saved", exam: canonical });

        await expect(saveTeacherExamMutation({ ...exam, revision: 1 })).resolves.toEqual({
            ok: true,
            exam: canonical,
        });
        expect(persistenceMocks.saveLocalExam).toHaveBeenCalledWith(canonical);
    });

    it("preserves the local draft and exposes canonical revision conflicts", async () => {
        actionMocks.save.mockResolvedValue({
            status: "conflict",
            currentRevision: 8,
            serverUpdatedAt: "2026-08-06T03:04:05.000Z",
        });

        await expect(saveTeacherExamMutation({ ...exam, revision: 6 })).resolves.toEqual({
            ok: false,
            conflict: true,
            currentRevision: 8,
            serverUpdatedAt: "2026-08-06T03:04:05.000Z",
            error: "다른 기기나 탭에서 시험이 먼저 변경되었습니다. 현재 초안은 유지됩니다.",
        });
        expect(persistenceMocks.saveLocalExam).not.toHaveBeenCalled();
        expect(persistenceMocks.saveExam).not.toHaveBeenCalled();
    });

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

    it("does not let a list projection mutate an existing full exam cache", async () => {
        const answerKeyPdfRef = { store: "remote", key: "answer-key", kind: "answer_key_pdf" };
        const localFull = { ...exam, answerKeyPdfRef, pdfData: "legacy-problem-pdf", answerKeyPdf: "legacy-answer-key" };
        const summary = { ...exam, organizationId: "org-1", title: "Fresh summary" };
        actionMocks.list.mockResolvedValue({ status: "loaded", exams: [summary], meta: collectionMeta });
        persistenceMocks.readLocalExams.mockReturnValue([localFull]);

        await expect(loadTeacherExams()).resolves.toMatchObject({
            items: [summary],
            remoteLoaded: true,
            meta: collectionMeta,
        });
        expect(persistenceMocks.saveLocalExams).not.toHaveBeenCalled();
        expect(persistenceMocks.readLocalExams).not.toHaveBeenCalled();
    });

    it("does not cache a fresh list projection as if it were full detail", async () => {
        const summary = { ...exam, organizationId: "org-1", title: "Fresh summary" };
        actionMocks.list.mockResolvedValue({ status: "loaded", exams: [summary], meta: collectionMeta });
        persistenceMocks.readLocalExams.mockReturnValue([]);

        await loadTeacherExams();
        expect(persistenceMocks.saveLocalExams).not.toHaveBeenCalled();
    });

    it.each([
        ["a noncanonical loadedAt", { ...collectionMeta, loadedAt: "2026-08-09T10:02:03+09:00" }],
        ["a whitespace-padded loadedAt", { ...collectionMeta, loadedAt: ` ${collectionMeta.loadedAt} ` }],
        ["a raw/parsed mismatch", { ...collectionMeta, rawCount: 2 }],
        ["a parsed/item mismatch", { ...collectionMeta, parsedCount: 2, rawCount: 2 }],
        ["an extra metadata key", { ...collectionMeta, provider: "supabase" }],
    ])("rejects all exam rows when the canonical metadata has %s", async (_label, meta) => {
        const summary = { ...exam, organizationId: "org-1" };
        actionMocks.list.mockResolvedValue({ status: "loaded", exams: [summary], meta });

        await expect(loadTeacherExams()).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteSynced: false,
            remoteError: "Invalid canonical exam collection",
        });
    });

    it("rejects all exam rows when one row disagrees with the metadata organization", async () => {
        actionMocks.list.mockResolvedValue({
            status: "loaded",
            exams: [{ ...exam, organizationId: "org-other" }],
            meta: collectionMeta,
        });

        await expect(loadTeacherExams()).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteError: "Invalid canonical exam collection",
        });
    });
});

describe("teacher dashboard exam mutations", () => {
    const fullExam: Exam = {
        ...exam,
        organizationId: "org-1",
        title: "Canonical exam",
        pdfDataRef: {
            store: "remote", key: "problem", kind: "problem_pdf", organizationId: "org-1",
            examId: "exam-detail", mimeType: "application/pdf", size: 123, updatedAt: "2026-08-04T00:00:00.000Z",
        },
        answerKeyPdfRef: {
            store: "remote", key: "answer", kind: "answer_key_pdf", organizationId: "org-1",
            examId: "exam-detail", mimeType: "application/pdf", size: 45, updatedAt: "2026-08-04T00:00:00.000Z",
        },
        questions: [{ id: 1, number: 1, choices: 5, answer: 2, score: 1 }],
    };

    it("archives the canonical full exam rather than overwriting it with a summary", async () => {
        const candidate = (teacherExamClient as Record<string, unknown>).setTeacherExamArchivedFromSummary;
        expect(candidate).toBeTypeOf("function");
        if (typeof candidate !== "function") return;
        actionMocks.load.mockResolvedValue({ status: "loaded", exam: fullExam });
        actionMocks.save.mockImplementation(async (updated: Exam) => ({ status: "saved", exam: updated }));

        const result = await candidate({
            id: fullExam.id,
            title: fullExam.title,
            createdAt: fullExam.createdAt,
            questions: fullExam.questions,
            pdfDataRef: fullExam.pdfDataRef,
        }, true);

        expect(result).toMatchObject({
            ok: true,
            exam: {
                archived: true,
                pdfDataRef: fullExam.pdfDataRef,
                answerKeyPdfRef: fullExam.answerKeyPdfRef,
            },
        });
        expect(actionMocks.load.mock.invocationCallOrder[0]).toBeLessThan(actionMocks.save.mock.invocationCallOrder[0]);
    });

    it("returns the server-issued next revision after an archive mutation", async () => {
        const canonical = { ...fullExam, archived: true, revision: 4, updatedAt: "2026-08-06T06:07:08.000Z" };
        actionMocks.load.mockResolvedValue({ status: "loaded", exam: { ...fullExam, revision: 3 } });
        actionMocks.save.mockResolvedValue({ status: "saved", exam: canonical });

        await expect(teacherExamClient.setTeacherExamArchivedFromSummary({ id: fullExam.id }, true)).resolves.toEqual({
            ok: true,
            exam: canonical,
        });
    });

    it("makes an archive retry idempotent after a commit-success response loss", async () => {
        const candidate = (teacherExamClient as Record<string, unknown>).setTeacherExamArchivedFromSummary;
        expect(candidate).toBeTypeOf("function");
        if (typeof candidate !== "function") return;
        let canonical: Exam = { ...fullExam, archived: false };
        actionMocks.load.mockImplementation(async () => ({ status: "loaded", exam: canonical }));
        actionMocks.save.mockImplementationOnce(async (updated: Exam) => {
            canonical = updated;
            return { status: "service_unavailable", error: "response lost" };
        });

        await expect(candidate({ id: fullExam.id }, true)).resolves.toEqual({
            ok: false,
            error: "response lost",
        });
        await expect(candidate({ id: fullExam.id }, true)).resolves.toMatchObject({
            ok: true,
            exam: { archived: true },
        });
        expect(actionMocks.save).toHaveBeenCalledTimes(1);
    });
});
