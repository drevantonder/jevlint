import { readDocument } from "./read-document.js";

export async function documentRoute(documentId: string) {
  return { status: 200, document: await readDocument(documentId) };
}
