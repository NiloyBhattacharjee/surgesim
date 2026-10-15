import { createDefaultRegistry, describeSchema, type InputSpec, type SchemaDescription } from "@surgesim/engine";

/** Every built-in component schema, as plain data. Drives the palette, ports and inspector. */
export const SCHEMAS: SchemaDescription[] = createDefaultRegistry().schemas().map(describeSchema);
const byType = new Map(SCHEMAS.map((s) => [s.type, s]));

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
  const base = type[0]!.toLowerCase() + type.slice(1);
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
  const canvas = el("div", "canvas");
  const inspector = el("div", "inspector");
  root.replaceChildren(palette, canvas, inspector);
  const pos = new Map<string, { x: number; y: number }>();
  let selected: string | null = null;
  let model: Model | null = null;

  for (const s of SCHEMAS) {
    const chip = el("button", "chip", s.type);
    chip.type = "button";
    chip.title = `${s.description} Drag onto the canvas, or click to add.`;
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-surgesim-type", s.type));
    chip.addEventListener("click", () => add(s.type, null));
    palette.appendChild(chip);
  }
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
      canvas.appendChild(el("p", "hint", "The JSON does not parse as a model. Fix it in the JSON tab to see the diagram."));
      return;
    }
    const comps = model.components ?? [];
    if (comps.length === 0) canvas.appendChild(el("p", "hint", "Drag a component from the palette onto the canvas."));
    const grid = layout(model);
    const svg = document.createElementNS(SVG, "svg");
    canvas.appendChild(svg);
    const nodes = new Map<string, HTMLElement>();
    for (const c of comps) {
      const [d, lane] = grid.get(c.name)!;
      const p = pos.get(c.name) ?? { x: 16 + lane * 190, y: 16 + d * 150 };
      pos.set(c.name, p);
      const node = el("div", "node");
      if (c.name === selected) node.classList.add("selected");
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      node.append(el("div", "type", c.type), el("div", "name", c.name));
      for (const l of byType.get(c.type)?.links ?? []) {
        const row = el("div", "port-row", l.key);
        row.title = l.description;
        const dot = el("span", "port");
        dot.dataset.key = l.key;
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
      svg.replaceChildren();
      svg.setAttribute("width", String(canvas.scrollWidth));
      svg.setAttribute("height", String(canvas.scrollHeight));
      for (const c of comps)
        for (const [key, t] of Object.entries(c.links ?? {})) {
          const from = nodes.get(c.name)?.querySelector<HTMLElement>(`.port[data-key="${CSS.escape(key)}"]`);
          const to = nodes.get(t);
          if (!from || !to) continue;
          const a = centre(from);
          const b = { x: to.offsetLeft + to.offsetWidth / 2, y: to.offsetTop };
          svg.appendChild(curve(a, b, isPull(c.type, key)));
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
        p.x = Math.max(0, origin.x + now.x - start.x);
        p.y = Math.max(0, origin.y + now.y - start.y);
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
      let line: SVGPathElement | null = null;
      dot.onpointermove = (ev) => {
        line?.remove();
        line = curve(a, local(ev), false);
        line.classList.add("pending");
        svg.appendChild(line);
      };
      dot.onpointerup = (ev) => {
        dot.onpointermove = dot.onpointerup = null;
        line?.remove();
        if (line === null) return; // a click, not a drag
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".node")?.dataset.name;
        setLink(model!, name, key, target && target !== name ? target : null);
        commit();
      };
    }

    requestAnimationFrame(drawEdges);
    const sel = comps.find((c) => c.name === selected);
    if (sel) inspect(sel, comps);
    else inspector.appendChild(el("p", "hint", "Click a component to edit it. Drag from a port (●) to another component to link them; drop on empty space to unlink."));
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
    head.appendChild(el("strong", "", c.type));
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
      for (const v of ["", ...comps.filter((x) => x.name !== c.name).map((x) => x.name)])
        select.appendChild(Object.assign(el("option", "", v === "" ? "(none)" : v), { value: v }));
      select.value = c.links?.[l.key] ?? "";
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
