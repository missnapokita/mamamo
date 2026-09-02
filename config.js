// Bidamax hosted player configuration.
// Keep secrets OUT of this file. GitHub Pages is public.
window.BIDAMAX_PLAYER_CONFIG = {
  streamApi: "https://cache-liart.vercel.app/api/player-stream",
  diagnosticsApi: "https://cache-liart.vercel.app/api/player-diagnostics",
  playerVersion: "v2.2-progress-faststart",
  requestTimeoutMs: 25000,
  progressTickMs: 160,
  progressPhaseDurationMs: 5200,
  probeTimeoutMs: 4000,
  startupProbeConcurrency: 2,
  backgroundProbeTimeoutMs: 5000,
  backgroundProbeDelayMs: 450,
  maxGenerationAttempts: 2,
  generationRetryDelayMs: 500,
  overlayTimeoutMs: 4300
};
