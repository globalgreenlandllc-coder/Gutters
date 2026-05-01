"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  ChevronDown,
  LogOut,
  Search,
  Settings,
  User,
} from "lucide-react";
import { useClerk } from "@clerk/nextjs";
import { Logo } from "@/components/ui/logo";
import { Avatar } from "@/components/ui/avatar";
import { CreditsChip } from "./credits-chip";
import { useSession } from "@/lib/auth-mock";
import { cn } from "@/lib/utils";

const NAV: { href: string; label: string }[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/proposals", label: "Proposals" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useClerk();
  const { session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    await signOut();
    router.push("/");
  }

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
        <Link href="/dashboard" className="ring-focus rounded-md">
          <Logo showSubtitle={false} />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => {
            const active =
              n.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname?.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  active
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-2">
          <div className="relative hidden h-9 w-72 items-center rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-500 transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15 lg:flex">
            <Search className="mr-2 h-4 w-4 text-zinc-400" />
            <input
              type="search"
              placeholder="Search proposals, clients…"
              className="w-full bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400"
            />
            <kbd className="ml-2 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-500">
              ⌘K
            </kbd>
          </div>

          <CreditsChip />

          <button
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent-600" />
          </button>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 transition hover:border-zinc-200 hover:bg-zinc-50"
            >
              <Avatar initials={session?.user.initials ?? "?"} />
              <div className="hidden text-left sm:block">
                <div className="text-xs font-medium text-zinc-900">
                  {session?.user.name ?? "—"}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {session?.profile.company ?? ""}
                </div>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-zinc-200 bg-white p-1 shadow-elevated">
                  <MenuItem icon={User} label="Profile" href="/dashboard/settings" />
                  <MenuItem
                    icon={Settings}
                    label="Settings"
                    href="/dashboard/settings"
                  />
                  <div className="my-1 h-px bg-zinc-100" />
                  <button
                    onClick={logout}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-700 transition hover:bg-rose-50"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-100 md:hidden">
        <div className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-4 py-2">
          {NAV.map((n) => {
            const active =
              n.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname?.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  active
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50",
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </div>
      </div>
    </header>
  );
}

function MenuItem({
  icon: Icon,
  label,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-50"
    >
      <Icon className="h-4 w-4 text-zinc-500" />
      {label}
    </Link>
  );
}
