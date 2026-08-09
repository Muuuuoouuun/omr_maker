"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    createSignedStudentSessionCookie,
    resolveAuthorizedStudentSessionCookie,
    validateStudentServerSession,
    STUDENT_SERVER_SESSION_COOKIE,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentIdentityInput,
    type StudentServerIdentity,
} from "@/lib/studentServerSession";
import { shouldUseSecureTeacherSessionCookie } from "@/lib/teacherServerSession";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    verifyStudentCredentials,
    validateVerifiedStudentCredentialSession,
    type StudentCredentialClient,
} from "@/lib/studentCredentialVerifier";
import {
    buildStudentLoginRateLimitKeys,
    checkStudentLoginRateLimit,
    recordStudentLoginFailure,
    recordStudentLoginSuccess,
    STUDENT_LOGIN_RATE_LIMIT_ERROR,
    STUDENT_LOGIN_LOCKOUT_MS,
    STUDENT_LOGIN_MAX_FAILURES,
    STUDENT_LOGIN_WINDOW_MS,
} from "@/lib/studentLoginRateLimit";
import { applyDurableRateLimitToSubjects } from "@/lib/durableRateLimit";
import {
    resolveServerStudentLogin,
    studentRegionFromProfile,
    type StudentLoginEnrollmentRow,
    type StudentLoginProfileRow,
} from "@/lib/studentLoginIdentity";
import {
    boundGuestClaimAttemptIds,
    claimSignedGuestAttempts,
    type GuestClaimResult,
    type GuestClaimRpcClient,
} from "@/lib/studentGuestClaimGateway";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    createSignedGuestClaimOwnerProof,
    GUEST_CLAIM_OWNER_COOKIE,
    guestClaimOwnerMatchesStudent,
    parseSignedGuestClaimOwnerProof,
} from "@/lib/studentGuestClaimOwner";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import {
    resolveExamEntryInviteWithGateway,
    type ExamEntryInviteRpcClient,
} from "@/lib/examEntryInviteGateway";
import {
    createExamEntryInviteE2eSimulationClient,
    getExamEntryInviteE2eFixtureGroups,
} from "@/lib/examEntryInviteE2eSimulation";

const WORKSPACE_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16}|pilot_org_[a-f0-9]{24})$/;
type QueryError = { message?: string } | null;
const STUDENT_LOGIN_DURABLE_POLICY = {
    limit: STUDENT_LOGIN_MAX_FAILURES,
    windowMs: STUDENT_LOGIN_WINDOW_MS,
    lockoutMs: STUDENT_LOGIN_LOCKOUT_MS,
};

interface StudentAuthFilter {
    eq(column: string, value: string): StudentAuthFilter;
    in(column: string, values: string[]): StudentAuthFilter;
    maybeSingle(): PromiseLike<{ data: unknown; error: QueryError }>;
    order(column: string, options?: { ascending?: boolean }): StudentAuthFilter;
    limit(value: number): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
}

interface StudentAuthClient extends GuestClaimRpcClient {
    from(table: string): {
        select(columns?: string): StudentAuthFilter;
    };
}

export interface StudentLoginGroup {
    id: string;
    name: string;
    region?: string;
}

export interface StudentExamInviteContext {
    examId: string;
    inviteToken: string;
}

export interface IssuedStudentIdentity {
    studentId: string;
    name: string;
    groupId: string;
    groupName: string;
    regionId?: string;
    regionName?: string;
}

/**
 * Client-safe identity restored from the signed HttpOnly cookie. Organization
 * scope deliberately stays server-only; callers only receive the fields needed
 * to rebuild their local view model.
 */
export interface RestoredStudentSession {
    studentId: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    isGuest: boolean;
    identityType: "guest" | "temporary" | "registered";
    guestId?: string;
}

export type StudentSessionIssueStatus =
    | "ok"
    | "degraded_local"
    | "invalid_workspace"
    | "invalid_credentials"
    | "code_not_issued"
    | "rate_limited"
    | "unauthenticated"
    | "error";

