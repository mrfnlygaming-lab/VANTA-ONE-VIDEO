export type Motion =
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "still";
export const MAX_IMAGES: 6;
export const MAX_TOTAL_DURATION: 60;
export const MAX_PROMPT_LENGTH: 1000;
export function promptMotion(prompt: string): Motion | null;
export function resolvePromptMotion(prompt: string, fallback?: Motion): Motion;
