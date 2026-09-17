import type { UploadState } from "./upload-state.js";

export function startUpload(state: UploadState): UploadState {
  return {
    ...state,
    isQueued: false,
    isUploading: true,
    isComplete: false,
    hasFailed: false,
  };
}

export function finishUpload(state: UploadState): UploadState {
  return {
    ...state,
    isUploading: false,
    isComplete: true,
  };
}

export function uploadStatus(state: UploadState): string {
  if (state.hasFailed) return state.errorMessage ?? "Upload failed";
  if (state.isComplete) return "Complete";
  if (state.isUploading) return "Uploading";
  if (state.isQueued) return "Queued";
  return "Unknown";
}
