import { describe, expect, it } from "vitest";
import { createTeacherRosterSaveQueue } from "./teacherRosterSaveQueue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe("teacher roster save queue", () => {
    it("runs saves in order and forwards the committed revision", async () => {
        const queue = createTeacherRosterSaveQueue(4);
        const firstGate = deferred<{ localSaved: boolean; remoteSaved: boolean; revision: number }>();
        const started: string[] = [];

        const first = queue.enqueue(async revision => {
            started.push(`first:${revision}`);
            return firstGate.promise;
        });
        const second = queue.enqueue(async revision => {
            started.push(`second:${revision}`);
            return { localSaved: true, remoteSaved: true, revision: revision + 1 };
        });

        await Promise.resolve();
        expect(started).toEqual(["first:4"]);
        firstGate.resolve({ localSaved: true, remoteSaved: true, revision: 5 });

        await expect(first).resolves.toMatchObject({ revision: 5 });
        await expect(second).resolves.toMatchObject({ revision: 6 });
        expect(started).toEqual(["first:4", "second:5"]);
        expect(queue.getRevision()).toBe(6);
    });

    it("continues after a failed task without inventing a revision", async () => {
        const queue = createTeacherRosterSaveQueue(2);
        await expect(queue.enqueue(async () => {
            throw new Error("offline");
        })).rejects.toThrow("offline");

        await expect(queue.enqueue(async revision => ({
            localSaved: true,
            remoteSaved: true,
            revision: revision + 1,
        }))).resolves.toMatchObject({ revision: 3 });
    });
});
