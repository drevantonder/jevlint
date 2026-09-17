import { usersRepository } from "./users-repository.js";

export function findActiveUsers() {
  return usersRepository.findUsers({ status: "active" });
}
