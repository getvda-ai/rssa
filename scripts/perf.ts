// Performance tests for RSS-A v0.1: each measurement maps to a claim in the spec or the design
// document (see docs/PERF-RESULTS.md). Runs the real SDK and the real hub code in Node with an
// instrumented in-memory store and fetch, so counts (subrequests, KV reads/writes, signature
// verifications) are exact and timings are CPU-bound. Not part of `npm test`.
//
//   node scripts/perf.ts            → all sections, human-readable
//   node scripts/perf.ts --json     → also writes docs/perf-results.json

import { writeFileSync } from "node:fs";
import { Hub, type Store } from "../hub/src/hub.ts";
import {
  canonicalize, contentHash, entryPayload, keyFromSeed, localFilter, readGroup, signEntry, verifyEntry, type RssaEntry,
} from "../packages/sdk-js/src/index.ts";
import { BASE, POLICY, T0, buildGroup, cardUrl, entryFor, feedUrl, publish, seed, type Group } from "./synthetic.ts";

const out: Record<string, unknown> = {};
const log = (s = "") => console.log(s);
const ms = (n: number) => `${n.toFixed(n < 1 ? 3 : n < 10 ? 2 : 1)} ms`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---------- instruments ----------

// Count signature verifications and key imports by wrapping the global WebCrypto.
const counters = { verify: 0, importKey: 0, digest: 0 };
const subtle = crypto.subtle as any;
for (const name of ["verify", "importKey", "digest"] as const) {
  const orig = subtle[name].bind(subtle);
  Object.defineProperty(subtle, name, { value: (...a: unknown[]) => { counters[name]++; return orig(...a); }, configurable: true });
}
const resetCounters = () => { counters.verify = 0; counters.importKey = 0; counters.digest = 0; };

/** v0.2 storage: keys under `r:` are a group's SQLite rows (Durable Object); the rest is the KV directory.
 * Rows read/written are what Durable Objects bill; a row may be at most 2 MB. */
const ROW_LIMIT = 2_000_000;
interface CountingStore extends Store {
  m: Map<string, string>; reads: number; writes: number; rowReads: number; rowWrites: number; kvReads: number; kvWrites: number;
  bytesRead: number; bytesWritten: number; oversize: string[]; reset(): void;
}
function countingStore(): CountingStore {
  const m = new Map<string, string>();
  const row = (k: string) => k.startsWith("r:");
  const s: CountingStore = {
    m, reads: 0, writes: 0, rowReads: 0, rowWrites: 0, kvReads: 0, kvWrites: 0, bytesRead: 0, bytesWritten: 0, oversize: [],
    reset() { s.reads = s.writes = s.rowReads = s.rowWrites = s.kvReads = s.kvWrites = s.bytesRead = s.bytesWritten = 0; s.oversize = []; },
    get: async (k) => { s.reads++; if (row(k)) s.rowReads++; else s.kvReads++; const v = m.get(k) ?? null; s.bytesRead += v?.length ?? 0; return v; },
    put: async (k, v) => { s.writes++; if (row(k)) s.rowWrites++; else s.kvWrites++; s.bytesWritten += v.length; if (v.length > ROW_LIMIT) s.oversize.push(`${k} (${(v.length / 1048576).toFixed(1)} MiB)`); m.set(k, v); },
    delete: async (k) => { s.writes++; if (row(k)) s.rowWrites++; else s.kvWrites++; m.delete(k); },
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  };
  return s;
}

function newHub(g: Group, store = countingStore(), at = T0 + 86_400_000) {
  let t = at;
  const hub = new Hub({ store, fetch: g.web.fetcher, now: () => t, adminToken: "x", baseUrl: "https://hub.perf.test" });
  return { hub, store, tick: (d: number) => { t += d; } };
}

async function measure<T>(fn: () => Promise<T>) {
  // process.cpuUsage() ticks in ~16 ms steps on Windows, so CPU is taken as wall time: every fetch
  // and store call is in-process (no latency injected), so wall time here is CPU time.
  const w0 = performance.now();
  const r = await fn();
  const w = performance.now() - w0;
  return { r, wall: w, cpu: w };
}

// ---------- A. per-entry cost (claim: Ed25519 verify ≈ 0.1 ms) ----------

