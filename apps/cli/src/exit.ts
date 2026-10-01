/** Process exit codes used by the CLI. */
export const EXIT_OK = 0;
/** The model is malformed or failed validation. */
export const EXIT_INVALID_MODEL = 1;
/** Bad command-line usage, or a file could not be read or written. */
export const EXIT_USAGE = 2;
/** The run completed but at least one assertion failed (use this to fail a CI job). */
export const EXIT_ASSERTION_FAILED = 3;
