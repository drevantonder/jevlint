export interface ExportJob {
  fetchBatch: string;
  updatePayload: Record<string, string>;
  saveChanges: () => Promise<void>;
  isComplete: boolean;
  status: string;
  onComplete: () => void;
}
