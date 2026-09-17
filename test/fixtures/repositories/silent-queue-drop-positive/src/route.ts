import { handleRequest } from "./publish.js";

export function route(body: string): string {
  return handleRequest(body);
}
