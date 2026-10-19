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

/**
 * Hub-wide directory: which groups exist, and which groups a feed, card or policy URL belongs to (#13).
 *
 * One key per fact (`gid:<id>`, `mi:<url hash>:<id>`), never a read-modify-write of a shared array: KV reads
 * can be up to a minute stale, so concurrent writers to one array overwrite each other. That lost 11 of 16
 * group registrations made a second apart on 2026-10-19. The arrays written before (`groups`,
 * `member:<url>`) are still read, and an id is removed from them when its group drops the URL.
 */
export class Directory {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  private async arr(key: string): Promise<string[]> {
    const v = await this.store.get(key);
    return v ? (JSON.parse(v) as string[]) : [];
  }
  private async listed(prefix: string): Promise<string[]> {
    if (!this.store.list) throw new Error("Directory needs a Store with list()");
    return (await this.store.list(prefix)).map((k) => k.slice(prefix.length));
  }
  private static async urlKey(url: string) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
    return `mi:${Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}:`;
  }
  async groupIds(): Promise<string[]> {
    const [legacy, ids] = await Promise.all([this.arr("groups"), this.listed("gid:")]);
    return [...new Set([...legacy, ...ids])];
  }
  async addGroup(id: string) { await this.store.put(`gid:${id}`, "1"); }
  /** One list per ping, whatever the number of groups on the hub. */
  async groupsFor(url: string): Promise<string[]> {
    const [legacy, ids] = await Promise.all([this.arr(`member:${url}`), this.listed(await Directory.urlKey(url))]);
    return [...new Set([...legacy, ...ids])];
  }
  /** Moves this group's index entries from `before` to `after` (only the URLs that changed are written). */
  async reindex(id: string, before: string[], after: string[]) {
    for (const u of after.filter((x) => !before.includes(x))) await this.store.put(`${await Directory.urlKey(u)}${id}`, "1");
    for (const u of before.filter((x) => !after.includes(x))) {
      await this.store.delete(`${await Directory.urlKey(u)}${id}`);
      const legacy = await this.arr(`member:${u}`);
      if (!legacy.includes(id)) continue;
      const rest = legacy.filter((x) => x !== id);
      if (rest.length) await this.store.put(`member:${u}`, JSON.stringify(rest));
      else await this.store.delete(`member:${u}`);
    }
  }
}
