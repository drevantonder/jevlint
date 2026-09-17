import { registerDevice } from "./device.js";

export async function handleEnrollment(deviceId: string): Promise<void> {
  await registerDevice(deviceId, { owner: "team" });
}
