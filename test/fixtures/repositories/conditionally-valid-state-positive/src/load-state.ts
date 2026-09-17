export interface User {
  id: string;
  name: string;
}

export interface LoadState {
  status: "idle" | "loading" | "success" | "error";
  data?: User;
  errorMessage?: string;
}

export const initialLoadState: LoadState = { status: "idle" };
