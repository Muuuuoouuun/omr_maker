import type { Attempt, Exam } from "@/types/omr";

type Env = Record<string, string | undefined>;

export interface SupabaseConfig {
    url: string;
    publishableKey: string;
}

export interface SupabaseExamRow {
    id: string;
    title: string;
    payload: Exam;
    created_at: string;
    updated_at: string;
    archived: boolean;
}

export interface SupabaseAttemptRow {
    id: string;
    exam_id: string;
    student_name: string;
    student_id: string | null;
    group_id: string | null;
    group_name: string | null;
    payload: Attempt;
    started_at: string;
    finished_at: string;
}

export interface PersistenceResult {
    localSaved: boolean;
    remoteSaved: boolean;
    remoteError?: string;
}

interface LoadResult<T> {
    items: T[];
    remoteLoaded: boolean;
    remoteError?: string;
}

interface SupabaseQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

type SupabaseClientLike = {
    from(table: string): {
        select(columns?: string): {
            eq(column: string, value: string): {
                maybeSingle(): Promise<SupabaseQueryResult<unknown>>;
            };
            order(column: string, options?: { ascending?: boolean }): Promise<SupabaseQueryResult<unknown[]>>;
        };
        upsert(row: unknown): Promise<SupabaseQueryResult<unknown>>;
        delete(): {
            eq(column: string, value: string): Promise<SupabaseQueryResult<unknown>>;
        };
    };
};

const EXAM_PREFIX = "omr_exam_";
const ATTEMPTS_KEY = "omr_attempts";

let supabaseClientPromise: Promise<SupabaseClientLike | null> | null = null;

export function getSupabaseConfigFromEnv(env: Env): SupabaseConfig | null {
    const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const publishableKey = (
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )?.trim();

    if (!url || !publishableKey) return null;
    return { url, publishableKey };
}

export function getSupabaseConfig(): SupabaseConfig | null {
    return getSupabaseConfigFromEnv(process.env);
}

export function isSupabaseConfigured(): boolean {
    return !!getSupabaseConfig();
}

export function examToSupabaseRow(exam: Exam): SupabaseExamRow {
    const createdAt = exam.createdAt || new Date().toISOString();
    return {
        id: exam.id,
        title: exam.title,
        payload: exam,
        created_at: createdAt,
        updated_at: exam.updatedAt || createdAt,
        archived: !!exam.archived,
    };
}

export function examFromSupabaseRow(row: SupabaseExamRow | { payload: Exam }): Exam {
    return row.payload;
}

export function attemptToSupabaseRow(attempt: Attempt): SupabaseAttemptRow {
    return {
        id: attempt.id,
        exam_id: attempt.examId,
        student_name: attempt.studentName,
        student_id: attempt.studentId || null,
        group_id: attempt.groupId || null,
        group_name: attempt.groupName || null,
        payload: attempt,
        started_at: attempt.startedAt,
        finished_at: attempt.finishedAt,
    };
}

export function attemptFromSupabaseRow(row: SupabaseAttemptRow | { payload: Attempt }): Attempt {
    return row.payload;
}

function getActivityTime(item: Exam | Attempt): number {
    if ("finishedAt" in item) {
        return Date.parse(item.finishedAt || item.startedAt || "") || 0;
    }
    return Date.parse(item.updatedAt || item.createdAt || "") || 0;
}

export function sortByNewestActivity<T extends Exam | Attempt>(items: T[]): T[] {
    return [...items].sort((a, b) => getActivityTime(b) - getActivityTime(a));
}

function mergeById<T extends { id: string } & (Exam | Attempt)>(localItems: T[], remoteItems: T[]): T[] {
    const merged = new Map<string, T>();

    for (const item of [...localItems, ...remoteItems]) {
        const current = merged.get(item.id);
        if (!current || getActivityTime(item) >= getActivityTime(current)) {
            merged.set(item.id, item);
        }
    }

    return sortByNewestActivity([...merged.values()]);
}

function hasBrowserStorage(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

export function readLocalExam(id: string): Exam | null {
    if (!hasBrowserStorage()) return null;
    return readJson<Exam | null>(localStorage.getItem(`${EXAM_PREFIX}${id}`), null);
}

export function readLocalExams(): Exam[] {
    if (!hasBrowserStorage()) return [];

    const exams: Exam[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(EXAM_PREFIX)) continue;
        const exam = readJson<Exam | null>(localStorage.getItem(key), null);
        if (exam?.id) exams.push(exam);
    }

    return sortByNewestActivity(exams);
}

export function saveLocalExam(exam: Exam): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        localStorage.setItem(`${EXAM_PREFIX}${exam.id}`, JSON.stringify(exam));
        return true;
    } catch {
        return false;
    }
}

export function deleteLocalExam(id: string): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        localStorage.removeItem(`${EXAM_PREFIX}${id}`);
        const attempts = readLocalAttempts().filter(attempt => attempt.examId !== id);
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
        return true;
    } catch {
        return false;
    }
}

export function readLocalAttempts(): Attempt[] {
    if (!hasBrowserStorage()) return [];
    return sortByNewestActivity(readJson<Attempt[]>(localStorage.getItem(ATTEMPTS_KEY), []));
}

export function saveLocalAttempt(attempt: Attempt): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        const attempts = readLocalAttempts();
        const next = attempts.filter(item => item.id !== attempt.id);
        next.push(attempt);
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(sortByNewestActivity(next)));
        return true;
    } catch {
        return false;
    }
}

