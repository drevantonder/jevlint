async function liveAsk(query: string): Promise<string> {
  const response = await fetch("https://api.example.com/ask?q=" + query);
  if (!response.ok) {
    throw new Error("ask failed");
  }
  return response.text();
}

export async function search(query: string): Promise<string> {
  let first: string;
  try {
    first = await liveAsk(query);
  } catch {
    first = "fallback";
  }
  const second = await liveAsk(query);
  return `${first}:${second}`;
}
