interface Feature {
  key: string;
  enabled: boolean;
}

export function lookupFeature(features: Feature[], key: string): Feature | undefined {
  const feature = features.find((candidate) => candidate.key === key);
  if (!feature) return undefined;
  if (!feature.enabled) return undefined;
  return feature;
}
