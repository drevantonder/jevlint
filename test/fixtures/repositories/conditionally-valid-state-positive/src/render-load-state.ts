import type { LoadState } from "./load-state.js";

export function renderLoadState(state: LoadState): string {
  switch (state.status) {
    case "idle":
      return "Not started";
    case "loading":
      return "Loading";
    case "success":
      return state.data!.name;
    case "error":
      return state.errorMessage!;
  }
}
