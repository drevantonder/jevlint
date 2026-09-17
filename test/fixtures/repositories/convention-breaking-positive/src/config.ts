export interface LoaderConfig {
  name: string;
  label: string;
}

export async function readConfig(path: string): Promise<LoaderConfig | null> {
  void path;
  return null;
}
