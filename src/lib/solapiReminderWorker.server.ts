import "next/dist/compiled/server-only";
import { sendSolapiReminder, solapiReadiness, type SolapiConfig } from "./solapiProvider.server";
import type { ReminderCandidate } from "./solapiReminders";

export interface ReminderRpcClient {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function runReminderWorker(client: ReminderRpcClient, config: SolapiConfig, options: {
    deadlineAt?: number; maxMessages?: number; send?: typeof sendSolapiReminder;
} = {}) {
    const summary = { processed: 0, preview: 0, accepted: 0, failed: 0, unknown: 0 };
    if (config.mode === "disabled") return { status: "disabled" as const, ...summary };
    const ready = solapiReadiness(config);
    const channels = config.mode === "dry_run" ? ["kakao", "sms"]
        : [ready.kakaoReady && "kakao", ready.smsReady && "sms"].filter(Boolean);
    if (!config.organizationId || channels.length === 0) return { status: "configuration_required" as const, ...summary };
    const deadlineAt = options.deadlineAt ?? Date.now() + 40_000;
    const maximum = Math.min(100, Math.max(1, options.maxMessages ?? 25));
    const send = options.send ?? sendSolapiReminder;
    for (let index = 0; index < maximum && Date.now() + 12_000 < deadlineAt; index++) {
        const claim = await client.rpc("omr_claim_reminder_v1", {
            p_organization_id: config.organizationId, p_mode: config.mode, p_channels: channels,
        });
        if (claim.error) throw new Error("reminder_claim_failed");
        if (claim.data === null) break;
        const job = claim.data as { id: string; candidate: ReminderCandidate };
        if (typeof job.id !== "string" || !job.candidate || job.candidate.organizationId !== config.organizationId) {
            throw new Error("reminder_invalid_claim");
        }
        summary.processed++;
        if (config.mode === "dry_run") { summary.preview++; continue; }
        const outcome = await send(job.candidate, config);
        const finished = await client.rpc("omr_finish_reminder_v1", {
            p_organization_id: config.organizationId, p_id: job.id, p_status: outcome.status,
            p_provider_group_id: outcome.providerGroupId ?? null, p_error_code: outcome.errorCode ?? null,
        });
        // A persisted claim is never re-posted, including when outcome persistence fails.
        if (finished.error || finished.data !== true) throw new Error("reminder_outcome_persistence_failed");
        summary[outcome.status]++;
    }
    return { status: summary.failed || summary.unknown ? "degraded" as const : "ok" as const, ...summary };
}
