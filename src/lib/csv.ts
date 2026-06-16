export function parseCsvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;

    const pushCell = () => {
        row.push(cell.trim());
        cell = "";
    };

    const pushRow = () => {
        pushCell();
        const isEmpty = row.every(value => value.length === 0);
        if (!isEmpty) rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            pushCell();
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            if (char === "\r" && next === "\n") i += 1;
            pushRow();
            continue;
        }

        cell += char;
    }

    if (cell.length > 0 || row.length > 0) pushRow();
    if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
    return rows;
}

export function formatCsvCell(value: unknown): string {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsvRows(rows: unknown[][]): string {
    return rows.map(row => row.map(formatCsvCell).join(",")).join("\n");
}
