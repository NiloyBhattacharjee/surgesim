import { createDefaultRegistry, describeSchema, loadModel, type InputSpec, type SchemaDescription } from "@surgesim/engine";

/** Every built-in component schema, as plain data. Drives the palette, ports and inspector. */
export const SCHEMAS: SchemaDescription[] = createDefaultRegistry().schemas().map(describeSchema);
const byType = new Map(SCHEMAS.map((s) => [s.type, s]));

/** How each type looks in the editor: friendly label, colour kind, default name. Palette order follows the flow. */
const LOOK: Record<string, [label: string, kind: string, name: string]> = {
  EntityGenerator: ["Traffic source", "source", "traffic"],
  RateLimiter: ["Rate limiter", "control", "limiter"],
  RetryPolicy: ["Retry policy", "control", "retry"],
  Queue: ["Queue", "queue", "queue"],
  MessageQueue: ["Message queue (SQS)", "queue", "messages"],
  Server: ["Server", "worker", "server"],
  WorkerPool: ["Worker pool", "worker", "workers"],
  Autoscaler: ["Autoscaler", "control", "autoscaler"],
  EntitySink: ["Done (sink)", "sink", "done"],
};
const look = (type: string): [string, string, string] => LOOK[type] ?? [type, "control", type[0]!.toLowerCase() + type.slice(1)];

/** Whether `targetType` may be the target of link `key` on a `fromType` component (the link's role check). */
export function canLink(fromType: string, key: string, targetType: string): boolean {
  const accepts = byType.get(fromType)?.links.find((l) => l.key === key)?.accepts;
  return accepts !== undefined && (byType.get(targetType)?.roles.includes(accepts) ?? false);
}

interface Component {
  type: string;
  name: string;
  inputs?: Record<string, unknown>;
  links?: Record<string, string>;
}
/** The parts of a model the diagram edits; everything else is passed through untouched. */
export interface Model {
  components?: Component[];
  settings?: { timeSeries?: { outputs?: string[] } };
  assertions?: { output: string }[];
}

const isPull = (type: string, key: string): boolean => {
  const accepts = byType.get(type)?.links.find((l) => l.key === key)?.accepts;
  return accepts === "queue" || accepts === "pullable";
};

function starter(spec: InputSpec): unknown {
  if (spec.default !== undefined) return spec.default;
  if (spec.type === "rateProfile") return [[0, 10]];
  if (spec.type === "enum") return spec.options?.[0];
  if (spec.type === "boolean") return false;
  if (spec.type === "string") return "";
  return Math.max(spec.min ?? 1, 1);
}

/** Add a component with a fresh name and starter values for the inputs it needs to validate. Returns its name. */
export function addComponent(m: Model, type: string): string {
  const comps = (m.components ??= []);
  const base = look(type)[2];
  let name = base;
  for (let i = 2; comps.some((c) => c.name === name); i++) name = `${base}${i}`;
  const inputs: Record<string, unknown> = {};
  const specs = byType.get(type)?.inputs ?? [];
  for (const s of specs) {
    const w = s.requiredWhen;
    const cond = w && (inputs[w.input] ?? specs.find((o) => o.key === w.input)?.default) === w.equals;
    if (s.required || cond) inputs[s.key] = starter(s);
  }
  comps.push({ type, name, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) });
  return name;
}

/** Rewrite every reference to an output id prefix `name.`; drop them when `to` is null. */
function rewriteOutputs(m: Model, name: string, to: string | null): void {
  const hit = (id: string): boolean => id.startsWith(`${name}.`);
  const swap = (id: string): string => (to === null || !hit(id) ? id : to + id.slice(name.length));
  const ts = m.settings?.timeSeries;
  if (ts?.outputs) ts.outputs = ts.outputs.filter((id) => to !== null || !hit(id)).map(swap);
  if (m.assertions) m.assertions = m.assertions.filter((a) => to !== null || !hit(a.output)).map((a) => ({ ...a, output: swap(a.output) }));
}

