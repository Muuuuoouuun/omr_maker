import {
    AVATAR_COLORS,
    GROUP_COLORS,
    disambiguateRosterStudentId,
    rosterGroupMatchesStudent,
    rosterGroupScopeKey,
    type RosterGroup,
    type RosterStudent,
} from "@/lib/rosterStorage";
import { recomputeRosterGroupsFromStudents } from "@/lib/rosterAnalytics";
import { studentIdFor } from "@/utils/storage";

/**
 * Shared, pure roster mutations used by both the roster management page and the
 * exam distribution modal so that inline "반/학생 바로 추가" stays consistent with
 * the canonical roster CRUD (scoped ids, email/id dedup, group count recompute).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function normalizeEmail(value: string | undefined): string {
    return clean(value).toLowerCase();
}

export type AddRosterGroupReason = "missing-name" | "duplicate";
export type AddRosterStudentReason = "missing-name" | "invalid-email" | "missing-group" | "duplicate";
export type EditRosterGroupReason = "missing-name" | "missing-group" | "duplicate";
export type DeleteRosterGroupReason = "missing-group" | "not-empty";

export interface AddRosterGroupResult {
    ok: boolean;
    reason?: AddRosterGroupReason;
    /** Next students array (unchanged for group adds, returned for a uniform call site). */
    students: RosterStudent[];
    /** Next groups array (recomputed counts). */
    groups: RosterGroup[];
    /** Created group, or the existing match when reason === "duplicate". */
    group?: RosterGroup;
}

export interface AddRosterStudentResult {
    ok: boolean;
    reason?: AddRosterStudentReason;
    students: RosterStudent[];
    groups: RosterGroup[];
    student?: RosterStudent;
}

export interface EditRosterGroupResult {
    ok: boolean;
    reason?: EditRosterGroupReason;
    students: RosterStudent[];
    groups: RosterGroup[];
    group?: RosterGroup;
}

export interface DeleteRosterGroupResult {
    ok: boolean;
    reason?: DeleteRosterGroupReason;
    students: RosterStudent[];
    groups: RosterGroup[];
    group?: RosterGroup;
    studentCount?: number;
}
export interface RosterGroupDraft {
    name: string;
    region?: string;
    color?: string;
}

export interface RosterStudentDraft {
    name: string;
    email: string;
    groupId: string;
}

/**
 * Add a roster group, de-duplicating by region-scoped name. When a group with the
 * same scope already exists, returns ok:false / reason:"duplicate" with the existing
 * group so the caller can simply select it.
 *
 * The id is intentionally free of "::" so that scoped student ids
 * (`${groupId}::${name}`) keep a clean single separator.
 */
export function addRosterGroup(
    students: RosterStudent[],
    groups: RosterGroup[],
    draft: RosterGroupDraft,
    options: { id?: string } = {},
): AddRosterGroupResult {
    const name = clean(draft.name);
    if (!name) {
        return { ok: false, reason: "missing-name", students, groups };
    }
    const region = clean(draft.region);
    const scopeKey = rosterGroupScopeKey(name, region);
    const existing = groups.find(group => rosterGroupScopeKey(group.name, group.region) === scopeKey);
    if (existing) {
        return { ok: false, reason: "duplicate", students, groups, group: existing };
    }

    const newGroup: RosterGroup = {
        id: clean(options.id) || `g-${Date.now()}`,
        name,
        ...(region ? { region } : {}),
        color: clean(draft.color) || GROUP_COLORS[groups.length % GROUP_COLORS.length],
        count: 0,
        avgScore: 0,
    };
    const nextGroups = recomputeRosterGroupsFromStudents(students, [...groups, newGroup]);
    const persistedGroup = nextGroups.find(group => group.id === newGroup.id) || newGroup;
    return { ok: true, students, groups: nextGroups, group: persistedGroup };
}

/**
 * Edit a group while preserving its id. Students that currently belong to the
 * group are moved to the new display name/region, but their ids stay stable so
 * existing attempts, codes, and analytics joins keep working.
 */
