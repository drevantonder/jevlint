export const _state = { count: 0 };

export function increment(): number {
  _state.count += 1;
  return _state.count;
}
