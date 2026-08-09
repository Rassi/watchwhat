/**
 * Records what actually happens to the posters during a stale open.
 *
 * Temporary — delete this file, its card in Settings, and its entry in the router when the
 * flicker is understood.
 *
 * Two theories, and synthetic pages could not separate them. Either the posters are being
 * re-fetched (the grid rebuild resets a lazy image that has not started loading, so it goes back
 * to the end of the browser's six-at-a-time queue), or the bytes never left and iOS is throwing
 * away *decoded* images under memory pressure and re-decoding them on each reattach.
 *
 * The discriminator is whether a poster that blanks and comes back cost a request. Resource
 * timings answer that: if in-view posters drop while the image request count sits still, nothing
 * was re-fetched and the blanking is in the decoder. If the count climbs in step, it is the
 * queue. Neither, and the rebuild is not what does it and this whole line is wrong.
 */

import { dbGetAll, dbPut } from "../data/db";
import type { ProgressRec } from "../data/model";

const REPORT_KEY = "watchwhat.flickerReport";
const ARMED_KEY = "watchwhat.flickerArmed";
const SAMPLE_MS = 250;
const RUN_MS = 30000;

interface Sample {
  /** Milliseconds since recording started. */
  t: number;
  /** Poster <img> elements in the viewport. */
  inView: number;
  /** How many of those are showing a picture. */
  up: number;
  /** Cumulative requests to the image CDN since the start. */
  imgReqs: number;
  /** Cumulative requests to the TMDB API since the start — the refresh's own traffic. */
  apiReqs: number;
  /** Grid rebuilds since the start. */
  rebuilds: number;
  /** Longest frame in this interval, in ms. A stalled main thread shows up here. */
  worstFrame: number;
}

export interface FlickerReport {
  at: string;
  samples: Sample[];
  verdict: string;
}

/**
 * Age every progress record past its TTL, which is the whole of what "closed for 12 hours" means
 * to this app — `progressTtlMs` is 12h for a running show. The next visit to Shows then does the
 * full bulk refresh for real, rather than a simulation of one.
 */
export async function backdateProgress(): Promise<number> {
  const all = await dbGetAll<ProgressRec>("progress");
  const stale = Date.now() - 13 * 3600 * 1000;
  for (const rec of all) {
    rec.fetchedAt = stale;
    await dbPut("progress", rec.traktId, rec);
  }
  return all.length;
}

/**
 * Record the *next* launch instead of this one.
 *
 * The symptom needs a cold start as much as it needs a stale library: a fresh process with an
 * empty in-memory image cache, which is what iOS hands back after reclaiming the app overnight.
 * Recording from a button can only ever catch the second half of that. So this ages the library,
 * leaves a flag, and lets the next launch pick it up — force-quit in between and the run is the
 * real thing rather than an imitation of it.
 */
export async function armNextLaunch(): Promise<number> {
  const n = await backdateProgress();
  localStorage.setItem(ARMED_KEY, "1");
  return n;
}

export function isArmed(): boolean {
  return localStorage.getItem(ARMED_KEY) === "1";
}

export function disarm(): void {
  localStorage.removeItem(ARMED_KEY);
}

/** Called from main.ts on every launch; does nothing unless armed. */
export function maybeRecordThisLaunch(): void {
  if (!isArmed()) return;
  disarm(); // one launch only, however the run turns out
  startRecording();
}

function countResources(host: string): number {
  return performance.getEntriesByType("resource").filter((e) => e.name.includes(host)).length;
}

export function isRecording(): boolean {
  return recording;
}

let recording = false;

