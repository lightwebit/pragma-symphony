// Behavioral timeouts (ms)
export const TOAST_ERROR_DURATION_MS     = 5_000
export const TOAST_EXPORT_DURATION_MS    = 4_000
export const USAGE_TICK_INTERVAL_MS      = 1_000
export const USAGE_HARD_TIMEOUT_MS       = 60_000
export const AUTO_CONFIRM_DELAY_MS       = 1_500

// Usage modal UX thresholds (seconds)
export const USAGE_SHOW_ELAPSED_AFTER_S  = 5
export const USAGE_SHOW_CANCEL_AFTER_S   = 15

// Usage bar percentage thresholds
export const USAGE_BAR_DANGER_PCT        = 80
export const USAGE_BAR_WARN_PCT          = 50

// Panel widths (px)
export const PANEL_LEFT_DEFAULT_PX       = 220
export const PANEL_RIGHT_DEFAULT_PX      = 300
export const PANEL_LEFT_MIN_PX           = 120
export const PANEL_LEFT_MAX_PX           = 450
export const PANEL_RIGHT_MIN_PX          = 150
export const PANEL_RIGHT_MAX_PX          = 600

// E2E run. Must stay aligned with e2e::DEFAULT_TIMEOUT_SECS on the Rust side,
// which has the last word anyway when the frontend passes nothing.
export const E2E_DEFAULT_TIMEOUT_SECS = 600

// Live run. Must stay aligned with live::DEFAULT_TIMEOUT_SECS on the Rust side.
export const LIVE_DEFAULT_TIMEOUT_SECS = 600

// localStorage keys
export const LS_THEME         = 'pragma:theme'
export const LS_FOCUS_MODE    = 'pragma:focusMode'
export const LS_LEFT_WIDTH    = 'pragma:leftWidth'
export const LS_RIGHT_WIDTH   = 'pragma:rightWidth'
export const LS_WORKING_DIR   = 'pragma:workingDir'   // legacy migration key only
// Suffix: project id. The E2E timeout is a local preference, not a
// property of the project to be versioned in the DB.
export const LS_E2E_TIMEOUT_PREFIX = 'pragma:e2eTimeout:'
// Same nature of local preference for Live: timeout and the unbounded/one-shot choice.
export const LS_LIVE_TIMEOUT_PREFIX    = 'pragma:liveTimeout:'
export const LS_LIVE_UNBOUNDED_PREFIX  = 'pragma:liveUnbounded:'
