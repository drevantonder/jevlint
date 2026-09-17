import { createParcel } from "../adapters/shipping/parcel-provider.js";

export async function shipOrder(shipment: Shipment) {
  return createParcel(shipment);
}
