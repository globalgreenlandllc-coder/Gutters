"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import {
  ChevronDown,
  CreditCard,
  Database,
  DollarSign,
  Key,
  LayoutDashboard,
  LogOut,
  Menu,
  Palette,
  ShieldAlert,
  Tag,
  Users,
  X,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MeData } from "@/app/actions/me";

const NAV: { href: string; label: string; icon: typeof LayoutDashboard }[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/financials", label: "Financials", icon: DollarSign },
  { href: "/admin/api-keys", label: "API keys", icon: Key },
  { href: "/admin/pricing", label: "Pricing", icon: Tag },
  { href: "/admin/material-defaults", label: "Material defaults", icon: Palette },
];

export function AdminShell({
  me,
  children,
}: {
  me: MeData;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useClerk();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    await signOut();
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 w-64 border-r border-zinc-200 bg-white transition-transform lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-zinc-200 px-5">
          <Link href="/admin" className="ring-focus rounded-md">
            <Logo showSubtitle={false} />
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <Badge tone="rose" className="gap-1.5">
            <ShieldAlert className="h-3 w-3" />
            Super admin
          </Badge>
          <div className="mt-2 truncate text-xs text-zinc-500">
            {me.user.email}
          </div>
        </div>

        <nav className="px-3 pb-4">
          <ul className="space-y-1">
            {NAV.map((n) => {
              const active =
                n.href === "/admin"
                  ? pathname === "/admin"
                  : pathname?.startsWith(n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                      active
                        ? "bg-zinc-900 text-white"
                        : "text-zinc-700 hover:bg-zinc-100",
                    )}
                  >
                    <n.icon
                      className={cn(
                        "h-4 w-4",
                        active ? "text-white" : "text-zinc-500",
                      )}
                    />
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="my-4 h-px bg-zinc-200" />

          <Link
            href="/dashboard"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Database className="h-4 w-4 text-zinc-500" />
            Switch to contractor view
          </Link>
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/85 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>

            <h1 className="text-sm font-medium text-zinc-700">
              Admin console · Gutters AI
            </h1>

            <div className="ml-auto flex items-center gap-2">
              <Badge tone="amber">
                <CreditCard className="h-3 w-3" />
                Production
              </Badge>

              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 transition hover:border-zinc-200 hover:bg-zinc-50"
                >
                  <Avatar
                    initials={initials(me.user.name, me.user.email)}
                  />
                  <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                </button>
                {menuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-zinc-200 bg-white p-1 shadow-elevated">
                      <div className="px-3 py-2">
                        <div className="text-sm font-medium text-zinc-900">
                          {me.user.name}
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                          {me.user.email}
                        </div>
                      </div>
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
        </header>

        <main className="px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

function initials(name: string, email: string) {
  const source = name && name.trim().length > 0 ? name : email;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}
