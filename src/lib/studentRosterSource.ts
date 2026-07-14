import type { SupabaseAdminReadClientLike } from "@/lib/supabaseServerAdmin";
import type { StudentRosterSnapshot } from "@/lib/studentRosterVerification";
import type { StudentCodeGroupLike, StudentCodeStudentLike } from "@/lib/studentCodes";

/**
 * Loads the trusted, server-side roster snapshot used to verify a student login.
 * This is the DATA source behind blocker 1: it must come from the service-role
 * store, never the client, so a crafted login cannot present its own roster.
 *
 * LIVE VERIFICATION PENDING: exercised here against mock clients only. Two things
 * still need real-Supabase confirmation / follow-up wiring:
 *  1. the exact omr_classes / omr_student_profiles / omr_class_students shapes; and
 *  2. server-side start-code provisioning — start codes currently live in client
 *     localStorage (omr_student_codes). Until a teacher-side action writes them into
 *     profile metadata (Step 3/4), `startCodes` will be empty and the start-code
 *     gate is effectively "issue on first login". The roster-MATCH gate (rejecting
 *     unknown students) is fully enforced regardless.
 */

function readString(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    return typeof value === "string" ? value.trim() : "";
}

function readMetadata(row: Record<string, unknown>): Record<string, unknown> {
    const meta = row.metadata;
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

async function listByOrg(
    client: SupabaseAdminReadClientLike,
    table: string,
    organizationId: string,
): Promise<Record<string, unknown>[]> {
    const { data, error } = await client
        .from(table)
        .select("*")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true });
    if (error) throw new Error(error.message || `Failed to read ${table}`);
    return (data || []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

export async function loadStudentRosterSnapshot(
    client: SupabaseAdminReadClientLike,
    organizationId: string,
    options: { requireRosterMatch?: boolean } = {},
): Promise<StudentRosterSnapshot> {
    const org = organizationId.trim();
    const [classRows, profileRows, enrollmentRows] = await Promise.all([
        listByOrg(client, "omr_classes", org),
        listByOrg(client, "omr_student_profiles", org),
        listByOrg(client, "omr_class_students", org),
    ]);

    const groups: StudentCodeGroupLike[] = classRows.map(row => ({
        id: readString(row, "id"),
        name: readString(row, "name"),
        region: readString(row, "campus") || readString(readMetadata(row), "region") || undefined,
    }));
    const classById = new Map(groups.map(group => [group.id, group]));

    // student_profile_id -> class name (for the studentCodes group matcher).
    const classForProfile = new Map<string, StudentCodeGroupLike>();
    for (const row of enrollmentRows) {
        const profileId = readString(row, "student_profile_id");
        const group = classById.get(readString(row, "class_id"));
        if (profileId && group && !classForProfile.has(profileId)) classForProfile.set(profileId, group);
    }

    const startCodes: Record<string, string> = {};
    const students: StudentCodeStudentLike[] = profileRows.map(row => {
        const id = readString(row, "id");
        const group = classForProfile.get(id);
        const code = readString(readMetadata(row), "startCode");
        if (id && code) startCodes[id] = code.toUpperCase();
        return {
            id,
            name: readString(row, "display_name"),
            group: group?.name || undefined,
            region: group?.region || readString(row, "region") || undefined,
            email: readString(row, "email") || undefined,
        };
    });

    return {
        organizationId: org,
        groups,
        students,
        startCodes,
        // Default to enforcing a roster match: an org with a provisioned roster
        // rejects unknown students. Callers can relax it for public quick-entry.
        requireRosterMatch: options.requireRosterMatch ?? students.length > 0,
    };
}
