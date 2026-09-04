import {
    rosterGroupFromSupabaseRow,
    rosterSnapshotToSupabaseRows,
    rosterStudentFromSupabaseRow,
    type RosterSnapshot,
    type SupabaseRosterClassRow,
    type SupabaseRosterClassStudentRow,
    type SupabaseRosterStudentProfileRow,
} from "@/lib/rosterPersistence";
import {
    normalizeRosterInvite,
    rosterGroupMatchesStudent,
    rosterGroupScopeKey,
    type RosterGroup,
    type RosterInvite,
    type RosterStudent,
} from "@/lib/rosterStorage";
import type { WorkspaceContext } from "@/lib/workspaceContext";

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface TeacherRosterSelectQuery {
    eq(column: string, value: string): Promise<GatewayResult<unknown[]>>;
}

export interface TeacherRosterGatewayClient {
    from(table: string): {
        select(columns: string): TeacherRosterSelectQuery;
    };
    rpc(name: string, params: Record<string, unknown>): Promise<GatewayResult<unknown>>;
}

export type TeacherRosterLoadResult =
    | { status: "loaded"; snapshot: RosterSnapshot }
    | { status: "service_unavailable"; error?: string };

export type TeacherRosterSaveResult =
    | { status: "saved"; snapshot: RosterSnapshot }
    | { status: "conflict" | "invalid_roster" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function validSnapshot(snapshot: RosterSnapshot): boolean {
    if (!snapshot || !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.students) || !Array.isArray(snapshot.invites)) {
        return false;
    }
    const groupIds = new Set(snapshot.groups.map(group => clean(group.id)));
    const groupScopes = new Set(snapshot.groups.map(group => rosterGroupScopeKey(group.name, group.region)));
    const studentIds = new Set(snapshot.students.map(student => clean(student.id)));
    const inviteIds = new Set(snapshot.invites.map(invite => clean(invite.id)));
    return groupIds.size === snapshot.groups.length
        && groupScopes.size === snapshot.groups.length
        && studentIds.size === snapshot.students.length
        && inviteIds.size === snapshot.invites.length
        && ![...groupIds, ...groupScopes, ...studentIds, ...inviteIds].some(id => !id)
        && snapshot.students.every(student => (
            snapshot.groups.filter(group => rosterGroupMatchesStudent(group, student)).length === 1
        ));
}

export async function loadTeacherRosterWithGateway(
    client: TeacherRosterGatewayClient,
    context: WorkspaceContext,
): Promise<TeacherRosterLoadResult> {
    const organizationId = clean(context.organizationId);
    if (!organizationId) return { status: "service_unavailable", error: "Teacher organization is missing" };

    const [classResult, studentResult, enrollmentResult, inviteResult, revisionResult] = await Promise.all([
        client.from("omr_classes").select("id, organization_id, name, campus, status, metadata, updated_at").eq("organization_id", organizationId),
        client.from("omr_student_profiles").select("id, organization_id, display_name, external_id, email, status, metadata, updated_at").eq("organization_id", organizationId),
        client.from("omr_class_students").select("class_id, organization_id, student_profile_id, enrollment_status").eq("organization_id", organizationId),
        client.from("omr_roster_invites").select("id, organization_id, email, sent_at, status").eq("organization_id", organizationId),
        client.from("omr_roster_revisions").select("organization_id, revision").eq("organization_id", organizationId),
    ]);
    const failed = [classResult, studentResult, enrollmentResult, inviteResult, revisionResult].find(result => result.error);
    if (failed?.error) return { status: "service_unavailable", error: failed.error.message };

    const groups = (classResult.data || [])
        .map((row, index) => rosterGroupFromSupabaseRow(row as SupabaseRosterClassRow, index))
        .filter((group): group is RosterGroup => !!group)
        .sort((a, b) => `${a.region || ""}:${a.name}`.localeCompare(`${b.region || ""}:${b.name}`, "ko"));
    const enrollmentByStudentId = new Map<string, SupabaseRosterClassStudentRow>();
    for (const row of (enrollmentResult.data || []) as SupabaseRosterClassStudentRow[]) {
        const current = enrollmentByStudentId.get(row.student_profile_id);
        if (!current || row.enrollment_status === "active") enrollmentByStudentId.set(row.student_profile_id, row);
    }
    const students = (studentResult.data || [])
        .map((row, index) => rosterStudentFromSupabaseRow(
            row as SupabaseRosterStudentProfileRow,
            groups,
            enrollmentByStudentId.get((row as SupabaseRosterStudentProfileRow).id),
            index,
        ))
        .filter((student): student is RosterStudent => !!student)
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const invites = (inviteResult.data || [])
        .map((row, index) => {
            const item = row as { id?: unknown; email?: unknown; sent_at?: unknown; status?: unknown };
            return normalizeRosterInvite({ id: item.id, email: item.email, sentAt: item.sent_at, status: item.status }, index);
        })
        .filter((invite): invite is RosterInvite => !!invite);

    const revisionRow = (revisionResult.data?.[0] || null) as { revision?: unknown } | null;
    const parsedRevision = Number(revisionRow?.revision);
    const revision = Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;

    return { status: "loaded", snapshot: { students, groups, invites, revision } };
}

export async function saveTeacherRosterWithGateway(
    client: TeacherRosterGatewayClient,
    snapshot: RosterSnapshot,
    context: WorkspaceContext,
): Promise<TeacherRosterSaveResult> {
    const organizationId = clean(context.organizationId);
    if (!organizationId || !validSnapshot(snapshot)) return { status: "invalid_roster" };
    const rows = rosterSnapshotToSupabaseRows(snapshot, organizationId, undefined, context.organizationName);
    const expectedRevision = Number(snapshot.revision ?? 0);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { status: "invalid_roster" };
    const result = await client.rpc("omr_save_roster_v2", {
        p_organization_id: organizationId,
        p_expected_revision: expectedRevision,
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
    const response = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as { revision?: unknown }
        : null;
    const parsedRevision = Number(response?.revision);
    const revision = Number.isSafeInteger(parsedRevision) && parsedRevision > expectedRevision
        ? parsedRevision
        : expectedRevision + 1;
    return { status: "saved", snapshot: { ...snapshot, revision } };
}
