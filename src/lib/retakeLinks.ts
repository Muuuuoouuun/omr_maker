import type { RetakeMetadata } from "@/types/omr";

export interface RetakeLinkMetadata {
    labels?: string[];
    concepts?: string[];
}

function joinedMetadata(values: string[] | undefined): string {
    return (values || [])
        .map(value => value.trim())
        .filter(Boolean)
        .join(",");
}

export function buildRetakeHref(
    examId: string,
    sourceAttemptId: string,
    questionIds: number[],
    mode: RetakeMetadata["mode"] = "wrong",
    metadata: RetakeLinkMetadata = {},
): string {
    const params = new URLSearchParams({
        retakeFrom: sourceAttemptId,
        questions: Array.from(new Set(questionIds))
            .filter(questionId => Number.isFinite(questionId))
            .sort((a, b) => a - b)
            .join(","),
        mode,
    });
    const labels = joinedMetadata(metadata.labels);
    const concepts = joinedMetadata(metadata.concepts);
    if (labels) params.set("labels", labels);
    if (concepts) params.set("concepts", concepts);
    return `/solve/${examId}?${params.toString()}`;
}
