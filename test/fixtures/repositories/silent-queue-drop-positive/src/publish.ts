import { queue } from "./queue.js";

export function handleRequest(body: string): string {
  queue.publish(body);
  return "accepted";
}
