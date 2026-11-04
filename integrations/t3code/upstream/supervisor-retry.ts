const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;

function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}
