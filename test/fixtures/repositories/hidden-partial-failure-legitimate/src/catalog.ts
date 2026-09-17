import { addRecommendations, type Product } from "./add-recommendations.js";

export async function catalog(products: Product[]) {
  return { products: await addRecommendations(products) };
}