export interface StudentSessionIssueResult {
    ok: boolean;
    status: StudentSessionIssueStatus;
    identity?: IssuedStudentIdentity;
    session?: RestoredStudentSession;
    canLoginWithCurrentScope?: boolean;
    guestClaim?: GuestClaimResult;
    error?: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function normalizeWorkspaceId(value: unknown): string | null {
    const workspaceId = clean(value).toLowerCase();
    return WORKSPACE_ID_PATTERN.test(workspaceId) ? workspaceId : null;
}

function restoredSessionFromSignedIdentity(identity: StudentServerIdentity): RestoredStudentSession {
    const isGuest = identity.kind === "guest";
    return {
        studentId: isGuest ? `guest:${identity.guestId}` : clean(identity.studentId),
        name: identity.name,
        groupId: identity.groupId,
        groupName: identity.groupName,
        regionId: identity.regionId,
        regionName: identity.regionName,
        isGuest,
        identityType: identity.identityType,
        ...(isGuest && identity.guestId ? { guestId: identity.guestId } : {}),
    };
}

function clientFingerprintFromHeaders(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || headerStore.get("user-agent")?.trim()
        || "unknown-client";
}

function recordDurableStudentLoginFailure(keys: string[]): void {
    recordStudentLoginFailure(keys);
}

async function recordDurableStudentLoginSuccess(keys: string[]): Promise<void> {
    recordStudentLoginSuccess(keys);
    await applyDurableRateLimitToSubjects({
        namespace: "student-login",
        subjects: keys,
        operation: "success",
        policy: STUDENT_LOGIN_DURABLE_POLICY,
    });
}

function adminClient(): StudentAuthClient | null {
    const config = getSupabaseServerConfigFromEnv();
    return config ? createSupabaseAdminClient(config) as unknown as StudentAuthClient : null;
}

async function setSessionCookie(input: StudentIdentityInput): Promise<{ ok: boolean }> {
    const value = createSignedStudentSessionCookie(input);
    if (!value) return { ok: false };
    try {
        const headerStore = await headers();
        const cookieStore = await cookies();
        cookieStore.set(STUDENT_SERVER_SESSION_COOKIE, value, {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
            path: "/",
            maxAge: STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
        });
        return { ok: true };
    } catch (error) {
        console.error("Student session cookie write failed", error);
        return { ok: false };
    }
}

async function setGuestClaimOwnerCookie(
    guest: StudentServerIdentity,
    student: StudentServerIdentity,
): Promise<boolean> {
    const value = createSignedGuestClaimOwnerProof({ guest, student });
    if (!value) return false;
    try {
        const headerStore = await headers();
        const cookieStore = await cookies();
        cookieStore.set(GUEST_CLAIM_OWNER_COOKIE, value, {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
            path: "/",
            maxAge: Math.max(1, Math.floor((Math.min(guest.expiresAt, student.expiresAt) - Date.now()) / 1000)),
        });
        return true;
    } catch (error) {
        console.error("Guest DB-owner claim cookie write failed", error);
        return false;
    }
}

async function resolveStudentLoginScope(
    client: ExamEntryInviteRpcClient,
    input: string | StudentExamInviteContext,
): Promise<
    | { status: "resolved"; organizationId: string; groupIds?: string[] }
    | { status: "invalid" }
    | { status: "service_unavailable" }
> {
    if (typeof input !== "string") {
        const resolved = await resolveExamEntryInviteWithGateway(client, input.examId, input.inviteToken);
        if (resolved.status !== "resolved") return resolved;
        return {
            status: "resolved",
            organizationId: resolved.scope.organizationId,
            groupIds: resolved.scope.groupIds,
        };
    }
    // Backward compatibility is intentionally limited to non-production test
    // and local data. Production browser identity must come from an opaque,
    // server-resolved exam invite rather than a stable organization id.
    if (process.env.NODE_ENV === "production") return { status: "invalid" };
    const organizationId = normalizeWorkspaceId(input);
    return organizationId ? { status: "resolved", organizationId } : { status: "invalid" };
}

/** Minimal public directory scoped by an opaque, exam-specific invite. */
export async function loadStudentLoginDirectory(input: string | StudentExamInviteContext): Promise<{
    status: "ok" | "degraded_local" | "invalid_workspace" | "error";
    groups?: StudentLoginGroup[];
    error?: typeof INITIAL_CAPACITY_EXCEEDED_ERROR;
}> {
    const client = adminClient();
    const inviteSimulationClient = !client && typeof input !== "string"
        ? createExamEntryInviteE2eSimulationClient(process.env)
        : null;
    if (inviteSimulationClient && typeof input !== "string") {
        try {
            const scope = await resolveStudentLoginScope(inviteSimulationClient, input);
            if (scope.status === "invalid") return { status: "invalid_workspace" };
            if (scope.status === "service_unavailable") return { status: "error" };
            const groups = getExamEntryInviteE2eFixtureGroups(
                process.env,
                scope.organizationId,
                scope.groupIds || [],
            );
            return groups.length > 0 ? { status: "ok", groups } : { status: "invalid_workspace" };
        } catch {
            return { status: "error" };
        }
    }
    if (!client) {
        return { status: process.env.NODE_ENV === "production" ? "error" : "degraded_local" };
    }

    try {
        const scope = await resolveStudentLoginScope(client, input);
        if (scope.status === "invalid") return { status: "invalid_workspace" };
        if (scope.status === "service_unavailable") return { status: "error" };
        let query = client.from("omr_classes")
            .select("id,name,campus,status")
            .eq("organization_id", scope.organizationId)
            .eq("status", "active");
        if (scope.groupIds) query = query.in("id", scope.groupIds);
        const result = await query.order("name", { ascending: true })
            .limit(INITIAL_OPERATIONS_LIMITS.classes + 1);
        if (result.error) throw new Error(result.error.message || "Failed to load student login groups");
        if ((result.data?.length || 0) > INITIAL_OPERATIONS_LIMITS.classes) {
            return { status: "error", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
        }
        const groups = (result.data || [])
            .map(asRecord)
            .map(row => ({
                id: clean(row.id),
                name: clean(row.name),
                region: clean(row.campus) || undefined,
            }))
            .filter(group => group.id && group.name);
        return { status: "ok", groups };
    } catch (error) {
        console.error("loadStudentLoginDirectory failed", error);
        return { status: "error" };
    }
}

/**
 * Issue a signed student session. With Supabase configured, the identity is
 * derived from the server roster and a teacher-issued access-code hash. The
 * client-supplied identity is accepted only in the no-database local fallback,
 * where it cannot unlock server-owned attempts.
 */
export async function issueStudentSession(input: {
    workspaceId?: string;
    examId?: string;
    inviteToken?: string;
    name: string;
    groupId?: string;
    studentLookup?: string;
    startCode?: string;
    studentId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    guestAttemptIds?: string[];
}): Promise<StudentSessionIssueResult> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) {
        return { ok: false, status: "unauthenticated" };
    }
    const cookieStore = await cookies();
    const client = adminClient();
    if (!client) {
        if (process.env.NODE_ENV === "production") {
            return { ok: false, status: "error" };
        }
        const studentId = clean(input.studentId);
        const name = clean(input.name);
        if (!studentId || !name) return { ok: false, status: "degraded_local" };
        const identity: IssuedStudentIdentity = {
            studentId,
            name,
            groupId: clean(input.groupId),
            groupName: clean(input.groupName) || "Unknown",
            regionId: clean(input.regionId) || undefined,
            regionName: clean(input.regionName) || undefined,
        };
        const result = await setSessionCookie({
            kind: "student",
            ...identity,
            organizationId: normalizeWorkspaceId(input.workspaceId) || undefined,
            identityType: "temporary",
        });
        return { ok: result.ok, status: "degraded_local", identity: result.ok ? identity : undefined };
    }
    const existingValidation = await resolveAuthorizedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (existingValidation.status === "service_unavailable") return { ok: false, status: "error" };
    const existingIdentity = existingValidation.status === "active" ? existingValidation.identity : null;
    const existingGuestSession = existingIdentity?.kind === "guest" ? existingIdentity : null;

