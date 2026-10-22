import { describe, expect, it } from 'vitest';
import { examFromSupabaseRow, examToSupabaseRow, sanitizeExamPayload } from './omrPersistence';
import { normalizeExamAuthoringSettings } from './examAuthoringSettings';
import type { Exam } from '@/types/omr';

describe('teacher authoring settings persistence', () => {
    it('round trips target total and selected PDF pages through the saved exam payload', () => {
        const exam: Exam = { id:'setup-exam', title:'국어', createdAt:'2026-10-21T00:00:00Z', questions:[], authoringSettings: { targetTotalScore:100, pdfPageRange:'1-12,17-20' } };
        const restored=examFromSupabaseRow(examToSupabaseRow(exam));
        expect(restored.authoringSettings).toEqual(exam.authoringSettings);
        expect(sanitizeExamPayload(JSON.parse(JSON.stringify(restored)))?.authoringSettings).toEqual(exam.authoringSettings);
    });
    it('supports old exams and strips invalid or unknown setup properties', () => {
        expect(normalizeExamAuthoringSettings(undefined)).toBeUndefined();
        expect(normalizeExamAuthoringSettings({targetTotalScore:Infinity,pdfPageRange:'<script>',secret:'x'})).toBeUndefined();
        expect(normalizeExamAuthoringSettings({targetTotalScore:50,pdfPageRange:' 1-4 ',secret:'x'})).toEqual({targetTotalScore:50,pdfPageRange:'1-4'});
    });
});
