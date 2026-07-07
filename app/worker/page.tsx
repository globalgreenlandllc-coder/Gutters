import { requireWorker } from "@/lib/worker";
import { listMyJobs } from "@/app/actions/worker-jobs";
import { WorkerJobsClient } from "@/components/worker/worker-jobs-client";

export default async function WorkerJobsPage() {
  await requireWorker();
  const jobs = await listMyJobs();
  return <WorkerJobsClient initialJobs={jobs} />;
}
