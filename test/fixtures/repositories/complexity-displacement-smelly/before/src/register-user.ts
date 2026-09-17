export function registerUser(input: RegistrationInput) {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Invalid email");
  return users.insert({ email, name: input.name.trim() });
}
