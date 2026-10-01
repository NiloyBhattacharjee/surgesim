import { handleRun, type RunRequest } from "./handler.js";

/**
 * Web Worker entry. It is the only place that touches the worker global, so the engine itself never
 * does. Replies with the handler's response plus how long the run took (measured here, in the host).
 */
interface WorkerScope {
  onmessage: ((e: { data: RunRequest }) => void) | null;
  postMessage(message: unknown): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const started = Date.now();
  const response = handleRun(e.data);
  scope.postMessage({ ...response, elapsedMs: Date.now() - started });
};
