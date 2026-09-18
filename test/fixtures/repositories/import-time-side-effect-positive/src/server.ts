import { createServer } from "node:http";
import { collectMetrics } from "./metrics.js";

const server = createServer((req, res) => {
  res.end("ok");
});
server.listen(3000);
setInterval(collectMetrics, 60_000);
await connectDatabase();

export async function connectDatabase() {
}
