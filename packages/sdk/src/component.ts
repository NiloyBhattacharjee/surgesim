/** A structured authoring problem, mirroring the engine's validation errors. */
export interface BuildProblem {
  component: string | null;
  key: string | null;
  message: string;
}

/** Thrown by {@link Model.toJSON} when the model is structurally wrong (never a bare string). */
export class ModelBuildError extends Error {
  constructor(readonly problems: readonly BuildProblem[]) {
    super(
      `Model has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` +
        problems.map((p) => `  - ${[p.component, p.key].filter((x) => x !== null).join(".") || "(model)"}: ${p.message}`).join("\n"),
    );
    this.name = "ModelBuildError";
  }
}

/** One component in the JSON model format. */
export interface ComponentJson {
  type: string;
  name: string;
  inputs?: Record<string, unknown>;
  links?: Record<string, string>;
  stream?: string;
}

/**
 * A component being authored. Create these with the `Model` builder methods
 * (`model.workerPool("workers", {...})`), which type each component's inputs and links.
 *
 * `Out` is the union of the component's output keys, so `component.output("p99")` is checked.
 */
export class Component<Out extends string = string> {
  /** @internal */
  readonly links = new Map<string, Component<string>>();

  constructor(
    readonly type: string,
    readonly name: string,
    readonly inputs: Readonly<Record<string, unknown>>,
    readonly stream?: string,
  ) {}

  /**
   * Point a link at another component. Use this for forward references and cycles (a pool's
   * `onThrottle` back to the retry policy that feeds it), which cannot be passed at creation.
   */
  link(key: string, target: Component<string>): this {
    this.links.set(key, target);
    return this;
  }

  /** The id of one of this component's outputs, e.g. `"sink.p99"`, for assertions and time series. */
  output(key: Out): string {
    return `${this.name}.${key}`;
  }

  /** @internal */
  toJSON(): ComponentJson {
    const inputs = Object.fromEntries(Object.entries(this.inputs).filter(([, v]) => v !== undefined));
    const links = Object.fromEntries([...this.links].map(([k, target]) => [k, target.name]));
    return {
      type: this.type,
      name: this.name,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(this.links.size > 0 ? { links } : {}),
      ...(this.stream !== undefined ? { stream: this.stream } : {}),
    };
  }
}
