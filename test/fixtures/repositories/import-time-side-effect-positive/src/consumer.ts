import { connectDatabase } from "./server.js";

export function ping(): string {
  void connectDatabase;
  return "pong";
}
