/** All shows, grouped like TV Time's "All shows" page — purely from the local cache. */

import { replaceHash, type Route } from "../router";
import { el, posterCard, renderGate, sectionHeader } from "./components";
import { ensureImages, ensureProgress, loadLibrary } from "../data/sync";
import { isEnded, type Library, type ShowRec } from "../data/model";
import { posterUrl } from "../api/tmdb";
import { homeTabs } from "./hometabs";

type Bucket = "watching" | "upToDate" | "finished" | "stopped" | "notStarted";

const LABELS: Record<Bucket, string> = {
  watching: "Watching",
  upToDate: "Up to date",
  finished: "Finished",
  stopped: "Stopped",
  notStarted: "Haven't started",
};

/** What lands in each group — the rules are cache-derived and not self-evident. */
const INFO: Record<Bucket, string[]> = {
  watching: [
    "Shows you've watched at least one episode of, with episodes still left to watch.",
    "A show stays here no matter how long ago you last watched it — this tab is your whole library, not a to-watch queue.",
  ],
  upToDate: [
    "Shows you've watched every aired episode of, and that are still running.",
    "As soon as a new episode airs, the show moves back to Watching.",
  ],
  finished: [
    "Shows you've watched every aired episode of, and that have ended or been cancelled.",
    "Nothing more is coming, so these stay here.",
    "Sorted by when you finished them, most recent first — the other groups are A–Z.",
  ],
  stopped: [
    'Shows you hid with "Stop tracking" — the equivalent of removing a show in TV Time.',
    "They're kept out of Watch next and the other groups, but nothing is deleted.",
  ],
  notStarted: [
    "Shows on your watchlist that you haven't watched a single episode of yet.",
    "Watching one episode moves the show to Watching.",
  ],
};

const ORDER: Bucket[] = ["watching", "notStarted", "upToDate", "finished", "stopped"];

/** How far down the viewport a section header may sit and still count as the one you're at. */
const SECTION_MARK = 64;

function bucketOf(lib: Library, show: ShowRec): Bucket | null {
  if (lib.hidden.has(show.traktId)) return "stopped";
  const watched = lib.watched.get(show.traktId);
  if (!watched || watched.plays === 0) {
    return lib.watchlist.some((e) => e.traktId === show.traktId) ? "notStarted" : null;
  }
  const progress = lib.progress.get(show.traktId);
  if (!progress) return "watching"; // unknown yet — refined once progress loads
  if (progress.completed < progress.aired) return "watching";
  return isEnded(show) ? "finished" : "upToDate";
}

