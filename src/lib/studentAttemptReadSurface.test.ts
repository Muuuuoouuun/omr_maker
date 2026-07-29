import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("student official attempt read surface", () => {
    it("authorizes list and detail reads only from the signed HttpOnly student session", () => {
        const action = source("src/app/actions/studentAttempts.ts");
        expect(action).toContain("STUDENT_SERVER_SESSION_COOKIE");
        expect(action).toContain("parseSignedStudentSessionCookie");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("listStudentAttemptsWithGateway(context.client, context.session)");
        expect(action).toContain("loadStudentAttemptWithGateway(context.client, attemptId, context.session)");
        expect(action).not.toContain("organizationId: string");
        expect(action).not.toContain("studentId: string");
    });

    it("uses server gateways on dashboard/review and the official history loader", () => {
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const history = source("src/app/student/history/page.tsx");
        const review = source("src/app/student/review/[attemptId]/page.tsx");
        expect(dashboard).toContain("listMyAssignmentsClient({");
        expect(dashboard).toContain("server: () => listMyAssignments()");
        expect(dashboard).toContain("localFallback: async () => readLocalAttempts()");
        expect(dashboard).not.toContain("loadStudentOfficialAttempts(currentUser)");
        expect(dashboard).not.toContain("loadAttemptsForStudent(currentUser)");
        expect(history).toContain("loadStudentOfficialAttempts(currentSession)");
        expect(history).not.toContain("loadAttemptsForStudent(currentSession)");
        expect(review).toContain("loadMyAttemptClient(id, {");
        expect(review).toContain("server: (attemptId) => loadMyAttempt(attemptId)");
        expect(review).toContain("const serverExamPromise = loadExamForReview(id)");
        expect(review).toContain("loadReviewExamClient(found.id, {");
        expect(review).toContain("server: () => serverExamPromise");
        expect(review).toContain("submissionReceiptForAttempt(found, storedReceipt, result.source)");
        expect(review).toContain("saveLocalServerConfirmedAttempt(found)");
        expect(review).toContain('submissionReceipt.prerequisite === "login"');
        expect(review).not.toContain("loadStudentOfficialAttempt(id, session)");
        expect(review).not.toContain("loadAttemptForStudent");
    });

    it("allows local fallback only for guests or explicit development local_only status", () => {
        const client = source("src/lib/studentAttemptClient.ts");
        expect(client).toContain("if (session.isGuest)");
        expect(client).toContain('if (result.status === "local_only")');
        expect(client).toContain("items: []");
        expect(client).not.toContain("loadAttemptsForStudent");
        expect(client).not.toContain("loadAttemptForStudent");
    });

    it("removes publishable-key access to canonical exams and grading tables", () => {
        const migration = source("supabase/migrations/202607140015_student_attempt_read_boundary.sql");
        for (const table of ["omr_exams", "omr_attempts", "omr_question_results"]) {
            expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
            expect(migration).toContain(`grant all on table public.${table} to service_role`);
        }
        expect(migration).toContain('drop policy if exists "OMR exams are publicly readable"');
        expect(migration).toContain('drop policy if exists "OMR attempts are publicly readable"');
        expect(migration).toContain('drop policy if exists "OMR question results are publicly readable"');
    });

    it("replays pending submissions through the purpose-specific server action", () => {
        const flusher = source("src/components/SyncFlusher.tsx");
        const orchestration = source("src/lib/studentSubmissionFlush.ts");
        expect(flusher).toContain("flushPendingSubmissionReceipts");
        expect(flusher).toContain("submitSignedSessionAttempt: submitAttempt");
        expect(flusher).toContain("maintainAndFlushPendingSubmissionReceipts");
        expect(flusher).toContain("window.setTimeout(flush, followUpDelayMs)");
        expect(flusher).toContain("window.clearTimeout(cleanupTimer)");
        expect(flusher).toContain(".catch(() =>");
        expect(flusher).toContain("rerunRequested = true");
        expect(flusher).toContain("if (rerunRequested && !disposed) {");
        expect(flusher).toContain("STUDENT_SESSION_CHANGED_EVENT");
        expect(flusher).toContain('window.addEventListener(STUDENT_SESSION_CHANGED_EVENT, flush)');
        expect(flusher).toContain('window.addEventListener("online", flush)');
        expect(flusher).toContain('if (document.visibilityState === "visible") flush()');
        expect(flusher).toContain("isSubmissionReceiptStorageKey");
        expect(flusher).toContain("const onStorage = (event: StorageEvent) =>");
        expect(flusher).toContain('window.addEventListener("storage", onStorage)');
        expect(flusher).toContain('window.removeEventListener("storage", onStorage)');
        expect(flusher).toContain("queueMaintenance");
        expect(flusher).toContain("cleanupFollowUpDelayMs");
        expect(flusher).not.toContain("SUBMISSION_RECEIPT_ENTRY_PREFIX");
        expect(flusher).not.toContain("SUBMISSION_RECEIPT_ALIAS_PREFIX");
        expect(orchestration).toContain("await dependencies.migrateLegacySubmissionReceipts()");
        expect(orchestration.indexOf("await dependencies.migrateLegacySubmissionReceipts()"))
            .toBeLessThan(orchestration.indexOf("dependencies.pendingSubmissionReceiptIds("));
        expect(flusher).not.toContain("flushPendingAttemptSync");
        expect(flusher).not.toContain("upsertRemoteAttempt");
    });

    it("keeps the manual submission retry control responsive when retry orchestration rejects", () => {
        const review = source("src/app/student/review/[attemptId]/page.tsx");
        const retryHandler = review.slice(
            review.indexOf("const handleSubmissionRetry = async () =>"),
            review.indexOf("const reviewQuestionIds ="),
        );
        expect(retryHandler).toContain("retryPendingSubmissionReceipt");
        expect(retryHandler).toContain("} catch {");
        expect(retryHandler).toContain(
            'setSubmissionRetryFeedback("다시 시도 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.")',
        );
        expect(retryHandler).toContain("setSubmissionRetrying(false)");
    });

    it("marks direct server submissions and official history cache entries as locally confirmed", () => {
        const solve = source("src/app/solve/[id]/page.tsx");
        const historyClient = source("src/lib/studentAttemptClient.ts");
        expect(solve).toContain("saveLocalServerConfirmedAttempt(res.attempt)");
        expect(historyClient).toContain("withLocalServerConfirmation");
        expect(historyClient).toContain("saveLocalAttempts(attempts)");
    });

    it("keeps every shared attempt-index writer behind the same awaited lock", () => {
        const persistence = source("src/lib/omrPersistence.ts");
        expect(persistence).toContain("function deleteLocalExamUnlocked");
        expect(persistence).toContain(
            'return withBrowserStorageLock("attempt-index", () => deleteLocalExamUnlocked(id));',
        );
        expect(persistence).toContain("function saveLocalAttemptsUnlocked");
        expect(persistence).toContain(
            'return withBrowserStorageLock("attempt-index", () => saveLocalAttemptsUnlocked(attempts));',
        );
        expect(persistence).toContain("function replaceLocalAttemptWithCanonicalUnlocked");
        expect(persistence).toContain(
            'rollback: () => withBrowserStorageLock("attempt-index", replacement.rollback)',
        );
        expect(persistence).not.toMatch(/export function (?:saveLocalAttempts|saveLocalAttempt|deleteLocalExam)\(/);

        const solve = source("src/app/solve/[id]/page.tsx");
        const review = source("src/app/student/review/[attemptId]/page.tsx");
        const studentClient = source("src/lib/studentAttemptClient.ts");
        const teacherClient = source("src/lib/teacherAttemptClient.ts");
        expect(solve).toContain("await saveLocalAttempt(cachedAttempt)");
        expect(solve).toContain("await saveLocalServerConfirmedAttempt(res.attempt)");
        expect(review).toContain("await saveLocalServerConfirmedAttempt(found)");
        expect(studentClient).toContain("await saveLocalAttempts(attempts)");
        expect(teacherClient).toContain("await saveLocalAttempts(result.attempts)");
    });

    it("keeps synchronous receipt reads writer-free and reconciliation locks in fixed order", () => {
        const receipts = source("src/lib/studentAttemptReceipt.ts");
        const syncReads = [
            receipts.slice(
                receipts.indexOf("export function readSubmissionReceipt"),
                receipts.indexOf("export function readReconciledSubmissionAttemptId"),
            ),
            receipts.slice(
                receipts.indexOf("export function readReconciledSubmissionAttemptId"),
                receipts.indexOf("function queuePendingSubmissionReceiptUnlocked"),
            ),
            receipts.slice(
                receipts.indexOf("export function pendingSubmissionReceiptIds"),
                receipts.indexOf("function readStudentSessionGeneration"),
            ),
        ].join("\n");
        expect(syncReads).toContain("{ quarantine: false }");
        expect(syncReads).not.toContain("migrateLegacyRegistryUnlocked");
        expect(syncReads).not.toContain("quarantineCorruptValue");
        expect(syncReads).not.toContain(".setItem(");
        expect(syncReads).not.toContain(".removeItem(");

        const persistence = source("src/lib/omrPersistence.ts");
        const transaction = persistence.slice(
            persistence.indexOf("export async function replaceLocalAttemptWithCanonicalTransaction"),
            persistence.indexOf("/** Merge a batch into the local attempt index"),
        );
        expect(transaction).toContain('withBrowserStorageLock("attempt-index"');
        expect(transaction.indexOf("await commit(current)")).toBeLessThan(transaction.indexOf("current.rollback()"));

        const reconciliation = receipts.slice(
            receipts.indexOf("async function persistConfirmedReconciliationUnderAttemptLock"),
            receipts.indexOf("export function retryPendingSubmissionReceipt"),
        );
        expect(reconciliation).toContain('withBrowserStorageLock("submission-receipts"');
        expect(reconciliation).not.toContain('withBrowserStorageLock("attempt-index"');
    });

    it("resets the solve submission gate when local attempt locking fails", () => {
        const solve = source("src/app/solve/[id]/page.tsx");
        const review = source("src/app/student/review/[attemptId]/page.tsx");
        expect(solve).toContain("Local attempt durability failed");
        expect(solve).toContain('"제출 임시저장 실패"');
        expect(solve).toContain("resetFailedSubmission();");
        expect(solve).toContain("await saveDraftSnapshot();");
        expect(review).toContain("Review receipt persistence failed");
    });
});
