import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Clock, FileStore, Logger } from "@chronon-sim/platform";

/** FileStore backed by the Node file system. */
export class NodeFileStore implements FileStore {
  readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/** Logger writing info/debug to stdout and warn/error to stderr. */
export class ConsoleLogger implements Logger {
  debug(message: string): void {
    if (process.env["CHRONON_DEBUG"]) console.error(message);
  }
  info(message: string): void {
    console.log(message);
  }
  warn(message: string): void {
    console.error(message);
  }
  error(message: string): void {
    console.error(message);
  }
}

/** Clock backed by performance.now(). */
export class NodeClock implements Clock {
  nowMs(): number {
    return performance.now();
  }
}
