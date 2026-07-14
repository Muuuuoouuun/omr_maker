"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    resolveStudentSessionSecret,
    STUDENT_SERVER_SESSION_COOKIE,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentIdentityInput,
} from "@/lib/studentServerSession";
import { shouldUseSecureTeacherSessionCookie } from "@/lib/teacherServerSession";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    metadataWithStudentAccessCode,
    readStudentAccessCodeRecord,
    verifyStudentAccessCode,
} from "@/lib/studentAccessCode";
import {
    buildStudentLoginRateLimitKeys,
    checkStudentLoginRateLimit,
    recordStudentLoginFailure,
    recordStudentLoginSuccess,
    STUDENT_LOGIN_RATE_LIMIT_ERROR,
} from "@/lib/studentLoginRateLimit";
import {
    resolveServerStudentLogin,
    studentRegionFromProfile,
    type StudentLoginEnrollmentRow,
    type StudentLoginProfileRow,
} from "@/lib/studentLoginIdentity";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

const WORKSPACE_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16})$/;
const MAX_CODE_SYNC_ENTRIES = 500;

type QueryError = { message?: string } | null;

interface StudentAuthFilter {
    eq(column: string, value: string): StudentAuthFilter;
    in(column: string, values: string[]): StudentAuthFilter;
    maybeSingle(): PromiseLike<{ data: unknown; error: QueryError }>;
    order(column: string, options?: { ascending?: boolean }): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
}

interface StudentAuthClient {
    from(table: string): {
        select(columns?: string): StudentAuthFilter;
        upsert(row: unknown): PromiseLike<{ error: QueryError }>;
    };
}

export interface StudentLoginGroup {
    id: string;
    name: string;
    region?: string;
}

export interface IssuedStudentIdentity {
    studentId: string;
    name: string;
    groupId: string;
    groupName: string;
    regionId?: string;
    regionName?: string;
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

function clientFingerprintFromHeaders(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || headerStore.get("user-agent")?.trim()
        || "unknown-client";
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

/** Minimal public directory used by an academy-specific student invite link. */
export async function loadStudentLoginDirectory(workspaceValue: string): Promise<{
    status: "ok" | "degraded_local" | "invalid_workspace" | "error";
    groups?: StudentLoginGroup[];
}> {
    const workspaceId = normalizeWorkspaceId(workspaceValue);
    if (!workspaceId) return { status: "invalid_workspace" };
    const client = adminClient();
    if (!client) return { status: "degraded_local" };

    try {
        const result = await client.from("omr_classes")
            .select("id,name,campus,status")
            .eq("organization_id", workspaceId)
            .order("name", { ascending: true });
        if (result.error) throw new Error(result.error.message || "Failed to load student login groups");
        const groups = (result.data || [])
            .map(asRecord)
            .filter(row => (clean(row.status) || "active") === "active")
            .map(row => ({
                id: clean(row.id),
                name: clean(row.name),
                region: clean(row.campus) || undefined,
            }))
            .filter(group => group.id && group.name)
            .slice(0, 200);
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
    name: string;
    groupId?: string;
    studentLookup?: string;
    startCode?: string;
    studentId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
}): Promise<StudentSessionIssueResult> {
    const client = adminClient();
    if (!client) {
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

    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const name = clean(input.name);
    const groupId = clean(input.groupId);
    const studentLookup = clean(input.studentLookup);
    if (!workspaceId) return { ok: false, status: "invalid_workspace" };

    const headerStore = await headers();
    const rateLimitKeys = buildStudentLoginRateLimitKeys({
        workspaceId,
        studentLookup,
        clientFingerprint: clientFingerprintFromHeaders(headerStore),
    });
    if (!checkStudentLoginRateLimit(rateLimitKeys).allowed) {
        return { ok: false, status: "rate_limited", error: STUDENT_LOGIN_RATE_LIMIT_ERROR };
    }
    if (!name || !groupId || !studentLookup) {
        recordStudentLoginFailure(rateLimitKeys);
        return { ok: false, status: "invalid_credentials" };
    }

    try {
        const [profilesResult, enrollmentsResult, classResult] = await Promise.all([
            client.from("omr_student_profiles")
                .select("id,organization_id,display_name,external_id,email,status,metadata")
                .eq("organization_id", workspaceId)
                .eq("display_name", name)
                .order("id", { ascending: true }),
            client.from("omr_class_students")
                .select("class_id,organization_id,student_profile_id,enrollment_status")
                .eq("organization_id", workspaceId)
                .eq("class_id", groupId)
                .order("student_profile_id", { ascending: true }),
            client.from("omr_classes")
                .select("id,organization_id,name,campus,status")
                .eq("organization_id", workspaceId)
                .eq("id", groupId)
                .maybeSingle(),
        ]);
        if (profilesResult.error || enrollmentsResult.error || classResult.error) {
            throw new Error(profilesResult.error?.message || enrollmentsResult.error?.message || classResult.error?.message || "Student login query failed");
        }
        const classRow = asRecord(classResult.data);
        if (!clean(classRow.id) || (clean(classRow.status) || "active") !== "active") {
            recordStudentLoginFailure(rateLimitKeys);
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
            recordStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "invalid_credentials" };
        }

        const accessCodeRecord = readStudentAccessCodeRecord(profile.metadata);
        if (!accessCodeRecord) {
            recordStudentLoginFailure(rateLimitKeys);
            return { ok: false, status: "code_not_issued" };
        }
        const secret = resolveStudentSessionSecret();
        if (!secret) return { ok: false, status: "error" };
        if (!verifyStudentAccessCode(profile.metadata, {
            code: input.startCode,
            studentId: profile.id,
            organizationId: workspaceId,
            secret,
        })) {
            recordStudentLoginFailure(rateLimitKeys);
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
        const cookieResult = await setSessionCookie({
            kind: "student",
            ...identity,
            organizationId: workspaceId,
            identityType: "temporary",
        });
        if (!cookieResult.ok) return { ok: false, status: "error" };
        recordStudentLoginSuccess(rateLimitKeys);
        return { ok: true, status: "ok", identity };
    } catch (error) {
        console.error("issueStudentSession failed", error);
        return { ok: false, status: "error" };
    }
}

/** Refresh an already authenticated student/guest cookie without trusting localStorage identity. */
export async function refreshStudentSession(): Promise<StudentSessionIssueResult> {
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!identity) return { ok: false, status: "unauthenticated" };
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
    });
    if (!result.ok) return { ok: false, status: "error" };
    if (identity.kind === "guest") {
        return { ok: true, status: "ok" };
    }
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

/** Confirm that the browser still has a valid signed student/guest cookie. */
export async function validateStudentSession(): Promise<StudentSessionIssueResult> {
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!identity) return { ok: false, status: "unauthenticated" };
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

/** Teacher-authenticated migration/write-through for locally issued start codes. */
export async function syncStudentAccessCodes(entries: Array<{ studentId: string; code: string }>): Promise<{
    status: "ok" | "degraded_local" | "unauthenticated" | "error";
    syncedCount: number;
    missingCount?: number;
}> {
    const cookieStore = await cookies();
    const teacherSession = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!teacherSession) return { status: "unauthenticated", syncedCount: 0 };
    const client = adminClient();
    if (!client) return { status: "degraded_local", syncedCount: 0 };
    const secret = resolveStudentSessionSecret();
    if (!secret) return { status: "error", syncedCount: 0 };

