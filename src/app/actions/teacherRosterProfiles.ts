"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import {
    listTeacherAttemptSummariesWithGateway,
    loadTeacherAttemptWithGateway,
    type TeacherAttemptGatewayClient,
} from "@/lib/teacherAttemptGateway";
import {
    listTeacherExamsWithGateway,
    type TeacherExamGatewayClient,
} from "@/lib/teacherExamGateway";
import {
    loadTeacherRosterWithGateway,
    type TeacherRosterGatewayClient,
} from "@/lib/teacherRosterGateway";
import {
    buildStudentProfileInsight,
    type StudentProfileInsight,
} from "@/lib/studentProfileAnalytics";
import {
    buildGroupProfileInsight,
    type GroupProfileInsight,
} from "@/lib/groupProfileAnalytics";
import { reportServerError } from "@/lib/reportServerError";
import { readEffectiveWorkspacePlan } from "@/lib/effectiveWorkspacePlanGateway";
import { hasPlanEntitlement } from "@/utils/plans";
import { rosterGroupMatchesStudent, type RosterGroup } from "@/lib/rosterStorage";
import type { TeacherAttemptSummary } from "@/lib/teacherAttemptSummary";
import type { Attempt } from "@/types/omr";

export type TeacherRosterProfileRequest =
    | { kind: "student"; id: string }
    | { kind: "group"; id: string };

export type TeacherRosterProfileResult =
    | { status: "loaded"; kind: "student"; profile: StudentProfileInsight }
    | { status: "loaded"; kind: "group"; profile: GroupProfileInsight }
    | { status: "forbidden" | "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

type ProfileGatewayClient = TeacherAttemptGatewayClient & TeacherExamGatewayClient & TeacherRosterGatewayClient;
const PROFILE_RICH_ATTEMPT_LIMIT = 20;
const PROFILE_RICH_QUESTION_RESULT_LIMIT = 10_000;
const PROFILE_DETAIL_CONCURRENCY = 6;

function summaryMatchesStudent(summary: TeacherAttemptSummary, studentId: string): boolean {
    return summary.studentProfileId === studentId || summary.studentId === studentId;
}

function summaryMatchesGroup(
    summary: TeacherAttemptSummary,
    group: RosterGroup,
    memberIds: ReadonlySet<string>,
): boolean {
    return summary.groupId === group.id
        || (!!summary.studentProfileId && memberIds.has(summary.studentProfileId))
        || (!!summary.studentId && memberIds.has(summary.studentId));
}

function boundedRelevantSummaries(
    summaries: readonly TeacherAttemptSummary[],
    matches: (summary: TeacherAttemptSummary) => boolean,
): TeacherAttemptSummary[] | null {
    const relevant = summaries.filter(summary => summary.status === "completed" && matches(summary));
    if (relevant.length > PROFILE_RICH_ATTEMPT_LIMIT) return null;
    let resultCount = 0;
    for (const summary of relevant) {
        const count = summary.questionResultsQuestionCount;
        if (!Number.isSafeInteger(count) || Number(count) <= 0 || Number(count) > 500) return null;
        resultCount += Number(count);
        if (!Number.isSafeInteger(resultCount) || resultCount > PROFILE_RICH_QUESTION_RESULT_LIMIT) return null;
    }
    return relevant;
}

async function loadExactProfileAttempts(
    client: ProfileGatewayClient,
    context: ReturnType<typeof workspaceContextFromTeacherSession>,
    summaries: readonly TeacherAttemptSummary[],
    matchesOwner: (attempt: Attempt) => boolean,
): Promise<Attempt[] | null> {
    const attempts = new Array<Attempt>(summaries.length);
    let cursor = 0;
    let rejected = false;
    async function worker() {
        while (!rejected && cursor < summaries.length) {
            const index = cursor;
            cursor += 1;
            const summary = summaries[index];
            const result = await loadTeacherAttemptWithGateway(client, summary.id, context);
            const attempt = result.status === "loaded" ? result.attempt : null;
            if (!attempt
                || attempt.id !== summary.id
                || attempt.examId !== summary.examId
                || attempt.organizationId !== context.organizationId
                || attempt.status !== "completed"
                || !matchesOwner(attempt)
                || !Array.isArray(attempt.questionResults)
                || attempt.questionResults.length !== summary.questionResultsQuestionCount) {
                rejected = true;
                return;
            }
            attempts[index] = attempt;
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(PROFILE_DETAIL_CONCURRENCY, summaries.length) },
        () => worker(),
    ));
    if (rejected) return null;
    for (let index = 0; index < attempts.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(attempts, index)
            || attempts[index].id !== summaries[index].id) return null;
    }
    return attempts;
}

