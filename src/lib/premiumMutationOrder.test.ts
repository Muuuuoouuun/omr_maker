import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("premium mutation authorization order", () => {
    it("uses the final canonical save as the sole exam and advanced-design authorization boundary", () => {
        const createPage = source("src/app/create/page.tsx");
        const save = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        expect(save).toBeGreaterThan(-1);
        expect(createPage).not.toContain("authorizeAdvancedQuestionDesign");
        expect(createPage).not.toContain("authorizeExamCreation");
        expect(createPage).not.toContain("releaseExamCreationAuthorization");
        expect(createPage).toContain('from "@/app/actions/teacherExam"');
    });

    it("does not pre-reserve or compensate plan usage in the browser editor", () => {
        const createPage = source("src/app/create/page.tsx");
        expect(createPage).not.toContain("reservedExamId");
        expect(createPage).not.toContain("advancedQuestionDesignAuthorized");
        expect(createPage).not.toContain("canonicalSaveAttempted");
        expect(createPage).not.toContain("requiresCanonicalReservation");
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

    it("persists the new publish target before upload and keeps it until the canonical save is confirmed", () => {
        const createPage = source("src/app/create/page.tsx");
        const target = createPage.indexOf("getOrCreateNewExamPublishTarget(");
        const upload = createPage.indexOf("await uploadTeacherPdfDirect(");
        const save = createPage.indexOf("await saveTeacherCanonicalExam(examData)");
        const confirmed = createPage.indexOf('serverSave.status === "saved"');
        const clear = createPage.indexOf("clearNewExamPublishTarget(localStore");
        expect(target).toBeGreaterThan(-1);
        expect(upload).toBeGreaterThan(target);
        expect(save).toBeGreaterThan(upload);
        expect(clear).toBeGreaterThan(confirmed);
        expect(createPage).not.toContain("releaseExamCreationAuthorization");
        expect(createPage).toContain("clearNewExamPublishTarget(localStore, draftStorageKey)");
    });

    it("gates legacy asset hydration and serializes a workspace-scoped publish across tabs", () => {
        const createPage = source("src/app/create/page.tsx");
        const hydrationGuard = createPage.indexOf("if (isAssetHydrating)");
        const scopedDraft = createPage.indexOf("scopedExamDraftStorageKey(");
        const lock = createPage.indexOf("await withExclusiveExamPublishLock(");
        const target = createPage.indexOf("getOrCreateNewExamPublishTarget(");
        expect(createPage).toContain("resolveExamEditorLoad(");
        expect(createPage).toContain("readLocalExam");
        expect(createPage).toContain("requiresCanonicalTarget");
        expect(createPage).toContain("requiresCanonicalTarget\n                ? getOrCreateNewExamPublishTarget(");
        expect(createPage).toContain("safeBrowserStorage(() => window.sessionStorage)");
        expect(createPage).toContain("safeBrowserStorage(() => window.localStorage)");
        expect(scopedDraft).toBeGreaterThan(-1);
        expect(lock).toBeGreaterThan(scopedDraft);
        expect(target).toBeGreaterThan(lock);
        expect(hydrationGuard).toBeGreaterThan(-1);
        expect(createPage).not.toContain("authorizeExamCreation");
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

    it("makes account-bound canonical RPCs the sole exam and roster plan mutation boundaries", () => {
        const examAction = source("src/app/actions/teacherExam.ts");
        const rosterAction = source("src/app/actions/teacherRoster.ts");
        expect(examAction).not.toContain("authorizeExamCreation");
        expect(examAction).not.toContain("authorizeAdvancedQuestionDesign");
        expect(examAction).not.toContain("releaseExamCreationAuthorization");
        expect(examAction).toContain("saveTeacherExamWithGateway");
        expect(rosterAction).not.toContain("authorizeRosterStudentSet");
        expect(rosterAction).not.toContain("previous.snapshot.students.map");
        expect(rosterAction).toContain("saveTeacherRosterWithGateway");
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
