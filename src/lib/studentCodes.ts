import { studentIdFor } from "@/utils/storage";

export const STUDENT_CODES_STORAGE_KEY = "omr_student_codes";
export const START_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEFAULT_STUDENT_GROUP_ID = "unassigned";
export const DEFAULT_STUDENT_GROUP_NAME = "미분류";

export interface StudentCodeGroupLike {
    id: string;
    name: string;
    region?: string;
}

export interface StudentCodeStudentLike {
    id?: string;
    name: string;
    group?: string;
    region?: string;
    email?: string;
}

export interface StudentIdentityResolution {
    studentId: string;
    legacyStudentId: string;
    groupId: string;
    groupName: string;
    matchedRosterProfile: boolean;
    rosterMatchCount: number;
    requiresStudentLookup: boolean;
    lookupMatched: boolean;
    lookupMismatch: boolean;
}

export type StudentStartCodeDecision =
    | {
        status: "allowed";
        codes: Record<string, string>;
        code?: string;
        codesChanged: boolean;
    }
    | {
        status: "code_required";
        codes: Record<string, string>;
        codesChanged: boolean;
    }
    | {
        status: "code_mismatch";
        codes: Record<string, string>;
        codesChanged: boolean;
    }
    | {
        status: "new_code_issued";
        codes: Record<string, string>;
        code: string;
        codesChanged: true;
    };

function normalizeCode(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const code = value.trim().toUpperCase();
    return code ? code : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeLookup(value: unknown): string {
    return clean(value).toLowerCase();
}

function studentMatchesLookup(student: StudentCodeStudentLike, lookup: string): boolean {
    if (!lookup) return false;
    return normalizeLookup(student.id) === lookup || normalizeLookup(student.email) === lookup;
}

function scopedGroupKey(studentId: string | undefined): string {
    const normalized = clean(studentId);
    const separatorIndex = normalized.indexOf("::");
    return separatorIndex > 0 ? normalized.slice(0, separatorIndex).trim() : "";
}

function studentMatchesGroup(student: StudentCodeStudentLike, group: StudentCodeGroupLike): boolean {
    const groupId = clean(group.id);
    const groupName = clean(group.name);
    const groupRegion = clean(group.region);
    const studentGroup = clean(student.group);
    const studentRegion = clean(student.region);
    const scopedGroup = scopedGroupKey(student.id);

    if (groupId && scopedGroup === groupId) return true;
    const sameGroup = !!groupName && (studentGroup === groupName || scopedGroup === groupName);
    if (!sameGroup) return false;
    if (!groupRegion) return true;
    return !studentRegion || studentRegion === groupRegion;
}

function groupForStudentProfile(
    student: StudentCodeStudentLike | undefined,
    groups: StudentCodeGroupLike[],
): StudentCodeGroupLike | undefined {
    if (!student) return undefined;
    const scopedGroup = scopedGroupKey(student.id);
    const studentGroup = clean(student.group);
    const studentRegion = clean(student.region);

    return groups.find(group => clean(group.id) === scopedGroup)
        || groups.find(group => {
            const groupName = clean(group.name);
            const groupRegion = clean(group.region);
            if (!groupName || groupName !== studentGroup) return false;
            return !groupRegion || !studentRegion || groupRegion === studentRegion;
        });
}

export function normalizeStartCodeInput(value: string): string {
    return value.replace(/\s/g, "").trim().toUpperCase().slice(0, 6);
}

/**
 * Cryptographically-strong float in [0, 1). Falls back to Math.random only when the
 * Web Crypto API is unavailable (e.g. very old runtimes), so start codes are not
 * predictable in normal browser/server environments.
 */
function secureRandom(): number {
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
        const buffer = new Uint32Array(1);
        cryptoObj.getRandomValues(buffer);
        return buffer[0] / 0x1_0000_0000; // divide by 2^32 → [0, 1)
    }
    return Math.random();
}

export function generateStartCode(random: () => number = secureRandom): string {
    let out = "";
    for (let i = 0; i < 6; i++) {
        const index = Math.min(START_CODE_ALPHABET.length - 1, Math.floor(random() * START_CODE_ALPHABET.length));
        out += START_CODE_ALPHABET[index];
    }
    return out;
}

export function parseStudentCodes(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

        const codes: Record<string, string> = {};
        for (const [studentId, code] of Object.entries(parsed)) {
            const normalizedCode = normalizeCode(code);
            const normalizedStudentId = studentId.trim();
            if (normalizedStudentId && normalizedCode) {
                codes[normalizedStudentId] = normalizedCode;
            }
        }
        return codes;
    } catch {
        return {};
    }
}

export function readStudentCodes(storage: Pick<Storage, "getItem">): Record<string, string> {
    return parseStudentCodes(storage.getItem(STUDENT_CODES_STORAGE_KEY));
}

