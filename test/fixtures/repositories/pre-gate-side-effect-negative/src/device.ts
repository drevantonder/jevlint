import { deviceCache } from "./cache.js";

export async function registerDevice(deviceId: string, record: { owner: string }): Promise<void> {
  const accepted = await deviceCache.createOrUpdate(deviceId, record);
  if (!accepted) throw new Error("device limit reached");
  deviceCache.set(deviceId, record);
}
