import { summarizePersistenceHealth, type PersistenceHealth, type PersistenceHealthSource } from "@/lib/persistenceHealth";
import type { RosterTombstones } from "@/lib/rosterPersistence";

export type DataDbReadinessMetricKey = "exams" | "attempts" | "roster" | "deleted_rows";
export type DataDbReadinessCheckKey = "storage" | "roster" | "analytics" | "deletions" | "production_rls";
export type DataDbReadinessTone = "ready" | "warning" | "error" | "neutral";

export interface DataDbReadinessMetric {
    key: DataDbReadinessMetricKey;
    label: string;
    value: string;
    detail: string;
}

export interface DataDbReadinessCheck {
    key: DataDbReadinessCheckKey;
    label: string;
    detail: string;
    tone: DataDbReadinessTone;
}

export interface DataDbReadinessSyncSource {
    key: string;
    label: string;
    detail: string;
    tone: DataDbReadinessTone;
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    pendingCount: number;
    error?: string;
}

export interface DataDbReadinessInput {
    syncSources: PersistenceHealthSource[];
    examCount: number;
    attemptCount: number;
    rosterStudentCount: number;
    rosterGroupCount: number;
    tombstones?: RosterTombstones;
}

export interface DataDbReadinessSummary {
    persistence: PersistenceHealth;
    label: string;
    detail: string;
    metrics: DataDbReadinessMetric[];
    checks: DataDbReadinessCheck[];
    syncSources: DataDbReadinessSyncSource[];
    tombstoneCount: number;
}

function countRecord(value: Record<string, string> | undefined): number {
    return value ? Object.keys(value).length : 0;
}

function nonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function storageCheck(persistence: PersistenceHealth): DataDbReadinessCheck {
    if (persistence.kind === "error") {
        return {
            key: "storage",
            label: "저장소 점검 필요",
            detail: persistence.error || persistence.detail,
            tone: "error",
        };
    }
    if (persistence.kind === "pending") {
        return {
            key: "storage",
            label: "원격 재동기화 대기",
            detail: persistence.detail,
            tone: "warning",
        };
    }
    if (persistence.kind === "synced") {
        return {
            key: "storage",
            label: "Supabase 동기화 정상",
            detail: "시험, 제출, 명단 원격 상태를 함께 확인했습니다.",
            tone: "ready",
        };
    }
    if (persistence.kind === "local") {
        return {
            key: "storage",
            label: "로컬 저장 모드",
            detail: "Supabase 환경변수가 없으면 이 브라우저 기준으로 저장됩니다.",
            tone: "neutral",
        };
    }
    return {
        key: "storage",
        label: "저장 상태 확인 중",
        detail: "시험, 제출, 명단 저장 상태를 읽고 있습니다.",
        tone: "neutral",
    };
}

function sourceKey(source: PersistenceHealthSource, index: number): string {
    return source.sourceKey?.trim() || `source-${index + 1}`;
}

function sourceLabel(source: PersistenceHealthSource, index: number): string {
    return source.sourceLabel?.trim() || `저장소 ${index + 1}`;
}

function pendingCount(source: PersistenceHealthSource): number {
    return nonNegative(source.pendingSyncCount || 0);
}

function buildSyncSourceStatus(source: PersistenceHealthSource, index: number): DataDbReadinessSyncSource {
    const key = sourceKey(source, index);
    const label = sourceLabel(source, index);
    const pending = pendingCount(source);
    const error = source.remoteError?.trim() || undefined;

    if (error) {
        return {
            key,
            label: `${label} 확인 필요`,
            detail: pending > 0 ? `${error} · ${pending}건 재시도 대기` : error,
            tone: "error",
            remoteLoaded: !!source.remoteLoaded,
            remoteSynced: source.remoteSynced,
            pendingCount: pending,
            error,
        };
    }

    if (!source.remoteLoaded) {
        return {
            key,
            label: `${label} 로컬 저장`,
            detail: "Supabase 원격 로드 없이 이 브라우저 데이터로 표시합니다.",
            tone: "neutral",
            remoteLoaded: false,
            remoteSynced: source.remoteSynced,
            pendingCount: pending,
        };
    }

    if (pending > 0 || source.remoteSynced === false) {
        return {
            key,
            label: `${label} 재동기화 대기`,
            detail: pending > 0 ? `${pending}건 재시도 대기` : "원격 상태를 다시 확인해야 합니다.",
            tone: "warning",
            remoteLoaded: true,
            remoteSynced: source.remoteSynced,
            pendingCount: pending,
        };
    }

    return {
        key,
        label: `${label} 원격 동기화`,
        detail: "Supabase 최신 데이터 기준으로 읽었습니다.",
        tone: "ready",
        remoteLoaded: true,
        remoteSynced: source.remoteSynced,
        pendingCount: pending,
    };
}

