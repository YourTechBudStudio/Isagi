export const homeRevealEase = [0.16, 1, 0.3, 1] as const;

export function getHomeRevealTransition(delay = 0) {
  return {
    duration: 0.8,
    delay,
    ease: homeRevealEase,
  };
}
