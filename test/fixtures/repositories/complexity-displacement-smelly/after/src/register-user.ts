export interface RegistrationSteps {
  normalizeEmail(value: string): string;
  validateEmail(value: string): boolean;
  normalizeName(value: string): string;
  persist(user: { email: string; name: string }): User;
}

export function registerUser(steps: RegistrationSteps, input: RegistrationInput) {
  const email = steps.normalizeEmail(input.email);
  if (!steps.validateEmail(email)) throw new Error("Invalid email");
  return steps.persist({ email, name: steps.normalizeName(input.name) });
}