async function sectionA() {
  log("A. Per-entry signing and verification cost (claim: an Ed25519 verify costs about 0.1 ms of CPU)");
  const key = await keyFromSeed(seed(1));
  const es = await Promise.all(Array.from({ length: 2000 }, (_, n) => entryFor(0, n, 0, key)));
  for (const e of es.slice(0, 200)) await verifyEntry(e, feedUrl(0), [key.publicJwk]); // warm
  const runs: Record<string, number> = {};
  const time = async (name: string, f: (e: RssaEntry) => Promise<unknown> | unknown) => {
    const t0 = performance.now();
    for (const e of es) await f(e);
    runs[name] = (performance.now() - t0) / es.length;
  };
  const raw = es.map((e) => ({ e, input: new TextEncoder().encode(e.sig!.split(".")[0] + ".x"), sig: new Uint8Array(64) }));
  const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.publicJwk.x } as JsonWebKey, { name: "Ed25519" } as any, false, ["verify"]);
  let i = 0;
  await time("raw Ed25519 verify (key imported once)", async () => { const x = raw[i++ % raw.length]; await crypto.subtle.verify({ name: "Ed25519" } as any, pub, x.sig, x.input); });
  await time("canonicalize payload", async (e) => canonicalize(await entryPayload(e, feedUrl(0))));
  await time("contentHash", (e) => contentHash(e));
  await time("signEntry", (e) => signEntry({ ...e, sig: undefined }, feedUrl(0), key));
  resetCounters();
  await time("verifyEntry (SDK, full)", (e) => verifyEntry(e, feedUrl(0), [key.publicJwk]));
  const perVerify = { importKey: counters.importKey / es.length, digest: counters.digest / es.length, verify: counters.verify / es.length };
  for (const [k, v] of Object.entries(runs)) log(`   ${k.padEnd(42)} ${ms(v)}`);
  log(`   per verifyEntry: ${perVerify.verify} verify, ${perVerify.importKey} importKey, ${perVerify.digest} sha256 calls`);
  out.A = { perEntryMs: runs, perVerify };
  log();
}

// ---------- B. hub refresh scaling ----------

async function sectionB() {
  log("B. Hub refresh cost vs group size (20 entries per member feed, standard preset, signatures required)");
  log("   members | first refresh: cpu   verifies subreq rowsR rowsW written | steady (1 new post, ETag 304s): cpu subreq rowsW | steady, no ETags: cpu verifies");
  const rows: unknown[] = [];
  for (const members of [3, 10, 30, 100, 300]) {
    const g = await buildGroup(members, 20, { etags: true });
    const { hub, store, tick } = newHub(g);
    const { id } = await hub.register(POLICY);
    store.reset(); g.web.resetCount(); resetCounters();
    const first = await measure(() => hub.refresh(id));
    const firstRow = { cpu: first.cpu, wall: first.wall, accepted: first.r.length, verifies: counters.verify, subrequests: g.web.subrequests, rowReads: store.rowReads, rowWrites: store.rowWrites, kvWrites: store.kvWrites, bytesWritten: store.bytesWritten };
    // Steady state: one member posts one new entry; the other feeds answer 304.
    tick(60_000);
    const es = g.entries[0];
    es.push(await entryFor(0, 1000, 0, g.keys[0]));
    publish(g.web, 0, es);
    store.reset(); g.web.resetCount(); resetCounters();
    const steady = await measure(() => hub.refresh(id));
    const steadyRow = { cpu: steady.cpu, accepted: steady.r.length, verifies: counters.verify, subrequests: g.web.subrequests, rowReads: store.rowReads, rowWrites: store.rowWrites, kvWrites: store.kvWrites, bytesWritten: store.bytesWritten };
    // Same without ETags (an origin that sends none): every feed is re-downloaded and re-parsed.
    const g2 = await buildGroup(members, 20, { etags: false });
    const h2 = newHub(g2);
    const { id: id2 } = await h2.hub.register(POLICY);
    await h2.hub.refresh(id2);
    h2.tick(60_000); resetCounters();
    const noEtag = await measure(() => h2.hub.refresh(id2));
    const noEtagRow = { cpu: noEtag.cpu, accepted: noEtag.r.length, verifies: counters.verify };
    log(`   ${String(members).padStart(7)} | ${ms(firstRow.cpu).padStart(10)} ${String(firstRow.verifies).padStart(8)} ${String(firstRow.subrequests).padStart(6)} ${String(firstRow.rowReads).padStart(5)} ${String(firstRow.rowWrites).padStart(5)} ${(firstRow.bytesWritten / 1024).toFixed(0).padStart(5)} KiB | ${ms(steadyRow.cpu).padStart(10)} ${String(steadyRow.subrequests).padStart(6)} ${String(steadyRow.rowWrites).padStart(5)} | ${ms(noEtagRow.cpu).padStart(10)} ${String(noEtagRow.verifies).padStart(4)}  (accepted ${noEtagRow.accepted})`);
    rows.push({ members, first: firstRow, steady: steadyRow, noEtag: noEtagRow });
  }
  out.B = rows;
  log();
}

