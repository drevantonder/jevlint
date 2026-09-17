export interface Job {
  id: string;
  phase: string;
}

export function isInProgress(job: Job): boolean {
  return job.phase === "queued" || job.phase === "running";
}
