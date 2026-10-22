import type { Attempt } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import { attemptMatchesStudentProfile } from "@/utils/storage";

interface IndexedStudent {
    student: RosterStudent;
    position: number;
}

/** Narrow legacy name matching without changing the roster's first-match order. */
export function buildTeacherLiveRosterIndex(students: ReadonlyArray<RosterStudent>) {
    const byProfileId = new Map<string, IndexedStudent>();
    const byRawId = new Map<string, IndexedStudent>();
    const byName = new Map<string, IndexedStudent[]>();
    for (const [position, student] of students.entries()) {
        const indexed = { student, position };
        const profileId = student.id.trim();
        if (!byProfileId.has(profileId)) byProfileId.set(profileId, indexed);
        if (!byRawId.has(student.id)) byRawId.set(student.id, indexed);
        const name = student.name.trim();
        const sameName = byName.get(name);
        if (sameName) sameName.push(indexed);
        else byName.set(name, [indexed]);
    }

    return {
        matchAttempt(attempt: Attempt): RosterStudent | undefined {
            const profileId = attempt.studentProfileId?.trim();
            // An explicit profile is authoritative: never fall back to a name.
            if (profileId) return byProfileId.get(profileId)?.student;

            const studentId = attempt.studentId?.trim() || "";
            let matched = studentId ? byProfileId.get(studentId) : undefined;
            const separator = studentId.indexOf("::");
            const scopedName = separator > 0
                && studentId.slice(0, separator).trim()
                ? studentId.slice(separator + 2).trim()
                : "";
            const names = new Set([attempt.studentName?.trim() || scopedName || ""]);
            if (scopedName) names.add(scopedName);
            for (const name of names) {
                for (const candidate of byName.get(name) || []) {
                    if (matched && candidate.position >= matched.position) break;
                    if (attemptMatchesStudentProfile(attempt, candidate.student)) {
                        matched = candidate;
                        break;
                    }
                }
            }
            return matched?.student;
        },
        matchSession(session: { studentProfileId?: string; ownerStudentId: string }): RosterStudent | undefined {
            const profile = session.studentProfileId === undefined ? undefined : byRawId.get(session.studentProfileId);
            const owner = byRawId.get(session.ownerStudentId);
            if (!profile) return owner?.student;
            return owner && owner.position < profile.position ? owner.student : profile.student;
        },
    };
}
