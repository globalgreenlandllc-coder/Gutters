import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { Logo } from "@/components/ui/logo";

export default function SignInPage() {
  return (
    <div className="relative grid min-h-screen bg-white lg:grid-cols-2">
      <div className="relative flex flex-col justify-between p-8 sm:p-12">
        <Link href="/" className="ring-focus rounded-md self-start">
          <Logo />
        </Link>

        <div className="mx-auto flex w-full max-w-sm flex-col">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
            Welcome back
          </h1>
          <p className="mt-2 mb-6 text-zinc-600">
            Sign in to continue to your contractor dashboard.
          </p>

          <SignIn
            routing="path"
            path="/sign-in"
            signUpUrl="/sign-up"
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
                identityPreviewEditButton: "text-accent-700",
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
              Built for gutter contractors
            </div>
            <h2 className="display-hero mt-8 text-balance text-4xl text-white xl:text-5xl">
              <span className="text-stripe-blue">Address-to-accepted</span>{" "}
              <span className="text-white">in under a minute.</span>
            </h2>
            <p className="mt-4 max-w-md text-white/70">
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
