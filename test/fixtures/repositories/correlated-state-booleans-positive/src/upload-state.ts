export interface UploadState {
  isQueued: boolean;
  isUploading: boolean;
  isComplete: boolean;
  hasFailed: boolean;
  errorMessage?: string;
}

export const initialUploadState: UploadState = {
  isQueued: true,
  isUploading: false,
  isComplete: false,
  hasFailed: false,
};
