export interface DeliveryUpdate {
  phase: "ordered" | "packed" | "shipped";
  note?: string;
}

export const update: DeliveryUpdate = {
  phase: "packed",
  note: "Gift wrap requested",
};