export function buildDataDbReadiness(input: DataDbReadinessInput): DataDbReadinessSummary {
    const persistence = summarizePersistenceHealth(input.syncSources);
    const examCount = nonNegative(input.examCount);
    const attemptCount = nonNegative(input.attemptCount);
    const rosterStudentCount = nonNegative(input.rosterStudentCount);
    const rosterGroupCount = nonNegative(input.rosterGroupCount);
    const tombstoneCount = countRecord(input.tombstones?.students) + countRecord(input.tombstones?.groups);
    const syncSources = input.syncSources.map(buildSyncSourceStatus);

    const checks: DataDbReadinessCheck[] = [
        storageCheck(persistence),
        {
            key: "roster",
            label: rosterStudentCount > 0 || rosterGroupCount > 0 ? "명단 데이터 준비" : "명단 데이터 없음",
            detail: rosterStudentCount > 0 || rosterGroupCount > 0
                ? `학생 ${rosterStudentCount}명, 반 ${rosterGroupCount}개 기준으로 분석합니다.`
                : "학생/반을 추가하면 지역·반별 분석과 배포 대상 계산이 안정화됩니다.",
            tone: rosterStudentCount > 0 || rosterGroupCount > 0 ? "ready" : "warning",
        },
        {
            key: "analytics",
            label: examCount > 0 || attemptCount > 0 ? "분석 데이터 감지" : "분석 데이터 대기",
            detail: examCount > 0 || attemptCount > 0
                ? `시험 ${examCount}개, 제출 ${attemptCount}건을 읽었습니다.`
                : "시험 생성과 제출이 쌓이면 대시보드 분석이 활성화됩니다.",
            tone: examCount > 0 || attemptCount > 0 ? "ready" : "neutral",
        },
        {
            key: "deletions",
            label: tombstoneCount > 0 ? "삭제 동기화 대기" : "삭제 동기화 정리됨",
            detail: tombstoneCount > 0
                ? `${tombstoneCount}개 삭제/보관 표시가 원격 재동기화 대상입니다.`
                : "삭제된 학생/반이 다시 나타나지 않도록 보관 표시가 정리되어 있습니다.",
            tone: tombstoneCount > 0 ? "warning" : "ready",
        },
        {
            key: "production_rls",
            label: "실사용 RLS 전환 확인",
            detail: "실제 학생 데이터를 저장하기 전 Supabase Auth, 조직 멤버십, production-rls.sql 정책 적용을 확인하세요.",
            tone: "warning",
        },
    ];

    return {
        persistence,
        label: persistence.label,
        detail: persistence.error || persistence.detail,
        metrics: [
            {
                key: "exams",
                label: "시험",
                value: `${examCount}개`,
                detail: "저장된 시험/배포 기준",
            },
            {
                key: "attempts",
                label: "제출",
                value: `${attemptCount}건`,
                detail: "원시험·재시험 제출 포함",
            },
            {
                key: "roster",
                label: "명단",
                value: `${rosterStudentCount}명`,
                detail: `반 ${rosterGroupCount}개`,
            },
            {
                key: "deleted_rows",
                label: "보관 표시",
                value: `${tombstoneCount}개`,
                detail: "삭제 재등장 방지",
            },
        ],
        checks,
        syncSources,
        tombstoneCount,
    };
}
