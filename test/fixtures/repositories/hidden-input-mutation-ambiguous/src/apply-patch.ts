export function applyPatch<T extends object>(target: T, patch: Partial<T>): T {
  Object.assign(target, patch);
  return target;
}
