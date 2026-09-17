type Task<T> = () => Promise<T>;

export function runWithLimit<T>(tasks: Task<T>[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const queue = tasks.map((task, index) => ({ task, index }));
  let active = 0;
  return new Promise((resolve, reject) => {
    function next(): void {
      if (queue.length === 0 && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        active += 1;
        item.task().then(
          (value) => {
            results[item.index] = value;
            active -= 1;
            next();
          },
          (error: unknown) => reject(error),
        );
      }
    }
    next();
  });
}