    const name = clean(input.name);
    const groupId = clean(input.groupId);
    const studentLookup = clean(input.studentLookup);
    const inviteInput = clean(input.examId) && clean(input.inviteToken)
        ? { examId: clean(input.examId), inviteToken: clean(input.inviteToken) }
        : null;
    // A guest-to-student connection may reuse scope only when it came from the
    // signed HttpOnly cookie. Never recover organization scope from a URL or
    // browser storage. The guest's signed class is also the only allowed class.
    const signedGuestScope = existingGuestSession?.organizationId && existingGuestSession?.groupId
        ? {
            status: "resolved" as const,
            organizationId: existingGuestSession.organizationId,
            groupIds: [existingGuestSession.groupId],
        }
        : null;
    const scope = inviteInput
        ? await resolveStudentLoginScope(client, inviteInput)
        : signedGuestScope || await resolveStudentLoginScope(client, input.workspaceId || "");
    if (scope.status === "invalid") return { ok: false, status: "invalid_workspace" };
    if (scope.status === "service_unavailable") return { ok: false, status: "error" };
    const workspaceId = scope.organizationId;
    if (scope.groupIds && !scope.groupIds.includes(groupId)) {
        return { ok: false, status: "invalid_credentials" };
    }

    const rateLimitKeys = buildStudentLoginRateLimitKeys({
        workspaceId,
        studentLookup,
        clientFingerprint: clientFingerprintFromHeaders(headerStore),
    });
    if (!checkStudentLoginRateLimit(rateLimitKeys).allowed) {
        return { ok: false, status: "rate_limited", error: STUDENT_LOGIN_RATE_LIMIT_ERROR };
    }
    if (!(await applyDurableRateLimitToSubjects({
        namespace: "student-login",
        subjects: rateLimitKeys,
        operation: "consume",
        policy: STUDENT_LOGIN_DURABLE_POLICY,
    })).allowed) {
        return { ok: false, status: "rate_limited", error: STUDENT_LOGIN_RATE_LIMIT_ERROR };
    }
    if (!name || !groupId || !studentLookup) {
        await recordDurableStudentLoginFailure(rateLimitKeys);
        return { ok: false, status: "invalid_credentials" };
    }

