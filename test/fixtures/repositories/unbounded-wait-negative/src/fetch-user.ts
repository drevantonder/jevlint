export async function fetchUser(userId: string) {
  const response = await fetch(`https://api.example.com/users/${userId}`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.json();
}
