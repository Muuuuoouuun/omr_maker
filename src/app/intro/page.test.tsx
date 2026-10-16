// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/BrandLogo", () => ({ default: () => null }));

import IntroPage from "./page";

const DEMO_HREF = "/?role=teacher&intent=demo";
const STORY_ORDER = ["problem", "vision", "features", "change", "future", "start"];

afterEach(cleanup);

describe("/intro storytelling page", () => {
    it("opens on the problem and then follows problem → vision → features → change → future → CTA", () => {
        render(<IntroPage />);

        const main = screen.getByRole("main");
        const headings = within(main).getAllByRole("heading", { level: 1 });
        expect(headings).toHaveLength(1);
        expect(headings[0].textContent).toBe("시험이 끝나면,선생님의 시험이 시작됩니다");

        const sections = STORY_ORDER.map(id => document.getElementById(id));
        sections.forEach((section, index) => expect(section, STORY_ORDER[index]).not.toBeNull());
        for (let index = 1; index < sections.length; index += 1) {
            const position = sections[index - 1]!.compareDocumentPosition(sections[index]!);
            expect(position & Node.DOCUMENT_POSITION_FOLLOWING, STORY_ORDER[index]).toBeTruthy();
        }
    });

    it("ties each of the five feature steps back to a problem it solves", () => {
        render(<IntroPage />);

        const problems = within(document.getElementById("problem")!).getAllByRole("listitem")
            .map(item => item.textContent || "")
            .filter(text => text.startsWith("숙제"));
        expect(problems).toHaveLength(3);

        const steps = within(document.getElementById("features")!).getAllByRole("article");
        expect(steps).toHaveLength(5);
        const solved = new Set<string>();
        for (const step of steps) {
            const match = (step.textContent || "").match(/해결 ([①②③]) (시간|기록|타이밍)/);
            expect(match, step.id).not.toBeNull();
            solved.add(`${match![1]} ${match![2]}`);
        }
        // Every problem raised in chapter 01 is answered by at least one step.
        expect([...solved].sort()).toEqual(["① 시간", "② 기록", "③ 타이밍"]);
    });

    it("labels every illustration's figures as examples", () => {
        render(<IntroPage />);

        const illustrations = screen.getAllByRole("img");
        expect(illustrations.length).toBeGreaterThanOrEqual(7);
        for (const illustration of illustrations) {
            expect(illustration.getAttribute("aria-label"), illustration.textContent || "").toBeTruthy();
            expect(illustration.textContent, illustration.getAttribute("aria-label") || "").toContain("예시");
        }
    });

    it("hands every demo CTA to the teacher portal instead of starting a session itself", () => {
        render(<IntroPage />);

        const links = screen.getAllByRole("link");
        const demoLinks = links.filter(link => /데모/.test(link.textContent || ""));
        expect(demoLinks.map(link => link.textContent)).toEqual([
            "데모 체험",
            "가입 없이 데모 보기",
            "데모로 확인하기",
            "데모 대시보드 열기",
            "데모 계정으로 둘러보기",
        ]);
        for (const link of demoLinks) expect(link.getAttribute("href")).toBe(DEMO_HREF);

        const studentLinks = links.filter(link => /학생으로 입장하기/.test(link.textContent || ""));
        expect(studentLinks).toHaveLength(2);
        for (const link of studentLinks) expect(link.getAttribute("href")).toBe("/?role=student");
    });

    it("points every in-page anchor at a rendered target", () => {
        render(<IntroPage />);

        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
        expect(anchors.length).toBeGreaterThanOrEqual(11);
        for (const anchor of anchors) {
            const id = anchor.getAttribute("href")!.slice(1);
            expect(document.getElementById(id), id).not.toBeNull();
        }
    });

    it("keeps the teacher portal's demo card addressable for the intent=demo handoff", () => {
        const home = readFileSync(resolve(process.cwd(), "src/app/page.tsx"), "utf8");
        expect(home).toContain('<section id="teacher-demo-entry" className="mockup-login-card"');
        expect(home).toContain('get("intent") !== "demo"');
        expect(home).toContain('document.getElementById("teacher-demo-entry")?.scrollIntoView({ block: "center" })');
        expect(home).toContain('href="/intro"');
    });
});
