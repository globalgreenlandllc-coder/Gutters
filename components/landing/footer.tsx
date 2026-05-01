import { Logo } from "@/components/ui/logo";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-ink-950/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-zinc-500">
          <a className="hover:text-zinc-200 transition" href="#">
            Privacy
          </a>
          <a className="hover:text-zinc-200 transition" href="#">
            Terms
          </a>
          <a className="hover:text-zinc-200 transition" href="#">
            Security
          </a>
          <a className="hover:text-zinc-200 transition" href="#">
            Contact
          </a>
        </div>
        <div className="text-xs text-zinc-600">
          © {new Date().getFullYear()} Gutters AI Inc.
        </div>
      </div>
    </footer>
  );
}
