import type { RosterPersistenceResult } from "@/lib/rosterPersistence";

export interface TeacherRosterSaveQueue {
    enqueue(task: (revision: number) => Promise<RosterPersistenceResult>): Promise<RosterPersistenceResult>;
    getRevision(): number;
    setRevision(revision: number): void;
}

function normalizeRevision(value: unknown): number {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

/**
 * Serializes whole-roster replacements and carries the server revision from one
 * save into the next. This prevents an older request from completing after a
 * newer one and overwriting the latest local/server snapshot.
 */
export function createTeacherRosterSaveQueue(initialRevision = 0): TeacherRosterSaveQueue {
    let revision = normalizeRevision(initialRevision);
    let tail: Promise<void> = Promise.resolve();

    return {
        enqueue(task) {
            const run = tail.then(() => task(revision)).then(result => {
                if (result.remoteSaved && result.revision !== undefined) {
                    revision = normalizeRevision(result.revision);
                }
                return result;
            });
            tail = run.then(() => undefined, () => undefined);
            return run;
        },
        getRevision() {
            return revision;
        },
        setRevision(nextRevision) {
            revision = normalizeRevision(nextRevision);
        },
    };
}
