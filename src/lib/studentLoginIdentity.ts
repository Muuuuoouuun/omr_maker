export interface StudentLoginProfileRow {
    id: string;
    organization_id: string;
    display_name: string;
    external_id?: string | null;
    email?: string | null;
    status?: string | null;
    metadata?: Record<string, unknown> | null;
}

export interface StudentLoginEnrollmentRow {
    class_id: string;
    organization_id: string;
    student_profile_id: string;
    enrollment_status?: string | null;
}

export interface ResolvedStudentLoginProfile {
    id: string;
    name: string;
    email?: string;
    metadata: Record<string, unknown>;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalized(value: unknown): string {
    return clean(value).toLocaleLowerCase("ko-KR");
}

function metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

export function resolveServerStudentLogin(params: {
    profiles: readonly StudentLoginProfileRow[];
    enrollments: readonly StudentLoginEnrollmentRow[];
    organizationId: string;
    groupId: string;
    name: string;
    studentLookup: string;
}): ResolvedStudentLoginProfile | null {
    const organizationId = clean(params.organizationId);
    const groupId = clean(params.groupId);
    const name = clean(params.name);
    const lookup = normalized(params.studentLookup);
    if (!organizationId || !groupId || !name || !lookup) return null;

    const enrolledIds = new Set(params.enrollments
        .filter(row => clean(row.organization_id) === organizationId
            && clean(row.class_id) === groupId
            && (clean(row.enrollment_status) || "active") === "active")
        .map(row => clean(row.student_profile_id))
        .filter(Boolean));

    const match = params.profiles.find(profile => {
        if (clean(profile.organization_id) !== organizationId) return false;
        if (!enrolledIds.has(clean(profile.id))) return false;
        if ((clean(profile.status) || "active") !== "active") return false;
        if (clean(profile.display_name) !== name) return false;
        return [profile.id, profile.external_id, profile.email].some(value => normalized(value) === lookup);
    });
    if (!match) return null;

    return {
        id: clean(match.id),
        name: clean(match.display_name),
        email: clean(match.email) || undefined,
        metadata: metadata(match.metadata),
    };
}

export function studentRegionFromProfile(metadataValue: unknown, classRegion: unknown): string | undefined {
    const profileMetadata = metadata(metadataValue);
    return clean(profileMetadata.region) || clean(classRegion) || undefined;
}
