import { getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";

type Env = Record<string, string | undefined>;

/**
 * How a teacher server action must behave for the current environment. This is
 * the teacher-side sibling of `resolveStudentServerMode` and follows the same
 * fail-closed policy, but the risk it guards is different:
 *
 * - `service_role`   — a service-role key is configured; read/write against
 *   Supabase with the trusted server client, scoped to the teacher's org.
 * - `degraded_local` — no service-role key, but we are outside production, so the
 *   existing local + publishable-key path is an acceptable dev/self-hosted
 *   fallback. Teacher screens keep their offline-first behavior here.
 * - `denied` — no service-role key IN production. The server fails closed:
 *   returning `degraded_local` here would keep the publishable-key content path
 *   alive in production, which is exactly what must be retired before RLS is
 *   enabled (설계 §3, account-security checklist "Move workspace bootstrap writes
 *   from publishable-key client sync to server/service-role code"). A teacher
 *   caller must treat `denied` as a hard stop for remote reads/writes and never
 *   fall back to the publishable key — only to its own on-device cache.
 */
export type TeacherServerMode = "service_role" | "degraded_local" | "denied";

/**
 * Status contract shared by every teacher data server action and its client
 * facade. Kept here (a non-"use server" module) so both sides can import it.
 */
export type TeacherDataStatus =
    | "ok"
    | "unauthenticated"
    | "degraded_local"
    | "denied"
    | "not_found"
    | "error";

function isProduction(env: Env): boolean {
    return (env.NODE_ENV || "").trim() === "production";
}

export function resolveTeacherServerMode(env: Env = process.env): TeacherServerMode {
    if (getSupabaseServerConfigFromEnv(env)) return "service_role";
    return isProduction(env) ? "denied" : "degraded_local";
}

/**
 * True only when the teacher client may keep using the existing local +
 * publishable-key path (dev / self-hosted). Never true in production without the
 * service role — a `denied` request must be satisfied from the on-device cache
 * only, never the publishable key.
 */
export function allowsPublishableTeacherFallback(mode: TeacherServerMode): boolean {
    return mode === "degraded_local";
}
