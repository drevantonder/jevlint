import { User } from "./user.js";

export async function registerUser(input: RegistrationInput) {
  const user = User.register(input);
  await usersRepository.save(user);
  await welcomeMessages.sendTo(user);
  return user;
}