export function writeStudentCodes(storage: Pick<Storage, "setItem">, codes: Record<string, string>): boolean {
    try {
        storage.setItem(STUDENT_CODES_STORAGE_KEY, JSON.stringify(codes));
        return true;
    } catch {
        return false;
    }
}

export function resolveStudentIdentity(params: {
    name: string;
    selectedGroupId?: string;
    groups: StudentCodeGroupLike[];
    students: StudentCodeStudentLike[];
    studentLookup?: string;
}): StudentIdentityResolution {
    const trimmedName = params.name.trim();
    const selectedGroupId = clean(params.selectedGroupId);
    const group = params.groups.find(item => item.id === selectedGroupId || item.name === selectedGroupId);
    const matchingProfiles = params.students.filter(student => {
        if (student.name.trim() !== trimmedName) return false;
        return group ? studentMatchesGroup(student, group) : true;
    });
    const groupRegion = group?.region?.trim();
    const exactRegionProfiles = groupRegion
        ? matchingProfiles.filter(student => student.region?.trim() === groupRegion)
        : matchingProfiles;
    const fallbackRegionProfiles = groupRegion
        ? matchingProfiles.filter(student => !student.region?.trim())
        : [];
    const candidateProfiles = exactRegionProfiles.length > 0
        ? exactRegionProfiles
        : fallbackRegionProfiles.length > 0
            ? fallbackRegionProfiles
            : matchingProfiles;
    const lookup = normalizeLookup(params.studentLookup);
    const lookupProfiles = lookup ? candidateProfiles.filter(student => studentMatchesLookup(student, lookup)) : [];
    const lookupProfile = lookupProfiles.length === 1 ? lookupProfiles[0] : undefined;
    const profile = lookupProfile || candidateProfiles[0];
    const inferredGroup = group || groupForStudentProfile(profile, params.groups);
    const profileGroupKey = scopedGroupKey(profile?.id);
    const profileGroupName = clean(profile?.group);
    const resolvedGroupName = clean(inferredGroup?.name) || profileGroupName || DEFAULT_STUDENT_GROUP_NAME;
    const resolvedGroupId = selectedGroupId
        || clean(inferredGroup?.id)
        || profileGroupKey
        || profileGroupName
        || DEFAULT_STUDENT_GROUP_ID;
    const legacyStudentId = studentIdFor(trimmedName, resolvedGroupId);
    const studentId = profile?.id?.trim() || legacyStudentId;
    const hasLookup = !!lookup;

    return {
        studentId,
        legacyStudentId,
        groupId: resolvedGroupId,
        groupName: resolvedGroupName,
        matchedRosterProfile: !!profile?.id,
        rosterMatchCount: candidateProfiles.length,
        requiresStudentLookup: candidateProfiles.length > 0 && !lookupProfile,
        lookupMatched: !!lookupProfile,
        lookupMismatch: hasLookup && candidateProfiles.length > 0 && lookupProfiles.length === 0,
    };
}

export function findStudentStartCode(
    codes: Record<string, string>,
    studentId: string,
    legacyStudentId?: string,
): string {
    return codes[studentId] || (legacyStudentId ? codes[legacyStudentId] : "") || "";
}

export function hasStudentStartCode(
    codes: Record<string, string>,
    studentId: string,
    legacyStudentId?: string,
): boolean {
    return !!findStudentStartCode(codes, studentId, legacyStudentId);
}

export function resolveStudentStartCodeLogin(params: {
    studentId: string;
    legacyStudentId?: string;
    codes: Record<string, string>;
    hasPriorAttempt: boolean;
    providedCode?: string;
    generateCode?: () => string;
}): StudentStartCodeDecision {
    const nextCodes = { ...params.codes };
    const storedCode = findStudentStartCode(nextCodes, params.studentId, params.legacyStudentId);
    let codesChanged = false;

    if (storedCode && !nextCodes[params.studentId]) {
        nextCodes[params.studentId] = storedCode;
        codesChanged = true;
    }

    if (storedCode) {
        const providedCode = normalizeStartCodeInput(params.providedCode || "");
        if (!providedCode) {
            return { status: "code_required", codes: nextCodes, codesChanged };
        }
        if (providedCode !== storedCode) {
            return { status: "code_mismatch", codes: nextCodes, codesChanged };
        }
        return { status: "allowed", codes: nextCodes, code: storedCode, codesChanged };
    }

    if (!storedCode && params.hasPriorAttempt) {
        return { status: "code_required", codes: nextCodes, codesChanged };
    }

    if (!storedCode) {
        const code = params.generateCode?.() || generateStartCode();
        nextCodes[params.studentId] = code;
        return { status: "new_code_issued", codes: nextCodes, code, codesChanged: true };
    }

    return { status: "allowed", codes: nextCodes, code: storedCode, codesChanged };
}