function validRequest(input: unknown): input is TeacherRosterProfileRequest {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !("kind" in record) || !("id" in record)) return false;
    return (record.kind === "student" || record.kind === "group")
        && typeof record.id === "string"
        && record.id.length > 0
        && record.id.length <= 200
        && record.id.trim() === record.id
        && !/[\u0000-\u001f\u007f]/.test(record.id);
}

const STUDENT_PROFILE_KEYS = [
    "attempts", "averageScore", "bestScore", "latestScore", "trendDelta",
    "averageElapsedTimeSec", "averageQuestionTimeSec", "totalTrackedTimeSec",
    "focusLossCount", "wrongQuestionCount", "unansweredQuestionCount",
    "handwritingArchiveCount", "baseAttemptCount", "retakeAttemptCount",
    "weaknessGroups", "headlineWeaknessGroups", "mostMissedQuestions", "tagStats",
] as const;
const GROUP_PROFILE_KEYS = [
    "groupId", "groupName", "rosterStudentCount", "attemptCount", "retakeAttemptCount",
    "examCount", "activeStudentCount", "averageScore", "averageElapsedTimeSec",
    "averageQuestionTimeSec", "totalTrackedTimeSec", "focusLossCount", "wrongQuestionCount",
    "unansweredQuestionCount", "handwritingArchiveCount", "handwritingArchiveRate", "exams",
    "weaknessGroups", "mostMissedQuestions", "tagStats", "studentsNeedingAttention",
] as const;
const PROFILE_NESTED_KEYS = new Set([
    ...STUDENT_PROFILE_KEYS,
    ...GROUP_PROFILE_KEYS,
    "id", "examId", "examTitle", "finishedAt", "scorePercent", "elapsedTimeSec",
    "wrongQuestionNumbers", "unansweredQuestionNumbers", "slowQuestionNumbers",
    "revisitedQuestionNumbers", "answerChangedQuestionNumbers", "handwritingArchived",
    "handwritingLabel", "detailHref", "isRetake", "retakeQuestionCount", "key", "kind",
    "title", "basis", "wrongCount", "unansweredCount", "totalCount", "wrongRate",
    "questionNumbers", "recommendedQuestionIds", "severity", "reason", "sourceAttemptId",
    "retakeMode", "retakeQuestionIds", "retakeLabels", "retakeConcepts", "recommendedAction",
    "examIds", "maxWrongRate", "questionId", "questionNumber", "label", "concept",
    "averageTimeSec", "correctCount", "correctRate", "studentCount", "attemptCount",
    "topWeakness", "name", "latestScore", "trendDelta",
]);

function hasExactRootKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(record).sort();
    return keys.length === expected.length
        && [...expected].sort().every((key, index) => key === keys[index]);
}

function stableProfileData(value: unknown, seen: WeakSet<object>, state: { nodes: number }): boolean {
    if (value === undefined) return true;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return value.length <= 10_000 && !/[\u0000-\u001f\u007f]/.test(value);
    if (typeof value === "number") return Number.isFinite(value);
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    if (++state.nodes > 50_000) return false;
    seen.add(value);
    if (Array.isArray(value)) {
        if (value.length > 2_000) return false;
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(value, index) || !stableProfileData(value[index], seen, state)) return false;
        }
        return Reflect.ownKeys(value).every(key => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || !PROFILE_NESTED_KEYS.has(key)) return false;
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable || !stableProfileData(descriptor.value, seen, state)) return false;
    }
    return true;
}

