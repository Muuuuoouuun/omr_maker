import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    examHasAttachedPdf,
    isTeacherPreviewRequested,
    shouldOfferStudentPdfOpen,
    shouldOfferTeacherPreview,
    teacherPreviewHref,
} from "./solveToolsVisibility";

describe("solve tools visibility", () => {
    it("offers the teacher preview only to a teacher session or an explicit preview link", () => {
        expect(shouldOfferTeacherPreview({ hasTeacherSession: false, search: "" })).toBe(false);
        expect(shouldOfferTeacherPreview({ hasTeacherSession: false, search: "?class=A1" })).toBe(false);
        expect(shouldOfferTeacherPreview({ hasTeacherSession: false, search: "?preview=student" })).toBe(false);
        expect(shouldOfferTeacherPreview({ hasTeacherSession: false, search: "?preview=teacher" })).toBe(true);
        expect(shouldOfferTeacherPreview({ hasTeacherSession: false, search: "?class=A1&preview=teacher" })).toBe(true);
        expect(shouldOfferTeacherPreview({ hasTeacherSession: true, search: "" })).toBe(true);
    });

    it("builds the teacher preview link that the solve page recognizes", () => {
        const href = teacherPreviewHref("exam 1");
        expect(href).toBe("/solve/exam%201?preview=teacher");
        expect(isTeacherPreviewRequested(href.slice(href.indexOf("?")))).toBe(true);
    });

    it("offers the student PDF picker only when the exam has no attached PDF", () => {
        expect(shouldOfferStudentPdfOpen({})).toBe(true);
        expect(shouldOfferStudentPdfOpen(null)).toBe(true);
        expect(shouldOfferStudentPdfOpen({ pdfData: "data:application/pdf;base64,AAAA" })).toBe(false);
        expect(shouldOfferStudentPdfOpen({ pdfDataRef: { store: "indexeddb", key: "exam:1:pdf" } })).toBe(false);
        expect(examHasAttachedPdf({ pdfData: "" })).toBe(false);
    });

    it("gates the solve page tools and keeps the empty-state picker input mounted", () => {
        const solvePage = readFileSync(path.join(process.cwd(), "src/app/solve/[id]/page.tsx"), "utf8");
        expect(solvePage).toContain("{(teacherPreviewOffered || isTeacherMode) && (");
        expect(solvePage).toContain(") : studentPdfOpenOffered ? (");
        expect(solvePage).toContain('id="pdf-upload-input"');
        expect(solvePage).toContain('emptyStateAudience={isTeacherMode ? "editor" : "student"}');
        const viewer = readFileSync(path.join(process.cwd(), "src/components/PDFViewer.tsx"), "utf8");
        const studentCopy = viewer.slice(viewer.indexOf("    student: {"), viewer.indexOf("};", viewer.indexOf("    student: {")));
        expect(studentCopy).toContain("문제지 PDF 열기");
        expect(studentCopy).not.toContain("정답");
    });
});
