import type { Attempt, Exam } from "@/types/omr";
import type { SolvableExam } from "@/lib/examSolvePayload";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";

/**
 * Client-side wrapper over the student exam server actions.
 *
 * Policy: the server boundary is the primary path (answer-less exam payload,
 * server grading, ownership-scoped reads). The local path is a *fallback only*,
 * and it is restricted to data already on the device — it must never fetch the
 * full exam (with answers) from Supabase, otherwise clearing the session cookie
 * would become an answer-key oracle.
 *
 * Fallback triggers:
 * - `degraded_local` — server has no Supabase config (dev / self-hosted local).
 * - `not_found`      — exam/attempt exists only on this device (offline-created,
 *                      e2e-seeded, or never synced).
 * - thrown error     — network failure (offline PWA solving a cached exam).
 *
 * NOT a fallback trigger:
 * - `denied` — the server explicitly refused (production without the service
 *   role, or an ownership denial). Falling back to the on-device copy here would
 *   bypass the fail-closed policy (설계 §8: 명시적 denied 응답은 로컬 폴백으로
 *   우회하지 않는다), so `denied` is always surfaced as a hard stop.
 */

export type SolveAccessStatus =
    | "ok"
    | "unauthenticated"
    | "pin_required"
    | "pin_rate_limited"
    | "login_required"
    | "group_denied"
    | "not_started"
    | "ended"
    | "archived"
    | "not_found"
    | "denied"
    | "error";

export type ExamSource = "server" | "local";

export interface LoadExamClientResult {
    status: SolveAccessStatus;
    exam?: Exam | SolvableExam;
    source: ExamSource;
}

export interface SubmitClientResult {
    status: SolveAccessStatus;
    attempt?: Attempt;
    source: ExamSource;
}

export interface ListAttemptsClientResult {
    status: "ok" | "denied" | "error";
    attempts: Attempt[];
    source: ExamSource;
}

export interface LoadAttemptClientResult {
    status: "ok" | "denied" | "error";
    attempt?: Attempt;
    source: ExamSource;
}

interface ServerLoadResponse {
    status: string;
    exam?: SolvableExam;
}

interface ServerSubmitResponse {
    status: string;
    attempt?: Attempt;
}

const LOAD_STATUSES: SolveAccessStatus[] = [
    "ok", "unauthenticated", "pin_required", "pin_rate_limited", "login_required",
    "group_denied", "not_started", "ended", "archived", "not_found", "denied", "error",
];

function asLoadStatus(status: string): SolveAccessStatus {
    return (LOAD_STATUSES as string[]).includes(status) ? status as SolveAccessStatus : "error";
}

function shouldFallBackToLocal(status: string): boolean {
    return status === "degraded_local" || status === "not_found";
}

export async function loadExamForSolvingClient(
    examId: string,
    pin: string | undefined,
    deps: {
        server: (examId: string, pin?: string) => Promise<ServerLoadResponse>;
        /** Local-only read (no remote fetch) — e.g. omrPersistence.readLocalExam. */
        readLocalExam: (examId: string) => Exam | null;
        /** Client-side access evaluation for the local path. Returns a load status. */
        evaluateLocalAccess: (exam: Exam) => SolveAccessStatus;
    },
): Promise<LoadExamClientResult> {
    let serverStatus = "error";
    try {
        const res = await deps.server(examId, pin);
        serverStatus = res.status;
        if (!shouldFallBackToLocal(res.status)) {
            // Includes "denied": surfaced as-is, never bypassed via the local copy.
            return { status: asLoadStatus(res.status), exam: res.exam, source: "server" };
        }
    } catch {
        serverStatus = "degraded_local";
    }

    const local = deps.readLocalExam(examId);
    if (!local) {
        return { status: serverStatus === "not_found" ? "not_found" : "error", source: "local" };
    }
    // The local exam still carries answers on-device (it always did); the page
    // gates access with the same client evaluation used before the server path.
    return { status: deps.evaluateLocalAccess(local), exam: local, source: "local" };
}

