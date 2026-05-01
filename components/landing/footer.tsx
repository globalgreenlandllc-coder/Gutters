import { Logo } from "@/components/ui/logo";

export function Footer() {
  return (
    <footer className="border-t border-zinc-200 bg-white/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-zinc-600">
          <a className="transition hover:text-zinc-900" href="#">
            Privacy
          </a>
          <a className="transition hover:text-zinc-900" href="#">
            Terms
          </a>
          <a className="transition hover:text-zinc-900" href="#">
            Security
          </a>
          <a className="transition hover:text-zinc-900" href="#">
            Contact
          </a>
        </div>
        <div className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Gutters AI Inc.
        </div>
      </div>
    </footer>
  );
}
