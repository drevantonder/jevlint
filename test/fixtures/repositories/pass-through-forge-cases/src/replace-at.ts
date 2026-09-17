type Preset = { readonly name: string };

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, candidate) => (candidate === index ? value : item));
}

export function updatePreset(presets: readonly Preset[], index: number, preset: Preset) {
  const updated = replaceAt(presets, index, preset);
  return { presets: updated };
}
