import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the two loading-performance decisions that are cheap to make, expensive
 * to lose, and completely invisible in review — nothing fails, nothing warns, the
 * page just gets slower.
 *
 * Both were real regressions found by measuring, not by reading:
 *
 *  - Pretendard's single variable woff2 carries the full 11,172-syllable Korean
 *    set at ~2,010KB. Wired through next/font/local it was preloaded on every
 *    route, and the landing page shipped 2,282KB. The upstream dynamic-subset
 *    stylesheet splits it by unicode-range so a page fetches only the ranges its
 *    text renders: 230KB of font, 460KB total.
 *
 *  - MockupOverview only renders for the ?showcase=1 demo account, but a static
 *    import made it the one thing still pulling recharts into every teacher's
 *    initial dashboard bundle — silently cancelling the dynamic() calls already
 *    in place for ExamAnalyticsTab, StudentAnalyticsTab and TrendChart. Eager
 *    client JS went 749KB -> 315KB when it was deferred.
 *
 * These assert the shape of the fix, not byte counts — sizes drift with every
 * feature, but "don't ship the 2MB font file" and "don't reach the chart library
 * eagerly" stay true. Re-measure against a production build when the numbers
 * themselves matter.
 */

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

/** Every non-test source file under src/, as repo-relative paths. */
function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
                out.push(path.relative(rootDir, full));
            }
        }
    };
    walk(srcDir);
    return out;
}

/** "src/components/dashboard/TrendChart.tsx" -> "@/components/dashboard/TrendChart" */
function aliasFor(relativePath: string): string {
    return "@/" + relativePath.replace(/^src\//, "").replace(/\.tsx?$/, "");
}

describe("loading performance contract", () => {
    describe("Pretendard loads as unicode-range subsets, not one 2MB file", () => {
        it("does not make production builds depend on downloading Google fonts", () => {
            expect(read("src/app/layout.tsx")).not.toMatch(/from\s+["']next\/font\/google["']/);
        });

        it("imports the dynamic-subset stylesheet in the root layout", () => {
            expect(read("src/app/layout.tsx")).toContain(
                'import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css"',
            );
        });

        it("never reaches for the full variable font file", () => {
            const layout = read("src/app/layout.tsx");
            expect(layout).not.toContain("woff2/PretendardVariable.woff2");
            // Match the import statement, not the bare string — the comment above
            // that import names next/font/local to explain why it is NOT used, and
            // a substring check flags the explanation as the offence.
            expect(layout).not.toMatch(/^\s*import\s+.*\bfrom\s+["']next\/font\/local["']/m);
        });

        it("keeps the subset stylesheet a real dependency", () => {
            const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
            expect(pkg.dependencies?.pretendard).toBeTruthy();
        });

        it("defines --font-pretendard as a literal family name in :root", () => {
            // Not a next/font variable any more, so it resolves above <body> and is
            // safe in :root. The CLAUDE.md rule still applies to the Geist vars.
            expect(read("src/app/globals.css")).toContain('--font-pretendard: "Pretendard Variable"');
        });
    });

    describe("recharts is only reachable behind a lazy boundary", () => {
        // Derived, not hard-coded: a new chart component joins this list by itself
        // and has to satisfy the same rule.
        const chartModules = sourceFiles().filter(file => /from\s+["']recharts["']/.test(read(file)));

        it("finds the recharts consumers", () => {
            expect(chartModules.length).toBeGreaterThan(0);
        });

        it.each(chartModules)("%s is never imported statically", chartFile => {
            const alias = aliasFor(chartFile);
            // A static `import X from "@/…/Chart"` anywhere pulls recharts into that
            // importer's chunk, which is exactly how MockupOverview defeated three
            // existing dynamic() calls at once.
            const staticImport = new RegExp(`import\\s+[^;]*?\\sfrom\\s+["']${alias}["']`);
            const offenders = sourceFiles()
                .filter(file => file !== chartFile)
                .filter(file => staticImport.test(read(file)));
            expect(offenders).toEqual([]);
        });

        it.each(chartModules)("%s is loaded through dynamic()", chartFile => {
            const alias = aliasFor(chartFile);
            const lazyImport = new RegExp(`dynamic\\(\\s*\\(\\)\\s*=>\\s*import\\(["']${alias}["']\\)`);
            const loaders = sourceFiles().filter(file => lazyImport.test(read(file)));
            expect(loaders.length).toBeGreaterThan(0);
        });
    });
});
