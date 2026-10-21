import { mountDiagram } from "./diagram.js";
import type { RunRequest, RunResponse } from "./handler.js";
import { importForDemo } from "./kubernetes.js";
import mm1 from "../../../examples/mm1.json" with { type: "json" };
import spike from "../../../examples/traffic-spike.json" with { type: "json" };
import sqs from "../../../examples/sqs-dlq.json" with { type: "json" };
import coldStart from "../../../examples/serverless-cold-start.json" with { type: "json" };
import retryStorm from "../../../examples/retry-storm.json" with { type: "json" };
import autoscaled from "../../../examples/autoscaled-service.json" with { type: "json" };
import shopManifests from "../../../examples/kubernetes/shop.yaml";
import shopOverlay from "../../../examples/kubernetes/overlay.yaml";

/** Injected by the build: the worker bundle as source text, so the page needs no other file. */
declare const __WORKER_SOURCE__: string;

const EXAMPLES: Record<string, unknown> = {
  "Autoscaled service (SLO gates)": autoscaled,
  "Traffic spike: 50/s to 250/s": spike,
  "SQS visibility timeout and DLQ": sqs,
  "Serverless cold starts and throttling": coldStart,
  "Retry storm": retryStorm,
  "M/M/1 queue (theory check)": mm1,
  "Blank (build your own)": { version: 1, name: "My model", settings: { duration: 600, warmUp: 60, replications: 3 }, components: [] },
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
const diagram = mountDiagram($("diagram"), editor);
const tabs = [$<HTMLButtonElement>("tab-diagram"), $<HTMLButtonElement>("tab-json"), $<HTMLButtonElement>("tab-kubernetes")];
const manifests = $<HTMLTextAreaElement>("k8s-manifests");
const overlay = $<HTMLTextAreaElement>("k8s-overlay");
const k8sDuration = $<HTMLInputElement>("k8s-duration");
const notes = $<HTMLElement>("k8s-notes");
manifests.value = shopManifests;
overlay.value = shopOverlay;

type View = "diagram" | "json" | "kubernetes";
const IMPORTED = "Imported from Kubernetes";
function show(view: View): void {
  for (const t of tabs) t.setAttribute("aria-selected", String(t.id === `tab-${view}`));
  $("diagram").hidden = view !== "diagram";
  editor.hidden = view !== "json";
  $("kubernetes").hidden = view !== "kubernetes";
  if (view === "diagram") diagram.render();
}

for (const name of Object.keys(EXAMPLES)) {
  const o = document.createElement("option");
  o.textContent = name;
  picker.appendChild(o);
}

function load(name: string): void {
  editor.value = JSON.stringify(EXAMPLES[name], null, 2);
  diagram.reset();
  if (!$("diagram").hidden) diagram.render();
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
  const source = editor.value;
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
    diagram.play(r.playback, source);
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

function list(title: string, items: string[]): void {
  if (items.length === 0) return;
  const h = document.createElement("h3");
  h.textContent = title;
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  notes.append(h, ul);
}

/** Import the pasted manifests and overlay into the model editor, then run it and show the diagram replay. */
function importAndRun(): void {
  const duration = Number(k8sDuration.value);
  const r = importForDemo(manifests.value, overlay.value, Number.isFinite(duration) && duration > 0 ? duration : 1200);
  notes.replaceChildren();
  if (!r.ok) {
    showErrors(r.errors.map((message) => ({ component: null, key: null, message })));
    status.textContent = "Fix the manifests or the overlay and import again.";
    return;
  }
  list("Imported", r.mapped.map((m) => `${m.logicalId} → ${m.componentType} "${m.component}"${m.notes.length > 0 ? ` (${m.notes.join("; ")})` : ""}`));
  if (r.ignored.length > 0) list("Not modelled", [r.ignored.map((i) => i.logicalId).join(", ")]);
  list("Assumptions (the manifests do not say)", r.assumptions);
  list("Warnings", r.warnings);
  // The picker names what is loaded, and choosing it again reloads the imported model.
  EXAMPLES[IMPORTED] = r.json;
  if (![...picker.options].some((o) => o.value === IMPORTED)) {
    const o = document.createElement("option");
    o.textContent = IMPORTED;
    picker.appendChild(o);
  }
  picker.value = IMPORTED;
  show("diagram");
  load(IMPORTED);
  // Reloading the page should come back to the Kubernetes tab, not to an example that only existed in this session.
  const u = new URL(location.href);
  u.searchParams.delete("example");
  u.searchParams.set("tab", "kubernetes");
  history.replaceState(null, "", u);
  run();
}

picker.addEventListener("change", () => load(picker.value));
runButton.addEventListener("click", run);
$("k8s-import").addEventListener("click", importAndRun);
for (const t of tabs) t.addEventListener("click", () => show(t.id.slice("tab-".length) as View));

const params = new URL(location.href).searchParams;
const wanted = params.get("example");
const initial = wanted !== null && wanted in EXAMPLES ? wanted : (Object.keys(EXAMPLES)[0] as string);
picker.value = initial;
show("diagram");
load(initial);
// ?tab=kubernetes opens the Kubernetes tab; with run=1 it imports and runs straight away.
const kubernetes = params.get("tab") === "kubernetes";
if (kubernetes) show("kubernetes");
if (params.get("run") === "1") (kubernetes ? importAndRun : run)();
