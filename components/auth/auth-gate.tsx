"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useSession } from "@/lib/auth-mock";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/sign-in?next=${next}`);
    }
  }, [session, loading, pathname, router]);

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  return <>{children}</>;
}
