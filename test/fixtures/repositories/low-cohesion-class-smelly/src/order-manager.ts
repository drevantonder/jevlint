import { db } from "./db.js";
import { ledger } from "./ledger.js";
import { mailer } from "./mailer.js";

export class OrderManager {
  private orders: string[] = [];
  private outstandingCents = 0;
  private shipmentIds: string[] = [];

  addOrder(id: string): void {
    this.orders.push(id);
    void db.save(id);
  }

  orderCount(): number {
    return this.orders.length;
  }

  charge(cents: number): void {
    this.outstandingCents += cents;
    ledger.post(cents);
  }

  outstanding(): number {
    return this.outstandingCents;
  }

  ship(id: string): void {
    this.shipmentIds.push(id);
    void mailer.send(id);
  }

  shipped(): string[] {
    return this.shipmentIds;
  }
}