/** Rename a component and every link, time series and assertion that refers to it. */
export function renameComponent(m: Model, from: string, to: string): void {
  for (const c of m.components ?? []) {
    if (c.name === from) c.name = to;
    for (const k in c.links) if (c.links[k] === from) c.links[k] = to;
  }
  rewriteOutputs(m, from, to);
}

/** Remove a component and everything that refers to it. */
export function removeComponent(m: Model, name: string): void {
  m.components = (m.components ?? []).filter((c) => c.name !== name);
  for (const c of m.components) for (const k in c.links) if (c.links[k] === name) delete c.links[k];
  rewriteOutputs(m, name, null);
}

/** Set (or with `target` null, clear) one link. */
export function setLink(m: Model, name: string, key: string, target: string | null): void {
  const c = m.components?.find((x) => x.name === name);
  if (!c) return;
  if (target === null) {
    if (c.links) delete c.links[key];
    if (c.links && Object.keys(c.links).length === 0) delete c.links;
  } else (c.links ??= {})[key] = target;
}

/**
 * Grid slot for components without a user-chosen position: breadth-first depth along the flow, then lane.
 * Pull links (`queue`) point against the flow, so they are reversed. Cycles (retries) keep first-seen depth.
 */
export function layout(m: Model): Map<string, [depth: number, lane: number]> {
  const comps = m.components ?? [];
  const out = new Map(comps.map((c) => [c.name, [] as string[]]));
  const indeg = new Map(comps.map((c) => [c.name, 0]));
  for (const c of comps)
    for (const [key, t] of Object.entries(c.links ?? {})) {
      if (!out.has(t) || t === c.name) continue;
      const [a, b] = isPull(c.type, key) ? [t, c.name] : [c.name, t];
      out.get(a)!.push(b);
      indeg.set(b, indeg.get(b)! + 1);
    }
  const depth = new Map<string, number>();
  const roots = [...comps.filter((c) => indeg.get(c.name) === 0), ...comps].map((c) => c.name);
  for (const root of roots) {
    if (depth.has(root)) continue;
    depth.set(root, 0);
    const queue = [root];
    while (queue.length > 0) {
      const n = queue.shift()!;
      for (const next of out.get(n)!)
        if (!depth.has(next)) {
          depth.set(next, depth.get(n)! + 1);
          queue.push(next);
        }
    }
  }
  const lanes = new Map<number, number>();
  const grid = new Map<string, [number, number]>();
  for (const c of comps) {
    const d = depth.get(c.name)!;
    const lane = lanes.get(d) ?? 0;
    lanes.set(d, lane + 1);
    grid.set(c.name, [d, lane]);
  }
  return grid;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const SVG = "http://www.w3.org/2000/svg";

/**
 * Mount the drag-and-drop editor. The model JSON in `editor` stays the source of truth: every edit
 * here rewrites it, and `render()` redraws from it. Node positions live only on the page.
 */
export function mountDiagram(root: HTMLElement, editor: HTMLTextAreaElement): { render(): void; reset(): void } {
  const palette = el("div", "palette");
  const toolbar = el("div", "toolbar");
  const check = el("span", "check");
  const tidy = el("button", "", "Tidy up");
  tidy.type = "button";
  tidy.title = "Forget dragged positions and lay the diagram out along the flow.";
  toolbar.append(check, tidy);
  const canvas = el("div", "canvas");
  const inspector = el("div", "inspector");
  root.replaceChildren(palette, toolbar, canvas, inspector);
  const pos = new Map<string, { x: number; y: number }>();
  let selected: string | null = null;
  let model: Model | null = null;

  const order = [...Object.keys(LOOK), ...SCHEMAS.map((s) => s.type).filter((t) => !(t in LOOK))];
  for (const type of order) {
    const s = byType.get(type);
    if (!s) continue;
    const [label, kind] = look(type);
    const chip = el("button", `chip kind-${kind}`);
    chip.append(el("span", "dot"), label);
    chip.type = "button";
    chip.title = `${s.description} Drag onto the canvas, or click to add.`;
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-surgesim-type", s.type));
    chip.addEventListener("click", () => add(s.type, null));
    palette.appendChild(chip);
  }
  tidy.addEventListener("click", () => {
    pos.clear();
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (root.hidden || selected === null || !model || (e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      removeComponent(model, selected);
      pos.delete(selected);
      selected = null;
      commit();
    } else if (e.key === "Escape") {
      selected = null;
      render();
    }
  });
  canvas.addEventListener("dragover", (e) => e.preventDefault());
  canvas.addEventListener("drop", (e) => {
    const type = e.dataTransfer?.getData("text/x-surgesim-type");
    if (!type) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    add(type, { x: e.clientX - r.left + canvas.scrollLeft - 70, y: e.clientY - r.top + canvas.scrollTop - 20 });
  });

  function add(type: string, at: { x: number; y: number } | null): void {
    if (!model) return;
    const name = addComponent(model, type);
    // Clicked, not dropped: below everything, where it is easy to find.
    pos.set(name, at ?? { x: 16, y: Math.max(-134, ...[...pos.values()].map((p) => p.y)) + 150 });
    selected = name;
    commit();
    canvas.querySelector(".node.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function commit(): void {
    editor.value = JSON.stringify(model, null, 2);
    render();
  }

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left + canvas.scrollLeft, y: e.clientY - r.top + canvas.scrollTop };
  };

  function render(): void {
    try {
      const parsed: unknown = JSON.parse(editor.value);
      model = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Model) : null;
    } catch {
      model = null;
    }
    canvas.replaceChildren();
    inspector.replaceChildren();
    if (!model || (model.components !== undefined && !Array.isArray(model.components))) {
      model = null;
      check.className = "check bad";
      check.textContent = "Invalid JSON";
      canvas.appendChild(el("p", "hint", "The JSON does not parse as a model. Fix it in the JSON tab to see the diagram."));
      return;
    }
    const comps = model.components ?? [];
    if (comps.length === 0) canvas.appendChild(el("p", "hint empty", "Drag a component from the palette above onto this canvas, or click one to add it. Start with a Traffic source."));

    // Live validation: the same checks Run does, shown on the nodes and ports they concern.
    const loaded = loadModel(model);
    const errors = loaded.ok ? [] : loaded.errors;
    check.className = errors.length === 0 ? "check ok" : "check bad";
    check.textContent = errors.length === 0 ? "✓ Ready to run" : `${errors.length} problem${errors.length === 1 ? "" : "s"}`;
    check.title = errors.map((e) => (e.component ? `[${[e.component, e.key].filter(Boolean).join(".")}] ` : "") + e.message).join("\n");
    const problems = (name: string, key?: string): string[] =>
      errors.filter((e) => e.component === name && (key === undefined || e.key === key)).map((e) => e.message);
    const grid = layout(model);
    const svg = document.createElementNS(SVG, "svg");
    canvas.appendChild(svg);
    const nodes = new Map<string, HTMLElement>();
    for (const c of comps) {
      const [d, lane] = grid.get(c.name)!;
      const p = pos.get(c.name) ?? { x: 16 + lane * 190, y: 16 + d * 150 };
      pos.set(c.name, p);
      const node = el("div", `node kind-${look(c.type)[1]}`);
      if (c.name === selected) node.classList.add("selected");
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      node.append(el("div", "type", look(c.type)[0]), el("div", "name", c.name));
      const own = problems(c.name);
      if (own.length > 0) {
        node.classList.add("bad");
        node.title = own.join("\n");
        node.appendChild(el("span", "badge", "!"));
      }
      for (const l of byType.get(c.type)?.links ?? []) {
        const row = el("div", "port-row", l.key);
        const dot = el("span", "port");
        dot.dataset.key = l.key;
        const bad = problems(c.name, l.key);
        row.title = bad.length > 0 ? bad.join("\n") : `${l.description} Drag to a highlighted component to link.`;
        if (bad.length > 0) row.classList.add("bad");
        if (c.links?.[l.key] !== undefined) dot.classList.add("on");
        dot.addEventListener("pointerdown", (e) => dragLink(e, c.name, l.key, dot));
        row.appendChild(dot);
        node.appendChild(row);
      }
      node.dataset.name = c.name;
      node.addEventListener("pointerdown", (e) => dragNode(e, c.name, node));
      canvas.appendChild(node);
      nodes.set(c.name, node);
    }
    const drawEdges = (): void => {
      svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>';
      svg.setAttribute("width", String(canvas.scrollWidth));
      svg.setAttribute("height", String(canvas.scrollHeight));
      for (const c of comps)
        for (const [key, t] of Object.entries(c.links ?? {})) {
          const from = nodes.get(c.name)?.querySelector<HTMLElement>(`.port[data-key="${CSS.escape(key)}"]`);
          const to = nodes.get(t);
          if (!from || !to) continue;
          const a = centre(from);
          const b = { x: to.offsetLeft + to.offsetWidth / 2, y: to.offsetTop };
          const path = curve(a, b, isPull(c.type, key));
          path.setAttribute("marker-end", "url(#arrow)");
          svg.appendChild(path);
        }
    };
    const centre = (dot: HTMLElement): { x: number; y: number } => {
      const r = dot.getBoundingClientRect();
      return local({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    };

    function dragNode(e: PointerEvent, name: string, node: HTMLElement): void {
      if ((e.target as HTMLElement).classList.contains("port")) return;
      const start = local(e);
      const p = pos.get(name)!;
      const origin = { ...p };
      let moved = false;
      node.setPointerCapture(e.pointerId);
      node.onpointermove = (ev) => {
        const now = local(ev);
        p.x = Math.max(0, Math.round((origin.x + now.x - start.x) / 8) * 8);
        p.y = Math.max(0, Math.round((origin.y + now.y - start.y) / 8) * 8);
        moved ||= Math.abs(now.x - start.x) + Math.abs(now.y - start.y) > 3;
        node.style.left = `${p.x}px`;
        node.style.top = `${p.y}px`;
        drawEdges();
      };
      node.onpointerup = () => {
        node.onpointermove = node.onpointerup = null;
        if (!moved) {
          selected = name;
          render();
        }
      };
    }

    function dragLink(e: PointerEvent, name: string, key: string, dot: HTMLElement): void {
      e.stopPropagation();
      dot.setPointerCapture(e.pointerId);
      const a = centre(dot);
      const fromType = comps.find((c) => c.name === name)!.type;
      let line: SVGPathElement | null = null;
      let hover: HTMLElement | null = null;
      const nodeAt = (ev: PointerEvent): HTMLElement | null =>
        document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".node") ?? null;
      dot.onpointermove = (ev) => {
        if (line === null) {
          // Show where this link can go: valid targets light up, the rest fade.
          canvas.classList.add("linking");
          for (const c of comps)
            nodes.get(c.name)!.classList.add(c.name !== name && canLink(fromType, key, c.type) ? "can-drop" : "no-drop");
        }
        line?.remove();
        line = curve(a, local(ev), false);
        line.classList.add("pending");
        svg.appendChild(line);
        hover?.classList.remove("hover");
        hover = nodeAt(ev);
        if (hover?.classList.contains("can-drop")) hover.classList.add("hover");
      };
      dot.onpointerup = (ev) => {
        dot.onpointermove = dot.onpointerup = null;
        if (line === null) {
          selected = name; // a click on a port selects its component
          render();
          return;
        }
        canvas.classList.remove("linking");
        const target = nodeAt(ev);
        if (target === null) setLink(model!, name, key, null);
        else if (target.classList.contains("can-drop")) setLink(model!, name, key, target.dataset.name!);
        commit();
      };
    }

    requestAnimationFrame(drawEdges);
    const sel = comps.find((c) => c.name === selected);
    if (sel) inspect(sel, comps);
    else if (comps.length > 0)
      inspector.appendChild(el("p", "hint", "Click a component to edit it (Delete removes it). Drag from a port ● to a highlighted component to link them; drop on empty space to unlink."));
  }

  function curve(a: { x: number; y: number }, b: { x: number; y: number }, pull: boolean): SVGPathElement {
    const path = document.createElementNS(SVG, "path");
    const d = Math.max(40, Math.abs(b.y - a.y) / 2);
    path.setAttribute("d", `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x},${b.y - d} ${b.x},${b.y}`);
    if (pull) path.classList.add("pull");
    return path;
  }

  function inspect(c: Component, comps: Component[]): void {
    const schema = byType.get(c.type);
    const head = el("div", "inspector-head");
    const title = el("strong", "", look(c.type)[0]);
    title.appendChild(el("span", "type-id", ` ${c.type}`));
    head.appendChild(title);
    const del = el("button", "", "Delete");
    del.type = "button";
    del.addEventListener("click", () => {
      removeComponent(model!, c.name);
      pos.delete(c.name);
      selected = null;
      commit();
    });
    head.appendChild(del);
    inspector.appendChild(head);
    if (schema) inspector.appendChild(el("p", "hint", schema.description));
    const form = el("div", "fields");
    inspector.appendChild(form);
    const field = (label: string, title: string, input: HTMLElement): void => {
      const l = el("label");
      l.title = title;
      l.append(el("span", "", label), input);
      form.appendChild(l);
    };

    const nameInput = el("input");
    nameInput.value = c.name;
    nameInput.addEventListener("change", () => {
      const to = nameInput.value.trim();
      if (to === "" || to === c.name || comps.some((x) => x.name === to)) {
        nameInput.value = c.name;
        return;
      }
      renameComponent(model!, c.name, to);
      pos.set(to, pos.get(c.name)!);
      pos.delete(c.name);
      selected = to;
      commit();
    });
    field("name", "Unique name, used in links and output ids.", nameInput);

    for (const s of schema?.inputs ?? []) {
      const current = c.inputs?.[s.key];
      const hint = s.default !== undefined ? `default ${JSON.stringify(s.default)}` : s.required ? "required" : "";
      let input: HTMLInputElement | HTMLSelectElement;
      if (s.type === "enum" || s.type === "boolean") {
        input = el("select");
        const options = s.type === "enum" ? (s.options ?? []) : ["true", "false"];
        for (const v of ["", ...options]) input.appendChild(Object.assign(el("option", "", v === "" ? `(${hint || "unset"})` : v), { value: v }));
        input.value = current === undefined ? "" : String(current);
      } else {
        input = el("input");
        if (s.type === "number" || s.type === "integer") {
          input.type = "number";
          input.step = s.type === "integer" ? "1" : "any";
        }
        input.placeholder = hint;
        input.value = current === undefined ? "" : typeof current === "string" ? current : JSON.stringify(current);
      }
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        let value: unknown = raw;
        if (raw === "") value = undefined;
        else if (s.type === "number" || s.type === "integer") value = Number(raw);
        else if (s.type === "boolean") value = raw === "true";
        else if (s.type === "sampler" || s.type === "rateProfile") {
          try {
            value = JSON.parse(raw);
          } catch {
            input.setAttribute("aria-invalid", "true");
            return;
          }
        }
        const inputs = (c.inputs ??= {});
        if (value === undefined) delete inputs[s.key];
        else inputs[s.key] = value;
        if (Object.keys(inputs).length === 0) delete c.inputs;
        commit();
      });
      const unit = s.unit === "time" ? " (s)" : s.unit === "rate" ? " (/s)" : "";
      const example = s.type === "sampler" ? ' A number, or e.g. {"dist":"exponential","mean":0.5}.' : s.type === "rateProfile" ? " [[startSeconds, ratePerSecond], ...]" : "";
      field(s.key + unit, s.description + example, input);
    }

    for (const l of schema?.links ?? []) {
      const select = el("select");
      const current = c.links?.[l.key];
      const valid = comps.filter((x) => x.name !== c.name && (canLink(c.type, l.key, x.type) || x.name === current));
      for (const v of ["", ...valid.map((x) => x.name)])
        select.appendChild(Object.assign(el("option", "", v === "" ? "(none)" : v), { value: v }));
      select.value = current ?? "";
      select.addEventListener("change", () => {
        setLink(model!, c.name, l.key, select.value === "" ? null : select.value);
        commit();
      });
      field(`→ ${l.key}${l.required ? " *" : ""}`, l.description, select);
    }
  }

  return {
    render,
    reset() {
      pos.clear();
      selected = null;
    },
  };
}
