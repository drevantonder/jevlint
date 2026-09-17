import { authenticate, InvalidCredentialsError } from "./authenticate.js";

export async function loginRoute(email: string, password: string) {
  try {
    return { status: 200, session: await authenticate(email, password) };
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return { status: 401, message: error.message };
    }
    throw error;
  }
}
