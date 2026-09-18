export function wrap<Fn extends (...args: any[]) => any>(fn: Fn): Fn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastArgs: any[] = [];
  return ((...args: Parameters<Fn>): ReturnType<Fn> => {
    lastArgs.push(args);
    return fn(...args);
  }) as Fn;
}
