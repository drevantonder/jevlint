export const SiteSettings: Record<string, number> = {
  max_image_size_kb: 5 * 1024,
  max_video_size_kb: 50 * 1024,
};

export function maxSizeFor(type: string): number {
  return SiteSettings[`max_${type}_size_kb`] ?? 10 * 1024;
}
