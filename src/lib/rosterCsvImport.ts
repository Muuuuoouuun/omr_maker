import {
    AVATAR_COLORS,
    GROUP_COLORS,
    disambiguateRosterStudentId,
    rosterGroupScopeKey,
    type RosterGroup,
    type RosterStudent,
} from "@/lib/rosterStorage";
import { studentIdFor } from "@/utils/storage";

/**
 * Pure CSV → roster diff planner.
 *
 * The roster page used to parse a CSV and commit the mutations in a single
 * pass, surfacing only a post-hoc toast. This module instead produces a
 * *dry-run plan* (adds / updates with field-level diffs / id-collision
 * conflicts / skips) plus the already-computed next students/groups arrays,
 * so the UI can preview every row before committing and the commit itself is
 * a trivial persist of `nextStudents` / `nextGroups`.
 *
 * Keeping this logic here (rather than inline in the page) makes it unit
 * testable and keeps the preview modal thin.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepted header aliases for the optional region/campus/branch column.
const REGION_HEADERS = ["region", "campus", "branch", "지역", "지점", "캠퍼스"];

export type RosterCsvDisposition = "add" | "update" | "conflict" | "skip";
export type RosterCsvSkipReason = "missing-fields" | "invalid-email";
export type RosterCsvFieldKey = "name" | "email" | "group" | "region";
export type RosterCsvImportError = "empty" | "header";

export interface RosterCsvFieldChange {
    field: RosterCsvFieldKey;
    from: string;
    to: string;
}

interface RosterCsvRowBase {
    /** 1-based line number within the source file (the header is line 1). */
    line: number;
    name: string;
    email: string;
    group: string;
    region: string;
}

export interface RosterCsvAddRow extends RosterCsvRowBase {
    /** Id the newly-created student will receive. */
    id: string;
}

export interface RosterCsvUpdateRow extends RosterCsvRowBase {
    /** Existing student id being updated (unchanged by the import). */
    id: string;
    matchedBy: "email" | "id";
    /** Field-level diff of what the import actually changes (empty = no-op re-import). */
    changes: RosterCsvFieldChange[];
}

export interface RosterCsvConflictRow extends RosterCsvRowBase {
    /** Disambiguated id assigned to the newly-added student. */
    id: string;
    /** The id column value that collided with an unrelated existing student. */
    importedId: string;
    /** Name/email of the existing student that owns `importedId`. */
    existingName: string;
    existingEmail: string;
}

export interface RosterCsvSkipRow extends RosterCsvRowBase {
    reason: RosterCsvSkipReason;
}

export interface RosterCsvImportPlan {
    ok: boolean;
    error?: RosterCsvImportError;
    adds: RosterCsvAddRow[];
    updates: RosterCsvUpdateRow[];
    conflicts: RosterCsvConflictRow[];
    skips: RosterCsvSkipRow[];
    /** Groups newly created while planning (for the "N개 반 생성" count). */
    createdGroups: RosterGroup[];
    /** Students array to persist on confirm (adds/conflicts prepended, updates applied in place). */
    nextStudents: RosterStudent[];
    /** Groups array to persist on confirm (new groups appended, region back-fills applied). */
    nextGroups: RosterGroup[];
    /** True when confirming would change stored data (adds + updates + conflicts > 0). */
    hasChanges: boolean;
}

export interface RosterCsvHeaderMap {
    idIdx: number;
    nameIdx: number;
    emailIdx: number;
    groupIdx: number;
    regionIdx: number;
}

function clean(value: string | undefined): string {
    return (value ?? "").trim();
}

function normalizeEmail(value: string | undefined): string {
    return clean(value).toLowerCase();
}

/**
 * When a scoped base id is already held by a *different* student (different
 * email), disambiguate with an email-derived suffix so the incoming student
 * doesn't collide with the unrelated one.
 */
function uniqueStudentId(baseId: string, emailKey: string, students: RosterStudent[]): string {
    const takenByOther = students.some(student => student.id === baseId && normalizeEmail(student.email) !== emailKey);
    return takenByOther ? disambiguateRosterStudentId(baseId, emailKey) : baseId;
}

export function mapRosterCsvHeader(header: string[]): RosterCsvHeaderMap {
    const normalized = header.map(cell => cell.trim().toLowerCase());
    return {
        idIdx: normalized.indexOf("id"),
        nameIdx: normalized.indexOf("name"),
        emailIdx: normalized.indexOf("email"),
        groupIdx: normalized.indexOf("group"),
        regionIdx: normalized.findIndex(cell => REGION_HEADERS.includes(cell)),
    };
}

/**
 * Build a dry-run import plan from parsed CSV rows against the current roster.
 * Does not mutate the input arrays; `nextStudents`/`nextGroups` are fresh
 * copies ready to persist when the teacher confirms.
 *
 * `options.now` seeds generated group ids (`g-${now}-${rowIndex}`) so callers
 * can keep them deterministic in tests.
 */
