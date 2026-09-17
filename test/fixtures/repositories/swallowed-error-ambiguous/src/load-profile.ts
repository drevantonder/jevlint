import { profileCache, profileService, logger } from "./services.js";

export async function loadProfile(userId: string) {
  try {
    return await profileService.load(userId);
  } catch (error) {
    logger.warn("Profile service unavailable", { error, userId });
    return profileCache.get(userId);
  }
}
