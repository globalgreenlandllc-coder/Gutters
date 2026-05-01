"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-mock";

export function Nav() {
  const { session } = useSession();
  return (
    <motion.header
      initial={{ y: -16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-x-0 top-0 z-50"
    >
      <div className="mx-auto mt-4 max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between rounded-2xl border border-zinc-200/80 bg-white/85 px-4 shadow-sm backdrop-blur-xl sm:px-5">
          <Link href="/" className="ring-focus rounded-md">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-zinc-600 md:flex">
            <a className="transition hover:text-zinc-900" href="#how">
              How it works
            </a>
            <a className="transition hover:text-zinc-900" href="#features">
              Features
            </a>
            <a className="transition hover:text-zinc-900" href="#pricing">
              Pricing
            </a>
          </nav>
          <div className="flex items-center gap-2">
            {session ? (
              <Link href="/dashboard">
                <Button size="sm">
                  Open dashboard
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <>
                <Link href="/sign-in">
                  <Button variant="ghost" size="sm">
                    Sign in
                  </Button>
                </Link>
                <Link href="/sign-in">
                  <Button size="sm">Start free</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </motion.header>
  );
}
