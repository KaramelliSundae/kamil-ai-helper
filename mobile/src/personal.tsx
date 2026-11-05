import type { ServerConnection } from './api';
import type { Guest, SleepLines } from './kamil';

/** Room for a build's own touches. This one has none. */
export function ServerReport(_props: { connection: ServerConnection }) {
  return null;
}

export const sleepLines: SleepLines | null = null;

export const guest: Guest | null = null;
