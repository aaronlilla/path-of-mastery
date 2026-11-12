import { artFor } from './gameArt';

/** The icon URL for a gem name when the art has one (no image is requested for names without art). */
export function useGemIcon(name: string): string | undefined {
  return artFor(name, 'gems');
}
