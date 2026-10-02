export const DEFAULT_REGION_NAME = "미분류 지역";

export function regionKeyFor(value: string | undefined): string {
    const name = typeof value === "string" ? value.trim() : "";
    return (name || DEFAULT_REGION_NAME).toLocaleLowerCase("ko-KR");
}
