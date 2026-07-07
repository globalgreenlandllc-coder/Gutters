import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { Logo } from "@/components/ui/logo";

export default function SignUpPage() {
  return (
    <div className="relative grid min-h-screen bg-white lg:grid-cols-2">
      <div className="relative flex flex-col justify-between p-8 sm:p-12">
        <Link href="/" className="ring-focus rounded-md self-start">
          <Logo />
        </Link>

        <div className="mx-auto flex w-full max-w-sm flex-col">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
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
                  "shadow-none border border-zinc-200 rounded-xl bg-white p-6",
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                socialButtonsBlockButton:
                  "border border-zinc-200 rounded-lg hover:bg-zinc-50",
                formFieldInput:
                  "rounded-lg border-zinc-200 focus:border-accent-500 focus:ring-accent-500/15",
                formButtonPrimary:
                  "bg-accent-600 hover:bg-accent-700 text-white rounded-lg font-medium",
                footerActionLink: "text-accent-700 hover:text-accent-800",
              },
            }}
          />
        </div>

        <div className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Gutters AI · Secured with Clerk
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-ink lg:block">
        <div
          aria-hidden
          className="hl-stripes absolute inset-y-0 right-0 w-14 opacity-90"
        />
        <div
          aria-hidden
          className="hl-stripes absolute inset-y-0 left-0 w-3 opacity-50"
        />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div>
            <div className="font-label inline-flex items-center rounded-md border border-white/25 px-2.5 py-1 text-white">
              Free for 14 days
            </div>
            <h2 className="display-hero mt-8 text-balance text-4xl text-white xl:text-5xl">
              <span className="text-stripe-blue">Quote a job</span>{" "}
              <span className="text-white">in under a minute.</span>
            </h2>
            <p className="mt-4 max-w-md text-white/70">
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
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div className="rounded-lg border border-white/15 bg-white/5 p-3">
      <div className="text-lg font-semibold tracking-tight text-white tabular-nums">
        {n}
      </div>
      <div className="text-xs text-white/70">{l}</div>
    </div>
  );
}