export function buildRosterCsvImportPlan(
    rows: string[][],
    students: RosterStudent[],
    groups: RosterGroup[],
    options: { now?: number } = {},
): RosterCsvImportPlan {
    const failPlan = (error: RosterCsvImportError): RosterCsvImportPlan => ({
        ok: false,
        error,
        adds: [],
        updates: [],
        conflicts: [],
        skips: [],
        createdGroups: [],
        nextStudents: students,
        nextGroups: groups,
        hasChanges: false,
    });

    if (!rows || rows.length < 2) return failPlan("empty");
    const { idIdx, nameIdx, emailIdx, groupIdx, regionIdx } = mapRosterCsvHeader(rows[0]);
    if (nameIdx === -1 || emailIdx === -1 || groupIdx === -1) return failPlan("header");

    const now = options.now ?? Date.now();
    const adds: RosterCsvAddRow[] = [];
    const updates: RosterCsvUpdateRow[] = [];
    const conflicts: RosterCsvConflictRow[] = [];
    const skips: RosterCsvSkipRow[] = [];
    const createdGroups: RosterGroup[] = [];

    let nextGroups = [...groups];
    const groupByScope = new Map(nextGroups.map(group => [rosterGroupScopeKey(group.name, group.region), group]));
    const nextStudents = [...students];
    let addedCount = 0;

    for (let i = 1; i < rows.length; i += 1) {
        const cols = rows[i];
        const line = i + 1; // header occupies line 1
        const importedId = idIdx >= 0 ? clean(cols[idIdx]) : "";
        const name = clean(cols[nameIdx]);
        const email = clean(cols[emailIdx]);
        const group = clean(cols[groupIdx]);
        const region = regionIdx >= 0 ? clean(cols[regionIdx]) : "";
        const emailKey = normalizeEmail(email);
        const base: RosterCsvRowBase = { line, name, email, group, region };

        if (!name || !email || !group) {
            skips.push({ ...base, reason: "missing-fields" });
            continue;
        }
        if (!EMAIL_RE.test(emailKey)) {
            skips.push({ ...base, reason: "invalid-email" });
            continue;
        }

        // Resolve the target group (region-scoped), creating it when absent and
        // back-filling a region onto a previously region-less match.
        const groupScopeKey = rosterGroupScopeKey(group, region);
        let currentGroup = groupByScope.get(groupScopeKey)
            || nextGroups.find(item => item.name === group && !item.region?.trim());
        if (!currentGroup) {
            const newGroup: RosterGroup = {
                id: `g-${now}-${i}`,
                name: group,
                ...(region ? { region } : {}),
                count: 0,
                avgScore: 0,
                color: GROUP_COLORS[nextGroups.length % GROUP_COLORS.length],
            };
            nextGroups = [...nextGroups, newGroup];
            groupByScope.set(groupScopeKey, newGroup);
            createdGroups.push(newGroup);
            currentGroup = newGroup;
        } else if (region && !currentGroup.region) {
            const previous = currentGroup;
            const updatedGroup = { ...previous, region };
            nextGroups = nextGroups.map(item => (item.id === previous.id ? updatedGroup : item));
            groupByScope.delete(rosterGroupScopeKey(previous.name, previous.region));
            groupByScope.set(groupScopeKey, updatedGroup);
            currentGroup = updatedGroup;
        }

        const baseId = studentIdFor(name, currentGroup.id);
        const existingByEmailIndex = nextStudents.findIndex(student => normalizeEmail(student.email) === emailKey);
        // An id column lets teachers re-import their own export, but a collision
        // on id alone doesn't prove it's the same student — only treat it as an
        // update when the email also matches (or the existing record has no email
        // yet). Otherwise the row would silently overwrite an unrelated student.
        const importedIdIndex = importedId ? nextStudents.findIndex(student => student.id === importedId) : -1;
        const importedIdEmail = importedIdIndex >= 0 ? normalizeEmail(nextStudents[importedIdIndex].email) : "";
        const importedIdConflicts = importedIdIndex >= 0 && !!importedIdEmail && importedIdEmail !== emailKey;
        const existingByIdIndex = importedIdIndex >= 0 && !importedIdConflicts ? importedIdIndex : -1;
        const existingIndex = existingByEmailIndex >= 0 ? existingByEmailIndex : existingByIdIndex;

        if (existingIndex >= 0) {
            const existing = nextStudents[existingIndex];
            // A blank region cell must not wipe a stored per-student region
            // override — only apply region when the column supplied a value.
            const applyRegion = regionIdx >= 0 && !!region;
            const changes: RosterCsvFieldChange[] = [];
            if (existing.name !== name) changes.push({ field: "name", from: existing.name, to: name });
            if (existing.email !== email) changes.push({ field: "email", from: existing.email, to: email });
            if (existing.group !== group) changes.push({ field: "group", from: existing.group, to: group });
            if (applyRegion && (existing.region ?? "") !== region) {
                changes.push({ field: "region", from: existing.region ?? "", to: region });
            }
            nextStudents[existingIndex] = {
                ...existing,
                name,
                email,
                group,
                ...(applyRegion ? { region } : {}),
            };
            updates.push({
                ...base,
                id: existing.id,
                matchedBy: existingByIdIndex === existingIndex ? "id" : "email",
                changes,
            });
            continue;
        }

        // New student: a clean add, or an id-collision conflict added as new.
        const collided = importedIdConflicts && importedIdIndex >= 0 ? nextStudents[importedIdIndex] : null;
        const id = importedId && !importedIdConflicts
            ? importedId
            : uniqueStudentId(baseId, emailKey, nextStudents);
        const newStudent: RosterStudent = {
            id,
            name,
            email,
            group,
            ...(region ? { region } : {}),
            avatar: AVATAR_COLORS[(nextStudents.length + addedCount) % AVATAR_COLORS.length],
            avgScore: 0,
            examsTaken: 0,
            lastActive: "방금 전",
            trend: "flat",
            status: "active",
        };
        nextStudents.unshift(newStudent);
        addedCount += 1;

        if (collided) {
            conflicts.push({
                ...base,
                id,
                importedId,
                existingName: collided.name,
                existingEmail: collided.email,
            });
        } else {
            adds.push({ ...base, id });
        }
    }

    return {
        ok: true,
        adds,
        updates,
        conflicts,
        skips,
        createdGroups,
        nextStudents,
        nextGroups,
        hasChanges: adds.length + conflicts.length > 0 || updates.some(update => update.changes.length > 0),
    };
}

