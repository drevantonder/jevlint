export function greet(name: string | undefined): string {
  if (!name) return "hello, stranger";
  return "hello, " + name;
}
