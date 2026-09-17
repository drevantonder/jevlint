export async function get(key: string): Promise<string | undefined> {
  return store.get(key);
}

export async function save(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export function remove(key: string, cb: (error: Error | null) => void): void {
  try {
    store.delete(key);
    cb(null);
  } catch (error) {
    cb(error instanceof Error ? error : new Error(String(error)));
  }
}

const store = new Map<string, string>();
