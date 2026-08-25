/**
 * Nebula Notebook Frontend Configuration
 *
 * Centralized configuration exports for the frontend.
 * Import from this module for convenient access to all config values.
 *
 * @example
 * import { MAX_OUTPUT_LINES, AUTOSAVE_CHECK_DELAY_MS } from '@/config';
 */

// Autosave timing
export {
  MIN_AUTOSAVE_DELAY_MS,
  MAX_AUTOSAVE_DELAY_MS,
  AUTOSAVE_CHECK_DELAY_MS,
  AUTOSAVE_RETRY_DELAY_MS,
} from './autosave.config';

// Display limits and dimensions
export {
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES_ERROR,
  MAX_OUTPUT_CHARS_ERROR,
  OUTPUT_TRUNCATION_THRESHOLD,
  DEFAULT_CELL_HEIGHT_PX,
  OUTPUT_MIN_HEIGHT_PX,
  OUTPUT_DEFAULT_HEIGHT_PX,
  SOURCE_MIN_HEIGHT_PX,
  SOURCE_DEFAULT_HEIGHT_PX,
  SOURCE_COLLAPSE_THRESHOLD_PX,
  OUTPUT_MAX_HEIGHT_PX,
  SCROLL_ANIMATION_DURATION_MS,
  HIGHLIGHT_ANIMATION_DURATION_MS,
  TRANSITION_DURATION_MS,
  OUTPUT_FLUSH_INTERVAL_MS,
  EXECUTION_TIMER_INTERVAL_MS,
} from './display.config';

// Polling and timing
export {
  DIRECTORY_POLL_INTERVAL_MS,
  WEBSOCKET_RECONNECT_INTERVAL_MS,
  MTIME_TOLERANCE_SECONDS,
} from './polling.config';
