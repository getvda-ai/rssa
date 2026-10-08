// Storage for the hub. Two layers:
// - `Store`: a small key/value store for the hub-wide directory (group list, member index).
//   Workers KV in production, a Map in Node.
// - `GroupStore`: one group's rows, (table, key) → JSON string. SQLite inside the group's Durable
//   Object in production; in Node, rows are kept in a `Store` under prefixed keys, so state survives
//   a new Hub instance over the same store and every row read or written is countable.

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys that start with `prefix`. Needed only by `storeGroupStore`. */
  list?(prefix: string): Promise<string[]>;
}

export interface GroupStore {
  get(table: string, key: string): Promise<string | null>;
  list(table: string): Promise<Array<[string, string]>>;
  /** Applies all puts and deletes atomically. */
  write(puts: Array<[string, string, string]>, dels: Array<[string, string]>): Promise<void>;
}

/** Cloudflare caps a SQLite row at 2 MB; nothing the hub writes may come near it. */
export const MAX_ROW_BYTES = 2_000_000;

/** A GroupStore kept in a Store under `r:<group>:<table>:<key>`. */
export function storeGroupStore(store: Store, group: string): GroupStore {
  const pre = (t: string) => `r:${group}:${t}:`;
  return {
    get: (t, k) => store.get(pre(t) + k),
    async list(t) {
      if (!store.list) throw new Error("storeGroupStore needs a Store with list()");
      const keys = await store.list(pre(t));
      const out: Array<[string, string]> = [];
      for (const key of keys) {
        const v = await store.get(key);
        if (v !== null) out.push([key.slice(pre(t).length), v]);
      }
      return out;
    },
    async write(puts, dels) {
      for (const [t, k, v] of puts) {
        if (v.length > MAX_ROW_BYTES) throw new Error(`row ${t}:${k} is ${v.length} bytes; limit ${MAX_ROW_BYTES}`);
        await store.put(pre(t) + k, v);
      }
      for (const [t, k] of dels) await store.delete(pre(t) + k);
    },
  };
}

/** An in-memory Store (tests, local runs). */
export function memoryStore(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  };
}

/** Hub-wide directory: which groups exist, and which groups a feed, card or policy URL belongs to (#13). */
export class Directory {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  private async arr(key: string): Promise<string[]> {
    const v = await this.store.get(key);
    return v ? (JSON.parse(v) as string[]) : [];
  }
  groupIds() { return this.arr("groups"); }
  async addGroup(id: string) {
    const ids = await this.groupIds();
    if (!ids.includes(id)) await this.store.put("groups", JSON.stringify([...ids, id]));
  }
  /** One read per ping, whatever the number of groups on the hub. */
  groupsFor(url: string) { return this.arr(`member:${url}`); }
  /** Moves this group's index entries from `before` to `after` (only the URLs that changed are written). */
  async reindex(id: string, before: string[], after: string[]) {
    const add = after.filter((u) => !before.includes(u));
    const remove = before.filter((u) => !after.includes(u));
    for (const u of add) {
      const ids = await this.groupsFor(u);
      if (!ids.includes(id)) await this.store.put(`member:${u}`, JSON.stringify([...ids, id]));
    }
    for (const u of remove) {
      const ids = (await this.groupsFor(u)).filter((x) => x !== id);
      if (ids.length) await this.store.put(`member:${u}`, JSON.stringify(ids));
      else await this.store.delete(`member:${u}`);
    }
  }
}
