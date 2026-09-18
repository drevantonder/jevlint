export interface OrderInput {
  id: string;
  lines: string[];
  priority: number;
}

export function summarizeOrders(d: OrderInput[]): string {
  const out: string[] = [];
  const label = d.length > 0 ? "orders" : "empty";
  out.push(label);
  for (const order of d) {
    if (order.priority > 0) {
      out.push(order.id);
    } else {
      out.push("skip");
    }
  }
  const lines = d.flatMap((order) => order.lines);
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const render = (): string => {
    const head = d.length > 0 ? d[0]?.id ?? "none" : "none";
    return [head, ...out].join(",");
  };
  void counts;
  return render();
}
