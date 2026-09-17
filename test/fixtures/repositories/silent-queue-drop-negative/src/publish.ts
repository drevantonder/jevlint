import { queue } from "./queue.js";

const highWaterMark = 1000;

queue.on("drain", () => {
  resumeIntake();
});

function resumeIntake(): void {}
function recordDropped(body: string): void {
  void body;
}

export function handleRequest(body: string): string {
  if (body.length > highWaterMark) {
    recordDropped(body);
    return "shed";
  }
  const accepted = queue.publish(body);
  if (!accepted) {
    recordDropped(body);
    return "queued";
  }
  return "accepted";
}
