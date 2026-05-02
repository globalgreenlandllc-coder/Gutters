"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowRight, Lock, Mail, Sparkles } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { GoogleButton } from "@/components/auth/google-button";
import { signIn } from "@/lib/auth-mock";

function SignInInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("alex@riveragutters.com");
  const [password, setPassword] = useState("••••••••••");
  const [busy, setBusy] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    signIn(email);
    setTimeout(() => router.push(next), 300);
  }

  function demo() {
    setBusy(true);
    signIn();
    setTimeout(() => router.push(next), 250);
  }

  function viaGoogle(emailFromGoogle: string) {
    signIn(emailFromGoogle, { provider: "google" });
    setTimeout(() => router.push(next), 200);
  }

  return (
    <div className="relative grid min-h-screen lg:grid-cols-2">
      <div className="relative flex flex-col justify-between p-8 sm:p-12">
        <Link href="/" className="ring-focus rounded-md self-start">
          <Logo />
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mx-auto w-full max-w-sm"
        >
          <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900">
            Welcome back
          </h1>
          <p className="mt-2 text-zinc-600">
            Sign in to continue to your contractor dashboard.
          </p>

          <div className="mt-6">
            <GoogleButton onSuccess={viaGoogle} />
          </div>

          <div className="my-5 flex items-center gap-3 text-xs text-zinc-400">
            <div className="h-px flex-1 bg-zinc-200" />
            or sign in with email
            <div className="h-px flex-1 bg-zinc-200" />
          </div>

          <form onSubmit={submit} className="space-y-3">
            <Field
              label="Work email"
              icon={Mail}
              type="email"
              value={email}
              onChange={setEmail}
              autoFocus
            />
            <Field
              label="Password"
              icon={Lock}
              type="password"
              value={password}
              onChange={setPassword}
            />
            <Button type="submit" className="w-full" disabled={busy}>
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <button
            type="button"
            onClick={demo}
            disabled={busy}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-medium text-zinc-500 transition hover:text-accent-700"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Or skip and use the demo account
          </button>

          <p className="mt-6 text-center text-sm text-zinc-500">
            New here?{" "}
            <Link
              href="/sign-up"
              className="font-medium text-accent-700 hover:text-accent-800"
            >
              Create an account
            </Link>
          </p>
        </motion.div>

        <div className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Gutters AI · No real account needed for the demo
        </div>
      </div>

      <div className="relative hidden lg:block">
        <div className="absolute inset-6 overflow-hidden rounded-3xl border border-zinc-200 bg-gradient-to-br from-accent-50 via-white to-sky-50 shadow-elevated">
          <div className="absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]" />
          <div className="relative flex h-full flex-col justify-between p-10">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-200 bg-white/80 px-3 py-1 text-xs font-medium text-accent-700 shadow-sm backdrop-blur">
                <Sparkles className="h-3 w-3" />
                Built for gutter contractors
              </div>
              <h2 className="font-display mt-6 text-balance text-3xl font-semibold leading-tight tracking-tight text-zinc-900 sm:text-4xl">
                Address-to-accepted in{" "}
                <span className="text-gradient">under a minute.</span>
              </h2>
              <p className="mt-3 max-w-md text-zinc-600">
                AI measures the roof, packages a proposal, and collects the
                deposit — all from your truck.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Stat n="148 LF" l="auto-measured eaves" />
              <Stat n="3 packages" l="Good · Better · Best" />
              <Stat n="±2%" l="vs ground truth" />
              <Stat n="1-click" l="accept & pay" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  icon: Icon,
  type,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="flex h-11 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15">
        <Icon className="h-4 w-4 text-zinc-400" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          className="w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
        />
      </div>
    </label>
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white/70 p-3 backdrop-blur">
      <div className="font-display text-lg font-semibold text-zinc-900">
        {n}
      </div>
      <div className="text-xs text-zinc-500">{l}</div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="p-8 text-zinc-500">Loading…</div>}>
      <SignInInner />
    </Suspense>
  );
}
