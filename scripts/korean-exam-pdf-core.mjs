import { isAbsolute, resolve } from "node:path";

export function buildPdfNormalizationJobs(artifacts, workspaceRoot) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
        throw new Error("PDF artifact manifest is required");
    }
    if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
        throw new Error("workspaceRoot must be an absolute path");
    }

    return artifacts.map(artifact => {
        if (
            typeof artifact.sourcePath !== "string"
            || !isAbsolute(artifact.sourcePath)
            || typeof artifact.outputPath !== "string"
            || !Array.isArray(artifact.sourcePageIndexes)
            || artifact.sourcePageIndexes.length !== artifact.outputPageCount
        ) {
            throw new Error(`Invalid PDF artifact manifest for ${artifact.examId || "unknown exam"}`);
        }
        const sourcePageIndexes = artifact.sourcePageIndexes.map(Number);
        if (
            sourcePageIndexes.some(page => !Number.isSafeInteger(page) || page < 0)
            || new Set(sourcePageIndexes).size !== sourcePageIndexes.length
            || sourcePageIndexes.some((page, index) => index > 0 && page <= sourcePageIndexes[index - 1])
        ) {
            throw new Error(`Invalid source page selection for ${artifact.examId}`);
        }
        return {
            examId: artifact.examId,
            sourcePath: artifact.sourcePath,
            outputPath: resolve(workspaceRoot, artifact.outputPath),
            sourcePageIndexes,
            outputPageCount: artifact.outputPageCount,
        };
    });
}
