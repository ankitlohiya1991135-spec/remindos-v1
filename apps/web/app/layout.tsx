import type { Metadata } from "next";
import { ClerkProvider, Show } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import Image from "next/image";
import localFont from "next/font/local";
import { DM_Sans } from "next/font/google";
import { InstallAppBanner } from "../components/pwa/install-app-banner";
import { RegisterServiceWorker } from "../components/pwa/register-sw";
import { OpenRemindersButton } from "../components/dashboard/open-reminders-button";
import { AppDrawer } from "../components/layout/app-drawer";
import { DrawerTrigger } from "../components/layout/drawer-trigger";
import { ThemeProvider } from "../components/theme/theme-provider";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" });

export const metadata: Metadata = {
  title: "Personal Life OS",
  description: "Manage tasks and reminders with Clerk authentication.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/logo-remindos.svg",
    apple: "/logo-remindos.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await currentUser();
  const raw = user?.firstName?.trim();
  const firstDisplay =
    raw && raw.length > 0 ? `${raw[0]!.toUpperCase()}${raw.slice(1)}` : null;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${dmSans.variable}`}>
        <ClerkProvider>
          <ThemeProvider>
            <header className="sticky top-0 z-40 shrink-0 border-b border-slate-200/80 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
              <div className="mx-auto flex h-16 w-full max-w-[88rem] items-center justify-between gap-3 px-3 sm:px-6 lg:px-10">
                <Link
                  href="/"
                  className="flex min-w-0 flex-1 items-center gap-3 text-slate-900 dark:text-slate-100"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#7c3aed_0%,#06b6d4_100%)] shadow-[0_12px_30px_-18px_rgba(124,58,237,0.9)]">
                    <Image src="/logo-remindos.svg" alt="RemindOS logo" width={20} height={20} />
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight sm:flex-row sm:items-baseline sm:gap-2">
                    <span className="truncate text-sm font-semibold tracking-tight sm:text-base">RemindOS</span>
                    {firstDisplay ? (
                      <span className="hidden truncate text-xs font-medium text-slate-500 dark:text-slate-400 sm:inline">
                        {firstDisplay}
                      </span>
                    ) : (
                      <span className="hidden text-xs font-medium text-slate-500 dark:text-slate-400 sm:inline">
                        Personal Life OS
                      </span>
                    )}
                  </span>
                </Link>
                <div className="flex shrink-0 items-center gap-2">
                  <Show when="signed-out">
                    <Link
                      href="/sign-in"
                      data-testid="header-sign-in"
                      className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/sign-up"
                      data-testid="header-sign-up"
                      className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
                    >
                      Get started
                    </Link>
                  </Show>
                  <Show when="signed-in">
                    <OpenRemindersButton />
                    <DrawerTrigger />
                  </Show>
                </div>
              </div>
            </header>
            {children}
            <AppDrawer />
            <InstallAppBanner />
            <RegisterServiceWorker />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
