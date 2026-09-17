import pLimit from "p-limit";

export function runJobs<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const limit = pLimit(4);
  return Promise.all(tasks.map((task) => limit(task)));
}
