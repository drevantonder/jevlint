import { slugify } from "./slug.js";

export function cardPath(title: string): string {
  return `/cards/${slugify(title)}`;
}
