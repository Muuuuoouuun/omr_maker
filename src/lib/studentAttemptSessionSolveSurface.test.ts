import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const solve = () => readFileSync(join(process.cwd(), "src/app/solve/[id]/page.tsx"), "utf8");
const secureSubmissionOutbox = () => readFileSync(
    join(process.cwd(), "src/lib/studentSecureSubmissionOutbox.ts"),
    "utf8",
);

describe("durable multi-device solve surface", () => {
    it("opens and restores the server session before a secure attempt begins", () => {
        const source = solve();
        expect(source).toContain("openDurableStudentAttemptSession");
        expect(source).toContain("session.answers");
        expect(source).toContain("session.subQuestionAnswers");
        expect(source).toContain("remainingAttemptSeconds");
        expect(source).toContain('if (res.source === "server") {\n                    setSecureRemoteMode(true);');
        expect(source).toContain("const durableExam = durable.exam as Exam");
        expect(source).toContain("progressPayload.currentQuestionId");
    });

    it("checkpoints at 5s, heartbeats at 15s, and submits the checkpointed session", () => {
        const source = solve();
        expect(source).toContain("studentAttemptSyncDelayMs");
        expect(source).toContain("checkpointDurableStudentAttemptSession");
        expect(source).toContain("heartbeatDurableStudentAttemptSession");
        expect(source).toContain("submitDurableStudentAttemptSession");
        expect(source).toContain("queueSecureSubmission");
        expect(source).toContain("replaySecureSubmissionsForOwner");
        expect(secureSubmissionOutbox()).toContain("finalCheckpoint: true");
    });

    it("staggers recurring lease traffic and skips heartbeat after a recent successful checkpoint", () => {
        const source = solve();
        expect(source).toContain("studentAttemptSyncDelayMs");
        expect(source).toContain("shouldSendStudentAttemptHeartbeat");
        expect(source).toContain("shouldDeferHeartbeatForCheckpoint");
        expect(source).toContain("leaseRenewedAtAfterSyncResult");
        expect(source).toContain("lastCheckpointLeaseRenewedAtRef");
        expect(source).toContain("checkpointStartedAtRef");
        expect(source).toContain('studentAttemptSyncDelayMs(current.session.sessionId, "checkpoint")');
        expect(source).toContain('studentAttemptSyncDelayMs(current.session.sessionId, "heartbeat")');
        expect(source).not.toContain("window.setInterval(async () =>");
    });

    it("reuses only same-tab lease capability and clears it on submit or logout", () => {
        const source = solve();
        expect(source).toContain("readDurableAttemptResumeCredential(window.sessionStorage, resumeKey)");
        expect(source).toContain("currentLeaseToken: storedResume?.leaseToken");
        expect(source).toContain("writeDurableAttemptResumeCredential(window.sessionStorage, resumeKey");
        expect(source).toContain("STUDENT_SESSION_CHANGED_EVENT");
        expect(source).toContain("clearDurableAttemptResumeCredential(window.sessionStorage, durableResumeKeyRef.current)");
    });

    it("binds drafts, drawings, and resume credentials to the same exact assignment-generation tuple", () => {
        const source = solve();
        expect(source).toContain("studentAssignmentDraftStorageKey");
        expect(source).toContain("migrateLegacyStudentDraftStorage");
        expect(source).toContain("buildLegacyStudentDraftRecoveryExport");
        expect(source).toContain("이전 임시저장 내보내기");
        expect(source).toContain("URL.createObjectURL");
        expect(source).toContain("ownerStudentId: session.studentId");
        expect(source).toContain("sessionGeneration: recoverySessionGeneration");
        expect(source).toContain("sharedIdentityEpoch: recoverySharedIdentityEpoch");
        expect(source).toContain("examId: id");
        expect(source).toContain("legacyDraftRecoveryExport.examId === id");
        expect(source).toContain("isCurrentLegacyStudentDraftRecovery");
        expect(source).toContain("getStudentSessionGeneration()");
        expect(source).toContain("getStudentSharedIdentityEpoch()");
        expect(source).toContain("STUDENT_SHARED_IDENTITY_EPOCH_KEY");
        expect(source).toContain("setLegacyDraftRecoveryExport(null)");
        expect(source).toContain("STUDENT_SESSION_KEY");
        expect(source).toContain('window.addEventListener("storage"');
        expect(source).toContain("안전한 내보내기 형식으로 확인할 수 없습니다");
        expect(source).not.toContain("resolveLegacyStudentDraftScope");
        expect(source).toContain("legacySegmentedDraftKey");
        expect(source).toContain("이전 임시저장 복구 필요");
        expect(source).toContain("assignmentRevision");
        expect(source).toContain("scopeBinding: DRAFT_KEY");
        expect(source).toContain("draft.scopeBinding !== scopedDraftKey");
        expect(source).toContain("saveJsonRecord(`draft:${encodeURIComponent(DRAFT_KEY)}:drawings`");
        expect(source).toContain("durableAttemptResumeKey({");
        const targetedRestore = source.slice(source.indexOf("const DRAFT_KEY"), source.indexOf("const OMR_PANEL_KEY"));
        expect(targetedRestore).not.toContain("omr_draft_${id}_${draftOwnerKey}");
    });

    it("keeps PIN-authenticated server exams on the durable path", () => {
        const source = solve();
        const pinSuccess = source.slice(source.indexOf('if (res.status === "ok" && res.exam) {'));
        expect(pinSuccess).toContain('if (res.source === "server") {');
        expect(pinSuccess).toContain("setSecureRemoteMode(true)");
        expect(pinSuccess).toContain("setSecureRequiresPin(true)");
    });

    it("requires an explicit takeover and explains guest device risk", () => {
        const source = solve();
        expect(source).toContain("takeoverDurableStudentAttemptSession");
        expect(source).toContain("다른 기기에서 계속하기");
        expect(source).toContain("게스트 응시는 브라우저 쿠키를 지우거나 다른 브라우저를 사용하면");
    });
});
