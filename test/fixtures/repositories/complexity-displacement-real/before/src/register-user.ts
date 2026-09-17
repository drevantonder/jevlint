export async function registerUser(input: RegistrationInput) {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Invalid email");
  const user = { id: createId(), email, name: input.name.trim() };
  await database.users.insert(user);
  await emailClient.sendWelcome(user.email, user.name);
  return user;
}
