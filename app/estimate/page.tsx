"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoadingState } from "@/components/estimate/loading-state";
import { ResultsView } from "@/components/estimate/results-view";
import { SAMPLE_ADDRESS } from "@/lib/mock-estimate";

function EstimateContent() {
  const params = useSearchParams();
  const address = params.get("address") || SAMPLE_ADDRESS;
  const [phase, setPhase] = useState<"loading" | "ready">("loading");

  useEffect(() => {
    setPhase("loading");
  }, [address]);

  if (phase === "loading") {
    return (
      <LoadingState address={address} onComplete={() => setPhase("ready")} />
    );
  }
  return <ResultsView address={address} />;
}

export default function EstimatePage() {
  return (
    <Suspense
      fallback={<LoadingState address="…" onComplete={() => undefined} />}
    >
      <EstimateContent />
    </Suspense>
  );
}
