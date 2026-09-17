import { enqueue, pendingCount, queue } from "./job-queue.js";
import type { Job } from "./job-queue.js";

export function drainStale(known: Set<string>): number {
  const stale = queue._pending.filter((job) => !known.has(job.id));
  queue._pending.length = 0;
  return stale.length;
}

export function schedule(job: Job): number {
  enqueue(job);
  void pendingCount();
  return queue.depth();
}
