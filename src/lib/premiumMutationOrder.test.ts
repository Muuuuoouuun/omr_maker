import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("premium mutation authorization order", () => {
    it("authorizes outgoing subquestions before any exam persistence", () => {
        const createPage = source("src/app/create/page.tsx");
        const entitlement = createPage.indexOf("await authorizeAdvancedQuestionDesign()");
        const save = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        expect(entitlement).toBeGreaterThan(-1);
        expect(save).toBeGreaterThan(entitlement);
        expect(createPage).toContain('from "@/app/actions/teacherExam"');
    });

    it("checks every outgoing edit that retains paid subquestions", () => {
        const createPage = source("src/app/create/page.tsx");
        expect(createPage).toContain("questionsWithRegions.some(question => (question.subQuestions?.length || 0) > 0)");
        expect(createPage).toContain("Fail closed before any exam or asset persistence");
        expect(createPage).toContain("await releaseExamCreationAuthorization(reservedExamId)");
    });

    it("creates the canonical exam owner before uploading new remote PDF metadata", () => {
        const createPage = source("src/app/create/page.tsx");
        const skeletonSave = createPage.indexOf("const skeletonSave = await saveTeacherCanonicalExam(");
        const firstAssetUpload = createPage.indexOf("const remote = await uploadTeacherExamAsset(formData)");
        expect(skeletonSave).toBeGreaterThan(-1);
        expect(firstAssetUpload).toBeGreaterThan(skeletonSave);
        expect(createPage).toContain("await deleteTeacherCanonicalExam(id)");
        expect(createPage).toContain("createdCanonicalSkeleton");
    });

    it("only compensates shared-AI reservations before provider cost can begin", () => {
        const aiAction = source("src/app/actions/analyzeKey.ts");
        const reserve = aiAction.indexOf("await authorizeSharedAiRecognition(sharedAiRequestId)");
        const providerCallMarker = aiAction.indexOf("onProviderCall();");
        const providerCall = aiAction.indexOf("await model.generateContent(");
        const release = aiAction.indexOf("await releaseSharedAiRecognition(sharedAiRequestId)");
        expect(providerCallMarker).toBeGreaterThan(-1);
        expect(providerCall).toBeGreaterThan(providerCallMarker);
        expect(aiAction).toContain("sharedAiRequestId && !providerCallStarted");
        expect(release).toBeGreaterThan(reserve);
        expect(aiAction.lastIndexOf("catch (error: unknown)")).toBeLessThan(release);
    });

    it("rechecks exam and roster plan rules inside canonical server actions", () => {
        const examAction = source("src/app/actions/teacherExam.ts");
        const rosterAction = source("src/app/actions/teacherRoster.ts");
        expect(examAction).toContain("await authorizeExamCreation(exam.id)");
        expect(examAction).toContain("await authorizeAdvancedQuestionDesign()");
        expect(rosterAction).toContain("await authorizeRosterStudentSet(snapshot.students.map(student => student.id))");
        expect(rosterAction).toContain("previous.snapshot.students.map(student => student.id)");
    });

    it("enforces plan limits within the canonical database write transaction", () => {
        const migration = source("supabase/migrations/202607180001_critical_release_guards.sql");
        expect(migration).toContain("public.omr_reserve_plan_usage(");
        expect(migration).toContain("raise exception 'plan exam limit exceeded'");
        expect(migration).toContain("raise exception 'plan entitlement required'");
        expect(migration).toContain("public.omr_sync_student_plan_usage(");
        expect(migration).toContain("raise exception 'plan student limit exceeded'");
        expect(migration).toContain("return public.omr_save_exam_plan_unlocked_v1");
        expect(migration).toContain("return public.omr_save_roster_plan_unlocked_v1");
    });
});
