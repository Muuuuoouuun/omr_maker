import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import {
    clientExamFromStudentExamPreview,
    clientExamFromStudentSolveExam,
    studentExamPreviewFromExam,
    studentSolveExamFromExam,
} from "./studentExamContract";

const fullExam: Exam = {
    id: "exam-1",
    title: "중간고사",
    organizationId: "org-secret",
    classId: "class-secret",
    createdByUserId: "teacher-secret",
    createdAt: "2026-07-14T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,answer-key",
    answerKeyPdfRef: { store: "indexeddb", key: "answer-key-secret" },
    pdfData: "data:application/pdf;base64,problem",
    accessConfig: { type: "group", groupIds: ["class-a"], pin: "4321" },
    questions: [{
        id: 1,
        number: 1,
        label: "객관식",
        score: 5,
        answer: 3,
        choices: 5,
        explanation: "정답은 3번",
        tags: { subject: "수학", concept: "비밀 태그" },
        pdfLocation: { page: 1, x: 0.2, y: 0.3 },
        passagePdfRegions: [{ page: 1, x: 0.05, y: 0.08, width: 0.44, height: 0.3 }],
    }],
};

describe("student exam contract", () => {
    it("keeps only solve-safe exam and question fields", () => {
        const dto = studentSolveExamFromExam(fullExam);
        expect(dto).toMatchObject({
            id: "exam-1",
            title: "중간고사",
            pdfData: "data:application/pdf;base64,problem",
            access: { type: "group", requiresPin: true },
            questions: [{
                id: 1,
                number: 1,
                choices: 5,
                passagePdfRegions: [{ page: 1, x: 0.05, y: 0.08, width: 0.44, height: 0.3 }],
            }],
        });

        const serialized = JSON.stringify(dto);
        for (const forbidden of [
            "answerKeyPdf",
            "answerKeyPdfRef",
            "createdByUserId",
            "organizationId",
            "classId",
            "explanation",
            "label",
            "score",
            "tags",
            "비밀 태그",
            "정답은 3번",
            "4321",
            '"answer":3',
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it("keeps the pre-access preview free of questions and PDF content", () => {
        const preview = studentExamPreviewFromExam(fullExam);
        expect(preview).toMatchObject({
            id: "exam-1",
            title: "중간고사",
            questionCount: 1,
            access: { type: "group", requiresPin: true },
        });
        const serialized = JSON.stringify(preview);
        expect(serialized).not.toContain("questions");
        expect(serialized).not.toContain("pdfData");
        expect(serialized).not.toContain("problem");
        expect(clientExamFromStudentExamPreview(preview).questions).toEqual([]);
    });

    it("keeps the client compatibility object solve-safe", () => {
        const clientExam = clientExamFromStudentSolveExam(studentSolveExamFromExam(fullExam));
        expect(JSON.stringify(clientExam)).not.toContain('"answer"');
        expect(JSON.stringify(clientExam)).not.toContain("answerKeyPdf");
        expect(clientExam.accessConfig).toEqual({ type: "group" });
    });

});
