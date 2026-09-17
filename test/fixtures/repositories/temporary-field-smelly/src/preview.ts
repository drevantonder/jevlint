import { Document } from "./document.js";

export function preview(document_: Document): string {
  return document_.render();
}
