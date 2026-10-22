"use client";

import { Suspense, use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { draftFromWatcher, WatcherEditor } from "@/components/watcher-editor";
import type { WatcherView } from "@/components/watcher-bits";
import { Button, Card, ErrorNote, LoadingRows, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/use-api";

function EditWatcher({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<{ watcher: WatcherView }>(`/api/watchers/${id}`);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  return (
    <>
      <PageHeader title={`Edit: ${data.watcher.name}`} description={data.watcher.url}
        actions={<Link prefetch={false} href={`/watchers/${id}`}><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Back to watcher</Button></Link>} />
      <WatcherEditor key={data.watcher.updated_at} id={id} initial={draftFromWatcher(data.watcher)} />
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><EditWatcher id={id} /></Suspense>;
}
