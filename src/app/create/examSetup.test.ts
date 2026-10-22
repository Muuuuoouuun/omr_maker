import { describe, expect, it } from 'vitest';
import { applyExamSetupPreset, applyMixedPointScores, ambiguousQuestionPages, duplicateQuestionPages, mergeQuestionPdfPlacements, parseNumberSelection } from './examSetup';
import type { Question } from '@/types/omr';

const physicsQuestions: Question[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, number: i + 1, score: 5, answer: i % 5 + 1, choices: 5 }));

describe('exam setup from real paper structure', () => {
    it('includes Korean common and language/media pages while excluding speech/writing', () => {
        const selected = parseNumberSelection('1-12,17-20', 20);
        expect(selected).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,17,18,19,20]);
        expect(parseNumberSelection('1-16', 20)).not.toContain(17);
    });
    it.each(['0', '1-21', '17-12', '1,,2', '1-2garbage', 'NaN', '9999999999999999999'])('rejects invalid range %s without silently including every page', value => {
        expect(() => parseNumberSelection(value, 20)).toThrow();
    });
    it('deduplicates overlapping input and preserves actual page numbering', () => {
        expect(parseNumberSelection('1-3,2,5', 6)).toEqual([1,2,3,5]);
        expect(parseNumberSelection('', 4)).toEqual([1,2,3,4]);
    });
    it('exposes alternate pages for repeated elective question numbers', () => {
        expect(duplicateQuestionPages(new Map([[35, new Set([13,17])], [36, new Set([13,17])], [1, new Set([1])]])))
            .toEqual(['35번 (13, 17p)', '36번 (13, 17p)']);
    });
    it('sets the actual Physics 2/3-point distribution to50 while preserving answers and subquestions', () => {
        const input = physicsQuestions.map((question, index) => index === 0 ? { ...question, subQuestions: [{ schemaVersion: 1 as const, id: 'reason', kind: 'free_text' as const, prompt: '근거', maxLength: 300 }] } : question);
        const result = applyMixedPointScores(input, [5,8,11,12,14,15,16,17,18,20]);
        expect(result.reduce((sum, question) => sum + question.score!, 0)).toBe(50);
        expect(result.map(question => question.answer)).toEqual(input.map(question => question.answer));
        expect(result[0].subQuestions).toEqual(input[0].subQuestions);
        expect(input.every(question => question.score === 5)).toBe(true);
    });
    it('does not fabricate answer keys or3-point positions when expanding a Korean preset', () => {
        const result = applyExamSetupPreset(physicsQuestions, 'korean');
        expect(result).toHaveLength(45);
        expect(result.slice(0,20).map(question => question.answer)).toEqual(physicsQuestions.map(question => question.answer));
        expect(result.slice(20).every(question => question.answer === undefined)).toBe(true);
        expect(result.reduce((sum, question) => sum + question.score!, 0)).toBe(90);
        expect(new Set(result.map(question => question.id)).size).toBe(45);
    });
});


it('distinguishes repeated elective headings from low-confidence page numbers and indented passage lists', () => {
    const placement = (page:number,x:number,score:number) => ({page,location:{questionNumber:1,x,y:0.3,score,text:'question'}});
    const first=placement(1,0.104,124),right=placement(1,0.51,124),elective=placement(13,0.104,124);
    const best=new Map([[1,first],[2,right],[35,elective]]);
    const candidates=new Map([[1,[first,placement(15,0.153,127)]],[2,[right,placement(2,0.114,94)]],[35,[elective,placement(17,0.51,124)]]]);
    expect(ambiguousQuestionPages(candidates,best)).toEqual(['35번 (13, 17p)']);
});


it('merges a delayed PDF result while preserving answers, points, subquestions, and manual region edits', async () => {
    const original:Question[]=[{id:1,number:1,answer:2,score:5},{id:2,number:2,score:5}];
    let resolve!: (questions:Question[])=>void;
    const delayed=new Promise<Question[]>(done=>{resolve=done;});
    const latest:Question[]=[{...original[0],answer:4,score:3,tags:{concept:'수정한 개념'}},{...original[1],pdfLocation:{page:7,x:0.3,y:0.4}}];
    resolve(original.map(q=>({...q,pdfLocation:{page:1,x:0.1,y:0.2},tags:{source:'지문1'}})));
    const result=mergeQuestionPdfPlacements(latest,original,await delayed);
    expect(result[0]).toMatchObject({answer:4,score:3,tags:{concept:'수정한 개념',source:'지문1'},pdfLocation:{page:1}});
    expect(result[1].pdfLocation?.page).toBe(7);
    expect(mergeQuestionPdfPlacements(latest.slice(0,1),original,result)).toEqual(latest.slice(0,1));
});


it('demotes reviewed analysis after an elective remap while preserving its text and current answers',()=>{
    const original:Question[]=[{id:35,number:35,answer:3,score:2,pdfLocation:{page:13,x:0.1,y:0.2},tags:{concept:'화법',unit:'발표'},contentAnalysis:{concepts:['화법'],trapPoints:['함정'],summary:'원본 분석',status:'reviewed'}}];
    const matched=original.map(q=>({...q,pdfLocation:{page:17,x:0.1,y:0.2}}));
    const result=mergeQuestionPdfPlacements(original,original,matched);
    expect(result[0]).toMatchObject({answer:3,score:2,pdfLocation:{page:17},contentAnalysis:{summary:'원본 분석',status:'draft'},tags:{unit:'발표'}});
    expect(result[0].tags?.concept).toBeUndefined();
    expect(mergeQuestionPdfPlacements(original,original,original)[0].contentAnalysis?.status).toBe('reviewed');
});
