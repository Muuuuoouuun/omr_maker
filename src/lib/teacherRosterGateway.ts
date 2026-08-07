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
    | { status: "loaded"; snapshot: RosterSnapshot; revision: number }
    | { status: "service_unavailable"; error?: string };

export type TeacherRosterSaveResult =
    | { status: "saved"; snapshot: RosterSnapshot; revision: number }
    | { status: "conflict" | "invalid_roster" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
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

    const groups = classRows
        .map((row, index) => rosterGroupFromSupabaseRow(row as SupabaseRosterClassRow, index))
        .filter((group): group is RosterGroup => !!group)
        .sort((a, b) => `${a.region || ""}:${a.name}`.localeCompare(`${b.region || ""}:${b.name}`, "ko"));
    const enrollmentByStudentId = new Map<string, SupabaseRosterClassStudentRow>();
    for (const row of enrollmentRows as SupabaseRosterClassStudentRow[]) {
        const current = enrollmentByStudentId.get(row.student_profile_id);
        if (!current || row.enrollment_status === "active") enrollmentByStudentId.set(row.student_profile_id, row);
    }
    const students = studentRows
        .map((row, index) => rosterStudentFromSupabaseRow(
            row as SupabaseRosterStudentProfileRow,
            groups,
            enrollmentByStudentId.get((row as SupabaseRosterStudentProfileRow).id),
            index,
        ))
        .filter((student): student is RosterStudent => !!student)
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const invites = inviteRows
        .map((row, index) => {
            const item = row as { id?: unknown; email?: unknown; sent_at?: unknown; status?: unknown };
            return normalizeRosterInvite({ id: item.id, email: item.email, sentAt: item.sent_at, status: item.status }, index);
        })
        .filter((invite): invite is RosterInvite => !!invite);

    const rawRevision = payload.revision;
    const parsedRevision = typeof rawRevision === "number" ? rawRevision : Number(rawRevision);
    const revision = Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;

    return { status: "loaded", snapshot: { students, groups, invites }, revision };
}

export async function saveTeacherRosterWithGateway(
    client: TeacherRosterGatewayClient,
    snapshot: RosterSnapshot,
    context: WorkspaceContext,
    expectedRevision: number | null = null,
): Promise<TeacherRosterSaveResult> {
    const organizationId = clean(context.organizationId);
    if (!organizationId || !validSnapshot(snapshot)) return { status: "invalid_roster" };
    const rows = rosterSnapshotToSupabaseRows(snapshot, organizationId, undefined, context.organizationName);
    const result = await client.rpc("omr_save_roster_v2", {
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
