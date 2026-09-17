export interface Job {
  id: string;
}

export const queue = {
  depth(): number {
    return queue._pending.length;
  },
  _pending: [] as Job[],
};

export function pendingCount(): number {
  return queue.depth();
}

export function enqueue(job: Job): void {
  queue._pending.push(job);
}
