import { ManagedCalendar } from "./calendar.js";

export async function bookDemo(title: string, credentialId: string) {
  const calendar = new ManagedCalendar();
  return calendar.createEvent({ title }, credentialId);
}
