import { getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";

type Env = Record<string, string | undefined>;

/**
 * How a student server action must behave for the current environment:
 *
 * - `service_role`  — a service-role key is configured; read/write against
 *   Supabase with the trusted server client.
 * - `degraded_local` — no service-role key, but we are outside production, so a
 *   local answer-bearing fallback is acceptable for offline dev/testing.
 * - `denied` — no service-role key IN production. The server must fail closed:
 *   returning `degraded_local` here would let the client fall back to reading the
 *   full local exam (correct answers included), which leaks the answer key. There
 *   is no safe way to serve a graded student flow without the trusted server path,
 *   so the request is refused instead.
 */
export type StudentServerMode = "service_role" | "degraded_local" | "denied";

function isProduction(env: Env): boolean {
    return (env.NODE_ENV || "").trim() === "production";
}

export function resolveStudentServerMode(env: Env = process.env): StudentServerMode {
    if (getSupabaseServerConfigFromEnv(env)) return "service_role";
    return isProduction(env) ? "denied" : "degraded_local";
}

/**
 * True only when the server explicitly permits the client to fall back to a
 * locally-synced exam copy that still contains answers/explanations. This is
 * NEVER allowed in production without the service role — the caller must treat a
 * `denied` mode as a hard stop, not a hint to read local data.
 */
export function allowsAnswerBearingLocalFallback(mode: StudentServerMode): boolean {
    return mode === "degraded_local";
}
