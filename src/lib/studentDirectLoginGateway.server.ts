import "next/dist/compiled/server-only";

import {
    STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH,
    STUDENT_START_CODE_MAX_LENGTH,
    validateVerifiedStudentCredentialSession,
    verifyStudentCredentials,
    type StudentCredentialClient,
    type StudentCredentialSessionValidationClient,
    type VerifiedStudentCredentialIdentity,
} from "./studentCredentialVerifier";
import { INITIAL_OPERATIONS_LIMITS } from "./initialOperationsPolicy";

type QueryError = { message?: string } | null;

interface DirectStudentLoginQuery {
    eq(column: string, value: string): DirectStudentLoginQuery;
    in(column: string, values: string[]): DirectStudentLoginQuery;
    order(column: string, options?: { ascending?: boolean }): DirectStudentLoginQuery;
    maybeSingle(): PromiseLike<{ data: unknown; error: QueryError }>;
    limit(value: number): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
}

export interface DirectStudentLoginClient extends StudentCredentialSessionValidationClient {
    from(table: string): {
        select(columns?: string): DirectStudentLoginQuery;
    };
}

export interface DirectStudentLoginInput {
    studentId: string;
    startCode: string;
    groupId?: string;
}

type DirectStudentLoginGroup = { id: string; name: string; region?: string };

export type DirectStudentLoginResult =
    | { status: "verified"; credential: VerifiedStudentCredentialIdentity; group: DirectStudentLoginGroup }
    | { status: "group_required"; groups: DirectStudentLoginGroup[] }
    | { status: "invalid_credentials" }
    | { status: "service_unavailable" };

const START_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

// The verifier awaits a Promise, while Supabase query builders are PromiseLike.
// Preserve the narrow verifier contract without casting the admin client, and
// enforce the direct-entry active-profile policy on the verifier's second read.
function credentialClient(client: DirectStudentLoginClient): StudentCredentialClient {
    function wrap(query: DirectStudentLoginQuery, requireActiveProfile: boolean) {
        return {
            eq(column: string, value: string) { return wrap(query.eq(column, value), requireActiveProfile); },
            async maybeSingle() {
                const result = await query.maybeSingle();
                if (!result.error && requireActiveProfile && record(result.data).status !== "active") {
                    return { data: null, error: null };
                }
                return result;
            },
        };
    }
    return {
        from(table) {
            return {
                select(columns) {
                    return wrap(client.from(table).select(columns), table === "omr_student_profiles");
                },
            };
        },
    };
}

/**
 * Resolve teacher-issued credentials to an active enrolled class. The exact
 * primary key is the only global lookup; all directory reads follow credential
 * authentication and use its server-resolved organization. Credential identity
 * is server-only and must be omitted from browser-facing action results.
 */
export async function resolveDirectStudentLogin(
    client: DirectStudentLoginClient,
    input: DirectStudentLoginInput,
): Promise<DirectStudentLoginResult> {
    if (
        typeof input.studentId !== "string"
        || input.studentId.length > STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH
        || typeof input.startCode !== "string"
        || input.startCode.length > STUDENT_START_CODE_MAX_LENGTH
        || (input.groupId !== undefined && (
            typeof input.groupId !== "string"
            || input.groupId.length > STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH
        ))
    ) return { status: "invalid_credentials" };
    const studentId = clean(input.studentId);
    const groupId = clean(input.groupId);
    const startCode = clean(input.startCode).replace(/\s/g, "").toUpperCase();
    if (!studentId || !START_CODE_PATTERN.test(startCode)) return { status: "invalid_credentials" };

    try {
        const profileResult = await client.from("omr_student_profiles")
            .select("id,organization_id,status")
            .eq("id", studentId)
            .maybeSingle();
        if (profileResult.error) return { status: "service_unavailable" };
        const profile = record(profileResult.data);
        const organizationId = clean(profile.organization_id);
        if (!organizationId || clean(profile.id) !== studentId || profile.status !== "active") {
            return { status: "invalid_credentials" };
        }

        const credential = await verifyStudentCredentials(credentialClient(client), {
            organizationId,
            studentProfileId: studentId,
            code: startCode,
        });
        if (credential.status === "service_unavailable") return { status: "service_unavailable" };
        if (credential.status !== "verified") return { status: "invalid_credentials" };
        const validity = await validateVerifiedStudentCredentialSession(client, credential.identity);
        if (validity === "service_unavailable") return { status: "service_unavailable" };
        if (validity !== "active") return { status: "invalid_credentials" };

        const enrollmentResult = await client.from("omr_class_students")
            .select("class_id,organization_id,student_profile_id,enrollment_status")
            .eq("organization_id", organizationId)
            .eq("student_profile_id", studentId)
            .eq("enrollment_status", "active")
            .order("class_id", { ascending: true })
            .limit(INITIAL_OPERATIONS_LIMITS.classes + 1);
        if (
            enrollmentResult.error
            || !Array.isArray(enrollmentResult.data)
            || enrollmentResult.data.length > INITIAL_OPERATIONS_LIMITS.classes
        ) return { status: "service_unavailable" };
        const classIds = new Set<string>();
        for (const value of enrollmentResult.data) {
            const row = record(value);
            const classId = clean(row.class_id);
            if (
                !classId
                || clean(row.organization_id) !== organizationId
                || clean(row.student_profile_id) !== studentId
                || row.enrollment_status !== "active"
            ) return { status: "invalid_credentials" };
            classIds.add(classId);
        }
        if (classIds.size === 0) return { status: "invalid_credentials" };

        const classResult = await client.from("omr_classes")
            .select("id,organization_id,name,campus,status")
            .eq("organization_id", organizationId)
            .eq("status", "active")
            .in("id", [...classIds])
            .order("name", { ascending: true })
            .limit(INITIAL_OPERATIONS_LIMITS.classes + 1);
        if (
            classResult.error
            || !Array.isArray(classResult.data)
            || classResult.data.length > INITIAL_OPERATIONS_LIMITS.classes
        ) return { status: "service_unavailable" };
        const groups: DirectStudentLoginGroup[] = [];
        for (const value of classResult.data) {
            const row = record(value);
            const id = clean(row.id);
            const name = clean(row.name);
            if (
                !classIds.has(id)
                || !name
                || clean(row.organization_id) !== organizationId
                || row.status !== "active"
            ) return { status: "invalid_credentials" };
            groups.push({ id, name, region: clean(row.campus) || undefined });
        }
        if (groups.length === 0) return { status: "invalid_credentials" };
        if (!groupId && groups.length > 1) return { status: "group_required", groups };
        const selectedGroup = groupId ? groups.find(group => group.id === groupId) : groups[0];
        if (!selectedGroup) return { status: "invalid_credentials" };
        return { status: "verified", credential: credential.identity, group: selectedGroup };
    } catch {
        return { status: "service_unavailable" };
    }
}
