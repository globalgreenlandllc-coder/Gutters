"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  CalendarDays,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  LogOut,
  MapPin,
  Search,
  Settings,
  ShieldAlert,
  User,
  Users,
} from "lucide-react";
import { useClerk } from "@clerk/nextjs";
import { Logo } from "@/components/ui/logo";
import { Avatar } from "@/components/ui/avatar";
import { CreditsChip } from "./credits-chip";
import { useSession } from "@/lib/auth-mock";
import { cn } from "@/lib/utils";

type NavIcon = typeof LayoutGrid;
const NAV: { href: string; label: string; Icon: NavIcon }[] = [
  { href: "/dashboard", label: "Overview", Icon: LayoutGrid },
  { href: "/dashboard/leads", label: "Leads", Icon: MapPin },
  { href: "/dashboard/calendar", label: "Calendar", Icon: CalendarDays },
  { href: "/dashboard/blueprints", label: "Blueprints", Icon: FileSpreadsheet },
  { href: "/dashboard/proposals", label: "Proposals", Icon: FileText },
  { href: "/dashboard/clients", label: "Clients", Icon: Users },
  { href: "/dashboard/settings", label: "Settings", Icon: Settings },
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
    <header className="sticky top-0 z-40 border-b border-zinc-200/70 bg-white/80 backdrop-blur-xl supports-[backdrop-filter]:bg-white/60">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
        <Link href="/dashboard" className="ring-focus rounded-md shrink-0">
          <Logo showSubtitle={false} />
        </Link>

        <nav className="hidden items-center gap-0.5 md:flex">
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
                  "group relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition",
                  active
                    ? "text-accent-700"
                    : "text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-900",
                )}
              >
                <n.Icon
                  className={cn(
                    "h-4 w-4 transition",
                    active
                      ? "text-accent-600"
                      : "text-zinc-400 group-hover:text-zinc-600",
                  )}
                />
                {n.label}
                {active && (
                  <span className="absolute inset-x-2 -bottom-[18px] h-0.5 rounded-full bg-gradient-to-r from-accent-500 to-emerald-400" />
                )}
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
                  {session?.user.role === "SUPER_ADMIN" &&
                    !session?.impersonation && (
                      <>
                        <div className="my-1 h-px bg-zinc-100" />
                        <Link
                          href="/admin"
                          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-700 transition hover:bg-rose-50"
                        >
                          <ShieldAlert className="h-4 w-4" />
                          Admin console
                        </Link>
                      </>
                    )}
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
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition",
                  active
                    ? "bg-accent-600 text-white shadow-sm"
                    : "text-zinc-600 hover:bg-zinc-100",
                )}
              >
                <n.Icon className="h-3.5 w-3.5" />
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