export function editRosterGroup(
    students: RosterStudent[],
    groups: RosterGroup[],
    groupId: string,
    draft: RosterGroupDraft,
): EditRosterGroupResult {
    const target = groups.find(group => group.id === groupId);
    if (!target) {
        return { ok: false, reason: "missing-group", students, groups };
    }

    const name = clean(draft.name);
    if (!name) {
        return { ok: false, reason: "missing-name", students, groups, group: target };
    }

    const region = clean(draft.region);
    const scopeKey = rosterGroupScopeKey(name, region);
    const duplicate = groups.find(group => group.id !== groupId && rosterGroupScopeKey(group.name, group.region) === scopeKey);
    if (duplicate) {
        return { ok: false, reason: "duplicate", students, groups, group: duplicate };
    }

    const color = clean(draft.color) || target.color;
    const updatedGroup: RosterGroup = {
        ...target,
        name,
        color,
        ...(region ? { region } : { region: undefined }),
    };

    const nextStudents = students.map(student => {
        if (!rosterGroupMatchesStudent(target, student)) return student;
        return {
            ...student,
            group: name,
            ...(region ? { region } : { region: undefined }),
        };
    });
    const nextGroups = recomputeRosterGroupsFromStudents(
        nextStudents,
        groups.map(group => group.id === groupId ? updatedGroup : group),
    );
    return {
        ok: true,
        students: nextStudents,
        groups: nextGroups,
        group: nextGroups.find(group => group.id === groupId) || updatedGroup,
    };
}

/**
 * Delete only empty groups. This avoids silently orphaning students or changing
 * historical analytics scopes when a teacher taps delete by mistake.
 */
export function deleteRosterGroup(
    students: RosterStudent[],
    groups: RosterGroup[],
    groupId: string,
): DeleteRosterGroupResult {
    const target = groups.find(group => group.id === groupId);
    if (!target) {
        return { ok: false, reason: "missing-group", students, groups };
    }

    const studentCount = students.filter(student => rosterGroupMatchesStudent(target, student)).length;
    if (studentCount > 0) {
        return { ok: false, reason: "not-empty", students, groups, group: target, studentCount };
    }

    return {
        ok: true,
        students,
        groups: groups.filter(group => group.id !== groupId),
        group: target,
        studentCount: 0,
    };
}

/**
 * Add a student to an existing group (selected by id). Mirrors the roster page:
 * scoped id from the group id, email/id de-dup, region inherited from the group,
 * group counts recomputed.
 */
export function addRosterStudent(
    students: RosterStudent[],
    groups: RosterGroup[],
    draft: RosterStudentDraft,
): AddRosterStudentResult {
    const name = clean(draft.name);
    if (!name) {
        return { ok: false, reason: "missing-name", students, groups };
    }
    const email = clean(draft.email);
    if (!EMAIL_RE.test(email)) {
        return { ok: false, reason: "invalid-email", students, groups };
    }
    const group = groups.find(item => item.id === draft.groupId);
    if (!group) {
        return { ok: false, reason: "missing-group", students, groups };
    }

    const emailKey = normalizeEmail(email);
    const baseId = studentIdFor(name, group.id);
    const idTakenByOther = students.some(student => student.id === baseId && normalizeEmail(student.email) !== emailKey);
    const id = idTakenByOther ? disambiguateRosterStudentId(baseId, emailKey) : baseId;

    if (students.some(student => normalizeEmail(student.email) === emailKey || student.id === id)) {
        return { ok: false, reason: "duplicate", students, groups };
    }

    const region = clean(group.region);
    const newStudent: RosterStudent = {
        id,
        name,
        email,
        group: group.name,
        ...(region ? { region } : {}),
        avatar: AVATAR_COLORS[students.length % AVATAR_COLORS.length],
        avgScore: 0,
        examsTaken: 0,
        lastActive: "방금 전",
        trend: "flat",
        status: "active",
    };
    const nextStudents = [newStudent, ...students];
    const nextGroups = recomputeRosterGroupsFromStudents(nextStudents, groups);
    return { ok: true, students: nextStudents, groups: nextGroups, student: newStudent };
}
