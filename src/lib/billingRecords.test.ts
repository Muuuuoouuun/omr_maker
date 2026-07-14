import { describe, expect, it } from "vitest";
import { billingStatusMeta, createLocalPlanChangeInvoice, createLocalPlanCycleReminder, filterBillingRecordsForDisplay } from "./billingRecords";

describe("billing records", () => {
    it("labels local plan changes as records, not paid invoices", () => {
        const invoice = createLocalPlanChangeInvoice({
            planName: "Pro",
            amount: 19000,
            yearly: false,
            now: new Date("2026-06-15T12:00:00.000Z"),
            sequence: 3,
        });

        expect(invoice).toEqual({
            id: "LOCAL-2026-06-0003",
            date: "2026-06-15",
            amount: 19000,
            status: "local_record",
            desc: "Pro 플랜 · 2026년 6월 · 로컬 변경 기록",
        });
        expect(billingStatusMeta(invoice.status)).toMatchObject({
            label: "로컬 기록",
            receiptTitle: "플랜 변경 기록",
        });
    });

    it("keeps paid invoices visually distinct from local records", () => {
        expect(billingStatusMeta("paid")).toMatchObject({
            label: "결제 완료",
            badgeText: "PAID",
        });
        expect(billingStatusMeta("local_record")).toMatchObject({
            label: "로컬 기록",
            badgeText: "LOCAL RECORD",
        });
    });

    it("describes local plan cycle reminders without implying automatic payment", () => {
        const reminder = createLocalPlanCycleReminder({
            planName: "Pro",
            now: new Date("2026-06-26T12:00:00.000Z"),
            cycleDate: new Date("2026-07-01T00:00:00.000Z"),
        });

        expect(reminder).toMatchObject({
            title: "Pro 플랜 사용 주기 갱신 예정",
            message: "5일 후 (2026-07-01) 로컬 플랜 사용 주기가 갱신됩니다. 실결제는 아직 연동되지 않았습니다.",
            time: "5일 후",
        });
        expect(reminder?.message).not.toContain("자동 결제");
    });

    it("does not create local plan cycle reminders outside the threshold", () => {
        expect(createLocalPlanCycleReminder({
            planName: "Pro",
            now: new Date("2026-06-15T12:00:00.000Z"),
            cycleDate: new Date("2026-07-01T00:00:00.000Z"),
        })).toBeNull();
    });

    it("can attach simulated payment provider metadata without marking a record paid", () => {
        const invoice = createLocalPlanChangeInvoice({
            planName: "Academy",
            amount: 99000,
            yearly: false,
            now: new Date("2026-06-15T12:00:00.000Z"),
            sequence: 7,
            paymentProviderKey: "toss",
            paymentProviderLabel: "토스페이먼츠",
            paymentProviderMode: "simulation",
        });

        expect(invoice).toMatchObject({
            id: "LOCAL-2026-06-0007",
            status: "local_record",
            paymentProviderKey: "toss",
            paymentProviderLabel: "토스페이먼츠",
            paymentProviderMode: "simulation",
            checkoutId: "checkout:toss:LOCAL-2026-06-0007",
        });
        expect(invoice.status).not.toBe("paid");
    });

    it("hides legacy paid demo rows while live checkout is unavailable", () => {
        const localRecord = createLocalPlanChangeInvoice({
            planName: "Pro",
            amount: 19000,
            yearly: false,
            sequence: 1,
        });
        const fakePaid = {
            ...localRecord,
            id: "INV-DEMO",
            status: "paid" as const,
        };

        expect(filterBillingRecordsForDisplay([fakePaid, localRecord], false)).toEqual([localRecord]);
    });

    it("only shows paid rows backed by live provider metadata after checkout is enabled", () => {
        const base = createLocalPlanChangeInvoice({
            planName: "Pro",
            amount: 19000,
            yearly: false,
            sequence: 1,
        });
        const verifiedPaid = {
            ...base,
            id: "PAY-LIVE",
            status: "paid" as const,
            paymentProviderMode: "live" as const,
            paymentProviderKey: "toss" as const,
            checkoutId: "checkout:toss:PAY-LIVE",
        };
        const unverifiedPaid = { ...verifiedPaid, id: "PAY-NO-CHECKOUT", checkoutId: undefined };

        expect(filterBillingRecordsForDisplay([unverifiedPaid, verifiedPaid], true)).toEqual([verifiedPaid]);
    });
});
