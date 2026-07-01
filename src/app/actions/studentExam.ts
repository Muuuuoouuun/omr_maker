"use server";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { parseSignedStudentSessionCookie, STUDENT_SERVER_SESSION_COOKIE, type StudentServerIdentity } from "@/lib/studentServerSession";
import { getSupabaseServerConfigFromEnv, createSupabaseAdminClient, fetchAttemptRowsByOwner, fetchExamRowById, type SupabaseAdminClientLike, type SupabaseAdminReadClientLike } from "@/lib/supabaseServerAdmin";
import { attemptFromSupabaseRow, examFromSupabaseRow, attemptToSupabaseRow, questionResultRowsForAttempt } from "@/lib/omrPersistence";
import { evaluateExamAccess } from "@/lib/examAccess";
import { stripExamForSolving, type SolvableExam } from "@/lib/examSolvePayload";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, ownerStudentId, type SubmitAttemptInput } from "@/lib/studentExamCore";
import type { Attempt } from "@/types/omr";

type Status = "ok" | "unauthenticated" | "degraded_local" | "denied" | "error";

async function currentIdentity(): Promise<StudentServerIdentity | null> {
    const cookieStore = await cookies();
    return parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
}

type AdminClient = SupabaseAdminClientLike & SupabaseAdminReadClientLike;
function adminOrNull(): AdminClient | null {
    const config = getSupabaseServerConfigFromEnv();
    return config ? (createSupabaseAdminClient(config) as unknown as AdminClient) : null;
}

function pinOk(exam: { accessConfig?: { pin?: string } }, pin?: string): boolean {
    return !exam.accessConfig?.pin || (!!pin && pin === exam.accessConfig.pin);
}

export interface SolveLoadResult {
    status: Status | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived";
    exam?: SolvableExam;
}

export async function loadExamForSolving(examId: string, pin?: string): Promise<SolveLoadResult> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };

    const row = await fetchExamRowById(admin, examId);
    if (!row) return { status: "ended" };
    const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);

    const access = evaluateExamAccess(exam, { session: identityAccessSession(identity), pinVerified: pinOk(exam, pin) });
    if (access.status !== "allowed") return { status: access.status };
    return { status: "ok", exam: stripExamForSolving(exam) };
}

export async function submitAttempt(input: SubmitAttemptInput, pin?: string): Promise<{ status: Status; attempt?: Attempt }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };

    const row = await fetchExamRowById(admin, input.examId);
    if (!row) return { status: "error" };
    const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);

    const access = evaluateExamAccess(exam, { session: identityAccessSession(identity), pinVerified: pinOk(exam, pin) });
    if (access.status !== "allowed") return { status: "denied" };

    const attempt = buildServerAttempt(input, exam, identity, randomUUID(), new Date().toISOString());
    const attemptResult = await admin.from("omr_attempts").upsert(attemptToSupabaseRow(attempt));
    if (attemptResult.error) return { status: "error" };
    const resultRows = questionResultRowsForAttempt(attempt);
    if (resultRows.length > 0) {
        const qrResult = await admin.from("omr_question_results").upsert(resultRows);
        if (qrResult.error) return { status: "error" };
    }
    return { status: "ok", attempt };
}

export async function listMyAssignments(): Promise<{ status: Status; attempts?: Attempt[] }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: ownerStudentId(identity) });
    const attempts = rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .filter((a): a is Attempt => !!a && attemptOwnedBy(a, identity));
    return { status: "ok", attempts };
}

export async function loadMyAttempt(attemptId: string): Promise<{ status: Status; attempt?: Attempt }> {
    const identity = await currentIdentity();
    if (!identity) return { status: "unauthenticated" };
    const admin = adminOrNull();
    if (!admin) return { status: "degraded_local" };
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: ownerStudentId(identity) });
    const match = rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .find(a => !!a && a.id === attemptId && attemptOwnedBy(a, identity));
    return match ? { status: "ok", attempt: match } : { status: "denied" };
}
