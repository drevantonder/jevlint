export interface OperationState {
  status: "waiting" | "running" | "finished";
  detail?: string;
}

export function operationLabel(operation: OperationState): string {
  switch (operation.status) {
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "finished":
      return operation.detail ?? "Finished";
  }
}
