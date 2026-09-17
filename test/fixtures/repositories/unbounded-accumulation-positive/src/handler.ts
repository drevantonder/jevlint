import { trackRequest } from "./seen-urls.js";

export function handle(url: string): number {
  return trackRequest(url);
}
