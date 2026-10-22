"use client";

import { Suspense, use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Task } from "@/server/repo/scrapes";
import { draftFromTask, TaskEditor } from "@/components/task-editor";
import { Button, Card, ErrorNote, LoadingRows, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/use-api";

function EditTask({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<{ task: Task }>(`/api/tasks/${id}`);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingRows rows={6} /></Card>;
  return (
    <>
      <PageHeader title={`Edit: ${data.task.name}`} description={data.task.url} actions={<Link prefetch={false} href={`/tasks/${id}`}><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Back to task</Button></Link>} />
      <TaskEditor key={data.task.updated_at} id={id} initial={draftFromTask(data.task)} />
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><EditTask id={id} /></Suspense>;
}
