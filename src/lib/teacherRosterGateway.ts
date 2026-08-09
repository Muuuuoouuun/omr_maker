import {
    rosterGroupFromSupabaseRow,
    rosterSnapshotToSupabaseRows,
    rosterStudentFromSupabaseRow,
    type RosterSnapshot,
    type SupabaseRosterClassRow,
    type SupabaseRosterClassStudentRow,
    type SupabaseRosterStudentProfileRow,
} from "@/lib/rosterPersistence";
import { normalizeRosterInvite, type RosterGroup, type RosterInvite, type RosterStudent } from "@/lib/rosterStorage";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import {
    normalizeCanonicalUtcTimestamp,
    type CanonicalCollectionMeta,
} from "@/lib/canonicalCollectionContract";

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface TeacherRosterSelectQuery {
    eq(column: string, value: string): TeacherRosterSelectQuery;
    order(column: string, options: { ascending: boolean }): TeacherRosterSelectQuery;
    limit(value: number): PromiseLike<GatewayResult<unknown[]>>;
}

export interface TeacherRosterGatewayClient {
    from(table: string): {
        select(columns: string): TeacherRosterSelectQuery;
    };
    rpc(name: string, params: Record<string, unknown>): Promise<GatewayResult<unknown>>;
}

export type TeacherRosterLoadResult =
    | { status: "loaded"; snapshot: RosterSnapshot; revision: number; meta: CanonicalCollectionMeta }
    | { status: "service_unavailable"; error?: string };

