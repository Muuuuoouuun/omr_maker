import { describe, expect, it, vi } from "vitest";
import { runReminderWorker } from "./solapiReminderWorker.server";
import { solapiConfig } from "./solapiProvider.server";
import type { ReminderCandidate } from "./solapiReminders";

const candidate = { organizationId: "org-a", channel: "sms" } as ReminderCandidate;
const config = solapiConfig({ OMR_REMINDER_MODE: "live", OMR_REMINDER_ORGANIZATION_ID: "org-a", SOLAPI_API_KEY: "key", SOLAPI_API_SECRET: "secret", SOLAPI_SENDER_NUMBER: "0212345678", NEXT_PUBLIC_SHARE_BASE_URL: "https://school.example" });

describe("reminder scheduled worker", () => {
    it("does not touch the database or provider when disabled", async () => {
        const rpc = vi.fn(); const send = vi.fn();
        expect((await runReminderWorker({ rpc }, { ...config, mode: "disabled" }, { send })).status).toBe("disabled");
        expect(rpc).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
    it("records dry-run claims without provider calls or live outcome updates", async () => {
        const rpc = vi.fn().mockResolvedValueOnce({ data: { id: "d1", candidate }, error: null }).mockResolvedValue({ data: null, error: null });
        const send = vi.fn();
        expect(await runReminderWorker({ rpc }, { ...config, mode: "dry_run" }, { send })).toMatchObject({ preview: 1, accepted: 0 });
        expect(send).not.toHaveBeenCalled();
        expect(rpc.mock.calls.every(([name]) => name === "omr_claim_reminder_v1")).toBe(true);
    });
    it("persists claims before posting and records acceptance separately from delivery", async () => {
        const order: string[] = [];
        const rpc = vi.fn().mockImplementation(async name => {
            order.push(name);
            return { data: name === "omr_claim_reminder_v1" ? { id: "d1", candidate } : true, error: null };
        });
        const send = vi.fn().mockImplementation(async () => { order.push("send"); return { status: "accepted", providerGroupId: "G1" }; });
        expect(await runReminderWorker({ rpc }, config, { send, maxMessages: 1 })).toMatchObject({ processed: 1, accepted: 1 });
        expect(order).toEqual(["omr_claim_reminder_v1", "send", "omr_finish_reminder_v1"]);
    });
    it("cannot send after a claim failure and does not retry after outcome-write failure", async () => {
        const send = vi.fn().mockResolvedValue({ status: "unknown" });
        const failedClaim = vi.fn().mockResolvedValue({ error: new Error("database"), data: null });
        await expect(runReminderWorker({ rpc: failedClaim }, config, { send })).rejects.toThrow("claim_failed");
        expect(send).not.toHaveBeenCalled();
        const rpc = vi.fn().mockResolvedValueOnce({ data: { id: "d1", candidate }, error: null }).mockResolvedValue({ data: null, error: "database" });
        await expect(runReminderWorker({ rpc }, config, { send })).rejects.toThrow("persistence_failed");
        expect(send).toHaveBeenCalledTimes(1);
    });
    it("does not start a send when the execution budget cannot cover it", async () => {
        const rpc = vi.fn();
        await runReminderWorker({ rpc }, config, { deadlineAt: Date.now() + 1000 });
        expect(rpc).not.toHaveBeenCalled();
    });
});
