import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeReminderCron, sendSolapiReminder, solapiAuthorization, solapiConfig, solapiReadiness } from "./solapiProvider.server";
import { normalizeReminderPhone, reminderContent, type ReminderCandidate } from "./solapiReminders";

export const reminderFixture: ReminderCandidate = {
    organizationId: "org-a", examId: "exam-a", studentId: "student-a", studentName: "민수", examTitle: "수학 과제",
    phone: "01012345678", channel: "kakao", kind: "before_deadline", deadline: "2026-09-11T10:00:00Z",
    dueAt: "2026-09-11T09:00:00Z", assignmentId: "assignment-a", assignmentRevision: 2, beforeMinutes: 60,
};
const config = solapiConfig({
    OMR_REMINDER_MODE: "live", OMR_REMINDER_ORGANIZATION_ID: "org-a",
    SOLAPI_API_KEY: "test-key", SOLAPI_API_SECRET: "test-secret", SOLAPI_SENDER_NUMBER: "0212345678",
    SOLAPI_KAKAO_PF_ID: "pf-test", SOLAPI_TEMPLATE_BEFORE_DEADLINE: "before", SOLAPI_TEMPLATE_OVERDUE: "after",
    NEXT_PUBLIC_SHARE_BASE_URL: "https://school.example",
});

describe("SOLAPI adapter", () => {
    it("defaults to dry run and separates SMS and Kakao requirements", () => {
        expect(solapiConfig({}).mode).toBe("dry_run");
        expect(solapiReadiness({ ...config, pfId: "" })).toMatchObject({ kakaoReady: false, smsReady: true });
        expect(solapiReadiness({ ...config, sender: "" })).toMatchObject({ kakaoReady: true, smsReady: false });
        expect(solapiReadiness({ ...config, sender: "", smsFallback: true }).kakaoReady).toBe(false);
        expect(solapiReadiness({ ...config, origin: "http://localhost" }).smsReady).toBe(false);
    });
    it("uses the official date + salt HMAC signature", () => {
        const date = "2026-09-10T00:00:00.000Z";
        expect(solapiAuthorization(config, date, "salt")).toBe(`HMAC-SHA256 apiKey=test-key, date=${date}, salt=salt, signature=${createHmac("sha256", "test-secret").update(date + "salt").digest("hex")}`);
    });
    it("rejects unauthenticated and weak-secret scheduler requests", () => {
        const secret = "s".repeat(32);
        expect(authorizeReminderCron(new Headers(), secret)).toBe(false);
        expect(authorizeReminderCron(new Headers({ authorization: "Bearer short" }), "short")).toBe(false);
        expect(authorizeReminderCron(new Headers({ authorization: `Bearer ${secret}` }), secret)).toBe(true);
    });
    it("normalizes Korean mobile contacts without accepting arbitrary text", () => {
        expect(normalizeReminderPhone("+82 10-1234-5678")).toBe("01012345678");
        expect(normalizeReminderPhone("010-1234-5678")).toBe("01012345678");
        expect(normalizeReminderPhone("call 01012345678")).toBeNull();
        expect(normalizeReminderPhone("0101234")).toBeNull();
    });
    it("uses the actual solve route and assignment parameter with an absolute Korean deadline", () => {
        const content = reminderContent(reminderFixture, config.origin);
        expect(content.url).toBe("https://school.example/solve/exam-a?assignment=assignment-a");
        expect(content.text).toContain("19:00");
        expect(content.text).not.toContain("60분 남");
    });
    it("never calls the provider in dry-run, missing configuration or foreign workspace", async () => {
        const fetcher = vi.fn();
        await sendSolapiReminder(reminderFixture, { ...config, mode: "dry_run" }, fetcher);
        await sendSolapiReminder(reminderFixture, { ...config, apiSecret: "" }, fetcher);
        await sendSolapiReminder({ ...reminderFixture, organizationId: "org-b" }, config, fetcher);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("uses approved template variables and disables fallback unless explicitly configured", async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ failedMessageList: [], groupInfo: { groupId: "G123", count: { registeredSuccess: 1 } } }));
        expect(await sendSolapiReminder(reminderFixture, config, fetcher)).toEqual({ status: "accepted", providerGroupId: "G123" });
        const [url, options] = fetcher.mock.calls[0];
        expect(url).toBe("https://api.solapi.com/messages/v4/send-many/detail");
        const body = JSON.parse(options.body);
        expect(body.messages[0]).toMatchObject({ type: "ATA", kakaoOptions: { templateId: "before", disableSms: true, variables: { "#{학생명}": "민수" } } });
        expect(body.messages[0].from).toBeUndefined();
        await sendSolapiReminder({ ...reminderFixture, kind: "overdue" }, { ...config, smsFallback: true }, fetcher);
        expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[0]).toMatchObject({ from: "0212345678", kakaoOptions: { templateId: "after", disableSms: false } });
    });
    it("supports direct LMS with the solve link", async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ groupInfo: { groupId: "G123", count: { registeredSuccess: 1 } } }));
        await sendSolapiReminder({ ...reminderFixture, channel: "sms" }, config, fetcher);
        expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[0]).toMatchObject({ type: "LMS", from: "0212345678", text: expect.stringContaining("/solve/exam-a") });
    });
    it.each([
        [() => Response.json({ failedMessageList: [{ statusCode: "bad-template" }] }), "failed"],
        [() => new Response("private details", { status: 401 }), "failed"],
        [() => new Response("private details", { status: 503 }), "unknown"],
        [() => Response.json({ groupInfo: { groupId: "G123", count: { registeredSuccess: 0 } } }), "unknown"],
        [() => new Response("invalid JSON"), "unknown"],
        [() => { throw new Error("secret in transport error"); }, "unknown"],
    ])("does not confuse errors with delivery success or retry uncertain sends", async (response, status) => {
        const fetcher = vi.fn().mockImplementation(response);
        const result = await sendSolapiReminder(reminderFixture, config, fetcher);
        expect(result.status).toBe(status);
        expect(JSON.stringify(result)).not.toMatch(/private details|secret in/);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
