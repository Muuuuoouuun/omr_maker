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
