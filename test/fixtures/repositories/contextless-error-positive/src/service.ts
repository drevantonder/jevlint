import { saveRecord } from "./save-record.js";

export async function handleSave(id: string, record: unknown): Promise<void> {
  try {
    await saveRecord(id, record);
  } catch (error) {
    console.log("save failed", error);
  }
}
