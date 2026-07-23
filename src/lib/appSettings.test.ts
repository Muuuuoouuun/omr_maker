import { describe, expect, it } from "vitest";
import {
    DEFAULT_SETTINGS,
    normalizeExamDefaults,
    parseImportedSettings,
    parseStoredSettings,
} from "./appSettings";

describe("app settings", () => {
    it("defaults exam creation to 5-choice questions", () => {
        expect(DEFAULT_SETTINGS.examDefaults).toMatchObject({
            questions: 20,
            duration: 50,
            scorePerQ: 5,
            choices: 5,
            autosaveSec: 30,
        });
    });

    it("normalizes invalid exam defaults back to service-safe values", () => {
        expect(normalizeExamDefaults({
            questions: -1,
            duration: "bad",
            scorePerQ: 0,
            choices: 3,
            autosaveSec: 999,
        })).toEqual(DEFAULT_SETTINGS.examDefaults);
    });

    it("keeps explicit 4-choice settings while treating unspecified choices as 5", () => {
        expect(normalizeExamDefaults({ choices: 4 }).choices).toBe(4);
        expect(normalizeExamDefaults({}).choices).toBe(5);
    });

    it("caps the default question count at the supported 50-question limit", () => {
        expect(normalizeExamDefaults({ questions: 200 }).questions).toBe(50);
    });

    it("parses stored settings and merges missing sections", () => {
        const settings = parseStoredSettings(JSON.stringify({
            examDefaults: {
                questions: 30,
                duration: 60,
                scorePerQ: 4.5,
                choices: 4,
                autosaveSec: 10,
            },
        }));

        expect(settings.examDefaults).toEqual({
            questions: 30,
            duration: 60,
            scorePerQ: 4.5,
            choices: 4,
            autosaveSec: 10,
        });
        expect(settings.profile.name).toBe(DEFAULT_SETTINGS.profile.name);
    });

    it("accepts complete exported settings and rejects unrelated JSON values", () => {
        expect(parseImportedSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
        expect(parseImportedSettings({})).toBeNull();
        expect(parseImportedSettings([])).toBeNull();
        expect(parseImportedSettings({ hello: "world" })).toBeNull();
        expect(parseImportedSettings({ ...DEFAULT_SETTINGS, theme: "dark" })).toBeNull();
        expect(parseImportedSettings({
            ...DEFAULT_SETTINGS,
            api: { geminiKey: {} },
        })).toBeNull();
        expect(parseImportedSettings({
            ...DEFAULT_SETTINGS,
            theme: { ...DEFAULT_SETTINGS.theme, mode: "sepia" },
        })).toBeNull();
    });
});
