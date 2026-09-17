export function registerOperations(registry: Registry) {
  registry.add(async (input) => {
    if (input.kind === "one") return Reflect.get(input, input.key);
    if (input.kind === "two") return Object.entries(input);
    return await loadFallback(input);
  });

  return registry;
}
