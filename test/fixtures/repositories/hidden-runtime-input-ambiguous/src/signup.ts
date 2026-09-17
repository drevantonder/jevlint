import { createTrial } from "./create-trial.js";

export function finishSignup(accountId: string): void {
  saveTrial(createTrial(accountId));
}
