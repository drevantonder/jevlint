export interface OrderInfo {
  orderId: string;
  customerEmail: string;
  warehouseAisle: string;
  taxJurisdiction: string;
  shipmentTrackingCode: string;
  refundPolicyUrl: string;
  fetchTracking(): Promise<string>;
  calculateTax(): number;
}
