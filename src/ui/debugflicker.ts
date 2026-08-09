/**
 * Records what actually happens to the posters during a stale open.
 *
 * Temporary — delete this file, its card in Settings, its call in main.ts and `setPosterBuster`
 * in api/tmdb.ts when the flicker is understood.
 *
 * The theories still standing are that the posters are re-fetched (a grid rebuild sends a lazy
 * image that has not started loading back to the end of the browser's six-at-a-time queue), or
 * that the bytes never left and iOS is discarding *decoded* images under memory pressure. The
 * discriminator is whether a poster that blanks and comes back cost a request, which resource
 * timings answer.
 *
 * The hard part has been staging the event rather than reading it. A twelve-hour-old open is
 * three things at once: the library is past its TTL, the process is cold, and the HTTP cache has
 * been purged. Ageing the timestamps covers the first, a force-quit the second, and nothing
 * covers the third — the first attempt at this had all eighty API calls finishing inside 250ms
 * off the disk cache, with no window for anything to flicker in. So there are two modes now: one
 * that fakes the third with cache-busted URLs, and one that simply waits for the real thing.
 */

import { setPosterBuster } from "../api/tmdb";
import { dbGetAll, dbPut } from "../data/db";
import type { ProgressRec } from "../data/model";

const REPORT_KEY = "watchwhat.flickerReport";
const ARMED_KEY = "watchwhat.flickerArmed";
const RUN_MS = 30000;
/** Fine sampling for the opening seconds, where the whole event has so far turned out to live. */
const FAST_MS = 50;
const FAST_UNTIL = 6000;
const SLOW_MS = 250;

type Mode = "real" | "cold";

interface Sample {
  t: number;
  /** Poster <img> elements in the viewport. */
  inView: number;
  /** How many of those are showing a picture. */
  up: number;
  imgReqs: number;
  apiReqs: number;
  rebuilds: number;
  /** Longest frame in this interval, in ms. */
  worstFrame: number;
  /** Which screen, so a dip to zero can be told from you walking off to Settings. */
  at: string;
}

interface ResourceSummary {
  count: number;
  medianMs: number;
  maxMs: number;
}

export interface FlickerReport {
  at: string;
  mode: Mode;
  /** How stale the library was when the run started — the real event's defining feature. */
  staleHours: number;
  samples: Sample[];
  images: ResourceSummary;
  api: ResourceSummary;
  verdict: string;
}

async function ageLibrary(): Promise<number> {
  const all = await dbGetAll<ProgressRec>("progress");
  const stale = Date.now() - 13 * 3600 * 1000;
  for (const rec of all) {
    rec.fetchedAt = stale;
    await dbPut("progress", rec.traktId, rec);
  }
  return all.length;
}

/** Hours since the least recently refreshed show was fetched — 0 if there is nothing stored. */
async function staleHours(): Promise<number> {
  const all = await dbGetAll<ProgressRec>("progress");
  if (all.length === 0) return 0;
  const oldest = Math.min(...all.map((r) => r.fetchedAt));
  return Math.round(((Date.now() - oldest) / 3600000) * 10) / 10;
}

/**
 * Wait for the genuine article.
 *
 * No timestamps are touched: the point is to catch an open that is stale because the app really
 * was shut all night, with a cache that iOS really did purge. Arming survives launches until one
 * of them qualifies, so it can be set now and collected tomorrow morning.
 */
export function armForRealOpen(): void {
  localStorage.setItem(ARMED_KEY, "real");
}

/** Age the library and force cold poster loads on the next launch, without waiting a night. */
export async function armColdSimulation(): Promise<number> {
  const n = await ageLibrary();
  localStorage.setItem(ARMED_KEY, "cold");
  return n;
}

export function armedMode(): Mode | null {
  const v = localStorage.getItem(ARMED_KEY);
  return v === "real" || v === "cold" ? v : null;
}

export function disarm(): void {
  localStorage.removeItem(ARMED_KEY);
}

