import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    session: vi.fn(), mutation: vi.fn(), origin: vi.fn(), subject: vi.fn(), rate: vi.fn(),
    entitlement: vi.fn(), quota: vi.fn(), release: vi.fn(), generate: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => ({}), cookies: async () => ({ get: () => ({ value: 'signed' }) }) }));
vi.mock('@/lib/teacherServerSession', () => ({ TEACHER_SERVER_SESSION_COOKIE: 'teacher', resolveAuthorizedTeacherSessionCookie: mocks.session }));
vi.mock('@/lib/teacherMutationAuthorization', () => ({ isTeacherMutationAuthorized: mocks.mutation }));
vi.mock('@/lib/aiActionSecurity', () => ({ authorizeTeacherAiActionRequest: mocks.origin, authorizedTeacherAiRateLimitSubject: mocks.subject }));
vi.mock('@/lib/durableRateLimit', () => ({ applyDurableRateLimit: mocks.rate }));
vi.mock('@/app/actions/premiumAccess', () => ({ authorizePlanEntitlement: mocks.entitlement, authorizeSharedAiRecognition: mocks.quota, releaseSharedAiRecognition: mocks.release }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel() { return { generateContent: mocks.generate }; } } }));
import { analyzeExamImages } from './analyzeExam';

const images = ['data:image/jpeg;base64,YWJj'];
const questions = [{ id: 7, number: 1 }];
beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ userId: 'teacher' });
    mocks.mutation.mockReturnValue(true);
    mocks.origin.mockReturnValue({ allowed: true });
    mocks.subject.mockReturnValue('teacher');
    mocks.rate.mockResolvedValue({ allowed: true });
    mocks.entitlement.mockResolvedValue({ ok: true });
    mocks.quota.mockResolvedValue({ ok: true });
    mocks.generate.mockResolvedValue({ response: { text: () => '[]' } });
    vi.stubEnv('GEMINI_API_KEY', 'server-key');
});
describe('premium exam analysis action', () => {
    it('requires authenticated mutation authorization before provider', async () => {
        mocks.session.mockResolvedValue(null);
        await expect(analyzeExamImages(images, questions, 'personal-key')).rejects.toThrow('로그인');
        expect(mocks.entitlement).not.toHaveBeenCalled();
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('denies free accounts even with personal keys', async () => {
        mocks.entitlement.mockResolvedValue({ ok: false });
        await expect(analyzeExamImages(images, questions, 'personal-key')).rejects.toThrow('프리미엄');
        expect(mocks.entitlement).toHaveBeenCalledWith('advancedAnalytics');
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(mocks.quota).not.toHaveBeenCalled();
    });
    it('denies shared quota exhaustion before provider', async () => {
        mocks.quota.mockResolvedValue({ ok: false });
        await expect(analyzeExamImages(images, questions)).rejects.toThrow('사용량');
        expect(mocks.generate).not.toHaveBeenCalled();
    });
    it('uses personal funding only after entitlement and skips shared quota', async () => {
        await expect(analyzeExamImages(images, questions, 'personal-key')).resolves.toEqual([]);
        expect(mocks.generate).toHaveBeenCalledTimes(1);
        expect(mocks.quota).not.toHaveBeenCalled();
    });
    it('sanitizes provider output/errors and retains usage once provider starts', async () => {
        mocks.generate.mockRejectedValue(new Error('secret-provider-key-private-exam-content'));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(analyzeExamImages(images, questions)).rejects.toThrow('시험지 분석을 완료하지 못했습니다');
        expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-provider');
        expect(mocks.release).not.toHaveBeenCalled();
        warning.mockRestore();
    });
    it('rejects unknown provider question ids', async () => {
        mocks.generate.mockResolvedValue({ response: { text: () => '[{"questionId":999,"questionNumber":1}]' } });
        await expect(analyzeExamImages(images, questions)).rejects.toThrow('시험지 분석을 완료하지 못했습니다');
    });
});
