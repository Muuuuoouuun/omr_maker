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

    it("keeps a new exam as an upload intent until the final atomic canonical save", () => {
        const createPage = source("src/app/create/page.tsx");
        const firstAssetUpload = createPage.indexOf("await uploadTeacherPdfDirect(");
        const finalSave = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        expect(firstAssetUpload).toBeGreaterThan(-1);
        expect(finalSave).toBeGreaterThan(firstAssetUpload);
        expect(createPage).not.toContain("skeletonSave");
        expect(createPage).not.toContain("createdCanonicalSkeleton");
        expect(createPage).not.toContain("deleteTeacherCanonicalExam");
    });

    it("persists the new publish target before quota/upload and keeps it after ambiguous save failure", () => {
        const createPage = source("src/app/create/page.tsx");
        const target = createPage.indexOf("getOrCreateNewExamPublishTarget(");
        const quota = createPage.indexOf("await authorizeExamCreation(id)");
        const upload = createPage.indexOf("await uploadTeacherPdfDirect(");
        const saveAttempt = createPage.indexOf("canonicalSaveAttempted = true");
        const save = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        const confirmed = createPage.indexOf('serverSave.status === "saved"');
        const clear = createPage.indexOf("clearNewExamPublishTarget(localStore");
        expect(target).toBeGreaterThan(-1);
        expect(quota).toBeGreaterThan(target);
        expect(upload).toBeGreaterThan(quota);
        expect(saveAttempt).toBeGreaterThan(upload);
        expect(save).toBeGreaterThan(saveAttempt);
        expect(clear).toBeGreaterThan(confirmed);
        expect(createPage).toContain("reservedExamId && !canonicalSaveAttempted");
    });

    it("gates legacy asset hydration and serializes a workspace-scoped publish across tabs", () => {
        const createPage = source("src/app/create/page.tsx");
        const hydrationGuard = createPage.indexOf("if (isAssetHydrating)");
        const scopedDraft = createPage.indexOf("scopedExamDraftStorageKey(");
        const lock = createPage.indexOf("await withExclusiveExamPublishLock(");
        const target = createPage.indexOf("getOrCreateNewExamPublishTarget(");
        const quota = createPage.indexOf("await authorizeExamCreation(id)");
        expect(createPage).toContain("resolveExamEditorLoad(");
        expect(createPage).toContain("readLocalExam");
        expect(createPage).toContain("requiresCanonicalReservation");
        expect(createPage).toContain("requiresCanonicalReservation\n                ? getOrCreateNewExamPublishTarget(");
        expect(createPage).toContain("safeBrowserStorage(() => window.sessionStorage)");
        expect(createPage).toContain("safeBrowserStorage(() => window.localStorage)");
        expect(scopedDraft).toBeGreaterThan(-1);
        expect(lock).toBeGreaterThan(scopedDraft);
        expect(target).toBeGreaterThan(lock);
        expect(hydrationGuard).toBeGreaterThan(-1);
        expect(quota).toBeGreaterThan(target);
        expect(createPage).not.toContain("tryAcquireNewExamPublishLock");
        expect(createPage).not.toContain("releaseNewExamPublishLock");
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