function boundedProfileSnapshot<T extends StudentProfileInsight | GroupProfileInsight>(
    profile: T,
    kind: "student" | "group",
): T | null {
    try {
        if (!stableProfileData(profile, new WeakSet(), { nodes: 0 })) return null;
        if (!hasExactRootKeys(profile as unknown as Record<string, unknown>, kind === "student" ? STUDENT_PROFILE_KEYS : GROUP_PROFILE_KEYS)) return null;
        const serialized = JSON.stringify(profile);
        if (new TextEncoder().encode(serialized).byteLength > 512 * 1024) return null;
        const parsed = JSON.parse(serialized) as T;
        return stableProfileData(parsed, new WeakSet(), { nodes: 0 }) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Builds the existing rich roster profile on the authenticated server boundary.
 * The client receives only the bounded display DTO and never imports the grading
 * verifier or raw per-question analytics implementation into the users route.
 */
export async function loadTeacherCanonicalRosterProfile(
    input: TeacherRosterProfileRequest,
): Promise<TeacherRosterProfileResult> {
    try {
        if (!validRequest(input)) return { status: "service_unavailable", error: "프로필 요청이 올바르지 않습니다." };
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
        const cookieStore = await cookies();
        const session = await resolveAuthorizedTeacherSessionCookie(
            cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
        );
        if (!session) return { status: "unauthorized" };
        const config = getSupabaseServerConfigFromEnv();
        if (!config) {
            return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
        }
        const context = workspaceContextFromTeacherSession(session);
        const client = createSupabaseAdminClient(config) as unknown as ProfileGatewayClient;
        const effectivePlan = await readEffectiveWorkspacePlan(client, context.organizationId);
        const requiredCapability = input.kind === "student" ? "studentGrowthReports" : "advancedAnalytics";
        if (!effectivePlan.authoritative
            || !hasPlanEntitlement(effectivePlan.plan, requiredCapability)) {
            return { status: "forbidden" };
        }
        const [summaryResult, examResult, rosterResult] = await Promise.all([
            listTeacherAttemptSummariesWithGateway(client, context),
            listTeacherExamsWithGateway(client, context),
            loadTeacherRosterWithGateway(client, context),
        ]);
        if (
            summaryResult.status !== "loaded"
            || examResult.status !== "loaded"
            || rosterResult.status !== "loaded"
            || summaryResult.page.partial
            || summaryResult.page.hasMore
            || summaryResult.page.itemCount !== summaryResult.attempts.length
            || summaryResult.meta.organizationId !== context.organizationId
            || examResult.meta.organizationId !== context.organizationId
            || rosterResult.meta.organizationId !== context.organizationId
            || examResult.meta.rawCount !== examResult.meta.parsedCount
            || examResult.meta.parsedCount !== examResult.exams.length
            || examResult.exams.some(exam => exam.organizationId !== context.organizationId)
        ) {
            return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
        }
        const examById = new Map(examResult.exams.map(exam => [exam.id, exam]));
        if (input.kind === "student") {
            const student = rosterResult.snapshot.students.find(item => item.id === input.id);
            if (!student) return { status: "not_found" };
            const relevantSummaries = boundedRelevantSummaries(
                summaryResult.attempts,
                summary => summaryMatchesStudent(summary, student.id),
            );
            if (!relevantSummaries) return { status: "service_unavailable", error: "프로필 분석 범위가 너무 큽니다." };
            if (relevantSummaries.some(summary => !examById.has(summary.examId))) {
                return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
            }
            const attempts = await loadExactProfileAttempts(
                client,
                context,
                relevantSummaries,
                attempt => attempt.studentProfileId === student.id || attempt.studentId === student.id,
            );
            if (!attempts) return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
            const profile = boundedProfileSnapshot(buildStudentProfileInsight(student, attempts, examById, {
                recentLimit: 8,
                weaknessLimit: 6,
            }), "student");
            if (!profile) return { status: "service_unavailable", error: "프로필 분석 결과가 너무 큽니다." };
            return { status: "loaded", kind: "student", profile };
        }
        const group = rosterResult.snapshot.groups.find(item => item.id === input.id);
        if (!group) return { status: "not_found" };
        const memberIds = new Set(rosterResult.snapshot.students
            .filter(student => rosterGroupMatchesStudent(group, student))
            .map(student => student.id));
        const relevantSummaries = boundedRelevantSummaries(
            summaryResult.attempts,
            summary => summaryMatchesGroup(summary, group, memberIds),
        );
        if (!relevantSummaries) return { status: "service_unavailable", error: "프로필 분석 범위가 너무 큽니다." };
        if (relevantSummaries.some(summary => !examById.has(summary.examId))) {
            return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
        }
        const attempts = await loadExactProfileAttempts(
            client,
            context,
            relevantSummaries,
            attempt => attempt.groupId === group.id
                || (!!attempt.studentProfileId && memberIds.has(attempt.studentProfileId))
                || (!!attempt.studentId && memberIds.has(attempt.studentId)),
        );
        if (!attempts) return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
        const profile = boundedProfileSnapshot(buildGroupProfileInsight(
            group,
            rosterResult.snapshot.students,
            attempts,
            examById,
            { examLimit: 6, weaknessLimit: 6, riskLimit: 5 },
        ), "group");
        if (!profile) return { status: "service_unavailable", error: "프로필 분석 결과가 너무 큽니다." };
        return { status: "loaded", kind: "group", profile };
    } catch (error) {
        await reportServerError("teacher-roster-profile-read", error);
        return { status: "service_unavailable", error: "프로필 분석 데이터를 불러올 수 없습니다." };
    }
}
