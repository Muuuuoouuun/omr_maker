import { expect, type APIResponse, type Page, type Request } from "@playwright/test";
import { exactNextActionId } from "../helpers";
import { buildTeacherCanonicalAnalyticsSnapshotMap } from "../../src/lib/teacherCanonicalAnalyticsSnapshot.server";
import { gradeStudentAttemptOnServer } from "../../src/lib/serverAttemptGrading";
import type { SubmitAttemptInput } from "../../src/lib/studentExamCore";
import {
    parseSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentServerIdentity,
} from "../../src/lib/studentServerSession";
import type { RosterSnapshot } from "../../src/lib/rosterPersistence";
import { INITIAL_OPERATIONS_LIMITS } from "../../src/lib/initialOperationsPolicy";
import type { Attempt, Exam } from "../../src/types/omr";

interface ActionReplacement {
    upstream: Record<string, unknown>;
    replacement: unknown;
}

type ActionHandler = (
    request: Request,
    response: APIResponse,
    body: string,
) => ActionReplacement | Promise<ActionReplacement>;

function isConnectionReset(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: unknown }).code;
    return code === "ECONNRESET" || /\bECONNRESET\b/.test(error.message);
}

export async function canonicalFixtureFetchUpstream<T>(
    fetchUpstream: () => Promise<T>,
    readOnly: boolean,
): Promise<T> {
    try {
        return await fetchUpstream();
    } catch (error) {
        if (!readOnly || !isConnectionReset(error)) throw error;
        return fetchUpstream();
    }
}

const E2E_STUDENT_SESSION_ENV = {
    NODE_ENV: "test",
    STUDENT_SESSION_SECRET: "omr-maker-e2e-student-session-secret-2026",
};

function ownObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function visit(value: unknown, predicate: (candidate: Record<string, unknown>) => boolean): Record<string, unknown> | null {
    if (ownObject(value)) {
        if (predicate(value)) return value;
        for (const child of Object.values(value)) {
            const found = visit(child, predicate);
            if (found) return found;
        }
    } else if (Array.isArray(value)) {
        for (const child of value) {
            const found = visit(child, predicate);
            if (found) return found;
        }
    }
    return null;
}

