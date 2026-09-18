export class Counter {
  private count = 0;
  private label = "";

  setCount(count: number): void {
    this.count = count;
  }

  rename(label: string): void {
    this.label = label;
  }
}
