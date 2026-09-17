import { writeRecord } from "./store.js";

export async function saveRecord(id: string, record: unknown): Promise<void> {
  try {
    await writeRecord(id, record);
  } catch (e) {
    throw new Error("save failed");
  }
}
