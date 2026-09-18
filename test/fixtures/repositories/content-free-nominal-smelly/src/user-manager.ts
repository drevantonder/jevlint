export class UserManager {
  private users: Map<string, string> = new Map();
  private newsletterSubscribers: string[] = [];
  private payrollLedger: Map<string, number> = new Map();

  createUser(id: string, name: string): void {
    this.users.set(id, name);
  }

  deleteUser(id: string): void {
    this.users.delete(id);
  }

  subscribeNewsletter(email: string): void {
    this.newsletterSubscribers.push(email);
  }

  sendNewsletter(body: string): string[] {
    return this.newsletterSubscribers.map((subscriber) => `${subscriber}:${body}`);
  }

  recordPayroll(id: string, amount: number): void {
    this.payrollLedger.set(id, amount);
  }

  totalPayroll(): number {
    let total = 0;
    for (const amount of this.payrollLedger.values()) total += amount;
    return total;
  }
}
