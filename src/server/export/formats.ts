import { strToU8, zipSync } from "fflate";
import { toCsv } from "@/lib/csv";
import type { Cell, Dataset } from "@/lib/types";

export type ExportFormat = "csv" | "json" | "ndjson" | "xlsx";

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const pick = (columns: string[], row: Record<string, Cell>) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));

// Characters XML 1.0 cannot contain.
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const xml = (s: string) => s.replace(XML_BAD, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number) {
  let n = i + 1;
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** A minimal but valid .xlsx (one sheet, bold header row, frozen header), built without a heavy spreadsheet library. */
export function toXlsx(columns: string[], rows: Record<string, Cell>[], sheetName = "Data"): Uint8Array {
  const cell = (ref: string, v: Cell, header = false) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(String(v).slice(0, 32_000))}</t></is></c>`;
  };
  const sheetRows = [
    `<row r="1">${columns.map((c, i) => cell(`${colName(i)}1`, c, true)).join("")}</row>`,
    ...rows.map((r, ri) => `<row r="${ri + 2}">${columns.map((c, ci) => cell(`${colName(ci)}${ri + 2}`, r[c] ?? null)).join("")}</row>`),
  ].join("");
  const widths = columns.map((c, i) => {
    const longest = Math.max(c.length, ...rows.slice(0, 200).map((r) => String(r[c] ?? "").length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${columns.length ? `<cols>${widths}</cols>` : ""}<sheetData>${sheetRows}</sheetData></worksheet>`;
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Data");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  return zipSync(files, { level: 6 });
}

/** Serializes a dataset in any supported format. */
export function serializeDataset(ds: Dataset, format: ExportFormat): { body: string | Uint8Array; type: string; ext: string } {
  switch (format) {
    case "csv": return { body: "﻿" + toCsv(ds.columns, ds.rows), type: EXPORT_TYPES.csv, ext: "csv" };
    case "json": return { body: JSON.stringify(ds.rows.map((r) => pick(ds.columns, r)), null, 2), type: EXPORT_TYPES.json, ext: "json" };
    case "ndjson": return { body: ds.rows.map((r) => JSON.stringify(pick(ds.columns, r))).join("\n") + "\n", type: EXPORT_TYPES.ndjson, ext: "ndjson" };
    case "xlsx": return { body: toXlsx(ds.columns, ds.rows, ds.name), type: EXPORT_TYPES.xlsx, ext: "xlsx" };
  }
}
