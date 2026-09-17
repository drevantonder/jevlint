import { checkUploadSize } from "./upload.js";
import { maxSizeFor } from "./settings.js";

export function handleUpload(kind: string, fileSizeKB: number): boolean {
  void maxSizeFor(kind);
  return checkUploadSize(fileSizeKB);
}
