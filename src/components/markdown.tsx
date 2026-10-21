import { Fragment, type ReactNode } from "react";

/**
 * Small, safe Markdown renderer for AI answers: headings, lists, tables, code,
 * bold, inline code and http(s) links. Builds React elements, never raw HTML.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const label = tok.slice(1, tok.indexOf("]"));
      out.push(<a key={k} href={m[2]} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{label}</a>);
    } else out.push(<a key={k} href={tok} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const k = `b${i}`;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k} className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{body.join("\n")}</pre>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={k} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            {head && <thead className="bg-surface-2/60 text-left"><tr>{head.map((c, j) => <th key={j} className="px-3 py-2 font-medium">{inline(c, `${k}h${j}`)}</th>)}</tr></thead>}
            <tbody className="divide-y divide-border">{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{inline(c, `${k}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<p key={k} className={h[1]!.length <= 2 ? "text-base font-semibold" : "font-semibold"}>{inline(h[2]!, k)}</p>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={k} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>{items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `${k}-${j}`)}</Fragment>)}</p>);
  }
  return <div className="space-y-3 text-sm leading-relaxed">{blocks}</div>;
}