/**
 * Called from main.ts on every launch.
 *
 * A "real" arming that finds a warm library stays armed and records nothing — that is the whole
 * discipline of it. Anything less and the recording is of an ordinary open, which is exactly the
 * thing that has wasted three rounds.
 */
export function maybeRecordThisLaunch(): void {
  const mode = armedMode();
  if (!mode) return;
  void (async () => {
    const hours = await staleHours();
    if (mode === "real" && hours < 12) return; // not the event; keep waiting
    disarm();
    if (mode === "cold") setPosterBuster(String(Date.now()));
    startRecording(mode, hours);
  })();
}

function resourceEntries(host: string): PerformanceResourceTiming[] {
  return performance.getEntriesByType("resource").filter((e) => e.name.includes(host)) as PerformanceResourceTiming[];
}

function summarize(host: string): ResourceSummary {
  const entries = resourceEntries(host);
  if (entries.length === 0) return { count: 0, medianMs: 0, maxMs: 0 };
  const times = entries.map((e) => Math.round(e.duration)).sort((a, b) => a - b);
  return {
    count: times.length,
    // A median in single-figure milliseconds means the cache served it and the run is warm —
    // which is the check that would have caught the last three false negatives immediately.
    medianMs: times[Math.floor(times.length / 2)]!,
    maxMs: times[times.length - 1]!,
  };
}

let recording = false;

/**
 * Make the refresh's own traffic arrive cold too, for the duration of a faked run.
 *
 * The posters are only half of it. How long the grid churns is set by how long the eighty TMDB
 * calls take, and off the disk cache they finish in a quarter of a second — which is why the
 * first faked run had no window for anything to flicker in. Cold, they take seconds, which is
 * what a twelve-hour-old open actually looks like. TMDB ignores parameters it does not know.
 */
function bustApiCache(): () => void {
  const original = window.fetch;
  const run = Date.now();
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof url === "string" && url.includes("api.themoviedb.org")) {
      const busted = `${url}${url.includes("?") ? "&" : "?"}_cb=${run}`;
      return original.call(window, busted, init);
    }
    return original.call(window, input as RequestInfo, init);
  };
  return () => {
    window.fetch = original;
  };
}

export function startRecording(mode: Mode, hours: number): void {
  if (recording) return;
  recording = true;
  const restoreFetch = mode === "cold" ? bustApiCache() : () => {};

  performance.setResourceTimingBufferSize?.(3000);
  performance.clearResourceTimings?.();

  const t0 = performance.now();
  const samples: Sample[] = [];
  let rebuilds = 0;
  let worstFrame = 0;
  let lastFrame = performance.now();

  const observer = new MutationObserver((records) => {
    for (const r of records) if (r.removedNodes.length > 3) rebuilds++;
  });
  // On an armed launch this runs before the router has mounted anything.
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
      imgReqs: resourceEntries("image.tmdb.org").length,
      apiReqs: resourceEntries("api.themoviedb.org").length,
      rebuilds,
      worstFrame: Math.round(worstFrame),
      at: location.hash.replace(/^#\/?/, "").split("/")[0] || "home",
    });
    worstFrame = 0;
  };

  let timer = setInterval(tick, FAST_MS);
  tick();
  setTimeout(() => {
    clearInterval(timer);
    timer = setInterval(tick, SLOW_MS);
  }, FAST_UNTIL);

  setTimeout(() => {
    clearInterval(timer);
    observer.disconnect();
    recording = false;
    setPosterBuster("");
    restoreFetch();
    const report: FlickerReport = {
      at: new Date().toISOString(),
      mode,
      staleHours: hours,
      samples,
      images: summarize("image.tmdb.org"),
      api: summarize("api.themoviedb.org"),
      verdict: "",
    };
    report.verdict = verdictOf(report);
    localStorage.setItem(REPORT_KEY, JSON.stringify(report));
  }, RUN_MS);
}

