// This local/demo-only chunk preserves the existing rich non-official analysis.
// Remote teacher analytics never imports it and consumes the bounded server DTO.
export {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    resolveAttemptGrading,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
export { buildAttemptScoreLookup } from "@/lib/attemptScores";