    const context = workspaceContextFromTeacherSession(teacherSession);
    const codeByStudentId = new Map(entries
        .slice(0, MAX_CODE_SYNC_ENTRIES)
        .map(entry => [clean(entry.studentId), clean(entry.code)] as const)
        .filter(([studentId, code]) => studentId && code));
    if (codeByStudentId.size === 0) return { status: "ok", syncedCount: 0, missingCount: 0 };

    try {
        const result = await client.from("omr_student_profiles")
            .select("*")
            .eq("organization_id", context.organizationId)
            .in("id", [...codeByStudentId.keys()])
            .order("id", { ascending: true });
        if (result.error) throw new Error(result.error.message || "Failed to load student profiles for code sync");

        const updatedAt = new Date().toISOString();
        const updates = (result.data || []).map(asRecord).flatMap(row => {
            const studentId = clean(row.id);
            const code = codeByStudentId.get(studentId);
            if (!studentId || !code) return [];
            const nextMetadata = metadataWithStudentAccessCode(row.metadata, {
                code,
                studentId,
                organizationId: context.organizationId,
                secret,
                updatedAt,
            });
            return nextMetadata ? [{ ...row, metadata: nextMetadata, updated_at: updatedAt }] : [];
        });
        if (updates.length > 0) {
            const upsertResult = await client.from("omr_student_profiles").upsert(updates);
            if (upsertResult.error) throw new Error(upsertResult.error.message || "Failed to sync student access codes");
        }
        return {
            status: "ok",
            syncedCount: updates.length,
            missingCount: Math.max(0, codeByStudentId.size - updates.length),
        };
    } catch (error) {
        console.error("syncStudentAccessCodes failed", error);
        return { status: "error", syncedCount: 0 };
    }
}

/**
 * Ensure a server-signed guest session. A valid guest cookie is reused so the
 * guest identity survives repeated logins; only the display name is refreshed.
 */
export async function issueGuestSession(name?: string): Promise<{ ok: boolean; guestId?: string }> {
    const trimmedName = name?.trim();
    const cookieStore = await cookies();
    const existing = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (existing?.kind === "guest" && existing.guestId) {
        if (!trimmedName || trimmedName === existing.name) {
            return { ok: true, guestId: existing.guestId };
        }
        const refreshed = await setSessionCookie({
            kind: "guest", guestId: existing.guestId, name: trimmedName, identityType: "guest",
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
    const cookieStore = await cookies();
    cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    return { ok: true };
}
