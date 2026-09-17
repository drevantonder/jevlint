export async function fetchUser(userId: string) {
  const response = await fetch(`https://api.example.com/users/${userId}`);
  return response.json();
}
