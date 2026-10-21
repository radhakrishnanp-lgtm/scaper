"use client";

import { useState } from "react";
import Link from "next/link";
import { History as HistoryIcon } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";
import { hostOf, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type RunRow = { id: string; url: string; mode: string; status: "ok" | "error" | "blocked"; extract: { type: string }; row_count: number; error: string | null; duration_ms: number; created_at: string };
type Page = { items: RunRow[]; nextCursor: string | null };

export default function HistoryPage() {
  const { data, error, loading, reload, setData } = useApi<Page>("/api/runs?limit=30");
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const loadMore = async () => {
    if (!data?.nextCursor) return;
    setMore(true);
    try {
      const next = await api<Page>(`/api/runs?limit=30&before=${encodeURIComponent(data.nextCursor)}`);
      setData({ items: [...data.items, ...next.items], nextCursor: next.nextCursor });
    } catch (e) { setMoreError(errorText(e)); } finally { setMore(false); }
  };

  return (
    <>
      <PageHeader title="History" description="Every scrape you ran. Scaper keeps the latest 500." />
      <Card>
        {error ? <ErrorNote message={error} onRetry={reload} /> : loading && !data ? <LoadingRows /> : !data?.items.length ? (
          <EmptyState icon={<HistoryIcon className="size-5" />} title="No scrapes yet" action={<Link href="/scrape" className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg">Scrape a page</Link>}>Results you scrape are saved here so you can open or export them later.</EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {data.items.map((r) => (
                <li key={r.id}>
                  <Link href={`/history/${r.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2/50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{hostOf(r.url)}<span className="font-normal text-muted"> {new URL(r.url).pathname.slice(0, 60)}</span></p>
                      <p className="mt-0.5 truncate text-xs text-muted">{r.status === "ok" ? `${r.row_count} rows` : r.error} · {r.extract.type} · {r.mode} · {(r.duration_ms / 1000).toFixed(1)}s</p>
                    </div>
                    <Badge tone={r.status === "ok" ? "success" : r.status === "blocked" ? "warning" : "danger"}>{r.status}</Badge>
                    <span className="hidden w-20 text-right text-xs text-muted sm:block">{timeAgo(r.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {moreError && <ErrorNote message={moreError} onRetry={loadMore} />}
            {data.nextCursor && <div className="border-t border-border p-3 text-center"><Button variant="ghost" loading={more} onClick={loadMore}>Load more</Button></div>}
          </>
        )}
      </Card>
    </>
  );
}