    try {
        const [profilesResult, enrollmentsResult, classResult] = await Promise.all([
            client.from("omr_student_profiles")
                .select("id,organization_id,display_name,external_id,email,status,metadata")
                .eq("organization_id", workspaceId)
                .eq("display_name", name)
                .eq("status", "active")
                .order("id", { ascending: true })
                .limit(INITIAL_OPERATIONS_LIMITS.activeStudents + 1),
            client.from("omr_class_students")
                .select("class_id,organization_id,student_profile_id,enrollment_status")
                .eq("organization_id", workspaceId)
                .eq("class_id", groupId)
                .eq("enrollment_status", "active")
                .order("student_profile_id", { ascending: true })
                .limit(INITIAL_OPERATIONS_LIMITS.activeStudents + 1),
            client.from("omr_classes")
                .select("id,organization_id,name,campus,status")
                .eq("organization_id", workspaceId)
                .eq("id", groupId)
                .maybeSingle(),
        ]);
        if (profilesResult.error || enrollmentsResult.error || classResult.error) {
            throw new Error(profilesResult.error?.message || enrollmentsResult.error?.message || classResult.error?.message || "Student login query failed");
        }
        if (
            (profilesResult.data?.length || 0) > INITIAL_OPERATIONS_LIMITS.activeStudents
            || (enrollmentsResult.data?.length || 0) > INITIAL_OPERATIONS_LIMITS.activeStudents
        ) {
            return { ok: false, status: "error", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
        }
        const classRow = asRecord(classResult.data);
        if (!clean(classRow.id) || (clean(classRow.status) || "active") !== "active") {
            await recordDurableStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "invalid_credentials" };
        }

        const profile = resolveServerStudentLogin({
            profiles: (profilesResult.data || []).map(asRecord) as unknown as StudentLoginProfileRow[],
            enrollments: (enrollmentsResult.data || []).map(asRecord) as unknown as StudentLoginEnrollmentRow[],
            organizationId: workspaceId,
            groupId,
            name,
            studentLookup,
        });
        if (!profile) {
            await recordDurableStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "invalid_credentials" };
        }

