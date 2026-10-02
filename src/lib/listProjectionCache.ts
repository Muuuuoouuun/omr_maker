function mergeRedactedStudentQuestions(
    projection: unknown,
    existing: unknown,
): unknown {
    if (!Array.isArray(projection) || !Array.isArray(existing)) return projection;
    const existingByQuestionId = new Map(existing.flatMap(note => {
        if (!note || typeof note !== "object") return [];
        return [[String((note as { questionId?: unknown }).questionId), note as Record<string, unknown>] as const];
    }));
    return projection.map(note => {
        if (!note || typeof note !== "object") return note;
        const projected = note as Record<string, unknown>;
        const prior = existingByQuestionId.get(String(projected.questionId));
        if (!prior) return note;
        const merged = { ...prior, ...projected };
        if (projected.body === "" && typeof prior.body === "string") merged.body = prior.body;

        if (projected.answer && typeof projected.answer === "object" && !Array.isArray(projected.answer)) {
            const projectedAnswer = projected.answer as Record<string, unknown>;
            const priorAnswer = prior.answer && typeof prior.answer === "object" && !Array.isArray(prior.answer)
                ? prior.answer as Record<string, unknown>
                : undefined;
            merged.answer = { ...priorAnswer, ...projectedAnswer };
            if (projectedAnswer.body === "" && typeof priorAnswer?.body === "string") {
                (merged.answer as Record<string, unknown>).body = priorAnswer.body;
            }
        }
        return merged;
    });
}

export function mergeListProjectionsForCache<T extends { id: string }>(
    projections: T[],
    existingItems: T[],
): T[] {
    const existingById = new Map(existingItems.map(item => [item.id, item]));
    return projections.map(projection => {
        const existing = existingById.get(projection.id);
        if (!existing) return projection;
        const merged = { ...existing } as Record<string, unknown>;
        for (const [key, value] of Object.entries(projection)) {
            merged[key] = key === "studentQuestions"
                ? mergeRedactedStudentQuestions(value, merged[key])
                : value;
        }
        return merged as T;
    });
}