async function getSupabaseClient(): Promise<SupabaseClientLike | null> {
    const config = getSupabaseConfig();
    if (!config) return null;
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = import("@supabase/supabase-js")
        .then((supabaseModule: unknown) => {
            const { createClient } = supabaseModule as {
                createClient: (url: string, key: string, options: unknown) => SupabaseClientLike;
            };

            return createClient(config.url, config.publishableKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
            });
        })
        .catch(error => {
            console.warn("Supabase client unavailable", error);
            return null;
        });

    return supabaseClientPromise;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message || "Unknown Supabase error");
    }
    return "Unknown Supabase error";
}

async function fetchRemoteExam(id: string): Promise<Exam | null> {
    const client = await getSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_exams")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load exam from Supabase");
    return data ? examFromSupabaseRow(data as SupabaseExamRow) : null;
}

async function fetchRemoteExams(): Promise<Exam[]> {
    const client = await getSupabaseClient();
    if (!client) return [];

    const { data, error } = await client
        .from("omr_exams")
        .select("*")
        .order("updated_at", { ascending: false });

    if (error) throw new Error(error.message || "Failed to load exams from Supabase");
    return (data || []).map(row => examFromSupabaseRow(row as SupabaseExamRow));
}

async function fetchRemoteAttempts(): Promise<Attempt[]> {
    const client = await getSupabaseClient();
    if (!client) return [];

    const { data, error } = await client
        .from("omr_attempts")
        .select("*")
        .order("finished_at", { ascending: false });

    if (error) throw new Error(error.message || "Failed to load attempts from Supabase");
    return (data || []).map(row => attemptFromSupabaseRow(row as SupabaseAttemptRow));
}

async function fetchRemoteAttempt(id: string): Promise<Attempt | null> {
    const client = await getSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_attempts")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load attempt from Supabase");
    return data ? attemptFromSupabaseRow(data as SupabaseAttemptRow) : null;
}

async function upsertRemoteExam(exam: Exam): Promise<void> {
    const client = await getSupabaseClient();
    if (!client) return;

    const { error } = await client.from("omr_exams").upsert(examToSupabaseRow(exam));
    if (error) throw new Error(error.message || "Failed to save exam to Supabase");
}

async function upsertRemoteAttempt(attempt: Attempt): Promise<void> {
    const client = await getSupabaseClient();
    if (!client) return;

    const { error } = await client.from("omr_attempts").upsert(attemptToSupabaseRow(attempt));
    if (error) throw new Error(error.message || "Failed to save attempt to Supabase");
}

async function deleteRemoteExam(id: string): Promise<void> {
    const client = await getSupabaseClient();
    if (!client) return;

    const attemptResult = await client.from("omr_attempts").delete().eq("exam_id", id);
    if (attemptResult.error) {
        throw new Error(attemptResult.error.message || "Failed to delete exam attempts from Supabase");
    }

    const examResult = await client.from("omr_exams").delete().eq("id", id);
    if (examResult.error) {
        throw new Error(examResult.error.message || "Failed to delete exam from Supabase");
    }
}

export async function loadExam(id: string): Promise<Exam | null> {
    const localExam = readLocalExam(id);
    try {
        const remoteExam = await fetchRemoteExam(id);
        if (remoteExam) {
            saveLocalExam(remoteExam);
            return remoteExam;
        }
    } catch (error) {
        console.warn("Falling back to local exam", error);
    }
    return localExam;
}

export async function loadExams(): Promise<LoadResult<Exam>> {
    const localItems = readLocalExams();
    try {
        const remoteItems = await fetchRemoteExams();
        for (const exam of remoteItems) saveLocalExam(exam);
        return { items: mergeById(localItems, remoteItems), remoteLoaded: isSupabaseConfigured() };
    } catch (error) {
        return { items: localItems, remoteLoaded: false, remoteError: errorMessage(error) };
    }
}

export async function loadAttempts(): Promise<LoadResult<Attempt>> {
    const localItems = readLocalAttempts();
    try {
        const remoteItems = await fetchRemoteAttempts();
        for (const attempt of remoteItems) saveLocalAttempt(attempt);
        return { items: mergeById(localItems, remoteItems), remoteLoaded: isSupabaseConfigured() };
    } catch (error) {
        return { items: localItems, remoteLoaded: false, remoteError: errorMessage(error) };
    }
}

export async function loadAttempt(id: string): Promise<Attempt | null> {
    const localAttempt = readLocalAttempts().find(attempt => attempt.id === id) || null;
    try {
        const remoteAttempt = await fetchRemoteAttempt(id);
        if (remoteAttempt) {
            saveLocalAttempt(remoteAttempt);
            return remoteAttempt;
        }
    } catch (error) {
        console.warn("Falling back to local attempt", error);
    }
    return localAttempt;
}

export async function saveExam(exam: Exam): Promise<PersistenceResult> {
    const localSaved = saveLocalExam(exam);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteExam(exam);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function saveAttempt(attempt: Attempt): Promise<PersistenceResult> {
    const localSaved = saveLocalAttempt(attempt);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteAttempt(attempt);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function deleteExam(id: string): Promise<PersistenceResult> {
    const localSaved = deleteLocalExam(id);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await deleteRemoteExam(id);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}
