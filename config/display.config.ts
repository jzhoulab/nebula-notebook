/**
 * Display Configuration
 *
 * Constants for output limits, cell dimensions, and animation durations.
 * These control how content is rendered and user experience.
 */

// =============================================================================
// Output Limits
// =============================================================================

/** Maximum lines of regular output to display */
export const MAX_OUTPUT_LINES = 10000;

/** Maximum characters of regular output to display (100MB - generous for images) */
export const MAX_OUTPUT_CHARS = 100_000_000;

/** Maximum lines of error output to display (tracebacks need more context) */
export const MAX_OUTPUT_LINES_ERROR = 10000;

/** Maximum characters of error output to display */
export const MAX_OUTPUT_CHARS_ERROR = 100_000_000;

/** Truncation threshold for inline output display (characters) */
export const OUTPUT_TRUNCATION_THRESHOLD = 2000;

// =============================================================================
// Cell Dimensions
// =============================================================================

/** Default estimated height for cells before measurement (pixels) */
export const DEFAULT_CELL_HEIGHT_PX = 150;

/** Minimum height for collapsed output (pixels) */
export const OUTPUT_MIN_HEIGHT_PX = 50;

/** Default height for collapsed output (pixels) */
export const OUTPUT_DEFAULT_HEIGHT_PX = 200;

/** Maximum height for collapsed output (pixels) */
export const OUTPUT_MAX_HEIGHT_PX = 600;

/** Minimum height for collapsed cell source (pixels) */
export const SOURCE_MIN_HEIGHT_PX = 60;

/** Default height for collapsed cell source (pixels) */
export const SOURCE_DEFAULT_HEIGHT_PX = 220;

/** Source taller than this offers the collapse control (pixels) */
export const SOURCE_COLLAPSE_THRESHOLD_PX = 320;

// =============================================================================
// Animation Durations
// =============================================================================

/** Scroll animation duration (milliseconds) */
export const SCROLL_ANIMATION_DURATION_MS = 150;

/** Cell highlight animation duration (milliseconds) - matches CSS */
export const HIGHLIGHT_ANIMATION_DURATION_MS = 1500;

/** General transition duration (milliseconds) */
export const TRANSITION_DURATION_MS = 300;

/** Cell output flush/batch interval during execution (milliseconds) */
export const OUTPUT_FLUSH_INTERVAL_MS = 100;

/** Execution timer update interval for smooth display (milliseconds) */
export const EXECUTION_TIMER_INTERVAL_MS = 100;
