/** Disjoint-set forest over arbitrary keys (path compression). Keys are added implicitly on first use. */
export class UnionFind<K> {
  private readonly parent = new Map<K, K>();

  find(x: K): K {
    let r = x;
    for (let p = this.parent.get(r); p !== undefined && p !== r; p = this.parent.get(r)) r = p;
    while (x !== r) { const n = this.parent.get(x)!; this.parent.set(x, r); x = n; }
    if (!this.parent.has(r)) this.parent.set(r, r);
    return r;
  }

  union(a: K, b: K): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}