// ---------- C. cheap checks before crypto ----------

async function sectionC() {
  log("C. Cheap checks before crypto (claim: garbage never reaches the signature step)");
  const g = await buildGroup(3, 0, { etags: true });
  const key = g.keys[1];
  // Member 1 floods 400 entries: 20 oversize (hub size check; more would push the feed past the
  // 2 MB feed limit and refuse it whole), 380 breaking group policy (summary > 280 characters).
  const junk: RssaEntry[] = [];
  for (let n = 0; n < 400; n++) {
    const e = await entryFor(1, n, 0, key);
    if (n < 20) e.content = "x".repeat(70_000); else e.summary = "y".repeat(400);
    junk.push(e);
  }
  publish(g.web, 1, junk);
  const { hub, store } = newHub(g);
  const { id } = await hub.register(POLICY);
  resetCounters();
  const r = await measure(() => hub.refresh(id));
  const status = await (await hub.handle(new Request(`https://hub.perf.test/g/${id}/status.json`))).json() as any;
  log(`   400 junk entries from a member: ${counters.verify} signature verifications, ${ms(r.cpu)} cpu, accepted ${r.r.length}, rejected ${status.rejected.length > 0 ? "(log shows " + status.rejected.length + ", capped)" : "none — check"}; member problem: ${status.members.find((m: any) => !m.ok)?.problem ?? "none"}`);

  // Non-member WebSub pings: what one unauthenticated junk ping costs the hub, by hub size.
  const rows: unknown[] = [];
  for (const groups of [1, 10, 100]) {
    const s = countingStore();
    const fakeG = await buildGroup(10, 1, { etags: true });
    const h = newHub(fakeG, s).hub;
    // One real group plus `groups - 1` other ids in the directory (a ping never looks at them in v0.2).
    const { id: realId } = await h.register(POLICY);
    await h.refresh(realId);
    const ids = [realId];
    for (let k = 1; k < groups; k++) ids.push(k.toString(16).padStart(12, "0"));
    s.m.set("groups", JSON.stringify(ids));
    s.reset();
    const res = await measure(() => h.handle(new Request("https://hub.perf.test/", { method: "POST", body: "hub.mode=publish&hub.url=https%3A%2F%2Fspam.example%2Ffeed" })));
    log(`   junk ping, hub with ${String(groups).padStart(3)} groups × 10 members: HTTP ${res.r.status}, ${s.kvReads} KV reads, ${s.rowReads} row reads, ${ms(res.cpu)} cpu`);
    rows.push({ groups, status: res.r.status, kvReads: s.kvReads, rowReads: s.rowReads, cpu: res.cpu });
  }
  out.C = { junkEntries: { verifies: counters.verify, cpu: r.cpu }, junkPing: rows };
  log();
}

// ---------- D. reader cost (claim: cost per post stays flat however many members ask for filters) ----------

