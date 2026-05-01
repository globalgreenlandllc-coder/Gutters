import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";
import { Logo } from "@/components/ui/logo";

export default function SignUpPage() {
  return (
    <div className="relative grid min-h-screen lg:grid-cols-2">
      <div className="relative flex flex-col justify-between p-8 sm:p-12">
        <Link href="/" className="ring-focus rounded-md self-start">
          <Logo />
        </Link>

        <div className="mx-auto flex w-full max-w-sm flex-col">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900">
            Create your account
          </h1>
          <p className="mt-2 mb-6 text-zinc-600">
            Start free with 12 AI estimates a month. No card required.
          </p>

          <SignUp
            routing="path"
            path="/sign-up"
            signInUrl="/sign-in"
            fallbackRedirectUrl="/dashboard"
            appearance={{
              elements: {
                rootBox: "w-full",
                card:
                  "shadow-none border border-zinc-200 rounded-2xl bg-white p-6",
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                socialButtonsBlockButton:
                  "border border-zinc-200 rounded-xl hover:bg-zinc-50",
                formFieldInput:
                  "rounded-xl border-zinc-200 focus:border-accent-500 focus:ring-accent-500/15",
                formButtonPrimary:
                  "bg-accent-600 hover:bg-accent-700 text-white rounded-xl shadow-glow font-medium",
                footerActionLink: "text-accent-700 hover:text-accent-800",
              },
            }}
          />
        </div>

        <div className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Gutters AI · Secured with Clerk
        </div>
      </div>

      <div className="relative hidden lg:block">
        <div className="absolute inset-6 overflow-hidden rounded-3xl border border-zinc-200 bg-gradient-to-br from-accent-50 via-white to-sky-50 shadow-elevated">
          <div className="absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]" />
          <div className="relative flex h-full flex-col justify-between p-10">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-200 bg-white/80 px-3 py-1 text-xs font-medium text-accent-700 shadow-sm backdrop-blur">
                <Sparkles className="h-3 w-3" />
                Free for 14 days
              </div>
              <h2 className="font-display mt-6 text-balance text-3xl font-semibold leading-tight tracking-tight text-zinc-900 sm:text-4xl">
                Quote a job in{" "}
                <span className="text-gradient">under a minute.</span>
              </h2>
              <p className="mt-3 max-w-md text-zinc-600">
                12 AI takeoffs included every month, $5 each after that. Re-run
                the same address up to 10× in 24h — free.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat n="$50/mo" l="12 estimates included" />
              <Stat n="$5" l="per extra address" />
              <Stat n="10× / 24h" l="free re-runs" />
              <Stat n="Cancel" l="anytime" />
            </div>
          </div>
        </div>
      </div>
    </div>
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
