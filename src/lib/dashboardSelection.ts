import type { Exam } from "@/types/omr";

export interface DashboardScopedOption {
    key: string;
}

export function resolveExamSelection(
    exams: Pick<Exam, "id">[],
    selectedExamId?: string,
): string {
    if (exams.length === 0) return "";
    if (selectedExamId && exams.some(exam => exam.id === selectedExamId)) {
        return selectedExamId;
    }
    return exams[0].id;
}

export function resolveExamSelectionInputValue(
    exams: Pick<Exam, "id" | "title">[],
    selectedExamId?: string,
): string {
    if (!selectedExamId) return "";
    return exams.find(exam => exam.id === selectedExamId)?.title || "";
}

export function resolveScopedSelection<T extends DashboardScopedOption>(
    options: T[],
    selectedKey?: string,
): string {
    if (options.length === 0) return "";
    if (selectedKey && options.some(option => option.key === selectedKey)) {
        return selectedKey;
    }
    return options[0].key;
}

export function formatRegionScopedLabel(name: string, regionName?: string): string {
    const cleanName = name.trim();
    const cleanRegion = regionName?.trim();
    return cleanRegion ? `${cleanName} · ${cleanRegion}` : cleanName;
}

/**
 * Deep link from a region/group-scoped view (e.g. a class card on the roster
 * page) into the teacher dashboard, preselecting a tab and carrying the
 * region as a query param.
 *
 * NOTE: as of this writing, StudentAnalyticsTab and ExamAnalyticsTab only
 * track their region filter as internal component state (`selectedRegionKey`)
 * — neither accepts an incoming prop for it, so the `region` param below is
 * inert until one of them reads it (see the "region deep link" handoff note
 * for the exact prop/read needed). The link is still worth shipping now: it
 * lands on the right tab immediately, and starts working fully the moment
 * that prop lands.
 */
export function buildRegionScopedAnalyticsHref(
    tab: "exam" | "student",
    regionKey?: string,
): string {
    const params = new URLSearchParams({ tab });
    if (regionKey) params.set("region", regionKey);
    return `/teacher/dashboard?${params.toString()}`;
}
