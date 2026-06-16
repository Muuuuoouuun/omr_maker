import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";

export interface DistributionTargetSummary {
    selectedGroupIds: string[];
    selectedGroupNames: string[];
    targetStudentCount: number;
    targetStudentIds: string[];
    missingGroupIds: string[];
    hasRoster: boolean;
}

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function scopedGroupKey(studentId: string): string {
    const separator = studentId.indexOf("::");
    return separator > 0 ? clean(studentId.slice(0, separator)) : "";
}

function groupKeys(group: RosterGroup): Set<string> {
    return new Set([group.id, group.name].map(clean).filter(Boolean));
}

function studentGroupKeys(student: RosterStudent): Set<string> {
    return new Set([student.group, scopedGroupKey(student.id)].map(clean).filter(Boolean));
}

export function summarizeDistributionTargets(params: {
    selectedGroupIds: string[];
    groups: RosterGroup[];
    students: RosterStudent[];
}): DistributionTargetSummary {
    const selectedGroupIds = Array.from(new Set(params.selectedGroupIds.map(clean).filter(Boolean)));
    const groupsByKey = new Map<string, RosterGroup>();
    for (const group of params.groups) {
        for (const key of groupKeys(group)) {
            groupsByKey.set(key, group);
        }
    }

    const selectedGroups = selectedGroupIds
        .map(groupId => groupsByKey.get(groupId))
        .filter((group): group is RosterGroup => !!group);
    const selectedGroupKeySets = selectedGroupIds
        .filter(groupId => !groupsByKey.has(groupId))
        .map(groupId => new Set([groupId]));
    const missingGroupIds = selectedGroupIds.filter(groupId => !groupsByKey.has(groupId));
    const selectedGroupNames = selectedGroupIds.map(groupId => {
        const group = groupsByKey.get(groupId);
        return group ? formatRegionScopedLabel(group.name, group.region) : groupId;
    });

    const targetStudents = params.students.filter(student => {
        if (selectedGroups.some(group => rosterGroupMatchesStudent(group, student))) return true;
        const keys = studentGroupKeys(student);
        return selectedGroupKeySets.some(selectedKeys => [...keys].some(key => selectedKeys.has(key)));
    });

    return {
        selectedGroupIds,
        selectedGroupNames,
        targetStudentCount: targetStudents.length,
        targetStudentIds: targetStudents.map(student => student.id),
        missingGroupIds,
        hasRoster: params.students.length > 0,
    };
}
