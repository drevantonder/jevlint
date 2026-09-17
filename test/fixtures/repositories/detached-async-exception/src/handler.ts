import { runJob } from "./tasks.js";

process.on("unhandledRejection", () => {});

export function handleTick(id: string) {
  runJob(id);
}
