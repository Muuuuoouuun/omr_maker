/**
 * Save-status chip shown in the solve header's status row.
 *
 * "failed" means the answer draft itself could not be written to this device
 * (storage full or blocked), which outranks being offline: offline answers are
 * still saved locally, failed ones are not.
 */
export type SolveDraftSaveState = "idle" | "saved" | "failed";

export type SolveSaveStatusKind = "saved" | "failed" | "offline";

export interface SolveSaveStatusChip {
    kind: SolveSaveStatusKind;
    tone: "muted" | "error" | "warning";
    /** Full label (desktop, and the accessible text everywhere). */
    label: string;
    /** Short label shown next to the icon on phones (≤768px). */
    compactLabel: string;
}

const SAVE_STATUS_CHIPS: Record<SolveSaveStatusKind, SolveSaveStatusChip> = {
    saved: { kind: "saved", tone: "muted", label: "저장됨", compactLabel: "저장됨" },
    failed: { kind: "failed", tone: "error", label: "저장 실패", compactLabel: "실패" },
    offline: { kind: "offline", tone: "warning", label: "오프라인 · 기기에 저장", compactLabel: "오프라인" },
};

export function solveSaveStatusChip({
    saveState,
    online,
}: {
    saveState: SolveDraftSaveState;
    online: boolean;
}): SolveSaveStatusChip | null {
    if (saveState === "failed") return SAVE_STATUS_CHIPS.failed;
    if (!online) return SAVE_STATUS_CHIPS.offline;
    if (saveState === "saved") return SAVE_STATUS_CHIPS.saved;
    return null;
}
