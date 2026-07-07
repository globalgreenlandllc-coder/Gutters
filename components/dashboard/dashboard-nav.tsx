"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen,
  CalendarDays,
  ChevronsUpDown,
  FileSpreadsheet,
  FileText,
  HardHat,
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
import { NotificationsBell } from "./notifications-bell";
import { useSession } from "@/lib/auth-mock";
import { cn } from "@/lib/utils";

type NavIcon = typeof LayoutGrid;
const NAV: { href: string; label: string; Icon: NavIcon }[] = [
  { href: "/dashboard", label: "Overview", Icon: LayoutGrid },
  { href: "/dashboard/leads", label: "Leads", Icon: MapPin },
  { href: "/dashboard/calendar", label: "Calendar", Icon: CalendarDays },
  { href: "/dashboard/blueprints", label: "Blueprints", Icon: FileSpreadsheet },
  { href: "/dashboard/proposals", label: "Proposals", Icon: FileText },
  { href: "/dashboard/workers", label: "Workers", Icon: HardHat },
  { href: "/dashboard/clients", label: "Clients", Icon: Users },
];

function isActive(pathname: string | null, href: string) {
  return href === "/dashboard"
    ? pathname === "/dashboard"
    : Boolean(pathname?.startsWith(href));
}

function NavItem({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: NavIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition",
        active
          ? "bg-zinc-100 font-medium text-zinc-900"
          : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900",
      )}
    >
      {active && (
        <span className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-orange-400 to-rose-500" />
      )}
      <Icon
        className={cn(
          "h-4 w-4 transition",
          active ? "text-zinc-900" : "text-zinc-400 group-hover:text-zinc-600",
        )}
      />
      {label}
    </Link>
  );
}

function AccountMenu({ align = "up" }: { align?: "up" | "down" }) {
  const router = useRouter();
  const { signOut } = useClerk();
  const { session } = useSession();
  const [open, setOpen] = useState(false);

  async function logout() {
    await signOut();
    router.push("/");
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-zinc-200 hover:bg-zinc-50"
      >
        <Avatar initials={session?.user.initials ?? "?"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-zinc-900">
            {session?.user.name ?? "—"}
          </div>
          <div className="truncate text-[11px] text-zinc-500">
            {session?.profile.company ?? ""}
          </div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={cn(
              "absolute z-20 w-56 rounded-xl border border-zinc-200 bg-white p-1 shadow-elevated",
              align === "up"
                ? "bottom-full left-0 mb-2"
                : "right-0 top-full mt-2",
            )}
          >
            <MenuItem icon={User} label="Profile" href="/dashboard/settings" />
            <MenuItem
              icon={Settings}
              label="Settings"
              href="/dashboard/settings"
            />
            {session?.user.role === "SUPER_ADMIN" && !session?.impersonation && (
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
  );
}

/**
 * Hyperline-style app shell: fixed white sidebar on the left (logo, nav,
 * documentation/settings, account block) + a bordered page header on top of
 * the scrolling content column.
 *
 * Pages render everything inside <DashboardShell title="…" actions={…}>.
 * `fullBleed` drops the padded max-width container (maps, canvases).
 */
export function DashboardShell({
  title,
  actions,
  children,
  fullBleed = false,
  contentClassName,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  fullBleed?: boolean;
  contentClassName?: string;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-white">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-zinc-200 bg-white lg:flex">
        <div className="flex h-16 shrink-0 items-center px-5">
          <Link href="/dashboard" className="ring-focus rounded-md">
            <Logo showSubtitle={false} />
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pt-2">
          {NAV.map((n) => (
            <NavItem key={n.href} {...n} active={isActive(pathname, n.href)} />
          ))}
        </nav>
        <div className="space-y-0.5 border-t border-zinc-100 px-3 py-3">
          <NavItem href="#" label="Documentation" Icon={BookOpen} active={false} />
          <NavItem
            href="/dashboard/settings"
            label="Settings"
            Icon={Settings}
            active={isActive(pathname, "/dashboard/settings")}
          />
          <div className="pt-2">
            <AccountMenu align="up" />
          </div>
        </div>
      </aside>

      {/* Content column */}
      <div className="flex min-h-screen flex-col lg:pl-60">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 border-b border-zinc-200 bg-white lg:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <Link href="/dashboard">
              <Logo showSubtitle={false} />
            </Link>
            <div className="flex items-center gap-2">
              <CreditsChip />
              <AccountMenu align="down" />
            </div>
          </div>
          <div className="flex gap-1 overflow-x-auto px-3 pb-2">
            {NAV.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-zinc-100 text-zinc-900"
                      : "text-zinc-500 hover:bg-zinc-50",
                  )}
                >
                  <n.Icon className="h-3.5 w-3.5" />
                  {n.label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Page header (desktop) */}
        <header className="sticky top-0 z-30 hidden border-b border-zinc-200 bg-white lg:block">
          <div className="flex h-16 items-center gap-3 px-6">
            <h1 className="text-[22px] font-semibold tracking-tight text-zinc-900">
              {title}
            </h1>
            <div className="flex flex-1 items-center justify-end gap-2">
              <div className="relative hidden h-9 w-64 items-center rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-500 transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15 xl:flex">
                <Search className="mr-2 h-4 w-4 text-zinc-400" />
                <input
                  type="search"
                  placeholder="Search proposals, clients…"
                  className="w-full bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400"
                />
                <kbd className="ml-2 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                  ⌘K
                </kbd>
              </div>
              <CreditsChip />
              <NotificationsBell />
              {actions}
            </div>
          </div>
        </header>

        {/* Mobile page title + actions */}
        {(title || actions) && (
          <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 lg:hidden">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              {title}
            </h1>
            <div className="flex items-center gap-2">{actions}</div>
          </div>
        )}

        {fullBleed ? (
          <div className={cn("flex-1", contentClassName)}>{children}</div>
        ) : (
          <main
            className={cn(
              "mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6",
              contentClassName,
            )}
          >
            {children}
          </main>
        )}
      </div>
    </div>
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