        const credential = await verifyStudentCredentials(
            client as unknown as StudentCredentialClient,
            {
                organizationId: workspaceId,
                studentProfileId: profile.id,
                code: clean(input.startCode),
            },
        );
        if (credential.status === "credential_not_configured") {
            await recordDurableStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "code_not_issued" };
        }
        if (credential.status === "service_unavailable") {
            throw new Error(credential.error || "Student credential lookup failed");
        }
        if (credential.status !== "verified") {
            await recordDurableStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "invalid_credentials" };
        }
        const currentCredential = await validateVerifiedStudentCredentialSession(
            client,
            credential.identity,
        );
        if (currentCredential === "service_unavailable") {
            throw new Error("Student credential validation unavailable");
        }
        if (currentCredential !== "active") {
            await recordDurableStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "invalid_credentials" };
        }

        const regionName = studentRegionFromProfile(profile.metadata, classRow.campus);
        const identity: IssuedStudentIdentity = {
            studentId: profile.id,
            name: profile.name,
            groupId,
            groupName: clean(classRow.name),
            regionId: regionName,
            regionName,
        };
        const now = Date.now();
        const verifiedStudent: StudentServerIdentity = {
            version: 2,
            kind: "student",
            ...identity,
            organizationId: workspaceId,
            identityType: "registered",
            accountId: credential.identity.accountId,
            credentialGeneration: credential.identity.credentialGeneration,
            issuedAt: now,
            expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
        };
        // Preserve retry authority before replacing the guest session cookie.
        // This proof carries no client attempt/exam/payload data: the claim RPC
        // remains authoritative by requiring rows actually owned by guest:{id}.
        if (existingGuestSession) {
            await setGuestClaimOwnerCookie(existingGuestSession, verifiedStudent);
        }
        const requestedGuestAttemptIds = boundGuestClaimAttemptIds(input.guestAttemptIds || []).attemptIds;
        const guestClaim = await claimSignedGuestAttempts(client, {
            guest: existingGuestSession,
            student: verifiedStudent,
            attemptIds: requestedGuestAttemptIds,
        });
        const cookieResult = await setSessionCookie({
            kind: "student",
            ...identity,
            organizationId: workspaceId,
            identityType: "registered",
            accountId: credential.identity.accountId,
            credentialGeneration: credential.identity.credentialGeneration,
        });
        if (!cookieResult.ok) return { ok: false, status: "error" };
        await recordDurableStudentLoginSuccess(rateLimitKeys);
        return { ok: true, status: "ok", identity, guestClaim };
    } catch (error) {
        console.error("issueStudentSession failed", error);
        return { ok: false, status: "error" };
    }
}

/**
 * Retry only claims for rows the database already owns as guest:{guestId}.
 * The client may select IDs to reduce work, but cannot submit an exam, score,
 * answers, timestamps, or any new canonical payload through this boundary.
 */
export async function retryGuestServerClaims(attemptIds: string[]): Promise<GuestClaimResult> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) {
        return { status: "retryable_error", acknowledgedAttemptIds: [], error: "Unauthenticated request" };
    }
    const client = adminClient();
    if (!client) {
        return { status: "retryable_error", acknowledgedAttemptIds: [], error: "Server storage unavailable" };
    }
    const cookieStore = await cookies();
    const studentValidation = await resolveAuthorizedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (studentValidation.status === "service_unavailable") {
        return { status: "retryable_error", acknowledgedAttemptIds: [], error: "Server storage unavailable" };
    }
    const student = studentValidation.status === "active" ? studentValidation.identity : null;
    const proof = parseSignedGuestClaimOwnerProof(cookieStore.get(GUEST_CLAIM_OWNER_COOKIE)?.value);
    if (!student || student.kind !== "student" || !proof || !guestClaimOwnerMatchesStudent(proof, student)) {
        return { status: "retryable_error", acknowledgedAttemptIds: [], error: "Guest claim proof unavailable" };
    }
    const guest: StudentServerIdentity = {
        version: 2,
        kind: "guest",
        guestId: proof.guestId,
        studentId: `guest:${proof.guestId}`,
        name: "Guest Student",
        identityType: "guest",
        issuedAt: proof.issuedAt,
        expiresAt: proof.expiresAt,
    };
    const boundedAttemptIds = boundGuestClaimAttemptIds(attemptIds).attemptIds;
    return claimSignedGuestAttempts(client, { guest, student, attemptIds: boundedAttemptIds });
}

