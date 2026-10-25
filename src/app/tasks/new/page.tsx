"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, FilePlus2, Puzzle } from "lucide-react";
import { actorPage, APIFY_TEMPLATES } from "@/components/apify-source";
import { TaskEditor, type TaskDraft } from "@/components/task-editor";
import { TEMPLATES, templateOptions } from "@/components/task-bits";
import { Button, Card, PageHeader } from "@/components/ui";
import { defaultTaskOptions } from "@/lib/schemas";
import { hostOf } from "@/lib/format";

function NewTask() {
  const params = useSearchParams();
  const templateId = params.get("template");
  const url = params.get("url") ?? "";
  const apifyId = params.get("apify");
  const template = TEMPLATES.find((t) => t.id === templateId);
  const apifyTemplate = apifyId ? APIFY_TEMPLATES.find((t) => t.actorId === apifyId) ?? APIFY_TEMPLATES[0]! : null;

  if (!templateId && !url && !apifyId) {
    return (
      <>
        <PageHeader title="New task" description="Start from a template or a blank task. Everything stays editable." actions={<Link prefetch={false} href="/tasks"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Tasks</Button></Link>} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Link prefetch={false} href="/tasks/new?template=blank" className="group">
            <Card className="h-full p-5 transition-colors group-hover:border-accent">
              <p className="flex items-center gap-2 font-medium"><FilePlus2 className="size-4 text-accent" />Blank task</p>
              <p className="mt-1 text-sm text-muted">One URL and Auto extraction. Add pages, fields and alerts as you go.</p>
            </Card>
          </Link>
          <Link prefetch={false} href="/tasks/new?apify=1" className="group">
            <Card className="h-full p-5 transition-colors group-hover:border-accent">
              <p className="flex items-center gap-2 font-medium"><Puzzle className="size-4 text-accent" />Social media and more (Apify)</p>
              <p className="mt-1 text-sm text-muted">Trending YouTube, Instagram, TikTok and X posts, or Google Maps places, from an Apify actor on your account.</p>
            </Card>
          </Link>
          {TEMPLATES.map((t) => (
            <Link prefetch={false} key={t.id} href={`/tasks/new?template=${t.id}`} className="group">
              <Card className="h-full p-5 transition-colors group-hover:border-accent">
                <p className="flex items-center gap-2 font-medium">{t.icon}{t.title}</p>
                <p className="mt-1 text-sm text-muted">{t.description}</p>
              </Card>
            </Link>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted">Just want data from one page right now? Use <Link prefetch={false} href="/scrape" className="font-medium text-accent hover:underline">Quick scrape</Link> and save it as a task later.</p>
      </>
    );
  }

  // From Integrations → Apify (?apify=actor-id) or the Apify card (?apify=1): an actor source, prefilled.
  const custom = apifyId && apifyId !== "1" && !APIFY_TEMPLATES.some((t) => t.actorId === apifyId) ? apifyId : null;
  const apifyOptions = apifyTemplate ? {
    ...defaultTaskOptions(),
    source: { type: "apify" as const, actorId: custom ?? apifyTemplate.actorId, input: custom ? {} : apifyTemplate.input, maxItems: 50, timeoutSeconds: 900, maxChargeUsd: 1 },
    dedupeBy: custom ? [] : apifyTemplate.keyFields,
    monitor: { ...defaultTaskOptions().monitor, keyFields: custom ? [] : apifyTemplate.keyFields },
  } : null;
  const initial: TaskDraft = {
    name: apifyTemplate ? (custom ? custom.split("~")[1] ?? custom : apifyTemplate.name) : url ? hostOf(url) : template ? template.title : "",
    description: "",
    url: apifyTemplate ? actorPage(custom ?? apifyTemplate.actorId) : url,
    mode: template?.mode ?? "browser",
    extract: template?.extract ? (template.extract.type === "selectors" ? { ...template.extract, itemSelector: template.extract.itemSelector ?? "" } : template.extract) : { type: "auto" },
    options: apifyOptions ?? (template ? templateOptions(template) : defaultTaskOptions()),
    tags: [],
    schedule: template?.scheduleMinutes ? { kind: "interval", minutes: template.scheduleMinutes, cron: "0 9 * * *" } : { kind: "off", minutes: 360, cron: "0 9 * * *" },
    startUrlsText: "",
  };

  return (
    <>
      <PageHeader title={template ? `New task: ${template.title}` : "New task"} description={template?.description ?? "Set the start page and what to extract. Test it, then save."}
        actions={<Link prefetch={false} href="/tasks/new"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Templates</Button></Link>} />
      <TaskEditor key={templateId ?? apifyId ?? url} initial={initial} />
    </>
  );
}

export default function Page() {
  return <Suspense><NewTask /></Suspense>;
}
