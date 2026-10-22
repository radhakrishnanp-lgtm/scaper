"use client";

import { useState, type ReactNode } from "react";
import type { PublicSettings } from "@/server/repo/settings";
import { useToast } from "@/components/toast";
import { Button, Card, CardHeader } from "@/components/ui";
import { api, ClientApiError, errorText } from "@/lib/api-client";

export type S = PublicSettings;
export type SettingsResponse = { settings: S; usage: { requests: number; tokens: number }; passwordProtected: boolean };

/** Saves one settings section; secrets come back masked and masked values mean "unchanged". */
export function useSection<K extends keyof S>(initial: S[K], key: K, onSaved: (s: S) => void) {
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async (extra: Record<string, unknown> = {}) => {
    setSaving(true); setErrors({});
    const body: Record<string, unknown> = { ...v, ...extra };
    for (const k of ["hasApiKey", "hasTelegramToken", "hasSmtpPass", "serviceAccountEmail"]) delete body[k];
    try {
      const res = await api<{ settings: S }>("/api/settings", { method: "PUT", body: { [key]: body } });
      setV(res.settings[key]); onSaved(res.settings);
      toast.success("Settings saved");
      return true;
    } catch (e) {
      if (e instanceof ClientApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([p, m]) => [p.replace(`${String(key)}.`, ""), m])));
      toast.error("Could not save", errorText(e));
      return false;
    } finally { setSaving(false); }
  };
  const set = (patch: Partial<S[K]>) => setV((x) => ({ ...x, ...patch }));
  return { v, set, save, saving, errors };
}

export function TestButton({ channel, label = "Send test" }: { channel: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button type="button" size="sm" variant="secondary" loading={busy} onClick={async () => {
      setBusy(true);
      try { const r = await api<{ message: string }>("/api/settings/test", { body: { channel } }); toast.success("It works", r.message); }
      catch (e) { toast.error("Test failed", errorText(e)); } finally { setBusy(false); }
    }}>{label}</Button>
  );
}

export function Panel({ title, description, icon, children, footer }: { title: string; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} description={description} />
      <div className="space-y-4 p-5">{children}</div>
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </Card>
  );
}

