export type Debounced = ((...args: string[]) => void) & {
  cancel: () => void;
  flush: () => void;
};

export function debounce(
  fn: (...args: string[]) => void,
  wait: number,
  options: { leading?: boolean; trailing?: boolean; maxWait?: number } = {},
): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: string[] | null = null;
  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;
  const maxWait = options.maxWait;
  function invoke(): void {
    if (lastArgs) fn(...lastArgs);
    timer = null;
    lastArgs = null;
  }
  const debounced = (...args: string[]): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    if (leading && !timer) fn(...args);
    timer = setTimeout(() => {
      if (trailing) invoke();
    }, maxWait ?? wait);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  debounced.flush = () => invoke();
  return debounced;
}
