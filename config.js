// Bidamax hosted player configuration.
// Keep secrets OUT of this file. GitHub Pages is public.
window.BIDAMAX_PLAYER_CONFIG = {
  streamApi: "https://cache-liart.vercel.app/api/player-stream",
  diagnosticsApi: "https://cache-liart.vercel.app/api/player-diagnostics",
  playerVersion: "v2.3-visible-completion",
  requestTimeoutMs: 25000,
  progressTickMs: 24,
  progressPhaseDurationMs: 4200,
  progressCompletionDurationMs: 320,
  progressCompletionHoldMs: 55,
  probeTimeoutMs: 4000,
  startupProbeConcurrency: 2,
  backgroundProbeTimeoutMs: 5000,
  backgroundProbeDelayMs: 700,
  maxGenerationAttempts: 2,
  generationRetryDelayMs: 500,
  overlayTimeoutMs: 4300
};
