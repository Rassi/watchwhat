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
import { posterCacheStats } from "./components";

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
  /**
   * Rough megabytes of decoded bitmap the page is holding: every poster in the document plus
   * every one pinned by the reuse cache, at 4 bytes a pixel. This is the number the memory theory
   * lives or dies on — if it is in the hundreds, iOS discarding our images is the likely story.
   */
  bitmapMB: number;
  /** How many <img> nodes the reuse cache is pinning, and their bitmaps in MB. */
  pinned: number;
  pinnedMB: number;
  /**
   * Milliseconds to decode three on-screen posters that have already loaded.
   *
   * This is the direct test for the memory theory, and it needs no memory API. A bitmap still
   * resident decodes in well under a millisecond, because there is nothing to do. One WebKit has
   * thrown away has to be decoded from the compressed bytes again, and that costs tens of
   * milliseconds. If this number climbs while the posters are blinking, they are being purged
   * and re-decoded, and nothing about the network is involved.
   */
  decodeMs: number;
}

interface ResourceSummary {
  count: number;
  medianMs: number;
  maxMs: number;
}

export interface FlickerReport {
  at: string;
  /**
   * Which build produced this. A recording was once read as a finding for a while before its
   * shape gave away that it came from the previous deploy — the phone had not picked the new one
   * up yet. Cheap to carry, and it settles that question before any of the numbers are believed.
   */
  build: string;
  mode: Mode;
  /** How stale the library was when the run started. */
  staleHours: number;
  /** Hours the app had been shut before this launch — what actually defines the real event. */
  shutHours: number;
  samples: Sample[];
  images: ResourceSummary;
  api: ResourceSummary;
  /** Wall-clock ms between recent app starts. Several small gaps means iOS is killing the process. */
  launchGaps: number[];
  verdict: string;
}

const LAUNCHES_KEY = "watchwhat.flickerLaunches";

/**
 * Note every start of the app, keeping the last twenty.
 *
 * If iOS is jettisoning the web process under memory pressure — the strongest form of the memory
 * theory — the app does not merely lose its pictures, it starts again from scratch. That is
 * invisible from inside a single session and obvious across this list: several launches seconds
 * apart, with no one having tapped anything. Runs on every load, costs one small write.
 */
export function noteLaunch(): void {
  let launches: number[] = [];
  try {
    launches = JSON.parse(localStorage.getItem(LAUNCHES_KEY) ?? "[]") as number[];
  } catch {
    launches = [];
  }
  launches.push(Date.now());
  localStorage.setItem(LAUNCHES_KEY, JSON.stringify(launches.slice(-20)));
}

