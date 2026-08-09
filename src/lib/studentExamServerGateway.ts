import { createHash, randomUUID } from "node:crypto";
import { evaluateExamAccess, examRequiresPin, verifyExamPin } from "@/lib/examAccess";
import {
    buildExamPinRateLimitKey,
    checkExamPinRateLimit,
    recordExamPinFailure,
    recordExamPinSuccess,
} from "@/lib/examPinRateLimit";
import { applyDurableRateLimitToSubjects } from "@/lib/durableRateLimit";
import {
    attemptToSupabaseRow,
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    questionResultRowsForAttempt,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import {
    gradeStudentAttemptOnServer,
    serverGradedAttemptReceiptFromAttempt,
} from "@/lib/serverAttemptGrading";
import {
    createStudentAttemptTicket,
    parseStudentAttemptTicket,
    type StudentAttemptTicketClaims,
} from "@/lib/studentAttemptTicket";
import {
    studentSolveExamFromExam,
    studentExamPreviewFromExam,
    type ServerGradedAttemptReceipt,
    type StudentAttemptSubmission,
    type StudentExamAccessInput,
    type StudentExamAccessResult,
    type StudentExamPreviewResult,
    type VerifiedStudentIdentity,
} from "@/lib/studentExamContract";
import type { Attempt } from "@/types/omr";
import {
    STUDENT_QUESTION_MAX_LENGTH,
    type StudentQuestionInput,
} from "@/lib/studentQuestions";
import { resolveStudentTargetedAssignmentWithGateway } from "@/lib/studentTargetedAssignmentGateway.server";

type Env = Record<string, string | undefined>;

interface VerifiedGuestIdentity {
    organizationId?: string;
    studentId: string;
    studentName: string;
    identityType: "guest";
    guestId: string;
    groupId?: string;
    groupName?: string;
}

type VerifiedExamIdentity = VerifiedStudentIdentity | VerifiedGuestIdentity;

const EXAM_PIN_IDENTITY_POLICY = { limit: 5, windowMs: 5 * 60 * 1000, lockoutMs: 5 * 60 * 1000 };
const EXAM_PIN_GLOBAL_POLICY = { limit: 60, windowMs: 10 * 60 * 1000, lockoutMs: 10 * 60 * 1000 };

interface GatewayQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface GatewaySelectQuery {
    eq(column: string, value: string): GatewaySelectQuery;
    maybeSingle(): Promise<GatewayQueryResult<unknown>>;
}

export interface StudentExamGatewayClient {
    from(table: string): {
        select(columns?: string): GatewaySelectQuery;
    };
    rpc(name: string, params: Record<string, unknown>): Promise<GatewayQueryResult<unknown>>;
}

export interface StudentQuestionGatewayClient {
    rpc(
        name: "omr_upsert_student_attempt_question_v1",
        params: Record<string, unknown>,
    ): Promise<GatewayQueryResult<unknown>>;
}

export type StudentAttemptSubmitResult =
    | { status: "submitted"; receipt: ServerGradedAttemptReceipt }
    | { status: "invalid_ticket" | "not_found" | "invalid_submission" | "service_unavailable"; error?: string };

export type StudentQuestionMutationResult =
    | { status: "saved"; attempt: Attempt }
    | { status: "invalid_request" | "service_unavailable"; error?: string };

export interface UpsertStudentQuestionGatewayInput {
    organizationId: string;
    studentId: string;
    attemptId: string;
    question: StudentQuestionInput;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function studentQuestionMutationId(input: {
    organizationId: string;
    studentId: string;
    attemptId: string;
    questionId: number;
    body: string;
    clientMutationId: string;
}): string {
    return `student-question:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

export async function upsertStudentQuestionWithGateway(
    client: StudentQuestionGatewayClient,
    input: UpsertStudentQuestionGatewayInput,
): Promise<StudentQuestionMutationResult> {
    const organizationId = clean(input.organizationId);
    const studentId = clean(input.studentId);
    const attemptId = clean(input.attemptId);
    const body = clean(input.question?.body);
    const questionId = input.question?.questionId;
    const clientMutationId = clean(input.question?.clientMutationId)
        || `fallback:${questionId}:${body}`;
    if (
        !organizationId || organizationId.length > 200
        || !studentId || studentId.length > 200
        || !attemptId || attemptId.length > 200
        || !Number.isSafeInteger(questionId) || questionId < 1
        || !body || body.length > STUDENT_QUESTION_MAX_LENGTH
        || new TextEncoder().encode(body).byteLength > 2000
        || clientMutationId.length > 200
    ) {
        return { status: "invalid_request" };
    }

    const result = await client.rpc("omr_upsert_student_attempt_question_v1", {
        p_organization_id: organizationId,
        p_owner_student_id: studentId,
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_body: body,
        p_mutation_id: studentQuestionMutationId({
            organizationId,
            studentId,
            attemptId,
            questionId,
            body,
            clientMutationId,
        }),
    });
    if (result.error) {
        return { status: "service_unavailable", error: result.error.message };
    }
    const attempt = storedAttemptFromRpcData(result.data);
    if (!attempt) {
        return { status: "service_unavailable", error: "missing_stored_attempt" };
    }
    if (
        clean(attempt.id) !== attemptId
        || clean(attempt.organizationId) !== organizationId
        || (clean(attempt.studentProfileId) || clean(attempt.studentId)) !== studentId
    ) {
        return { status: "service_unavailable", error: "stored_attempt_scope_mismatch" };
    }
    return { status: "saved", attempt };
}

export async function previewStudentExamWithGateway(
    client: StudentExamGatewayClient,
    examId: string,
): Promise<StudentExamPreviewResult> {
    const normalizedExamId = clean(examId);
    if (!normalizedExamId) return { status: "not_found" };
    const exam = await loadCanonicalExam(client, normalizedExamId);
    if (!exam) return { status: "not_found" };
    if (!clean(exam.organizationId)) return { status: "misconfigured" };
    return { status: "available", exam: studentExamPreviewFromExam(exam) };
}

async function loadCanonicalExam(
    client: StudentExamGatewayClient,
    examId: string,
    organizationId?: string,
) {
    let query = client.from("omr_exams").select("id, organization_id, payload").eq("id", examId);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const result = await query.maybeSingle();
    if (result.error) throw new Error(result.error.message || "Failed to load canonical exam");
    if (!result.data) return null;
    try {
        return examFromSupabaseRow(result.data as SupabaseExamRow);
    } catch {
        return null;
    }
}

export async function openStudentExamWithGateway(
    client: StudentExamGatewayClient,
    input: StudentExamAccessInput,
    env: Env = process.env,
    now = Date.now(),
    verifiedStudent?: VerifiedExamIdentity | null,
    guestSubjectId: string = randomUUID(),
): Promise<StudentExamAccessResult> {
    const examId = clean(input.examId);
    const studentId = clean(input.student?.studentId);
    const studentName = clean(input.student?.studentName);
    if (!examId || !studentId || !studentName) return { status: "login_required" };

    const exam = await loadCanonicalExam(client, examId);
    if (!exam) return { status: "not_found" };
    if (!clean(exam.organizationId)) return { status: "misconfigured" };

    const verifiedGuest = verifiedStudent?.identityType === "guest";
    if (exam.accessConfig?.type === "group" && (!verifiedStudent || verifiedGuest)) {
        return { status: "login_required" };
    }
    const verifiedOrganizationId = clean(verifiedStudent?.organizationId);
    if (
        verifiedStudent
        && (!verifiedGuest || verifiedOrganizationId)
        && verifiedOrganizationId !== clean(exam.organizationId)
    ) {
        return { status: "group_denied" };
    }

    const verifiedGuestId = verifiedGuest ? clean(verifiedStudent.guestId) : "";
    if (
        verifiedGuest
        && (!verifiedGuestId || clean(verifiedStudent.studentId) !== `guest:${verifiedGuestId}`)
    ) {
        return { status: "login_required" };
    }

    const effectiveStudent: {
        studentId: string;
        studentName: string;
        identityType: "guest" | "temporary" | "registered";
        groupId?: string;
        groupName?: string;
        guestId?: string;
    } = verifiedGuest
        ? {
            studentId: `guest:${verifiedGuestId}`,
            studentName: clean(verifiedStudent.studentName) || studentName,
            identityType: "guest" as const,
            guestId: verifiedGuestId,
        }
        : verifiedStudent
            ? {
                ...verifiedStudent,
                groupId: clean(verifiedStudent.groupId) || undefined,
                groupName: clean(verifiedStudent.groupName) || undefined,
            }
            : {
                studentId: `guest:${guestSubjectId}`,
                studentName,
                identityType: "guest" as const,
                guestId: guestSubjectId,
            };

    const requestedAssignmentId = clean(input.assignmentId);
    const requestedAssignmentRevision = Number(input.assignmentRevision);
    if (exam.accessConfig?.type === "targeted" && !requestedAssignmentId) {
        return verifiedGuest || !verifiedStudent ? { status: "login_required" } : { status: "group_denied" };
    }
    let assignmentId: string | undefined;
    let assignmentRetake: StudentExamAccessInput["retake"] | undefined;
    if (requestedAssignmentId) {
        if (!Number.isSafeInteger(requestedAssignmentRevision) || requestedAssignmentRevision < 1) {
            return { status: "group_denied" };
        }
        if (!verifiedStudent || verifiedGuest) return { status: "login_required" };
        const assignment = await resolveStudentTargetedAssignmentWithGateway(
            client,
            {
                kind: "student",
                organizationId: verifiedStudent.organizationId,
                studentId: verifiedStudent.studentId,
                name: verifiedStudent.studentName,
                identityType: verifiedStudent.identityType,
                groupId: verifiedStudent.groupId,
                groupName: verifiedStudent.groupName,
                issuedAt: now,
                expiresAt: now + 1,
            },
            requestedAssignmentId,
            requestedAssignmentRevision,
            exam.id,
        );
        if (assignment.status === "service_unavailable") return { status: "service_unavailable" };
        if (assignment.status !== "authorized") return { status: "group_denied" };
        assignmentId = assignment.assignmentId;
        input = { ...input, assignmentRevision: assignment.assignmentRevision };
        assignmentRetake = assignment.mode === "retake"
            ? { sourceAttemptId: assignment.sourceAttemptId, mode: "wrong", questionIds: assignment.questionIds }
            : undefined;
        if (input.retake && (
            !assignmentRetake
            || clean(input.retake.sourceAttemptId) !== assignmentRetake.sourceAttemptId
            || input.retake.mode !== assignmentRetake.mode
            || [...new Set(input.retake.questionIds)].sort((a, b) => a - b).join(",") !== assignmentRetake.questionIds.join(",")
        )) return { status: "invalid_questions" };
        if (!input.retake && assignmentRetake) input = { ...input, retake: assignmentRetake };
        if (input.retake && !assignmentRetake) return { status: "invalid_questions" };
    }

    const pinProvided = typeof input.pin === "string" && input.pin.trim().length > 0;
    let pinVerified: boolean;
    if (examRequiresPin(exam) && pinProvided) {
        const rateKeys = buildExamPinRateLimitKey(exam.id, effectiveStudent.studentId);
        if (!checkExamPinRateLimit(rateKeys).allowed) return { status: "pin_rate_limited" };
        const globalDecision = await applyDurableRateLimitToSubjects({
            namespace: "exam-pin-global",
            subjects: [rateKeys.globalKey],
            operation: "consume",
            policy: EXAM_PIN_GLOBAL_POLICY,
        });
        if (!globalDecision.allowed) return { status: "pin_rate_limited" };
        const identityDecision = await applyDurableRateLimitToSubjects({
            namespace: "exam-pin-identity",
            subjects: [rateKeys.identityKey],
            operation: "consume",
            policy: EXAM_PIN_IDENTITY_POLICY,
        });
        if (!identityDecision.allowed) {
            await applyDurableRateLimitToSubjects({
                namespace: "exam-pin-global",
                subjects: [rateKeys.globalKey],
                operation: "refund",
                policy: EXAM_PIN_GLOBAL_POLICY,
            });
            return { status: "pin_rate_limited" };
        }

        pinVerified = verifyExamPin(exam, input.pin || "");

        if (pinVerified) {
            recordExamPinSuccess(rateKeys);
            await applyDurableRateLimitToSubjects({
                namespace: "exam-pin-identity",
                subjects: [rateKeys.identityKey],
                operation: "success",
                policy: EXAM_PIN_IDENTITY_POLICY,
            });
            await applyDurableRateLimitToSubjects({
                namespace: "exam-pin-global",
                subjects: [rateKeys.globalKey],
                operation: "refund",
                policy: EXAM_PIN_GLOBAL_POLICY,
            });
        } else {
            recordExamPinFailure(rateKeys);
        }
    } else {
        pinVerified = verifyExamPin(exam, input.pin || "");
    }

    const accessExam = assignmentId ? { ...exam, accessConfig: { type: "targeted" as const } } : exam;
    const decision = evaluateExamAccess(accessExam, {
        now,
        pinVerified,
        session: {
            groupId: effectiveStudent.groupId,
            groupName: effectiveStudent.groupName,
            isGuest: effectiveStudent.identityType === "guest",
            identityType: effectiveStudent.identityType,
        },
    });
    if (decision.status !== "allowed") {
        return {
            status: decision.status,
            ...(decision.at ? { at: decision.at } : {}),
        };
    }

    const requestedQuestionIds = Array.isArray(input.retake?.questionIds)
        ? [...new Set(input.retake.questionIds.filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b)
        : [];
    const questionsById = new Map(exam.questions.map(question => [question.id, question]));
    let activeQuestions = exam.questions;
    let retakeSourceAttemptId: string | undefined;
    let retakeMode: "wrong" | undefined;
    if (input.retake) {
        if (input.retake.mode !== "wrong") return { status: "unsupported_retake" };
        const sourceId = clean(input.retake.sourceAttemptId);
        if (!sourceId) return { status: "invalid_questions" };
        const sourceRead = await client.from("omr_attempts")
            .select("*")
            .eq("id", sourceId)
            .eq("organization_id", exam.organizationId!)
            .eq("exam_id", exam.id)
            .eq("student_id", effectiveStudent.studentId)
            .maybeSingle();
        if (sourceRead.error || !sourceRead.data) return { status: "invalid_questions" };
        let sourceAttempt: Attempt;
        try {
            sourceAttempt = attemptFromSupabaseRow(sourceRead.data as Parameters<typeof attemptFromSupabaseRow>[0]);
        } catch {
            return { status: "invalid_questions" };
        }
        if (sourceAttempt.status !== "completed") return { status: "invalid_questions" };
        const eligibleQuestionIds = [...new Set((sourceAttempt.questionResults || [])
            .filter(result => result.status === "wrong" || result.status === "unanswered")
            .map(result => result.questionId)
            .filter(questionId => questionsById.has(questionId)))]
            .sort((a, b) => a - b);
        if (
            eligibleQuestionIds.length === 0
            || requestedQuestionIds.join(",") !== eligibleQuestionIds.join(",")
        ) return { status: "invalid_questions" };
        activeQuestions = eligibleQuestionIds.map(questionId => questionsById.get(questionId)!).filter(Boolean);
        retakeSourceAttemptId = sourceId;
        retakeMode = "wrong";
    } else if (Array.isArray(input.questionIds) && input.questionIds.length > 0) {
        // A raw subset is not a capability. Retake scope must be tied to a
        // completed, same-owner source attempt above.
        return { status: "invalid_questions" };
    }
    if (
        activeQuestions.length === 0
        || (requestedQuestionIds.length > 0 && activeQuestions.length !== requestedQuestionIds.length)
    ) {
        return { status: "invalid_questions" };
    }

    const ticket = createStudentAttemptTicket({
        examId: exam.id,
        organizationId: exam.organizationId!,
        assignmentId,
        assignmentRevision: assignmentId ? input.assignmentRevision : undefined,
        studentId: effectiveStudent.studentId,
        studentName: effectiveStudent.studentName,
        identityType: effectiveStudent.identityType,
        groupId: effectiveStudent.groupId,
        groupName: effectiveStudent.groupName,
        guestId: effectiveStudent.guestId,
        allowedQuestionIds: activeQuestions.map(question => question.id),
        retakeSourceAttemptId,
        retakeMode,
    }, env, now);
    if (!ticket) return { status: "misconfigured" };

    return {
        status: "allowed",
        exam: studentSolveExamFromExam({ ...exam, questions: activeQuestions }),
        ticket,
    };
}

function storedAttemptFromRpcData(data: unknown): Attempt | null {
    const candidate = Array.isArray(data) ? data[0] : data;
    if (!candidate || typeof candidate !== "object") return null;
    const payload = (candidate as { payload?: unknown }).payload;
    return payload && typeof payload === "object" ? payload as Attempt : null;
}

function storedAttemptMatchesTicket(
    attempt: Attempt,
    ticket: StudentAttemptTicketClaims,
): boolean {
    if (
        clean(attempt.id) !== `attempt_${ticket.ticketId}`
        || clean(attempt.examId) !== clean(ticket.examId)
        || clean(attempt.organizationId) !== clean(ticket.organizationId)
        || clean(attempt.studentId) !== clean(ticket.studentId)
        || clean(attempt.studentName) !== clean(ticket.studentName)
        || attempt.identityType !== ticket.identityType
        || clean(attempt.groupId) !== clean(ticket.groupId)
    ) {
        return false;
    }

    const results = attempt.questionResults;
    if (!Array.isArray(results) || results.length !== ticket.allowedQuestionIds.length) return false;
    const allowedQuestionIds = new Set(ticket.allowedQuestionIds);
    return results.every(result =>
        clean(result.attemptId) === clean(attempt.id)
        && clean(result.examId) === clean(ticket.examId)
        && clean(result.studentId) === clean(ticket.studentId)
        && allowedQuestionIds.delete(result.questionId)
    ) && allowedQuestionIds.size === 0;
}

export async function submitStudentAttemptWithGateway(
    client: StudentExamGatewayClient,
    submission: StudentAttemptSubmission,
    env: Env = process.env,
    now = Date.now(),
): Promise<StudentAttemptSubmitResult> {
    const ticket = parseStudentAttemptTicket(submission.ticket, env, now);
    if (!ticket) return { status: "invalid_ticket" };

    const exam = await loadCanonicalExam(client, ticket.examId, ticket.organizationId);
    if (!exam) return { status: "not_found" };
    const graded = gradeStudentAttemptOnServer(exam, ticket, submission, now);
    if (!graded.ok) return { status: "invalid_submission", error: graded.error };

    const rpcResult = await client.rpc("omr_submit_attempt_v1", {
        p_ticket_id: ticket.ticketId,
        p_attempt: attemptToSupabaseRow(graded.attempt),
        p_question_results: questionResultRowsForAttempt(graded.attempt),
    });
    if (rpcResult.error) {
        return { status: "service_unavailable", error: rpcResult.error.message };
    }

    const storedAttempt = storedAttemptFromRpcData(rpcResult.data);
    if (!storedAttempt) {
        return { status: "service_unavailable", error: "missing_stored_attempt" };
    }
    if (!storedAttemptMatchesTicket(storedAttempt, ticket)) {
        return { status: "service_unavailable", error: "stored_attempt_scope_mismatch" };
    }
    return {
        status: "submitted",
        receipt: serverGradedAttemptReceiptFromAttempt(storedAttempt),
    };
}