/** Sample the grid until `RUN_MS` is up, then stash the report for the Settings card to show. */
export function startRecording(): void {
  if (recording) return;
  recording = true;

  // The buffer holds 250 entries by default and the refresh alone spends most of that.
  performance.setResourceTimingBufferSize?.(2000);
  performance.clearResourceTimings?.();

  const t0 = performance.now();
  const samples: Sample[] = [];
  let rebuilds = 0;
  let worstFrame = 0;
  let lastFrame = performance.now();

  const observer = new MutationObserver((records) => {
    // A grid rebuild empties a container in one shot; ordinary DOM edits do not.
    for (const r of records) if (r.removedNodes.length > 3) rebuilds++;
  });
  // On an armed launch this runs before the router has mounted anything, so watch the body and
  // let #app appear underneath it.
  observer.observe(document.getElementById("app") ?? document.body, { childList: true, subtree: true });

  const frame = (now: number): void => {
    worstFrame = Math.max(worstFrame, now - lastFrame);
    lastFrame = now;
    if (recording) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const tick = (): void => {
    const posters = [...document.querySelectorAll<HTMLImageElement>("img.poster")];
    const inView = posters.filter((n) => {
      const r = n.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
    samples.push({
      t: Math.round(performance.now() - t0),
      inView: inView.length,
      up: inView.filter((n) => n.complete && n.naturalWidth > 0).length,
      imgReqs: countResources("image.tmdb.org"),
      apiReqs: countResources("api.themoviedb.org"),
      rebuilds,
      worstFrame: Math.round(worstFrame),
    });
    worstFrame = 0;
  };

  const sampler = setInterval(tick, SAMPLE_MS);
  tick();

  setTimeout(() => {
    clearInterval(sampler);
    observer.disconnect();
    recording = false;
    const report: FlickerReport = { at: new Date().toISOString(), samples, verdict: verdictOf(samples) };
    localStorage.setItem(REPORT_KEY, JSON.stringify(report));
  }, RUN_MS);
}

/**
 * Read the dip, if there was one, and say which theory it fits.
 *
 * The peak is taken before the trough deliberately: posters start at zero on a cold grid, and a
 * run that simply loads them slowly would otherwise read as a collapse from nothing to nothing.
 */
function verdictOf(samples: Sample[]): string {
  const settled = samples.filter((s) => s.inView > 0);
  if (settled.length < 4) return "Nothing to read — no posters were on screen.";

  let peak = settled[0]!;
  let trough: Sample | null = null;
  for (const s of settled) {
    if (s.up > peak.up && !trough) peak = s;
    else if (s.up < peak.up * 0.6 && (!trough || s.up < trough.up)) trough = s;
  }
  const last = settled[settled.length - 1]!;
  if (!trough) {
    return (
      `No dip: posters held at ${peak.up} of ${peak.inView} throughout ` +
      `(${last.rebuilds} rebuilds, ${last.apiReqs} API calls). Whatever you saw, it did not happen here.`
    );
  }

  const recovery = settled.find((s) => s.t > trough!.t && s.up >= peak.up * 0.9);
  const refetched = recovery ? recovery.imgReqs - trough.imgReqs : 0;
  const base =
    `Dipped from ${peak.up} to ${trough.up} of ${trough.inView} posters at ${(trough.t / 1000).toFixed(1)}s, ` +
    `${recovery ? `back to ${recovery.up} at ${(recovery.t / 1000).toFixed(1)}s` : "never recovered"}. ` +
    `${last.rebuilds} rebuilds, ${last.apiReqs} API calls, worst frame ${Math.max(...settled.map((s) => s.worstFrame))}ms. `;
  if (!recovery) return base;
  return (
    base +
    (refetched > 2
      ? `Coming back cost ${refetched} image requests, so the posters were re-fetched — it is the loading queue.`
      : `Coming back cost ${refetched} image requests, so the bytes never left — iOS discarded the decoded images.`)
  );
}

export function lastReport(): FlickerReport | null {
  const raw = localStorage.getItem(REPORT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FlickerReport;
  } catch {
    return null;
  }
}

/** The samples as a table, narrow enough to read on a phone. */
export function formatReport(report: FlickerReport): string {
  const head = "   t   up/view  imgs  api  rebuilds  worst";
  const rows = report.samples.map(
    (s) =>
      `${(s.t / 1000).toFixed(1).padStart(5)}  ${String(s.up).padStart(3)}/${String(s.inView).padEnd(3)} ` +
      `${String(s.imgReqs).padStart(5)} ${String(s.apiReqs).padStart(4)} ${String(s.rebuilds).padStart(9)} ` +
      `${String(s.worstFrame).padStart(6)}`,
  );
  return [head, ...rows].join("\n");
}

/** Also useful raw: the recording is small enough to paste into a chat. */
export function reportAsJson(report: FlickerReport): string {
  return JSON.stringify(report);
}

/** Cheap sanity check for the Settings card — how stale the library currently is. */
export async function progressAges(): Promise<string> {
  const all = await dbGetAll<ProgressRec>("progress");
  if (all.length === 0) return "no progress records";
  const hours = all.map((r) => (Date.now() - r.fetchedAt) / 3600000);
  const stale = hours.filter((h) => h > 12).length;
  return `${all.length} shows, ${stale} past the 12h TTL`;
}
