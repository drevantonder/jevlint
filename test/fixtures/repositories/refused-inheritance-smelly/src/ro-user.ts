import { User } from "./user.js";

export class ReadOnlyUser extends User {
  save(): void {
    throw new Error("read-only");
  }

  delete(): boolean {
    return false;
  }
}
