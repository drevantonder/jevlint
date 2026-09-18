export type DraftState = {
  mergeResult: string;
  applyPatch: (patch: string) => void;
  isDirty: boolean;
  title: string;
};
