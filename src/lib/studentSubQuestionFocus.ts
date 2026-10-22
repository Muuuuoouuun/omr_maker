import type { MissingRequiredSubQuestion } from "@/types/omr";

/** Match exact identities without interpolating imported IDs into a selector. */
export function focusMissingSubQuestionInput(root: ParentNode, missing: MissingRequiredSubQuestion): boolean {
    const input = Array.from(root.querySelectorAll<HTMLTextAreaElement>("textarea[data-sub-question-id]"))
        .find(candidate => candidate.dataset.questionId === String(missing.questionId)
            && candidate.dataset.subQuestionId === missing.subQuestionId);
    if (!input) return false;
    input.focus();
    return true;
}
