import type { RunRequest, RunResponse } from "./handler.js";
import mm1 from "../../../examples/mm1.json" with { type: "json" };
import spike from "../../../examples/traffic-spike.json" with { type: "json" };
import sqs from "../../../examples/sqs-dlq.json" with { type: "json" };
import coldStart from "../../../examples/serverless-cold-start.json" with { type: "json" };
import retryStorm from "../../../examples/retry-storm.json" with { type: "json" };
import autoscaled from "../../../examples/autoscaled-service.json" with { type: "json" };

/** Injected by the build: the worker bundle as source text, so the page needs no other file. */
declare const __WORKER_SOURCE__: string;

const EXAMPLES: Record<string, unknown> = {
  "Autoscaled service (SLO gates)": autoscaled,
  "Traffic spike: 50/s to 250/s": spike,
  "SQS visibility timeout and DLQ": sqs,
  "Serverless cold starts and throttling": coldStart,
  "Retry storm": retryStorm,
  "M/M/1 queue (theory check)": mm1,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>("model");
const picker = $<HTMLSelectElement>("example");
const runButton = $<HTMLButtonElement>("run");
const reps = $<HTMLInputElement>("reps");
const status = $<HTMLElement>("status");
const frame = $<HTMLIFrameElement>("report");
const errors = $<HTMLElement>("errors");
const download = $<HTMLAnchorElement>("download");

for (const name of Object.keys(EXAMPLES)) {
  const o = document.createElement("option");
  o.textContent = name;
  picker.appendChild(o);
}

function load(name: string): void {
  editor.value = JSON.stringify(EXAMPLES[name], null, 2);
  const u = new URL(location.href);
  u.searchParams.set("example", name);
  history.replaceState(null, "", u);
}

let worker: Worker | null = null;
function getWorker(): Worker {
  if (worker === null) worker = new Worker(URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: "text/javascript" })));
  return worker;
}

function showErrors(list: { component: string | null; key: string | null; message: string }[]): void {
  errors.replaceChildren();
  for (const e of list) {
    const li = document.createElement("li");
    const where = [e.component, e.key].filter((x) => x !== null).join(".");
    li.textContent = (where ? `[${where}] ` : "") + e.message;
    errors.appendChild(li);
  }
  errors.hidden = list.length === 0;
}

function run(): void {
  let json: unknown;
  try {
    json = JSON.parse(editor.value);
  } catch (e) {
    showErrors([{ component: null, key: null, message: `not valid JSON: ${(e as Error).message}` }]);
    status.textContent = "Fix the JSON and run again.";
    return;
  }
  const req: RunRequest = { json };
  const n = Number(reps.value);
  if (Number.isInteger(n) && n >= 1) req.replications = n;
  runButton.disabled = true;
  status.textContent = "Simulating in a Web Worker...";
  const w = getWorker();
  w.onmessage = (e: MessageEvent<RunResponse & { elapsedMs: number }>) => {
    runButton.disabled = false;
    const r = e.data;
    if (!r.ok) {
      showErrors(r.errors);
      status.textContent = `The model has ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}.`;
      return;
    }
    showErrors([]);
    frame.srcdoc = r.html;
    download.href = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
    download.download = "surgesim-report.html";
    download.hidden = false;
    const gate = r.assertionsTotal > 0 ? ` · ${r.assertionsTotal - r.assertionsFailed}/${r.assertionsTotal} assertions pass` : "";
    status.textContent = `${r.replications} replication(s), ${r.eventsProcessed.toLocaleString("en-US")} events in ${r.elapsedMs} ms${gate}`;
    document.title = `Surgesim demo: ${r.modelName ?? "run"} done`;
  };
  w.onerror = (e) => {
    runButton.disabled = false;
    status.textContent = `Worker error: ${e.message}`;
  };
  w.postMessage(req);
}

picker.addEventListener("change", () => load(picker.value));
runButton.addEventListener("click", run);

const wanted = new URL(location.href).searchParams.get("example");
const initial = wanted !== null && wanted in EXAMPLES ? wanted : (Object.keys(EXAMPLES)[0] as string);
picker.value = initial;
load(initial);
if (new URL(location.href).searchParams.get("run") === "1") run();
