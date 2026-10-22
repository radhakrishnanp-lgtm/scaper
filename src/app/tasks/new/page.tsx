"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, FilePlus2 } from "lucide-react";
import { TaskEditor, type TaskDraft } from "@/components/task-editor";
import { TEMPLATES, templateOptions } from "@/components/task-bits";
import { Button, Card, PageHeader } from "@/components/ui";
import { defaultTaskOptions } from "@/lib/schemas";
import { hostOf } from "@/lib/format";

function NewTask() {
  const params = useSearchParams();
  const templateId = params.get("template");
  const url = params.get("url") ?? "";
  const template = TEMPLATES.find((t) => t.id === templateId);

  if (!templateId && !url) {
    return (
      <>
        <PageHeader title="New task" description="Start from a template or a blank task. Everything stays editable." actions={<Link href="/tasks"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Tasks</Button></Link>} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Link href="/tasks/new?template=blank" className="group">
            <Card className="h-full p-5 transition-colors group-hover:border-accent">
              <p className="flex items-center gap-2 font-medium"><FilePlus2 className="size-4 text-accent" />Blank task</p>
              <p className="mt-1 text-sm text-muted">One URL and Auto extraction. Add pages, fields and alerts as you go.</p>
            </Card>
          </Link>
          {TEMPLATES.map((t) => (
            <Link key={t.id} href={`/tasks/new?template=${t.id}`} className="group">
              <Card className="h-full p-5 transition-colors group-hover:border-accent">
                <p className="flex items-center gap-2 font-medium">{t.icon}{t.title}</p>
                <p className="mt-1 text-sm text-muted">{t.description}</p>
              </Card>
            </Link>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted">Just want data from one page right now? Use <Link href="/scrape" className="font-medium text-accent hover:underline">Quick scrape</Link> and save it as a task later.</p>
      </>
    );
  }

  const initial: TaskDraft = {
    name: url ? hostOf(url) : template ? template.title : "",
    description: "",
    url,
    mode: template?.mode ?? "browser",
    extract: template?.extract ? (template.extract.type === "selectors" ? { ...template.extract, itemSelector: template.extract.itemSelector ?? "" } : template.extract) : { type: "auto" },
    options: template ? templateOptions(template) : defaultTaskOptions(),
    tags: [],
    schedule: template?.scheduleMinutes ? { kind: "interval", minutes: template.scheduleMinutes, cron: "0 9 * * *" } : { kind: "off", minutes: 360, cron: "0 9 * * *" },
    startUrlsText: "",
  };

  return (
    <>
      <PageHeader title={template ? `New task: ${template.title}` : "New task"} description={template?.description ?? "Set the start page and what to extract. Test it, then save."}
        actions={<Link href="/tasks/new"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Templates</Button></Link>} />
      <TaskEditor key={templateId ?? url} initial={initial} />
    </>
  );
}

export default function Page() {
  return <Suspense><NewTask /></Suspense>;
}