export const libraryRoute: Route = {
  name: "library",
  tab: "home",
  title: "All shows · WatchWhat",
  async render(container, params) {
    container.append(homeTabs("library"));

    const lib = await loadLibrary();
    const content = el("div", {});

    // Burger menu to jump between sections
    const burgerMenu = el("div", { class: "burger-menu" });
    const burgerBtn = el("button", { class: "burger-btn", title: "Jump to section" }, "☰");
    const burgerWrap = el("div", { class: "lib-burger" }, burgerBtn, burgerMenu);
    burgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      burgerWrap.classList.toggle("open");
    });
    container.addEventListener("click", () => burgerWrap.classList.remove("open"));
    container.append(burgerWrap, content);

    const sectionAnchors = new Map<Bucket, HTMLElement>();

    /**
     * The section you're at lives in the address (#/library/finished), so a
     * refresh — or coming back from a show — returns you to it instead of the top.
     */
    let pending = ORDER.includes(params[0] as Bucket) ? (params[0] as Bucket) : null;

    let jumped = false;
    const scrollToPending = (): void => {
      const anchor = pending && sectionAnchors.get(pending);
      if (!anchor) return;
      // Back/forward restores the exact position you left, which beats the top of
      // a section — so only take over from a page that opened at the top.
      if (!jumped && window.scrollY > 0) {
        pending = null;
        return;
      }
      jumped = true;
      window.scrollTo(0, window.scrollY + anchor.getBoundingClientRect().top - SECTION_MARK / 2);
    };

    // Shows move between sections as progress loads, so the restore has to survive
    // a few re-renders — until you take over by scrolling yourself.
    const release = (): void => {
      pending = null;
    };
    for (const ev of ["wheel", "touchstart", "keydown"] as const) {
      window.addEventListener(ev, release, { passive: true, once: true });
    }

    let queued = false;
    const onScroll = (): void => {
      if (!content.isConnected) {
        window.removeEventListener("scroll", onScroll); // the route is gone — no teardown hook to do it for us
        return;
      }
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        let at: Bucket | null = null;
        // Insertion order is document order, so the last one past the mark is the one you're in.
        for (const [bucket, anchor] of sectionAnchors) {
          if (anchor.getBoundingClientRect().top <= SECTION_MARK) at = bucket;
        }
        replaceHash(at ? `#/library/${at}` : "#/library");
      });
    };

    const changed = renderGate();

    const renderContent = (): void => {
      const buckets = new Map<Bucket, ShowRec[]>();
      for (const show of lib.shows.values()) {
        const bucket = bucketOf(lib, show);
        if (!bucket) continue;
        (buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket)!).push(show);
      }

      // Everything the cards below draw. `ensureProgress` calls back once per show it rebuilds,
      // and most of those leave this screen looking identical — the progress bar only moves when
      // the counts do. See docs/poster-flicker.md.
      const signature = ORDER.map((bucket) => {
        const shows = buckets.get(bucket);
        if (!shows?.length) return "";
        return shows
          .map((show) => {
            const progress = lib.progress.get(show.traktId);
            // `lastWatchedAt` is in here for the Finished section alone, which sorts by it: a
            // rewatch moves a card without touching any count the rest of this key would catch.
            return (
              `${show.traktId}:${show.poster ?? ""}:${progress?.completed ?? -1}/${progress?.aired ?? -1}` +
              `:${isEnded(show) ? 1 : 0}:${lib.watched.get(show.traktId)?.lastWatchedAt ?? ""}`
            );
          })
          .join(",");
      }).join("|");
      if (!changed(signature)) return;

      content.replaceChildren();
      burgerMenu.replaceChildren();
      sectionAnchors.clear();
      for (const bucket of ORDER) {
        const shows = buckets.get(bucket);
        if (!shows?.length) continue;
        // Finished shows answer "what did I wrap up lately?" — the rest are an A–Z index you look shows up in.
        if (bucket === "finished") {
          const at = (show: ShowRec): string => lib.watched.get(show.traktId)?.lastWatchedAt ?? "";
          shows.sort((a, b) => at(b).localeCompare(at(a)) || a.title.localeCompare(b.title));
        } else {
          shows.sort((a, b) => a.title.localeCompare(b.title));
        }
        const anchor = sectionHeader(`${LABELS[bucket]} (${shows.length})`, { title: LABELS[bucket], points: INFO[bucket] });
        sectionAnchors.set(bucket, anchor);
        const item = el("button", { class: "burger-item" }, `${LABELS[bucket]} (${shows.length})`);
        item.addEventListener("click", () => {
          burgerWrap.classList.remove("open");
          sectionAnchors.get(bucket)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        burgerMenu.append(item);
        content.append(
          anchor,
          el(
            "div",
            { class: "poster-grid" },
            ...shows.map((show) => {
              const progress = lib.progress.get(show.traktId);
              return posterCard({
                title: show.title,
                href: `#/show/${show.traktId}`,
                posterUrl: posterUrl(show.poster),
                progress: progress && progress.aired > 0 ? progress.completed / progress.aired : null,
                ended: isEnded(show),
                subtitle: show.title,
              });
            }),
          ),
        );
      }
      if (content.childElementCount === 0) {
        content.append(
          lib.shows.size > 0
            ? el("div", { class: "empty-note" }, "No shows yet — add some via Search.")
            : el("div", { class: "empty-note" }, "No shows here yet — import your data from Settings, or add some via Search."),
        );
      }
      // After a frame, not a microtask: the router scrolls to the top once render
      // returns, and that has to happen before we jump to the section.
      if (pending) requestAnimationFrame(scrollToPending);
    };

    renderContent();
    window.addEventListener("scroll", onScroll, { passive: true });

    const started = [...lib.watched.entries()].filter(([, w]) => w.plays > 0).map(([id]) => id);
    void ensureProgress(lib, started, renderContent, { skipFinishedTtl: true });
    void ensureImages(lib, [...lib.shows.keys()], renderContent);
  },
};