export type TeacherRosterSaveResult =
    | { status: "saved"; snapshot: RosterSnapshot; revision: number }
    | { status: "conflict" | "invalid_roster" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isExactIdentifier(value: unknown): value is string {
    return typeof value === "string" && !!value && value.trim() === value;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
    return !!normalizeCanonicalUtcTimestamp(value);
}

function isBoundedRosterText(value: unknown): value is string {
    return typeof value === "string"
        && value.length <= 120
        && !!value.trim()
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalRosterClassRow(value: unknown, organizationId: string): boolean {
    if (!isRecord(value)) return false;
    return isExactIdentifier(value.id)
        && value.organization_id === organizationId
        && !!clean(value.name)
        && (value.status === "active" || value.status === "archived")
        && isRecord(value.metadata)
        && isCanonicalUtcTimestamp(value.updated_at);
}

function isCanonicalRosterStudentRow(value: unknown, organizationId: string): boolean {
    if (!isRecord(value)) return false;
    return isExactIdentifier(value.id)
        && value.organization_id === organizationId
        && !!clean(value.display_name)
        && ["invited", "active", "inactive", "graduated", "withdrawn"].includes(String(value.status))
        && isRecord(value.metadata)
        && isCanonicalUtcTimestamp(value.updated_at);
}

function isCanonicalRosterEnrollmentRow(value: unknown, organizationId: string): boolean {
    if (!isRecord(value)) return false;
    return isExactIdentifier(value.class_id)
        && value.organization_id === organizationId
        && isExactIdentifier(value.student_profile_id)
        && ["active", "inactive", "transferred", "completed"].includes(String(value.enrollment_status));
}

function isCanonicalRosterInviteRow(value: unknown, organizationId: string): boolean {
    if (!isRecord(value)) return false;
    return isExactIdentifier(value.id)
        && value.organization_id === organizationId
        && !!clean(value.email)
        && ["pending", "accepted", "expired"].includes(String(value.status))
        && isBoundedRosterText(value.sent_at);
}

function validSnapshot(snapshot: RosterSnapshot): boolean {
    if (!snapshot || !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.students) || !Array.isArray(snapshot.invites)) {
        return false;
    }
    const groupIds = new Set(snapshot.groups.map(group => clean(group.id)));
    const studentIds = new Set(snapshot.students.map(student => clean(student.id)));
    const inviteIds = new Set(snapshot.invites.map(invite => clean(invite.id)));
    return groupIds.size === snapshot.groups.length
        && studentIds.size === snapshot.students.length
        && inviteIds.size === snapshot.invites.length
        && ![...groupIds, ...studentIds, ...inviteIds].some(id => !id);
}

export async function loadTeacherRosterWithGateway(
    client: TeacherRosterGatewayClient,
    context: WorkspaceContext,
): Promise<TeacherRosterLoadResult> {
    const organizationId = clean(context.organizationId);
    if (!organizationId) return { status: "service_unavailable", error: "Teacher organization is missing" };

    const result = await client.rpc("omr_load_roster_v2", { p_organization_id: organizationId });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const payload = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : null;
    const classRows = Array.isArray(payload?.classes) ? payload.classes : null;
    const studentRows = Array.isArray(payload?.students) ? payload.students : null;
    const enrollmentRows = Array.isArray(payload?.enrollments) ? payload.enrollments : null;
    const inviteRows = Array.isArray(payload?.invites) ? payload.invites : null;
    if (!payload || !classRows || !studentRows || !enrollmentRows || !inviteRows) {
        return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
    }
    if (
        classRows.length > INITIAL_OPERATIONS_LIMITS.classes
        || studentRows.length > INITIAL_OPERATIONS_LIMITS.students
        || enrollmentRows.length > INITIAL_OPERATIONS_LIMITS.enrollments
        || inviteRows.length > INITIAL_OPERATIONS_LIMITS.invites
    ) {
        return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
    }

    try {
        if (
            classRows.some(row => !isCanonicalRosterClassRow(row, organizationId))
            || studentRows.some(row => !isCanonicalRosterStudentRow(row, organizationId))
            || enrollmentRows.some(row => !isCanonicalRosterEnrollmentRow(row, organizationId))
            || inviteRows.some(row => !isCanonicalRosterInviteRow(row, organizationId))
        ) {
            return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
        }

        const rawClassIds = new Set(classRows.map(row => clean((row as { id?: unknown }).id)));
        if (rawClassIds.size !== classRows.length || rawClassIds.has("")) {
            return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
        }
        const groups: RosterGroup[] = [];
        for (const [index, row] of classRows.entries()) {
            if ((row as { status?: unknown }).status === "archived") continue;
            const group = rosterGroupFromSupabaseRow(row as SupabaseRosterClassRow, index);
            if (!group) return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
            groups.push(group);
        }
        groups.sort((a, b) => `${a.region || ""}:${a.name}`.localeCompare(`${b.region || ""}:${b.name}`, "ko"));

        const studentProfileIds = new Set(studentRows.map(row => clean((row as { id?: unknown }).id)));
        if (studentProfileIds.size !== studentRows.length || studentProfileIds.has("")) {
            return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
        }
        const enrollmentByStudentId = new Map<string, SupabaseRosterClassStudentRow>();
        for (const value of enrollmentRows) {
            const row = value as SupabaseRosterClassStudentRow;
            const classId = clean(row.class_id);
            const studentProfileId = clean(row.student_profile_id);
            if (
                !classId
                || !studentProfileId
                || !rawClassIds.has(classId)
                || !studentProfileIds.has(studentProfileId)
                || !["active", "inactive", "transferred", "completed"].includes(row.enrollment_status)
            ) {
                return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
            }
            if (row.enrollment_status === "active") enrollmentByStudentId.set(studentProfileId, row);
        }

        const students: RosterStudent[] = [];
        for (const [index, value] of studentRows.entries()) {
            const row = value as SupabaseRosterStudentProfileRow;
            if (row.status === "withdrawn") continue;
            const student = rosterStudentFromSupabaseRow(
                row,
                groups,
                enrollmentByStudentId.get(row.id),
                index,
            );
            if (!student) return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
            students.push(student);
        }
        students.sort((a, b) => a.name.localeCompare(b.name, "ko"));

        const invites: RosterInvite[] = [];
        for (const [index, row] of inviteRows.entries()) {
            const item = row as { id?: unknown; email?: unknown; sent_at?: unknown; status?: unknown };
            const invite = normalizeRosterInvite(
                { id: item.id, email: item.email, sentAt: item.sent_at, status: item.status },
                index,
            );
            if (!invite) return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
            invites.push(invite);
        }

        const rawRevision = payload.revision;
        const revision = typeof rawRevision === "number" ? rawRevision : Number(rawRevision);
        const snapshot = { students, groups, invites };
        if (!Number.isSafeInteger(revision) || revision < 0 || !validSnapshot(snapshot)) {
            return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
        }
        const rawCount = classRows.length + studentRows.length + enrollmentRows.length + inviteRows.length;
        const parsedCount = rawCount;
        if (rawCount !== parsedCount) {
            return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
        }
        return {
            status: "loaded",
            snapshot,
            revision,
            meta: {
                organizationId,
                loadedAt: new Date().toISOString(),
                rawCount,
                parsedCount,
            },
        };
    } catch {
        return { status: "service_unavailable", error: "Canonical roster snapshot is invalid" };
    }
}

export async function saveTeacherRosterWithGateway(
    client: TeacherRosterGatewayClient,
    snapshot: RosterSnapshot,
    context: WorkspaceContext,
    expectedRevision: number | null = null,
): Promise<TeacherRosterSaveResult> {
    const organizationId = clean(context.organizationId);
    const accountId = clean(context.accountId);
    const actorUserId = clean(context.actorUserId);
    const sessionAuthority = context.sessionAuthority;
    const sessionGeneration = context.accountSessionGeneration;
    const validIdentity = (sessionAuthority === "account" || sessionAuthority === "legacy_account")
        && !!accountId
        && !!actorUserId
        && Number.isSafeInteger(sessionGeneration)
        && (sessionGeneration ?? 0) >= 1;
    if (!organizationId || !validSnapshot(snapshot)) return { status: "invalid_roster" };
    if (!validIdentity) return { status: "service_unavailable", error: "Teacher session is unavailable" };
    const rows = rosterSnapshotToSupabaseRows(snapshot, organizationId, undefined, context.organizationName);
    const result = await client.rpc("omr_save_roster_v3", {
        p_session_authority: sessionAuthority,
        p_account_id: accountId,
        p_session_generation: sessionGeneration,
        p_actor_user_id: actorUserId,
        p_organization_id: organizationId,
        p_expected_revision: Number.isSafeInteger(expectedRevision) && (expectedRevision ?? -1) >= 0
            ? expectedRevision
            : null,
        p_classes: rows.classes,
        p_students: rows.students,
        p_enrollments: rows.enrollments,
        p_invites: snapshot.invites.map(invite => ({
            id: invite.id,
            organization_id: organizationId,
            email: invite.email,
            sent_at: invite.sentAt,
            status: invite.status,
        })),
    });
    if (result.error) {
        if (/roster revision conflict/i.test(result.error.message || "")) {
            return { status: "conflict", error: result.error.message };
        }
        return { status: "service_unavailable", error: result.error.message || "Canonical roster save failed" };
    }
    const rawRevision = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>).revision
        : undefined;
    const revision = typeof rawRevision === "number" ? rawRevision : Number(rawRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
        return { status: "service_unavailable", error: "Canonical roster revision is missing" };
    }
    return { status: "saved", snapshot, revision };
}
