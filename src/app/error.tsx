"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="mx-auto max-w-md py-24 text-center" role="alert">
      <p className="text-sm font-semibold text-danger">Error</p>
      <h1 className="mt-2 text-2xl font-semibold">This page hit a problem</h1>
      <p className="mt-2 text-sm text-muted">Your data is safe. Try again, and if it keeps happening, check the terminal running Scaper.</p>
      {error.digest && <p className="mt-2 font-mono text-xs text-muted">Ref: {error.digest}</p>}
      <button onClick={reset} className="mt-6 inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg">Try again</button>
    </div>
  );
}
