export function renderPage(input: { user: string }): string {
  return `<main><h1>hello ${input.user}</h1><nav><a href="/">home</a></nav></main>`;
}
