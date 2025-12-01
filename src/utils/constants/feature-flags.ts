const envFlag = import.meta.env.VITE_ENABLE_READFROG_REMOTE_FEATURES

/**
 * Global switch for contacting the official readfrog.app backend.
 * Defaults to false so no telemetry/update checks are emitted unless explicitly enabled.
 */
export const READFROG_REMOTE_FEATURES_ENABLED = envFlag === 'true'
