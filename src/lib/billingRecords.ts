import type { PaymentProviderKey, PaymentProviderMode } from "@/lib/paymentProvider";

export type BillingInvoiceStatus = "paid" | "local_record";

export interface BillingInvoice {
    id: string;
    date: string;
    amount: number;
    status: BillingInvoiceStatus;
    desc: string;
    paymentProviderKey?: PaymentProviderKey;
    paymentProviderLabel?: string;
    paymentProviderMode?: PaymentProviderMode;
    checkoutId?: string;
}

export interface BillingStatusMeta {
    label: string;
    badgeText: string;
    receiptTitle: string;
    footerNote: string;
    color: string;
    background: string;
}

export interface LocalPlanCycleReminder {
    title: string;
    message: string;
    time: string;
    date: string;
    daysUntil: number;
}

function isoDate(value: Date): string {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

export function billingStatusMeta(status: BillingInvoiceStatus): BillingStatusMeta {
    if (status === "paid") {
        return {
            label: "결제 완료",
            badgeText: "PAID",
            receiptTitle: "결제 영수증",
            footerNote: "이 영수증은 자동 생성되었습니다.",
            color: "#10b981",
            background: "rgba(16,185,129,0.1)",
        };
    }

    return {
        label: "로컬 기록",
        badgeText: "LOCAL RECORD",
        receiptTitle: "플랜 변경 기록",
        footerNote: "실결제 영수증이 아닙니다. 결제 연동 전 로컬 브라우저에 저장된 플랜 변경 기록입니다.",
        color: "#f59e0b",
        background: "rgba(245,158,11,0.12)",
    };
}

export function createLocalPlanCycleReminder(params: {
    planName: string;
    now?: Date;
    cycleDate?: Date;
    thresholdDays?: number;
}): LocalPlanCycleReminder | null {
    const now = params.now || new Date();
    const cycleDate = params.cycleDate || new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const thresholdDays = params.thresholdDays ?? 7;
    const daysUntil = Math.ceil((cycleDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    if (daysUntil < 0 || daysUntil > thresholdDays) return null;

    return {
        title: `${params.planName} 플랜 사용 주기 갱신 예정`,
        message: `${daysUntil}일 후 (${isoDate(cycleDate)}) 로컬 플랜 사용 주기가 갱신됩니다. 실결제는 아직 연동되지 않았습니다.`,
        time: `${daysUntil}일 후`,
        date: isoDate(cycleDate),
        daysUntil,
    };
}

export function createLocalPlanChangeInvoice(params: {
    planName: string;
    amount: number;
    yearly: boolean;
    now?: Date;
    sequence: number;
    paymentProviderKey?: PaymentProviderKey;
    paymentProviderLabel?: string;
    paymentProviderMode?: PaymentProviderMode;
}): BillingInvoice {
    const now = params.now || new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const nonce = Math.max(0, params.sequence).toString(36).padStart(4, "0").slice(-4).toUpperCase();
    const id = `LOCAL-${yyyy}-${mm}-${nonce}`;

    const invoice: BillingInvoice = {
        id,
        date: `${yyyy}-${mm}-${dd}`,
        amount: Math.max(0, Math.round(params.amount || 0)),
        status: "local_record",
        desc: `${params.planName} 플랜 · ${yyyy}년 ${Number(mm)}월${params.yearly ? " (연간)" : ""} · 로컬 변경 기록`,
    };

    if (params.paymentProviderKey) {
        invoice.paymentProviderKey = params.paymentProviderKey;
        invoice.paymentProviderLabel = params.paymentProviderLabel || params.paymentProviderKey;
        invoice.paymentProviderMode = params.paymentProviderMode || "simulation";
        invoice.checkoutId = `checkout:${params.paymentProviderKey}:${id}`;
    }

    return invoice;
}
