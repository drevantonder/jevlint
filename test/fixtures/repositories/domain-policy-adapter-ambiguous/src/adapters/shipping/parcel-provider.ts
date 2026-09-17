import { parcelApi } from "./parcel-api.js";

export async function createParcel(shipment: Shipment) {
  const serviceLevel = shipment.priority === "expedited" ? "EXPRESS" : "GROUND";
  return parcelApi.createShipment({
    reference: shipment.id,
    serviceLevel,
    destination: shipment.address,
  });
}
