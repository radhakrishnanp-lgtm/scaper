"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { Button, Card, Field, Input } from "@/components/ui";
import { api, errorText } from "@/lib/api-client";

function LoginForm() {
  const next = useSearchParams().get("next");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/api/auth/login", { body: { password } });
          // Only same-site paths, never an external redirect.
          window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        } catch (err) {
          setError(errorText(err));
          setBusy(false);
        }
      }}
      className="space-y-4 p-6"
    >
      <Field label="Password" error={error ?? undefined}>
        {(p) => <Input {...p} type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Button type="submit" className="w-full" loading={busy} disabled={!password}>Log in</Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 border-b border-border p-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><Lock className="size-5" /></span>
          <h1 className="text-lg font-semibold">Log in to Scaper</h1>
          <p className="text-sm text-muted">This Scaper is protected with a password.</p>
        </div>
        <Suspense><LoginForm /></Suspense>
      </Card>
    </div>
  );
}
