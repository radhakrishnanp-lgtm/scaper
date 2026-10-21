import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-sm font-semibold text-accent">404</p>
      <h1 className="mt-2 text-2xl font-semibold">This page doesn&apos;t exist</h1>
      <p className="mt-2 text-sm text-muted">The link may be old, or the item was deleted.</p>
      <Link href="/" className="mt-6 inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg">Back to dashboard</Link>
    </div>
  );
}
