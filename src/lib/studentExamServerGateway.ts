import { randomUUID } from "node:crypto";
import { evaluateExamAccess, verifyExamPin } from "@/lib/examAccess";
import {
    attemptToSupabaseRow,
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

type Env = Record<string, string | undefined>;

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

export type StudentAttemptSubmitResult =
    | { status: "submitted"; receipt: ServerGradedAttemptReceipt }
    | { status: "invalid_ticket" | "not_found" | "invalid_submission" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
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
    verifiedStudent?: VerifiedStudentIdentity | null,
    guestSubjectId = randomUUID(),
): Promise<StudentExamAccessResult> {
    const examId = clean(input.examId);
    const studentId = clean(input.student?.studentId);
    const studentName = clean(input.student?.studentName);
    if (!examId || !studentId || !studentName) return { status: "login_required" };

    const exam = await loadCanonicalExam(client, examId);
    if (!exam) return { status: "not_found" };
    if (!clean(exam.organizationId)) return { status: "misconfigured" };

    if (exam.accessConfig?.type === "group" && !verifiedStudent) {
        return { status: "login_required" };
    }
    if (verifiedStudent && clean(verifiedStudent.organizationId) !== clean(exam.organizationId)) {
        return { status: "group_denied" };
    }

    const effectiveStudent: {
        studentId: string;
        studentName: string;
        identityType: "guest" | "temporary" | "registered";
        groupId?: string;
        groupName?: string;
        guestId?: string;
    } = verifiedStudent
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

    const decision = evaluateExamAccess(exam, {
        now,
        pinVerified: verifyExamPin(exam, input.pin || ""),
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

    const requestedQuestionIds = Array.isArray(input.questionIds)
        ? [...new Set(input.questionIds.filter(value => Number.isInteger(value) && value > 0))]
        : [];
    const questionsById = new Map(exam.questions.map(question => [question.id, question]));
    const activeQuestions = requestedQuestionIds.length > 0
        ? requestedQuestionIds.map(questionId => questionsById.get(questionId)).filter(question => !!question)
        : exam.questions;
    if (
        activeQuestions.length === 0
        || (requestedQuestionIds.length > 0 && activeQuestions.length !== requestedQuestionIds.length)
    ) {
        return { status: "invalid_questions" };
    }

    const ticket = createStudentAttemptTicket({
        examId: exam.id,
        organizationId: exam.organizationId!,
        studentId: effectiveStudent.studentId,
        studentName: effectiveStudent.studentName,
        identityType: effectiveStudent.identityType,
        groupId: effectiveStudent.groupId,
        groupName: effectiveStudent.groupName,
        guestId: effectiveStudent.guestId,
        allowedQuestionIds: activeQuestions.map(question => question.id),
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
