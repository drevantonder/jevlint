import { enqueue, processQueue } from "./queue";

export function boot(): void {
  enqueue("first");
  processQueue();
}
