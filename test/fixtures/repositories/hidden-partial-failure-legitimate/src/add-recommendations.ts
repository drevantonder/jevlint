import { recommendations } from "./recommendations.js";

export interface Product {
  id: string;
  name: string;
}

export async function addRecommendations(products: Product[]) {
  const outcomes = await Promise.allSettled(
    products.map((product) => recommendations.forProduct(product.id)),
  );

  return products.map((product, index) => {
    const outcome = outcomes[index];
    return outcome?.status === "fulfilled"
      ? { ...product, recommendations: outcome.value }
      : product;
  });
}
