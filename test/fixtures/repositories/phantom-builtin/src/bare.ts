import { join } from "path";

export function locateBare(name: string): string {
  return join("etc", name);
}
