"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { blankWatcher, WatcherEditor } from "@/components/watcher-editor";
import { TARGETS } from "@/components/watcher-bits";
import { Button, PageHeader } from "@/components/ui";
import type { WatchTarget } from "@/lib/schemas";

function NewWatcher() {
  const params = useSearchParams();
  const type = params.get("type");
  const target = (TARGETS.some((t) => t.type === type) ? type : "page") as WatchTarget["type"];
  const initial = blankWatcher(params.get("url") ?? "", params.get("name") ?? "", target);
  return (
    <>
      <PageHeader title="New watcher" description="Scaper checks the page on a schedule and alerts you when your rules match."
        actions={<Link prefetch={false} href="/watchers"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Watchers</Button></Link>} />
      <WatcherEditor key={params.toString()} initial={initial} />
    </>
  );
}

export default function Page() {
  return <Suspense><NewWatcher /></Suspense>;
}
