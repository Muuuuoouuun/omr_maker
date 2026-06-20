import { describe, expect, it } from "vitest";
import { summarizePersistenceWrite } from "./persistenceFeedback";

describe("persistence feedback", () => {
    it("reports a full local and remote write as success", () => {
        expect(summarizePersistenceWrite(
            { localSaved: true, remoteSaved: true },
            { target: "시험", action: "저장" },
        )).toMatchObject({
            ok: true,
            level: "success",
            title: "시험 저장 완료",
        });
    });

    it("treats local-only writes as successful local persistence", () => {
        expect(summarizePersistenceWrite(
            { localSaved: true, remoteSaved: false },
            { target: "답안", action: "저장" },
        )).toMatchObject({
            ok: true,
            level: "success",
            detail: "Supabase 미연결 상태라 이 기기에 저장됐습니다.",
        });
    });

    it("keeps remote failures as sync warnings when local save succeeded", () => {
        expect(summarizePersistenceWrite(
            { localSaved: true, remoteSaved: false, remoteError: "network failed" },
            { target: "답안", action: "저장" },
        )).toMatchObject({
            ok: true,
            level: "info",
            title: "로컬 저장 완료",
            detail: "Supabase 동기화는 다음 로드 때 다시 시도됩니다.",
        });
    });

    it("distinguishes remote-only writes from total failure", () => {
        expect(summarizePersistenceWrite(
            { localSaved: false, remoteSaved: true },
            { target: "시험", action: "저장" },
        )).toMatchObject({
            ok: true,
            level: "info",
            title: "Supabase 저장 완료",
        });

        expect(summarizePersistenceWrite(
            { localSaved: false, remoteSaved: false, remoteError: "quota exceeded" },
            { target: "시험", action: "저장" },
        )).toMatchObject({
            ok: false,
            level: "error",
            title: "시험 저장 실패",
            detail: "quota exceeded",
        });
    });
});