function verdictOf(report: FlickerReport): string {
  // Only while posters are actually on screen: navigating to Settings mid-run drops the count to
  // zero, and reading that as the posters vanishing is how the last recording nearly lied.
  const settled = report.samples.filter((s) => s.inView > 0);
  if (settled.length < 4) return "Nothing to read — no posters were on screen long enough.";

  const warm = report.api.count > 10 && report.api.medianMs < 25;
  const preface = warm
    ? `Warm run: ${report.api.count} API calls with a median of ${report.api.medianMs}ms, so they came ` +
      `from the cache and the refresh was over before it began. Not the event. `
    : `Library was ${report.staleHours}h stale; ${report.api.count} API calls, median ${report.api.medianMs}ms, ` +
      `${report.images.count} poster requests, median ${report.images.medianMs}ms. `;

  const peak = Math.max(...settled.map((s) => s.up));
  if (peak === 0) return `${preface}No poster ever loaded in 30s.`;

  // Only from the moment the grid first fills. Every run starts at zero posters and climbs, and
  // reading that ramp as a collapse turns an ordinary load into a finding.
  const filledAt = settled.findIndex((s) => s.up >= peak * 0.9);
  const after = settled.slice(filledAt + 1);
  if (after.length === 0) return `${preface}Posters filled at the end of the run; nothing after it to read.`;

  const trough = after.reduce((lo, s) => (s.up < lo.up ? s : lo), after[0]!);
  if (trough.up >= peak * 0.6) {
    return (
      `${preface}No dip: posters reached ${peak} at ${(settled[filledAt]!.t / 1000).toFixed(1)}s and held ` +
      `(lowest ${trough.up}), through ${settled[settled.length - 1]!.rebuilds} rebuilds.`
    );
  }

  const recovery = after.find((s) => s.t > trough.t && s.up >= peak * 0.9);
  const refetched = recovery ? recovery.imgReqs - trough.imgReqs : 0;
  const worst = Math.max(...settled.map((s) => s.worstFrame));
  const base =
    `${preface}Dipped to ${trough.up} of ${trough.inView} at ${(trough.t / 1000).toFixed(1)}s, ` +
    `${recovery ? `back to ${recovery.up} at ${(recovery.t / 1000).toFixed(1)}s` : "never recovered"}. ` +
    `Worst frame ${worst}ms. `;
  if (!recovery) return base;
  return (
    base +
    (refetched > 2
      ? `Recovery cost ${refetched} image requests — they were re-fetched, so it is the loading queue.`
      : `Recovery cost ${refetched} image requests — the bytes never left, so iOS discarded the decoded images.`)
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

/** Narrow enough to read on a phone; only every other row once the fast phase is over. */
export function formatReport(report: FlickerReport): string {
  const head = "    t  up/view  imgs  api  rb  worst  at";
  const rows = report.samples
    .filter((s, i) => s.t < FAST_UNTIL || i % 4 === 0)
    .map(
      (s) =>
        `${(s.t / 1000).toFixed(2).padStart(6)} ${String(s.up).padStart(3)}/${String(s.inView).padEnd(3)} ` +
        `${String(s.imgReqs).padStart(5)} ${String(s.apiReqs).padStart(4)} ${String(s.rebuilds).padStart(3)} ` +
        `${String(s.worstFrame).padStart(6)}  ${s.at}`,
    );
  return [head, ...rows].join("\n");
}

export function reportAsJson(report: FlickerReport): string {
  return JSON.stringify(report);
}

/** For the Settings card: how stale the library is right now. */
export async function libraryState(): Promise<string> {
  const all = await dbGetAll<ProgressRec>("progress");
  if (all.length === 0) return "no progress records";
  const hours = await staleHours();
  const stale = all.filter((r) => (Date.now() - r.fetchedAt) / 3600000 > 12).length;
  return `${all.length} shows, oldest ${hours}h old, ${stale} past the TTL`;
}
