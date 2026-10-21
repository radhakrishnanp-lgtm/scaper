import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";
import { ToastProvider } from "@/components/toast";
import { env } from "@/server/env";

// Rendered per request so env-based settings (like the password) are read at runtime, not baked in at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Scaper", template: "%s · Scaper" },
  description: "Scrape any page, watch websites for changes and track prices. Runs on your own computer.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f6f5f2" }, { media: "(prefers-color-scheme: dark)", color: "#0f1113" }],
};

// Applies the saved or system theme before first paint, so there is no flash.
const themeScript = `try{var t=localStorage.getItem("scaper-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ToastProvider>
          <Shell passwordProtected={Boolean(env.SCAPER_APP_PASSWORD)}>{children}</Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