export async function submitAttemptClient(
    input: SubmitAttemptInput,
    pin: string | undefined,
    deps: {
        server: (input: SubmitAttemptInput, pin?: string) => Promise<ServerSubmitResponse>;
        /** Grades and persists locally (existing client path). Null on failure. */
        localFallback: (input: SubmitAttemptInput) => Promise<Attempt | null>;
        /**
         * Local grading needs the full exam (with answers) on this device. A
         * server-sourced solve session must NOT grade locally — the payload has
         * no answers, so every question would come back ungraded.
         */
        allowLocalFallback: boolean;
    },
): Promise<SubmitClientResult> {
    let serverStatus = "error";
    try {
        const res = await deps.server(input, pin);
        serverStatus = res.status;
        if (res.status === "ok" && res.attempt) {
            return { status: "ok", attempt: res.attempt, source: "server" };
        }
        if (!shouldFallBackToLocal(res.status)) {
            // Includes "denied": the answers stay in the on-device draft, but the
            // submit is NOT silently downgraded to a local-graded attempt.
            return { status: asLoadStatus(res.status), source: "server" };
        }
    } catch {
        serverStatus = "degraded_local";
    }

    if (!deps.allowLocalFallback) {
        return { status: serverStatus === "not_found" ? "not_found" : "error", source: "server" };
    }
    const attempt = await deps.localFallback(input);
    return attempt
        ? { status: "ok", attempt, source: "local" }
        : { status: "error", source: "local" };
}

export async function listMyAssignmentsClient(deps: {
    server: () => Promise<{ status: string; attempts?: Attempt[] }>;
    localFallback: () => Promise<Attempt[]>;
}): Promise<ListAttemptsClientResult> {
    try {
        const res = await deps.server();
        if (res.status === "ok" && res.attempts) {
            return { status: "ok", attempts: res.attempts, source: "server" };
        }
        if (res.status === "denied") {
            // Fail-closed production refusal: no local list, no silent degradation.
            return { status: "denied", attempts: [], source: "server" };
        }
    } catch {
        // fall through to local
    }
    try {
        return { status: "ok", attempts: await deps.localFallback(), source: "local" };
    } catch {
        return { status: "error", attempts: [], source: "local" };
    }
}

export interface LoadReviewExamClientResult {
    status: "ok" | "denied" | "error";
    exam?: Exam;
    source: ExamSource;
}

/**
 * Post-submit review exam: server-first (PIN/answer-key PDF withheld
 * server-side), falling back to the existing client exam load for degraded,
 * unsynced, or offline setups. An explicit `denied` stops here — the review
 * payload contains the full answer key, so a denied response must never be
 * satisfied from the local copy.
 */
export async function loadReviewExamClient(
    attemptId: string,
    deps: {
        server: (attemptId: string) => Promise<{ status: string; exam?: unknown }>;
        localFallback: () => Promise<Exam | null>;
    },
): Promise<LoadReviewExamClientResult> {
    try {
        const res = await deps.server(attemptId);
        if (res.status === "ok" && res.exam) {
            return { status: "ok", exam: res.exam as Exam, source: "server" };
        }
        if (res.status === "denied") {
            return { status: "denied", source: "server" };
        }
    } catch {
        // fall through to local
    }
    try {
        const local = await deps.localFallback();
        if (local) return { status: "ok", exam: local, source: "local" };
    } catch {
        // fall through
    }
    return { status: "error", source: "local" };
}

export async function loadMyAttemptClient(
    attemptId: string,
    deps: {
        server: (attemptId: string) => Promise<{ status: string; attempt?: Attempt }>;
        /** Local-only read; the caller applies its own client-side ownership check. */
        localFallback: (attemptId: string) => Promise<Attempt | null>;
    },
): Promise<LoadAttemptClientResult> {
    try {
        const res = await deps.server(attemptId);
        if (res.status === "ok" && res.attempt) {
            return { status: "ok", attempt: res.attempt, source: "server" };
        }
        if (res.status === "denied") {
            // Ownership denial (or fail-closed production): hard stop, no local read.
            return { status: "denied", source: "server" };
        }
    } catch {
        // fall through to local
    }
    try {
        const local = await deps.localFallback(attemptId);
        if (local) return { status: "ok", attempt: local, source: "local" };
    } catch {
        // fall through
    }
    return { status: "error", source: "local" };
}
