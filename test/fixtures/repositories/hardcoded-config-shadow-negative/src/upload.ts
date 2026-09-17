import { maxSizeFor } from "./settings.js";

export function checkUploadSize(kind: string, fileSizeKB: number): boolean {
  return fileSizeKB <= maxSizeFor(kind);
}
