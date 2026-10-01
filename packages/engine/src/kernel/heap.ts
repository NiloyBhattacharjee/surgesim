/**
 * Array-backed binary min-heap. `compare(a, b) < 0` means `a` is popped before `b`.
 * @internal
 */
export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    let i = items.length;
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent] as T;
      if (this.compare(item, p) >= 0) break;
      items[i] = p;
      i = parent;
    }
    items[i] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    let i = 0;
    const n = items.length;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.compare(items[child + 1] as T, items[child] as T) < 0) child++;
      const c = items[child] as T;
      if (this.compare(c, last) >= 0) break;
      items[i] = c;
      i = child;
    }
    items[i] = last;
    return top;
  }
}
