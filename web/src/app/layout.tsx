import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "HomePilot", template: "%s · HomePilot" },
  description: "A personal assistant you text: tasks, reminders, spending, and what the assistant itself costs to run.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
      <body className="min-h-dvh font-sans">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-6">
          <header className="flex flex-wrap items-center justify-between gap-3 py-5">
            <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-ink text-[13px] font-bold text-page">
                H
              </span>
              HomePilot
            </Link>
            <Nav />
          </header>
          <main id="main" className="flex-1 pb-16">
            {children}
          </main>
          <footer className="border-t border-line py-6 text-xs text-ink-3">
            HomePilot runs on a Mac mini at home. This dashboard reads its local API; nothing here is stored in the browser.
          </footer>
        </div>
      </body>
    </html>
  );
}
