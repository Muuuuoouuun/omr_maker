import {
    resolveStudentIdentity,
    resolveStudentStartCodeLogin,
    type StudentCodeGroupLike,
    type StudentCodeStudentLike,
} from "@/lib/studentCodes";
import type { StudentIdentityInput } from "@/lib/studentServerSession";

/**
 * Server-trusted roster used to verify a student login. This is loaded from the
 * organization's roster (omr_student_profiles / groups) and its server-held start
 * codes — NEVER from the client. Binding session issuance to this snapshot is what
 * stops a crafted login from minting an arbitrary studentId/groupId identity.
 */
export interface StudentRosterSnapshot {
    organizationId: string;
    groups: StudentCodeGroupLike[];
    /** Roster profiles; `id` is the real omr_student_profiles.id when provisioned. */
    students: StudentCodeStudentLike[];
    /** Server-held start codes keyed by studentId (or legacy studentId). */
    startCodes: Record<string, string>;
    /**
     * When true (roster-gated exam/org), a login that matches no roster profile is
     * rejected outright — no fabricated quick-entry identity is issued. When false,
     * an unmatched student may enter as an unprovisioned temporary identity (no
     * profile id), e.g. a public quick-entry class.
     */
    requireRosterMatch: boolean;
}

export interface StudentLoginRequest {
    name: string;
    selectedGroupId?: string;
    /** id or email used to disambiguate same-name roster profiles. */
    studentLookup?: string;
    startCode?: string;
    /** Server-derived: does this student already have a stored attempt? */
    hasPriorAttempt?: boolean;
}

export type StudentVerificationReason =
    | "invalid_input"
    | "roster_mismatch"
    | "ambiguous_student"
    | "code_required"
    | "code_mismatch";

export type StudentVerificationResult =
    | {
        ok: true;
        identity: StudentIdentityInput;
        /** Present when a brand-new start code was issued and must be persisted. */
        issuedCode?: string;
        /** True when startCodes changed and should be written back server-side. */
        codesChanged: boolean;
        codes: Record<string, string>;
    }
    | { ok: false; reason: StudentVerificationReason };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function regionForGroup(
    groups: StudentCodeGroupLike[],
    groupId: string,
    groupName: string,
): string | undefined {
    const match = groups.find(group => group.id === groupId || group.name === groupName || group.name === groupId);
    const region = clean(match?.region);
    return region || undefined;
}

/**
 * Verify a student login against the trusted roster and start codes, returning a
 * signed-session identity ONLY on success. Every rejection path (unknown student,
 * ambiguous same-name match, missing/wrong start code) refuses to produce an
 * identity, so the caller cannot issue a session for an unverified student.
 */
export function verifyStudentLogin(
    request: StudentLoginRequest,
    snapshot: StudentRosterSnapshot,
    generateCode?: () => string,
): StudentVerificationResult {
    const name = clean(request.name);
    if (!name) return { ok: false, reason: "invalid_input" };

    const resolution = resolveStudentIdentity({
        name,
        selectedGroupId: request.selectedGroupId,
        groups: snapshot.groups,
        students: snapshot.students,
        studentLookup: request.studentLookup,
    });

    if (snapshot.requireRosterMatch && !resolution.matchedRosterProfile) {
        return { ok: false, reason: "roster_mismatch" };
    }
    // Multiple same-name roster profiles and no unique lookup: refuse rather than
    // guess which student is logging in (guessing could bind the wrong profile).
    if (resolution.requiresStudentLookup && resolution.rosterMatchCount > 1) {
        return { ok: false, reason: "ambiguous_student" };
    }
    if (resolution.lookupMismatch) {
        return { ok: false, reason: "roster_mismatch" };
    }

    const startCode = resolveStudentStartCodeLogin({
        studentId: resolution.studentId,
        legacyStudentId: resolution.legacyStudentId,
        codes: snapshot.startCodes,
        hasPriorAttempt: !!request.hasPriorAttempt,
        providedCode: request.startCode,
        generateCode,
    });

    if (startCode.status === "code_required") return { ok: false, reason: "code_required" };
    if (startCode.status === "code_mismatch") return { ok: false, reason: "code_mismatch" };

    const regionName = regionForGroup(snapshot.groups, resolution.groupId, resolution.groupName);
    const identity: StudentIdentityInput = {
        kind: "student",
        studentId: resolution.studentId,
        name,
        organizationId: clean(snapshot.organizationId) || undefined,
        // Only a real roster profile carries a profile id; quick-entry stays null.
        studentProfileId: resolution.matchedRosterProfile ? resolution.studentId : undefined,
        groupId: resolution.groupId,
        groupName: resolution.groupName,
        regionName,
        identityType: "temporary",
    };

    return {
        ok: true,
        identity,
        issuedCode: startCode.status === "new_code_issued" ? startCode.code : undefined,
        codesChanged: startCode.codesChanged,
        codes: startCode.codes,
    };
}
