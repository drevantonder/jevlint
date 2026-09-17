import { EventEmitter } from "node:events";

export const bus = new EventEmitter();

let pending: string[] = [];

export function enqueue(item: string): void {
  pending.push(item);
}

export function processQueue(): string[] {
  const batch = pending;
  pending = [];
  return batch;
}

bus.on("drain", processQueue);