async function sectionD() {
  log("D. Reader cost on the hub (claim: large groups pull one cached merged feed; filtering is cheap)");
  const g = await buildGroup(25, 20, { etags: true });
  const { hub, store } = newHub(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  const url = `https://hub.perf.test/g/${id}/feed.atom`;
  const one = async (path: string, headers: Record<string, string> = {}) => {
    store.reset();
    const xs: number[] = [];
    let status = 0, bytes = 0;
    for (let k = 0; k < 30; k++) {
      const m = await measure(async () => { const r = await hub.handle(new Request(path, { headers })); status = r.status; bytes = (await r.text()).length; });
      xs.push(m.cpu);
    }
    return { cpu: median(xs), status, responseBytes: bytes, rowReadsPerReq: store.rowReads / 30, kvReadsPerReq: store.kvReads / 30, bytesReadPerReq: store.bytesRead / 30, writesPerReq: store.writes / 30 };
  };
  const etag = (await hub.handle(new Request(url))).headers.get("etag")!;
  const rows = {
    "GET feed.atom (500 entries)": await one(url),
    "GET feed.atom If-None-Match (304)": await one(url, { "if-none-match": etag }),
    "GET feed.atom?to=role:ops": await one(`${url}?to=role:ops`),
    "GET feed.atom?type=answer.": await one(`${url}?type=answer.`),
    "GET status.json": await one(`https://hub.perf.test/g/${id}/status.json`),
  };
  // Identified readers: first read of the day writes; many distinct readers each write once.
  store.reset();
  for (let k = 0; k < 200; k++) await hub.handle(new Request(url, { headers: { "user-agent": `x reader=https://r${k}.example/card.json` } }));
  const readerWrites = store.rowWrites;
  for (const [k, v] of Object.entries(rows)) log(`   ${k.padEnd(36)} ${ms(v.cpu).padStart(9)} cpu, ${v.rowReadsPerReq} row reads + ${v.kvReadsPerReq} KV reads (${(v.bytesReadPerReq / 1024).toFixed(0)} KiB), ${v.writesPerReq} writes, HTTP ${v.status}, ${(v.responseBytes / 1024).toFixed(0)} KiB out`);
  log(`   200 distinct identified readers: ${readerWrites} row writes (one row per reader per day; no shared key to contend on)`);
  out.D = { rows, identifiedReaders: { readers: 200, rowWrites: readerWrites } };
  log();
}

// ---------- E. push latency (claim: WebSub pushes in seconds) ----------

async function sectionE() {
  log("E. Ping → push latency (claim: WebSub pushes in seconds), 100 ms per outbound request (typical cross-cloud RTT)");
  const rows: unknown[] = [];
  for (const [members, subs] of [[3, 1], [10, 1], [30, 1], [100, 1], [10, 50]] as const) {
    const g = await buildGroup(members, 5, { etags: true, latencyMs: 100 });
    const { hub } = newHub(g);
    const { id } = await hub.register(POLICY);
    await hub.refresh(id);
    for (let k = 0; k < subs; k++) {
      await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": `https://sub${k}.example/cb`, "hub.topic": hub.groupFeedUrl(id) }));
    }
    g.entries[0].push(await entryFor(0, 500, 0, g.keys[0]));
    publish(g.web, 0, g.entries[0]);
    g.web.resetCount();
    const t0 = performance.now();
    let firstPush = 0;
    const origFetch = g.web.fetcher;
    const res = await hub.websub(new URLSearchParams({ "hub.mode": "publish", "hub.url": feedUrl(0) }));
    const total = performance.now() - t0;
    void origFetch; void firstPush;
    log(`   ${String(members).padStart(3)} members, ${String(subs).padStart(2)} subscriber(s): ping handled in ${(total / 1000).toFixed(2)} s (${g.web.subrequests} subrequests, ${g.web.posted.length} pushes), HTTP ${res.status}`);
    rows.push({ members, subscribers: subs, seconds: total / 1000, subrequests: g.web.subrequests, pushes: g.web.posted.length });
  }
  out.E = rows;
  log();
}

// ---------- F. limits and state size ----------

async function sectionF() {
  log("F. Limits: worst-case group state vs the 2 MB SQLite row limit (Durable Objects)");
  // 50 members × 10 entries × 60 KiB content: every feed is under the hub's 2 MB feed limit and every
  // entry under its 64 KiB content limit, so the hub accepts all of it.
  const g = await buildGroup(50, 10, { etags: true, contentBytes: 60_000 });
  const { hub, store } = newHub(g);
  const { id } = await hub.register(POLICY);
  const r = await hub.refresh(id);
  const rowsOf = [...store.m.entries()].filter(([k]) => k.startsWith(`r:${id}:`));
  const total = rowsOf.reduce((n, [, v]) => n + v.length, 0);
  const largest = Math.max(...rowsOf.map(([, v]) => v.length));
  const xmlRows = rowsOf.filter(([k]) => k.startsWith(`r:${id}:xml:`)).length;
  const sizes = { rows: rowsOf.length, totalBytes: total, largestRow: largest, xmlChunks: xmlRows };
  log(`   accepted ${r.length} entries; ${rowsOf.length} rows, ${(total / 1048576).toFixed(1)} MiB in all; largest row ${(largest / 1024).toFixed(0)} KiB; merged feed in ${xmlRows} chunks`);
  log(`   rows over the 2 MB limit (would fail in production): ${store.oversize.join(", ") || "none"}`);
  out.F = { accepted: r.length, sizes, oversize: store.oversize };
  log();
}

// ---------- G. maxEntries overflow ----------

async function sectionG() {
  log("G. Groups holding more than maxEntries (500): what a no-change refresh does");
  for (const etags of [true, false]) {
    const g = await buildGroup(30, 20, { etags }); // 600 entries
    const { hub, tick } = newHub(g);
    const { id } = await hub.register(POLICY);
    const first = await hub.refresh(id);
    const subs = await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": "https://sub.example/cb", "hub.topic": hub.groupFeedUrl(id) }));
    void subs;
    const runs: number[] = [], verifies: number[] = [], pushes: number[] = [];
    for (let k = 0; k < 3; k++) {
      tick(300_000); resetCounters(); g.web.resetCount();
      // One member edits nothing but its feed is re-served (e.g. a cache refresh changes the ETag).
      publish(g.web, 0, [...g.entries[0]]);
      runs.push((await hub.refresh(id)).length);
      verifies.push(counters.verify);
      pushes.push(g.web.posted.length);
    }
    log(`   ETags ${etags ? "on " : "off"}: first refresh accepted ${first.length}; three later refreshes with NO new posts accepted ${runs.join(", ")}, verified ${verifies.join(", ")} signatures, sent ${pushes.join(", ")} WebSub pushes`);
    (out.G ??= [] as unknown[]) as unknown[];
    (out.G as unknown[]).push({ etags, first: first.length, laterAccepted: runs, laterVerifies: verifies, laterPushes: pushes });
  }
  log();
}

// ---------- H. key rotation reach (claim: within 15 minutes) ----------

async function sectionH() {
  log("H. Key rotation reaches the hub (claim: within 15 minutes)");
  const g = await buildGroup(3, 2, { etags: false });
  const { hub, tick } = newHub(g);
  const { id } = await hub.register(POLICY);
  await hub.refresh(id);
  // Agent 0 rotates: new key in its card, new post signed with it.
  const k2 = await keyFromSeed(seed(5000));
  const card = JSON.parse(g.web.docs.get(cardUrl(0))!);
  card.capabilities.extensions[0].params.keys = { keys: [k2.publicJwk] };
  g.web.docs.set(cardUrl(0), JSON.stringify(card));
  g.entries[0].push(await entryFor(0, 900, 0, k2));
  publish(g.web, 0, g.entries[0]);
  const at: string[] = [];
  for (const minutes of [5, 10, 14, 16]) {
    tick((minutes - (at.length ? [5, 10, 14, 16][at.length - 1] : 0)) * 60_000);
    const acc = await hub.refresh(id);
    at.push(`${minutes} min: ${acc.includes("tag:perf.test,2026:a0-900") ? "accepted" : "held"}`);
  }
  // Urgent path: a ping on the card URL forces a refetch immediately.
  const g2 = await buildGroup(3, 2, { etags: false });
  const h2 = newHub(g2);
  const { id: id2 } = await h2.hub.register(POLICY);
  await h2.hub.refresh(id2);
  const c2 = JSON.parse(g2.web.docs.get(cardUrl(0))!);
  c2.capabilities.extensions[0].params.keys = { keys: [k2.publicJwk] };
  g2.web.docs.set(cardUrl(0), JSON.stringify(c2));
  g2.entries[0].push(await entryFor(0, 900, 0, k2));
  publish(g2.web, 0, g2.entries[0]);
  h2.tick(60_000);
  await h2.hub.websub(new URLSearchParams({ "hub.mode": "publish", "hub.url": cardUrl(0) }));
  const xml2 = await (await h2.hub.handle(new Request(`https://hub.perf.test/g/${id2}/feed.atom`))).text();
  const urgent = xml2.includes("tag:perf.test,2026:a0-900");
  const s1 = await (await hub.handle(new Request(`https://hub.perf.test/g/${id}/status.json`))).json() as any;
  const why = s1.rejected.filter((x: any) => x.id === "tag:perf.test,2026:a0-900").map((x: any) => x.reasons.join("; "));
  log(`   scheduled path (cron, card TTL 15 min): ${at.join("; ")}`);
  log(`   rejection log for the rotated-key post: ${why.length} record(s): ${why[0] ?? "-"}`);
  log(`   urgent path (agent pings its card URL): ${urgent ? "accepted at once" : "held"}`);
  out.H = { scheduled: at, urgent, rejectedAs: why };
  log();
}

// ---------- I. hubless reading and local filtering ----------

async function sectionI() {
  log("I. Hubless group read (readGroup) and consumer-side filtering (claim: plain code drops most items at zero token cost)");
  const rows: unknown[] = [];
  for (const members of [3, 10, 30, 100]) {
    const g = await buildGroup(members, 20, { etags: false });
    g.web.resetCount(); resetCounters();
    const r = await measure(() => readGroup(POLICY, { fetcher: g.web.fetcher }));
    const f = await measure(async () => localFilter(r.r.entries, { signedOnly: true, types: ["answer."], to: ["role:ops", "group"] }));
    log(`   ${String(members).padStart(3)} members: ${r.r.entries.length} entries read and verified in ${ms(r.cpu)} cpu (${g.web.subrequests} requests); local filter kept ${f.r.length} in ${ms(f.cpu)}`);
    rows.push({ members, entries: r.r.entries.length, cpu: r.cpu, requests: g.web.subrequests, filterKept: f.r.length, filterCpu: f.cpu });
  }
  out.I = rows;
  log();
}

// ---------- J. what a ping costs (v0.2: member index + targeted refresh in the group's Durable Object) ----------

async function sectionJ() {
  log("J. Ping cost (v0.2): member index + targeted refresh; rows written per accepted post (the cost model's biggest input)");
  const rows: unknown[] = [];
  for (const [members, subs] of [[10, 0], [10, 1], [20, 1], [100, 1]] as const) {
    const g = await buildGroup(members, 5, { etags: true });
    const store = countingStore();
    const { hub, tick } = newHub(g, store);
    const { id } = await hub.register(POLICY);
    await hub.refresh(id);
    for (let k = 0; k < subs; k++) await hub.websub(new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": `https://sub${k}.example/cb`, "hub.topic": hub.groupFeedUrl(id) }));
    const per: Array<{ kvReads: number; rowReads: number; rowWrites: number; fetches: number; pushes: number; cpu: number }> = [];
    for (let n = 0; n < 5; n++) {
      tick(600_000);
      const i = n % members;
      g.entries[i].push(await entryFor(i, 700 + n, 0, g.keys[i]));
      publish(g.web, i, g.entries[i]);
      store.reset(); g.web.resetCount();
      const m = await measure(() => hub.websub(new URLSearchParams({ "hub.mode": "publish", "hub.url": feedUrl(i) })));
      per.push({ kvReads: store.kvReads, rowReads: store.rowReads, rowWrites: store.rowWrites, fetches: g.web.subrequests - g.web.posted.length, pushes: g.web.posted.length, cpu: m.cpu });
    }
    const avg = (k: keyof (typeof per)[number]) => per.reduce((x, p) => x + p[k], 0) / per.length;
    // An idle full poll (every feed 304): what the 5-minute alarm costs.
    tick(300_000); store.reset(); g.web.resetCount();
    await hub.refresh(id);
    const poll = { rowWrites: store.rowWrites, fetches: g.web.subrequests };
    log(`   ${String(members).padStart(3)} members, ${subs} subscriber(s): per ping ${avg("kvReads")} KV read, ${avg("fetches")} fetches, ${avg("rowWrites").toFixed(1)} rows written, ${avg("pushes")} pushes, ${ms(avg("cpu"))} | idle poll: ${poll.fetches} fetches, ${poll.rowWrites} rows written`);
    rows.push({ members, subscribers: subs, perPing: { kvReads: avg("kvReads"), fetches: avg("fetches"), rowWrites: avg("rowWrites"), pushes: avg("pushes"), cpu: avg("cpu") }, idlePoll: poll });
  }
  out.J = rows;
  log();
}

const sections: Record<string, () => Promise<void>> = { A: sectionA, B: sectionB, C: sectionC, D: sectionD, E: sectionE, F: sectionF, G: sectionG, H: sectionH, I: sectionI, J: sectionJ };
const only = process.argv.slice(2).filter((a) => /^[A-J]$/.test(a));
log(`RSS-A performance run — node ${process.version}, ${new Date().toISOString()}\n`);
for (const [k, f] of Object.entries(sections)) if (!only.length || only.includes(k)) await f();
if (process.argv.includes("--json")) writeFileSync(new URL("../docs/perf-results.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
