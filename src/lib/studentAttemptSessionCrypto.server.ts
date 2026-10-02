import { createHmac } from "node:crypto";

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function leaseTokenHash(token: string, secret: string): string {
    if (!clean(token) || !clean(secret)) throw new Error("lease token and secret are required");
    return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}
