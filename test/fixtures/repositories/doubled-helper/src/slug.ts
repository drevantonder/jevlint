export function slugify(title: string): string {
  return title.trim().toLowerCase().replaceAll(/\s+/g, "-");
}
