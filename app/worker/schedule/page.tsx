import { requireWorker } from "@/lib/worker";
import { listMyJobs } from "@/app/actions/worker-jobs";
import { WorkerSchedule } from "@/components/worker/worker-schedule";

export default async function WorkerSchedulePage() {
  await requireWorker();
  const jobs = await listMyJobs();
  return <WorkerSchedule jobs={jobs} />;
}
