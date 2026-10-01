/**
 * Platform interfaces. Everything environment-specific (file I/O, wall clock, logging)
 * sits behind these so the engine stays embeddable in Node and in a Web Worker.
 * This package contains interfaces only; hosts (e.g. the CLI) provide implementations.
 */

/** Text file access. Paths are host-defined (the CLI uses OS paths). */
export interface FileStore {
  /** Read a whole file as UTF-8 text. Rejects if the file cannot be read. */
  readText(path: string): Promise<string>;
  /** Write (create or overwrite) a whole file as UTF-8 text, creating parent directories if needed. */
  writeText(path: string, content: string): Promise<void>;
}

/** Minimal leveled logger. `info` is also used for primary program output (e.g. the report). */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Wall-clock source, for measuring how long a run took (never used for simulation time). */
export interface Clock {
  /** Monotonic-ish milliseconds. Only differences are meaningful. */
  nowMs(): number;
}
