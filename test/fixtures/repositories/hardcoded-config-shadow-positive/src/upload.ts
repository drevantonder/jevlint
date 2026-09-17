export function checkUploadSize(fileSizeKB: number): boolean {
  const maxSizeKB = 10 * 1024;
  return fileSizeKB <= maxSizeKB;
}
