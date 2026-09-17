export abstract class CalendarProvider {
  abstract createEvent(event: { title: string }, credentialId: string): Promise<string>;
}

export class ManagedCalendar extends CalendarProvider {
  async createEvent(event: { title: string }): Promise<string> {
    return event.title;
  }
}