function parseJsonCandidates(raw: string): unknown[] {
    const values: unknown[] = [];
    const candidates = [raw, ...raw.split(/\r?\n/).map(line => line.slice(line.indexOf(":") + 1))];
    for (const candidate of candidates) {
        const trimmed = candidate.trim();
        if (!trimmed || !/[\[{]/.test(trimmed[0])) continue;
        try {
            values.push(JSON.parse(trimmed));
        } catch {
            // Flight lines that are references rather than JSON values are ignored.
        }
    }
    return values;
}

function decodeFlightValue(value: unknown): unknown {
    if (value === "$undefined") return undefined;
    if (Array.isArray(value)) return value.map(decodeFlightValue);
    if (!ownObject(value)) return value;
    const decoded: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        const decodedChild = decodeFlightValue(child);
        if (decodedChild !== undefined) decoded[key] = decodedChild;
    }
    return decoded;
}

function isRosterSnapshot(value: unknown): value is RosterSnapshot {
    return ownObject(value)
        && Array.isArray(value.students)
        && Array.isArray(value.groups)
        && Array.isArray(value.invites);
}

function rosterSaveTuple(value: unknown): { snapshot: RosterSnapshot; expectedRevision: number | null } | null {
    const decoded = decodeFlightValue(value);
    if (Array.isArray(decoded)) {
        for (let index = 0; index < decoded.length - 1; index += 1) {
            const snapshot = decoded[index];
            const expectedRevision = decoded[index + 1];
            if (
                isRosterSnapshot(snapshot)
                && (expectedRevision === null || (Number.isSafeInteger(expectedRevision) && Number(expectedRevision) >= 0))
            ) {
                return { snapshot, expectedRevision: expectedRevision === null ? null : Number(expectedRevision) };
            }
        }
        for (const child of decoded) {
            const found = rosterSaveTuple(child);
            if (found) return found;
        }
    } else if (ownObject(decoded)) {
        for (const child of Object.values(decoded)) {
            const found = rosterSaveTuple(child);
            if (found) return found;
        }
    }
    return null;
}

export function canonicalFixtureRosterSaveArguments(
    raw: string,
): { snapshot: RosterSnapshot; expectedRevision: number | null } {
    for (const value of parseJsonCandidates(raw)) {
        const found = rosterSaveTuple(value);
        if (found) return found;
    }
    throw new Error("canonical fixture could not decode roster save arguments");
}

export function canonicalFixtureRosterSaveTransition(
    raw: string,
    currentRevision: number,
): { status: "saved"; snapshot: RosterSnapshot; revision: number } | { status: "conflict"; error: string } {
    const { snapshot, expectedRevision } = canonicalFixtureRosterSaveArguments(raw);
    if (
        snapshot.students.length > INITIAL_OPERATIONS_LIMITS.students
        || snapshot.groups.length > INITIAL_OPERATIONS_LIMITS.classes
        || snapshot.invites.length > INITIAL_OPERATIONS_LIMITS.invites
    ) throw new Error("canonical fixture roster exceeds the bounded test contract");
    if (expectedRevision !== currentRevision) {
        return { status: "conflict", error: "roster revision conflict" };
    }
    return { status: "saved", snapshot, revision: currentRevision + 1 };
}

function actionArgument(request: Request, predicate: (candidate: Record<string, unknown>) => boolean): Record<string, unknown> {
    const raw = request.postData() || "";
    for (const value of parseJsonCandidates(raw)) {
        const found = visit(value, predicate);
        if (found) return decodeFlightValue(found) as Record<string, unknown>;
    }
    throw new Error(`canonical fixture could not decode ${request.headers()["next-action"] || "unknown action"}`);
}

function actionResult(body: string, predicate: (candidate: Record<string, unknown>) => boolean): Record<string, unknown> | null {
    for (const value of parseJsonCandidates(body)) {
        const found = visit(value, predicate);
        if (found) return found;
    }
    return null;
}

export function canonicalFixtureUpstreamResult(
    body: string,
    allowedStatuses: readonly string[],
): Record<string, unknown> {
    const existing = actionResult(body, candidate => typeof candidate.status === "string");
    const status = typeof existing?.status === "string" ? existing.status : "missing";
    if (!existing || !allowedStatuses.includes(status)) {
        throw new Error(`canonical fixture rejected upstream action status: ${status}`);
    }
    return existing;
}

function cookieValue(header: string, name: string): string {
    for (const pair of header.split(";")) {
        const separator = pair.indexOf("=");
        if (separator < 1 || pair.slice(0, separator).trim() !== name) continue;
        return pair.slice(separator + 1).trim();
    }
    return "";
}

export function canonicalFixtureStudentIdentity(cookieHeader: string): StudentServerIdentity {
    const signed = cookieValue(cookieHeader, STUDENT_SERVER_SESSION_COOKIE);
    const identity = parseSignedStudentSessionCookie(signed, E2E_STUDENT_SESSION_ENV, Date.now());
    if (!identity || identity.kind !== "student" || !identity.studentId) {
        throw new Error("canonical fixture requires a valid signed student session");
    }
    return identity;
}

export function canonicalFixtureAuthoritativeExam(savedExam: Exam | undefined, requestedExam: Exam): Exam {
    if (savedExam && JSON.stringify(savedExam) !== JSON.stringify(requestedExam)) {
        throw new Error("canonical fixture saved exam mismatch");
    }
    return savedExam || requestedExam;
}

function rewriteActionResult(
    body: string,
    upstream: Record<string, unknown>,
    replacement: unknown,
): string {
    const serialized = JSON.stringify(replacement);
    const upstreamSerialized = JSON.stringify(upstream);
    if (body.includes(upstreamSerialized)) {
        return body.replaceAll(upstreamSerialized, serialized);
    }
    return body;
}

function exactMeta(rawCount: number) {
    return {
        organizationId: "default",
        loadedAt: new Date().toISOString(),
        rawCount,
        parsedCount: rawCount,
    };
}

export async function registerCanonicalRemoteFixture(page: Page) {
    const handlers = new Map<string, ActionHandler>();
    const retryableReadActionIds = new Set<string>();
    const requestedActionIds = new Set<string>();
    const observedActionIds = new Set<string>();
    const rewrittenActionIds = new Set<string>();
    const actionInvocationCounts = new Map<string, number>();
    const rewrittenActionCounts = new Map<string, number>();
    const exams = new Map<string, Exam>();
    const attempts = new Map<string, Attempt>();
    let roster: RosterSnapshot = { students: [], groups: [], invites: [] };
    const revision = 1;
    const assignmentRevisions = new Map<string, number>();

    await page.route("**/*", async route => {
        const request = route.request();
        const actionId = request.method() === "POST" ? request.headers()["next-action"] : undefined;
        if (actionId) requestedActionIds.add(actionId);
        const handler = actionId ? handlers.get(actionId) : undefined;
        if (!handler) {
            await route.continue();
            return;
        }
        observedActionIds.add(actionId!);
        actionInvocationCounts.set(actionId!, (actionInvocationCounts.get(actionId!) || 0) + 1);
        const response = await canonicalFixtureFetchUpstream(
            () => route.fetch(),
            retryableReadActionIds.has(actionId!),
        );
        const body = await response.text();
        const action = await handler(request, response, body);
        const rewritten = rewriteActionResult(body, action.upstream, action.replacement);
        expect(rewritten, `authoritative fixture response for ${actionId}`).not.toBe(body);
        await route.fulfill({ response, body: rewritten });
        rewrittenActionIds.add(actionId!);
        rewrittenActionCounts.set(actionId!, (rewrittenActionCounts.get(actionId!) || 0) + 1);
    });

    function activateStudentSubmission(
        exam: Exam,
        worker = "app/page",
    ) {
        const authoritativeExam = canonicalFixtureAuthoritativeExam(exams.get(exam.id), exam);
        if (!exams.has(authoritativeExam.id)) exams.set(authoritativeExam.id, authoritativeExam);
        const actionId = exactNextActionId("src/app/actions/studentExam.ts", "submitAttempt", worker);
        handlers.set(actionId, (request, _response, body) => {
            const upstream = canonicalFixtureUpstreamResult(body, ["ok"]);
            const identity = canonicalFixtureStudentIdentity(request.headers().cookie || "");
            const input = actionArgument(request, candidate => (
                typeof candidate.examId === "string"
                && typeof candidate.submissionId === "string"
                && ownObject(candidate.answers)
                && typeof candidate.startedAt === "string"
            )) as unknown as SubmitAttemptInput;
            if (input.examId !== authoritativeExam.id) throw new Error("canonical fixture submission exam mismatch");
            const retakeQuestionIds = input.retake?.questionIds;
            const allowedQuestionIds = retakeQuestionIds === undefined
                ? authoritativeExam.questions.map(question => question.id)
                : [...new Set(retakeQuestionIds)].filter(questionId => (
                    Number.isInteger(questionId)
                    && authoritativeExam.questions.some(question => question.id === questionId)
                ));
            if (
                retakeQuestionIds !== undefined
                && (
                    allowedQuestionIds.length === 0
                    || allowedQuestionIds.length !== retakeQuestionIds.length
                    || !input.retake?.sourceAttemptId
                    || (input.retake.mode !== "wrong" && input.retake.mode !== "similar" && input.retake.mode !== "custom")
                )
            ) throw new Error("canonical fixture submission retake scope invalid");
            if (
                !ownObject(upstream.attempt)
                || upstream.attempt.examId !== authoritativeExam.id
                || upstream.attempt.studentId !== identity.studentId
            ) throw new Error("canonical fixture upstream attempt identity mismatch");
            if (
                identity.organizationId
                && authoritativeExam.organizationId
                && identity.organizationId !== authoritativeExam.organizationId
            ) throw new Error("canonical fixture submission organization mismatch");
            const issuedAt = Number.isFinite(Date.parse(input.startedAt)) ? Date.parse(input.startedAt) : Date.now();
            const result = gradeStudentAttemptOnServer(authoritativeExam, {
                schemaVersion: 2,
                audience: "omr-attempt",
                ticketId: input.submissionId,
                examId: authoritativeExam.id,
                organizationId: authoritativeExam.organizationId || "default",
                studentId: identity.studentId!,
                studentName: identity.name,
                identityType: identity.identityType,
                groupId: identity.groupId,
                groupName: identity.groupName,
                allowedQuestionIds,
                ...(input.retake
                    ? {
                        retakeSourceAttemptId: input.retake.sourceAttemptId,
                        retakeMode: input.retake.mode,
                    }
                    : {}),
                issuedAt,
                expiresAt: issuedAt + 60 * 60 * 1_000,
            }, {
                ticket: `fixture-${input.submissionId}`,
                answers: input.answers,
                autoSubmitted: input.autoSubmitted,
                questionTimings: input.questionTimings,
                focusLossEvents: input.focusLossEvents,
                tabFociLostCount: input.tabFociLostCount,
            }, issuedAt + 1_000);
            if (!result.ok) throw new Error(`canonical fixture submission was rejected: ${result.error}`);
            attempts.set(result.attempt.id, result.attempt);
            return { upstream, replacement: { status: "ok", attempt: result.attempt } };
        });
        return actionId;
    }

    function setRoster(nextRoster: RosterSnapshot) {
        roster = nextRoster;
    }

    function activateRoster(
        nextRoster: RosterSnapshot,
        worker = "app/teacher/users/page",
    ) {
        roster = nextRoster;
        let rosterRevision = revision;
        const loadRoster = exactNextActionId(
            "src/app/actions/teacherRoster.ts",
            "loadTeacherCanonicalRoster",
            worker,
        );
        const saveRoster = exactNextActionId(
            "src/app/actions/teacherRoster.ts",
            "saveTeacherCanonicalRoster",
            worker,
        );
        handlers.set(loadRoster, (_request, _response, body) => ({
            upstream: canonicalFixtureUpstreamResult(body, ["local_only"]),
            replacement: {
                status: "loaded",
                snapshot: roster,
                revision: rosterRevision,
                meta: exactMeta(roster.students.length + roster.groups.length + roster.invites.length),
            },
        }));
        retryableReadActionIds.add(loadRoster);
        handlers.set(saveRoster, (request, _response, body) => {
            const upstream = canonicalFixtureUpstreamResult(body, ["local_only"]);
            const replacement = canonicalFixtureRosterSaveTransition(request.postData() || "", rosterRevision);
            if (replacement.status === "saved") {
                roster = replacement.snapshot;
                rosterRevision = replacement.revision;
            }
            return {
                upstream,
                replacement,
            };
        });
        return { loadRoster, saveRoster };
    }

    function activateEmptyTeacherDashboard(
        nextRoster: RosterSnapshot = { students: [], groups: [], invites: [] },
        worker = "app/teacher/dashboard/page",
    ) {
        roster = nextRoster;
        const actionIds = {
            exams: exactNextActionId("src/app/actions/teacherExam.ts", "listTeacherCanonicalExams", worker),
            summaries: exactNextActionId("src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttemptSummaries", worker),
            roster: exactNextActionId("src/app/actions/teacherRoster.ts", "loadTeacherCanonicalRoster", worker),
        };
        const meta = exactMeta(0);
        const loaded = (replacement: unknown): ActionHandler => (_request, _response, body) => ({
            upstream: canonicalFixtureUpstreamResult(body, ["local_only"]),
            replacement,
        });
        handlers.set(actionIds.exams, loaded({ status: "loaded", exams: [], meta }));
        handlers.set(actionIds.summaries, loaded({
            status: "loaded",
            attempts: [],
            page: { partial: false, hasMore: false, itemCount: 0 },
            meta,
        }));
        handlers.set(actionIds.roster, loaded({
            status: "loaded",
            snapshot: roster,
            revision,
            meta: exactMeta(roster.students.length + roster.groups.length + roster.invites.length),
        }));
        retryableReadActionIds.add(actionIds.exams);
        retryableReadActionIds.add(actionIds.summaries);
        retryableReadActionIds.add(actionIds.roster);
        return actionIds;
    }

    function activateCreate(nextRoster: RosterSnapshot, worker = "app/create/page") {
        roster = nextRoster;
        const loadRoster = exactNextActionId("src/app/actions/teacherRoster.ts", "loadTeacherCanonicalRoster", worker);
        const saveExam = exactNextActionId("src/app/actions/teacherExam.ts", "saveTeacherCanonicalExam", worker);
        const saveAssignment = exactNextActionId("src/app/actions/teacherAssignment.ts", "saveTeacherIndividualAssignment", worker);
        handlers.set(loadRoster, (_request, _response, body) => ({
            upstream: canonicalFixtureUpstreamResult(body, ["local_only"]),
            replacement: {
                status: "loaded",
                snapshot: roster,
                revision,
                meta: exactMeta(roster.students.length + roster.groups.length + roster.invites.length),
            },
        }));
        retryableReadActionIds.add(loadRoster);
        handlers.set(saveExam, (request, _response, body) => {
            const upstream = canonicalFixtureUpstreamResult(body, ["local_only"]);
            const rawExam = actionArgument(request, candidate => (
                typeof candidate.id === "string"
                && typeof candidate.title === "string"
                && Array.isArray(candidate.questions)
            )) as unknown as Exam;
            const exam: Exam = {
                ...rawExam,
                organizationId: "default",
                revision,
                updatedAt: new Date().toISOString(),
            };
            exams.set(exam.id, exam);
            return { upstream, replacement: { status: "saved", exam } };
        });
        handlers.set(saveAssignment, (request, _response, body) => {
            const upstream = canonicalFixtureUpstreamResult(body, ["local_only"]);
            const input = actionArgument(request, candidate => (
                typeof candidate.examId === "string"
                && Array.isArray(candidate.targetStudentIds)
                && (candidate.mode === "base" || candidate.mode === "retake")
                && Number.isSafeInteger(candidate.expectedRevision)
            ));
            const examId = String(input.examId);
            const targetStudentIds = (input.targetStudentIds as unknown[]).filter((value): value is string => (
                typeof value === "string" && value.trim().length > 0
            ));
            const expectedRevision = Number(input.expectedRevision);
            const currentRevision = assignmentRevisions.get(examId) || 0;
            if (
                targetStudentIds.length === 0
                || targetStudentIds.length !== (input.targetStudentIds as unknown[]).length
                || targetStudentIds.length !== new Set(targetStudentIds).size
                || expectedRevision !== currentRevision
            ) throw new Error("canonical fixture assignment contract mismatch");
            const nextRevision = currentRevision + 1;
            assignmentRevisions.set(examId, nextRevision);
            return {
                upstream,
                replacement: {
                    status: "saved",
                    assignmentId: `assignment-${examId}`,
                    revision: nextRevision,
                    targetCount: targetStudentIds.length,
                    mode: input.mode,
                },
            };
        });
        return { loadRoster, saveExam, saveAssignment };
    }

    function activateTeacherDashboard(worker = "app/teacher/dashboard/page") {
        const exam = [...exams.values()].at(-1);
        const attempt = [...attempts.values()].at(-1);
        if (!exam || !attempt) throw new Error("canonical fixture has no confirmed submission");
        const actionIds = {
            exams: exactNextActionId("src/app/actions/teacherExam.ts", "listTeacherCanonicalExams", worker),
            summaries: exactNextActionId("src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttemptSummaries", worker),
            roster: exactNextActionId("src/app/actions/teacherRoster.ts", "loadTeacherCanonicalRoster", worker),
            attempts: exactNextActionId("src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttempts", worker),
            analytics: exactNextActionId("src/app/actions/teacherAttempts.ts", "loadTeacherCanonicalAnalyticsSnapshots", worker),
        };
        const meta = exactMeta(1);
        const rosterMeta = exactMeta(roster.students.length + roster.groups.length + roster.invites.length);
        const pageResult = { partial: false, hasMore: false, itemCount: 1 };
        const analyticsSnapshots = buildTeacherCanonicalAnalyticsSnapshotMap([exam], [attempt]);
        const loaded = (replacement: unknown): ActionHandler => (_request, _response, body) => ({
            upstream: canonicalFixtureUpstreamResult(body, ["local_only"]),
            replacement,
        });
        handlers.set(actionIds.exams, loaded({ status: "loaded", exams: [exam], meta }));
        handlers.set(actionIds.summaries, loaded({
            status: "loaded",
            attempts: [attempt],
            page: pageResult,
            meta,
        }));
        handlers.set(actionIds.roster, loaded({ status: "loaded", snapshot: roster, revision, meta: rosterMeta }));
        handlers.set(actionIds.attempts, loaded({
            status: "loaded",
            attempts: [attempt],
            page: pageResult,
            meta,
        }));
        handlers.set(actionIds.analytics, loaded({ status: "loaded", analyticsSnapshots, meta }));
        retryableReadActionIds.add(actionIds.exams);
        retryableReadActionIds.add(actionIds.summaries);
        retryableReadActionIds.add(actionIds.roster);
        retryableReadActionIds.add(actionIds.attempts);
        retryableReadActionIds.add(actionIds.analytics);
        return actionIds;
    }

    return {
        activateStudentSubmission,
        setRoster,
        activateRoster,
        activateCreate,
        activateEmptyTeacherDashboard,
        activateTeacherDashboard,
        requestedActionIds,
        observedActionIds,
        rewrittenActionIds,
        actionInvocationCounts,
        rewrittenActionCounts,
        confirmedExam: () => [...exams.values()].at(-1) || null,
        confirmedAttempt: () => [...attempts.values()].at(-1) || null,
        confirmedAttempts: () => [...attempts.values()],
    };
}
