"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

export function Nav() {
  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="fixed inset-x-0 top-0 z-50"
    >
      <div className="mx-auto mt-4 max-w-7xl px-4">
        <div className="glass-strong flex h-14 items-center justify-between rounded-2xl px-4 sm:px-5">
          <Link href="/" className="ring-focus rounded-md">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-zinc-400 md:flex">
            <a className="hover:text-white transition" href="#how">
              How it works
            </a>
            <a className="hover:text-white transition" href="#features">
              Features
            </a>
            <a className="hover:text-white transition" href="#pricing">
              Pricing
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex">
              Sign in
            </Button>
            <Button size="sm">Start free</Button>
          </div>
        </div>
      </div>
    </motion.header>
  );
}
