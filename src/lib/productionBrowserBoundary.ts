export interface CanonicalBrowserDataPlaneInput {
    nodeEnv: string | undefined;
    hasPublicSupabase: boolean;
}

export function canUseCanonicalBrowserDataPlane(
    input: CanonicalBrowserDataPlaneInput,
): boolean {
    return input.nodeEnv !== "production" && input.hasPublicSupabase;
}
