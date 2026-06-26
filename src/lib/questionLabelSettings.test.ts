import { describe, expect, it } from "vitest";
import {
    buildQuestionLabelCandidates,
    hideQuestionLabelCandidate,
    normalizeQuestionLabelSettings,
    questionLabelSettingsStorageKey,
    recordQuestionLabelSettingUsage,
    restoreHiddenQuestionLabelCandidates,
} from "./questionLabelSettings";

describe("question label settings", () => {
    it("keeps current labels first, then recent teacher labels, then defaults", () => {
        const settings = recordQuestionLabelSettingUsage(
            normalizeQuestionLabelSettings(null),
            { labels: ["문법", "비문학", "비문학"] },
            "2026-06-20T09:00:00.000Z",
        );

        const candidates = buildQuestionLabelCandidates({
            currentLabels: ["현대시"],
            defaultLabels: ["문법", "독해"],
            settings,
        });

        expect(candidates.map(candidate => `${candidate.source}:${candidate.label}`)).toEqual([
            "current:현대시",
            "recent:문법",
            "recent:비문학",
            "default:독해",
        ]);
    });

    it("hides stale presets without removing labels already used in the current exam", () => {
        const base = recordQuestionLabelSettingUsage(
            normalizeQuestionLabelSettings(null),
            { labels: ["문학", "어휘"] },
            "2026-06-20T09:00:00.000Z",
        );
        const hidden = hideQuestionLabelCandidate(base, "문학", "2026-06-20T10:00:00.000Z");

        expect(buildQuestionLabelCandidates({
            currentLabels: [],
            defaultLabels: ["문학", "독해"],
            settings: hidden,
        }).map(candidate => candidate.label)).toEqual(["어휘", "독해"]);

        expect(buildQuestionLabelCandidates({
            currentLabels: ["문학"],
            defaultLabels: ["독해"],
            settings: hidden,
        }).map(candidate => `${candidate.source}:${candidate.label}`)).toEqual([
            "current:문학",
            "recent:어휘",
            "default:독해",
        ]);
    });

    it("restores a hidden label when the teacher uses it again", () => {
        const base = recordQuestionLabelSettingUsage(
            normalizeQuestionLabelSettings(null),
            { labels: ["문학"] },
            "2026-06-20T09:00:00.000Z",
        );
        const hidden = hideQuestionLabelCandidate(base, "문학", "2026-06-20T10:00:00.000Z");
        const usedAgain = recordQuestionLabelSettingUsage(hidden, { labels: ["문학"] }, "2026-06-20T11:00:00.000Z");

        expect(usedAgain.hiddenLabels).toEqual([]);
        expect(usedAgain.recentLabels[0]).toMatchObject({
            value: "문학",
            count: 2,
            lastUsedAt: "2026-06-20T11:00:00.000Z",
        });
    });

    it("stores unit and concept recents separately from label candidates", () => {
        const settings = recordQuestionLabelSettingUsage(
            normalizeQuestionLabelSettings(null),
            {
                labels: ["독해"],
                units: ["고전 문학"],
                concepts: ["화자의 태도"],
            },
            "2026-06-20T09:00:00.000Z",
        );

        expect(settings.recentLabels.map(item => item.value)).toEqual(["독해"]);
        expect(settings.recentUnits.map(item => item.value)).toEqual(["고전 문학"]);
        expect(settings.recentConcepts.map(item => item.value)).toEqual(["화자의 태도"]);
    });

    it("uses a stable scope-specific storage key", () => {
        expect(questionLabelSettingsStorageKey("teacher_abc-123")).toBe("omr_question_label_settings_v1:teacher_abc-123");
        expect(questionLabelSettingsStorageKey("Class A")).toBe("omr_question_label_settings_v1:Class_A");
        expect(questionLabelSettingsStorageKey("김 선생")).toBe("omr_question_label_settings_v1:default");
    });

    it("can restore all hidden labels at once", () => {
        const hidden = hideQuestionLabelCandidate(normalizeQuestionLabelSettings(null), "독해");
        expect(hidden.hiddenLabels).toEqual(["독해"]);
        expect(restoreHiddenQuestionLabelCandidates(hidden).hiddenLabels).toEqual([]);
    });
});