/** Refresh an already authenticated student/guest cookie without trusting localStorage identity. */
export async function refreshStudentSession(): Promise<StudentSessionIssueResult> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) {
        return { ok: false, status: "unauthenticated" };
    }
    const cookieStore = await cookies();
    const client = adminClient() || {
        rpc: async () => ({ data: null, error: { message: "Student session storage unavailable" } }),
        from: () => ({ select: () => ({}) }),
    } as unknown as StudentAuthClient;
    const validation = await validateStudentServerSession(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (validation.status === "service_unavailable") return { ok: false, status: "error" };
    if (validation.status !== "active") return { ok: false, status: "unauthenticated" };
    const identity = validation.identity;
    const result = await setSessionCookie({
        kind: identity.kind,
        guestId: identity.guestId,
        studentId: identity.studentId,
        organizationId: identity.organizationId,
        name: identity.name,
        groupId: identity.groupId,
        groupName: identity.groupName,
        regionId: identity.regionId,
        regionName: identity.regionName,
        identityType: identity.identityType,
        accountId: identity.accountId,
        credentialGeneration: identity.credentialGeneration,
    });
    if (!result.ok) return { ok: false, status: "error" };
    const session = restoredSessionFromSignedIdentity(identity);
    return {
        ok: true,
        status: "ok",
        session,
        canLoginWithCurrentScope: identity.kind === "guest"
            && !!identity.organizationId
            && !!identity.groupId,
        ...(identity.kind === "student" ? {
            identity: {
                studentId: identity.studentId || "",
                name: identity.name,
                groupId: identity.groupId || "",
                groupName: identity.groupName || "Unknown",
                regionId: identity.regionId,
                regionName: identity.regionName,
            },
        } : {}),
    };
}

/** Confirm that the browser still has a valid signed student/guest cookie. */
export async function validateStudentSession(): Promise<StudentSessionIssueResult> {
    const cookieStore = await cookies();
    const client = adminClient() || {
        rpc: async () => ({ data: null, error: { message: "Student session storage unavailable" } }),
        from: () => ({ select: () => ({}) }),
    } as unknown as StudentAuthClient;
    const validation = await validateStudentServerSession(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (validation.status === "service_unavailable") return { ok: false, status: "error" };
    if (validation.status !== "active") return { ok: false, status: "unauthenticated" };
    const identity = validation.identity;
    if (identity.kind === "guest") return { ok: true, status: "ok" };
    return {
        ok: true,
        status: "ok",
        identity: {
            studentId: identity.studentId || "",
            name: identity.name,
            groupId: identity.groupId || "",
            groupName: identity.groupName || "Unknown",
            regionId: identity.regionId,
            regionName: identity.regionName,
        },
    };
}

/**
 * Ensure a server-signed guest session. A valid guest cookie is reused so the
 * guest identity survives repeated logins; only the display name is refreshed.
 */
export async function issueGuestSession(name?: string): Promise<{ ok: boolean; guestId?: string }> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) {
        return { ok: false };
    }
    const trimmedName = name?.trim();
    const cookieStore = await cookies();
    const client = adminClient() || {
        rpc: async () => ({ data: null, error: { message: "Student session storage unavailable" } }),
        from: () => ({ select: () => ({}) }),
    } as unknown as StudentAuthClient;
    const existingValidation = await resolveAuthorizedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (existingValidation.status === "service_unavailable") return { ok: false };
    const existing = existingValidation.status === "active" ? existingValidation.identity : null;
    if (existing && existing.kind !== "guest") return { ok: false };
    if (existing?.kind === "guest" && existing.guestId) {
        if (!trimmedName || trimmedName === existing.name) {
            return { ok: true, guestId: existing.guestId };
        }
        const refreshed = await setSessionCookie({
            kind: "guest",
            guestId: existing.guestId,
            organizationId: existing.organizationId,
            name: trimmedName,
            groupId: existing.groupId,
            groupName: existing.groupName,
            regionId: existing.regionId,
            regionName: existing.regionName,
            identityType: "guest",
        });
        return { ok: refreshed.ok, guestId: refreshed.ok ? existing.guestId : undefined };
    }
    const guestId = randomUUID();
    const result = await setSessionCookie({
        kind: "guest", guestId, name: trimmedName || "Guest Student", identityType: "guest",
    });
    return { ok: result.ok, guestId: result.ok ? guestId : undefined };
}

/** Logout clears the HttpOnly cookie so shared devices cannot inherit identity. */
export async function clearStudentServerSession(): Promise<{ ok: boolean }> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) {
        return { ok: false };
    }
    const cookieStore = await cookies();
    cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    cookieStore.delete(GUEST_CLAIM_OWNER_COOKIE);
    return { ok: true };
}
