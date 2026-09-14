import "next/dist/compiled/server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeReminderPhone, reminderContent, type ReminderCandidate, type ReminderReadiness } from "./solapiReminders";

type Env = Record<string, string | undefined>;
export interface SolapiConfig {
    mode: ReminderReadiness["mode"];
    apiKey: string; apiSecret: string; sender: string; pfId: string;
    beforeTemplateId: string; overdueTemplateId: string; smsFallback: boolean;
    origin: string; organizationId: string;
}

export function solapiConfig(env: Env = process.env): SolapiConfig {
    const read = (key: string) => env[key]?.trim() || "";
    const configuredMode = read("OMR_REMINDER_MODE");
    return {
        mode: configuredMode === "live" ? "live" : configuredMode === "disabled" ? "disabled" : "dry_run",
        apiKey: read("SOLAPI_API_KEY"), apiSecret: read("SOLAPI_API_SECRET"),
        sender: read("SOLAPI_SENDER_NUMBER").replace(/[\s()-]/g, ""), pfId: read("SOLAPI_KAKAO_PF_ID"),
        beforeTemplateId: read("SOLAPI_TEMPLATE_BEFORE_DEADLINE"), overdueTemplateId: read("SOLAPI_TEMPLATE_OVERDUE"),
        smsFallback: read("SOLAPI_SMS_FALLBACK") === "1",
        origin: read("NEXT_PUBLIC_SHARE_BASE_URL"), organizationId: read("OMR_REMINDER_ORGANIZATION_ID"),
    };
}

function validOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
}

export function solapiReadiness(config = solapiConfig()): ReminderReadiness {
    const missing: string[] = [];
    if (!config.apiKey || !/^[\w-]+$/.test(config.apiKey)) missing.push("SOLAPI_API_KEY");
    if (!config.apiSecret) missing.push("SOLAPI_API_SECRET");
    if (!validOrigin(config.origin)) missing.push("NEXT_PUBLIC_SHARE_BASE_URL");
    if (!config.organizationId) missing.push("OMR_REMINDER_ORGANIZATION_ID");
    const commonReady = missing.length === 0;
    const senderReady = /^\d{8,11}$/.test(config.sender);
    const kakaoMissing = [
        !config.pfId && "SOLAPI_KAKAO_PF_ID",
        !config.beforeTemplateId && "SOLAPI_TEMPLATE_BEFORE_DEADLINE",
        !config.overdueTemplateId && "SOLAPI_TEMPLATE_OVERDUE",
    ].filter((key): key is string => !!key);
    if (!senderReady) missing.push("SOLAPI_SENDER_NUMBER");
    missing.push(...kakaoMissing);
    return {
        mode: config.mode, missing,
        kakaoReady: commonReady && kakaoMissing.length === 0 && (!config.smsFallback || senderReady),
        smsReady: commonReady && senderReady,
    };
}

export function authorizeReminderCron(headers: Headers, secret = process.env.CRON_SECRET || ""): boolean {
    if (Buffer.byteLength(secret) < 32) return false;
    const actual = Buffer.from(headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${secret}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function solapiAuthorization(config: SolapiConfig, date = new Date().toISOString(), salt = randomBytes(16).toString("hex")): string {
    const signature = createHmac("sha256", config.apiSecret).update(date + salt).digest("hex");
    return `HMAC-SHA256 apiKey=${config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export type SolapiOutcome = { status: "accepted" | "failed" | "unknown"; providerGroupId?: string; errorCode?: string };

export async function sendSolapiReminder(candidate: ReminderCandidate, config: SolapiConfig, fetcher: typeof fetch = fetch): Promise<SolapiOutcome> {
    const readiness = solapiReadiness(config);
    if (config.mode !== "live" || candidate.organizationId !== config.organizationId
        || !(candidate.channel === "kakao" ? readiness.kakaoReady : readiness.smsReady)
        || !normalizeReminderPhone(candidate.phone)) return { status: "failed", errorCode: "configuration_blocked" };
    const content = reminderContent(candidate, config.origin);
    const message = candidate.channel === "sms"
        ? { to: candidate.phone, from: config.sender, text: content.text, type: "LMS", subject: "학습 제출 안내" }
        : {
            to: candidate.phone, ...(config.smsFallback ? { from: config.sender } : {}), text: content.text,
            type: "ATA", kakaoOptions: {
                pfId: config.pfId,
                templateId: candidate.kind === "before_deadline" ? config.beforeTemplateId : config.overdueTemplateId,
                disableSms: !config.smsFallback, variables: content.variables,
            },
        };
    try {
        const response = await fetcher("https://api.solapi.com/messages/v4/send-many/detail", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: solapiAuthorization(config) },
            body: JSON.stringify({ messages: [message], allowDuplicates: false }),
            signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error",
        });
        // Never retry automatically: a timeout/5xx may happen after SOLAPI accepted the message.
        if (!response.ok) return { status: response.status >= 500 ? "unknown" : "failed", errorCode: `http_${response.status}` };
        const body = await response.json();
        if (Array.isArray(body.failedMessageList) && body.failedMessageList.length > 0) {
            return { status: "failed", errorCode: "provider_rejected" };
        }
        const groupId = body.groupInfo?.groupId || body.groupInfo?._id;
        if (typeof groupId !== "string" || !/^[\w-]{1,128}$/.test(groupId)
            || body.groupInfo?.count?.registeredSuccess !== 1) return { status: "unknown", errorCode: "unexpected_response" };
        return { status: "accepted", providerGroupId: groupId };
    } catch { return { status: "unknown", errorCode: "transport_uncertain" }; }
}
