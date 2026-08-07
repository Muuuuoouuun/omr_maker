export const PRODUCTION_SIGNING_SECRET_MIN_BYTES = 32;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isProduction(nodeEnv: unknown): boolean {
    return clean(nodeEnv).toLowerCase() === "production";
}

export function resolveServerSigningSecret(
    value: unknown,
    nodeEnv: unknown,
): string | null {
    const secret = clean(value);
    if (!secret) return null;
    if (isProduction(nodeEnv) && Buffer.byteLength(secret, "utf8") < PRODUCTION_SIGNING_SECRET_MIN_BYTES) {
        return null;
    }
    return secret;
}