/**
 * Per-conflict-row choice the teacher makes in the preview modal:
 * - "add"       (신규 추가, default): keep the plan's behavior — the row becomes a new
 *               student under the disambiguated id.
 * - "overwrite" (기존 덮어쓰기): apply the row's fields onto the existing student that owns
 *               the collided id (keeping that student's id/avatar/score history).
 * - "skip"      (건너뛰기): drop the row entirely.
 */
export type RosterCsvConflictDisposition = "add" | "overwrite" | "skip";

export interface RosterCsvConflictResolution {
    /** Students array to persist, with each conflict disposition applied. */
    nextStudents: RosterStudent[];
    /** Conflict rows kept as brand-new students (disposition "add"). */
    addedCount: number;
    /** Conflict rows folded onto the colliding existing student (disposition "overwrite"). */
    overwrittenCount: number;
    /** Conflict rows dropped (disposition "skip"). */
    skippedCount: number;
    /** True when confirming would still change stored data after dispositions. */
    hasChanges: boolean;
}

/**
 * Apply per-row conflict dispositions to a dry-run plan at confirm time.
 *
 * `plan.nextStudents` already contains every conflict row as a prepended new student
 * (the historical "add as new" behavior, which stays the default), so this only has to
 * remove or fold back the rows the teacher redirected. Pure like the planner: neither
 * the plan nor its arrays are mutated.
 *
 * `dispositions` is keyed by the conflict row's `line`; missing entries default to "add".
 */
export function applyRosterCsvConflictDispositions(
    plan: RosterCsvImportPlan,
    dispositions: Record<number, RosterCsvConflictDisposition>,
): RosterCsvConflictResolution {
    let nextStudents = [...plan.nextStudents];
    let addedCount = 0;
    let overwrittenCount = 0;
    let skippedCount = 0;

    for (const conflict of plan.conflicts) {
        const disposition = dispositions[conflict.line] ?? "add";
        if (disposition === "add") {
            addedCount += 1;
            continue;
        }

        // Both remaining dispositions drop the planner's prepended new student.
        nextStudents = nextStudents.filter(student => student.id !== conflict.id);

        if (disposition === "skip") {
            skippedCount += 1;
            continue;
        }

        // Overwrite: fold the CSV row onto the existing owner of the collided id,
        // keeping its identity (id/avatar/score history). Mirrors the update path's
        // region rule — a blank region cell must not wipe a stored region.
        nextStudents = nextStudents.map(student => (
            student.id === conflict.importedId
                ? {
                    ...student,
                    name: conflict.name,
                    email: conflict.email,
                    group: conflict.group,
                    ...(conflict.region ? { region: conflict.region } : {}),
                }
                : student
        ));
        overwrittenCount += 1;
    }

    return {
        nextStudents,
        addedCount,
        overwrittenCount,
        skippedCount,
        hasChanges: plan.adds.length > 0
            || plan.updates.some(update => update.changes.length > 0)
            || addedCount + overwrittenCount > 0,
    };
}
