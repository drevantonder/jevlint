export class User {
  static register(input: RegistrationInput): User {
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) throw new Error("Invalid email");
    return new User(createId(), email, input.name.trim());
  }

  private constructor(
    readonly id: string,
    readonly email: string,
    readonly name: string,
  ) {}
}
