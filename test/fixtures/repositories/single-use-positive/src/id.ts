import { v4 } from "uuid";

export function newRequestId(): string {
  return v4();
}