function recentLaunches(): number[] {
  try {
    return JSON.parse(localStorage.getItem(LAUNCHES_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

/**
 * Hours since the launch before this one — how long the app was actually shut.
 *
 * This, not any timestamp in the library, is what "opened after twelve hours" means. The obvious
 * measure looked at how stale the progress records were, and it would have misfired on the very
 * next open: ended shows the user has finished are exempt from bulk refreshes, so their
 * `fetchedAt` never moves and the library reads permanently stale. `noteLaunch` has already
 * recorded this launch by the time anything asks, so the answer is the gap to the one before.
 */
function hoursSinceLastLaunch(): number {
  const launches = recentLaunches();
  if (launches.length < 2) return Infinity; // first ever launch on this device — treat as cold
  const previous = launches[launches.length - 2]!;
  return (Date.now() - previous) / 3600000;
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
 * Wait for a real gap, having made sure there will be something to see when it comes.
 *
 * The event has three ingredients and they are not equally fakeable. A cold process and a purged
 * HTTP cache can only come from real hours away — that is what the waiting buys, and every
 * attempt to shortcut it has produced a warm run that measured nothing. Library staleness is only
 * data, and faking it costs nothing in fidelity.
 *
 * So age the library here rather than leaving it to chance. Otherwise a six-hour gap can easily
 * find the running shows an hour short of their 12h TTL, no refresh runs at all, and the wait is
 * spent for a recording of an ordinary open.
 */
export async function armForRealOpen(): Promise<number> {
  const n = await ageLibrary();
  localStorage.setItem(ARMED_KEY, "real");
  return n;
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
/** How long the app must have been shut for a launch to count as the real thing. */
const REAL_OPEN_HOURS = 6;

export function maybeRecordThisLaunch(): void {
  const mode = armedMode();
  if (!mode) return;
  // Read before any await: a launch is only "the real one" relative to the previous launch, and
  // the answer must not depend on how long the database took to open.
  const shut = hoursSinceLastLaunch();
  if (mode === "real" && shut < REAL_OPEN_HOURS) return; // an ordinary open; stay armed
  void (async () => {
    const hours = await staleHours();
    disarm();
    if (mode === "cold") setPosterBuster(String(Date.now()));
    startRecording(mode, hours, shut);
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

export function startRecording(mode: Mode, hours: number, shut = 0): void {
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

  // Timed separately from the samples: decoding three posters twenty times a second would be a
  // load of its own, and re-decoding them is exactly the work being measured.
  let decodeMs = 0;
  const probeDecode = (): void => {
    if (!recording) return;
    const loaded = [...document.querySelectorAll<HTMLImageElement>("img.poster")]
      .filter((n) => n.complete && n.naturalWidth > 0)
      .slice(0, 3);
    if (loaded.length === 0) return;
    const start = performance.now();
    void Promise.all(loaded.map((n) => n.decode().catch(() => undefined))).then(() => {
      decodeMs = Math.round(performance.now() - start);
    });
  };
  const decodeTimer = setInterval(probeDecode, 500);

  const tick = (): void => {
    const posters = [...document.querySelectorAll<HTMLImageElement>("img.poster")];
    const inView = posters.filter((n) => {
      const r = n.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
    // Poster dimensions come from the decoded image, so an <img> that never loaded contributes
    // nothing — which is right: it is holding no bitmap.
    const bitmapBytes = posters.reduce((sum, n) => sum + n.naturalWidth * n.naturalHeight * 4, 0);
    const cache = posterCacheStats();
    samples.push({
      t: Math.round(performance.now() - t0),
      inView: inView.length,
      up: inView.filter((n) => n.complete && n.naturalWidth > 0).length,
      bitmapMB: Math.round(bitmapBytes / 1048576),
      pinned: cache.size,
      pinnedMB: Math.round(cache.bytes / 1048576),
      decodeMs,
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
    clearInterval(decodeTimer);
    observer.disconnect();
    recording = false;
    setPosterBuster("");
    restoreFetch();
    const report: FlickerReport = {
      at: new Date().toISOString(),
      build: __BUILD_STAMP__,
      mode,
      staleHours: hours,
      shutHours: Number.isFinite(shut) ? Math.round(shut * 10) / 10 : -1,
      samples,
      images: summarize("image.tmdb.org"),
      api: summarize("api.themoviedb.org"),
      launchGaps: recentLaunches()
        .slice(-8)
        .map((t, i, all) => (i === 0 ? 0 : t - all[i - 1]!))
        .slice(1),
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

  // A run whose samples stop for seconds was backgrounded — iOS freezes the timers — so its gaps
  // are not evidence of anything. The last recording spanned eleven minutes this way.
  const gaps = report.samples.slice(1).map((s, i) => s.t - report.samples[i]!.t);
  const frozen = gaps.some((g) => g > 3000);
  // Arming and reopening is itself two launches a few seconds apart, so one short gap proves
  // nothing. A process being killed and restarted comes in a run of them, and fast.
  const relaunches = report.launchGaps.filter((g) => g < 15000).length;
  const notes =
    (frozen ? "The app was backgrounded mid-run, so the timeline has holes. " : "") +
    (relaunches >= 2
      ? `${relaunches + 1} app starts within seconds of each other, which looks like the process ` +
        `being killed and restarted — check launchGaps before believing it. `
      : "");

  const peakBitmap = Math.max(...report.samples.map((s) => s.bitmapMB ?? 0));
  const peakPinnedMB = Math.max(...report.samples.map((s) => s.pinnedMB ?? 0));
  const peakPinned = Math.max(...report.samples.map((s) => s.pinned ?? 0));
  // Judged against this run's own baseline, not a fixed threshold: `decode()` resolves on a
  // promise and costs a few milliseconds even when there is nothing to do, and that floor differs
  // between devices. A purge shows as a spike over the run's own quiet level, not as any
  // particular number.
  const decodes = report.samples.map((s) => s.decodeMs ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const medianDecode = decodes.length ? decodes[Math.floor(decodes.length / 2)]! : 0;
  const worstDecode = decodes.length ? decodes[decodes.length - 1]! : 0;
  const purging = decodes.length > 4 && worstDecode > Math.max(medianDecode * 4, 20);
  const memory =
    `Peak ${peakBitmap}MB of decoded posters on screen, plus ${peakPinnedMB}MB across ${peakPinned} ` +
    `pinned by the reuse cache. Decoding an already-loaded poster took ${medianDecode}ms normally, ` +
    `${worstDecode}ms at worst` +
    (purging
      ? " — a spike that size means the bitmap was gone and had to be rebuilt, which is the memory theory. "
      : ", steady, so the bitmaps stayed resident. ");

  const warm = report.api.count > 10 && report.api.medianMs < 25;
  const preface =
    notes +
    memory +
    (warm
      ? `Warm run: ${report.api.count} API calls with a median of ${report.api.medianMs}ms, so they came ` +
        `from the cache and the refresh was over before it began. Not the event. `
      : `App had been shut ${report.shutHours}h, library ${report.staleHours}h stale; ${report.api.count} API ` +
        `calls, median ${report.api.medianMs}ms, ${report.images.count} poster requests, median ` +
        `${report.images.medianMs}ms. `);

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
  const head = "    t  up/view  imgs  api  rb  worst   MB  pin/MB  dec  at";
  const rows = report.samples
    .filter((s, i) => s.t < FAST_UNTIL || i % 4 === 0)
    .map(
      (s) =>
        `${(s.t / 1000).toFixed(2).padStart(6)} ${String(s.up).padStart(3)}/${String(s.inView).padEnd(3)} ` +
        `${String(s.imgReqs).padStart(5)} ${String(s.apiReqs).padStart(4)} ${String(s.rebuilds).padStart(3)} ` +
        `${String(s.worstFrame).padStart(6)} ${String(s.bitmapMB).padStart(4)} ` +
        `${String(s.pinned).padStart(4)}/${String(s.pinnedMB).padEnd(3)} ${String(s.decodeMs).padStart(4)}  ${s.at}`,
    );
  return [`build ${report.build}`, head, ...rows].join("\n");
}

export function reportAsJson(report: FlickerReport): string {
  return JSON.stringify(report);
}

/**
 * For the Settings card: the library's state, and — the thing actually worth knowing — the clock
 * time from which the next open will count as a real one. The gap is measured against the most
 * recent launch, which is this one, so every open pushes that moment six hours further out.
 */
export async function libraryState(): Promise<string> {
  const all = await dbGetAll<ProgressRec>("progress");
  if (all.length === 0) return "no progress records";
  const hours = await staleHours();
  const stale = all.filter((r) => (Date.now() - r.fetchedAt) / 3600000 > 12).length;
  const launches = recentLaunches();
  const thisLaunch = launches[launches.length - 1] ?? Date.now();
  const eligible = new Date(thisLaunch + REAL_OPEN_HOURS * 3600 * 1000);
  const clock = eligible.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${all.length} shows, oldest ${hours}h old, ${stale} past the TTL. An open from ${clock} onwards counts`;
}
