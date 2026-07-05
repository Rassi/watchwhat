import type { Route } from "../router";
import { el, toast } from "./components";
import { searchShows, type TraktShow } from "../api/trakt";
import { fetchShowImages, posterUrl } from "../api/tmdb";
import { addToWatchlist, loadLibrary, removeFromWatchlist } from "../data/sync";
import { isAuthenticated, isConfigured } from "../data/settings";

export const searchRoute: Route = {
  name: "search",
  async render(container) {
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings to search for shows."));
      return;
    }

    const lib = await loadLibrary();
    const input = el("input", { type: "search", placeholder: "Search TV shows…", autofocus: "true" });
    const results = el("div", {});
    container.append(el("div", { class: "search-bar" }, input), results);
    input.focus();

    let requestSeq = 0;
    let debounce: number | undefined;

    const inWatchlist = (traktId: number): boolean => lib.watchlist.some((e) => e.traktId === traktId);
    const isStarted = (traktId: number): boolean => (lib.watched.get(traktId)?.plays ?? 0) > 0;

    function row(show: TraktShow): HTMLElement {
      const img = el("img", { class: "mini-placeholder", loading: "lazy", alt: "" }) as HTMLImageElement;
      const cached = lib.shows.get(show.ids.trakt)?.poster;
      if (cached) img.src = posterUrl(cached, "w154")!;
      else if (show.ids.tmdb) {
        void fetchShowImages(show.ids.tmdb).then((images) => {
          const url = posterUrl(images?.poster, "w154");
          if (url) img.src = url;
        });
      }

      const action = el("button", { class: "btn" });
      const refreshAction = (): void => {
        if (isStarted(show.ids.trakt)) {
          action.textContent = "Tracking ✓";
          action.disabled = true;
        } else if (inWatchlist(show.ids.trakt)) {
          action.textContent = "Listed ✓";
          action.disabled = false;
        } else {
          action.textContent = "+ Add";
          action.disabled = false;
          action.classList.add("primary");
        }
      };
      refreshAction();
      action.addEventListener("click", async (e) => {
        e.stopPropagation();
        action.disabled = true;
        try {
          if (inWatchlist(show.ids.trakt)) {
            await removeFromWatchlist(lib, show.ids.trakt);
            toast(`Removed "${show.title}" from your list`);
          } else {
            await addToWatchlist(lib, show);
            toast(`Added "${show.title}" — it'll appear under Haven't Started`);
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : "Update failed", "error");
        }
        refreshAction();
      });

      const rowEl = el(
        "div",
        { class: "search-row" },
        img,
        el(
          "div",
          { class: "info" },
          el("div", { class: "t" }, `${show.title}${show.year ? ` (${show.year})` : ""}`),
          el("div", { class: "o" }, show.overview ?? ""),
        ),
        action,
      );
      rowEl.addEventListener("click", () => (location.hash = `#/show/${show.ids.trakt}`));
      return rowEl;
    }

    input.addEventListener("input", () => {
      window.clearTimeout(debounce);
      const query = input.value.trim();
      if (query.length < 2) {
        results.replaceChildren();
        return;
      }
      debounce = window.setTimeout(async () => {
        const seq = ++requestSeq;
        try {
          const found = await searchShows(query);
          if (seq !== requestSeq) return; // a newer search superseded this one
          results.replaceChildren(...found.map((r) => row(r.show)));
          if (found.length === 0) results.append(el("div", { class: "empty-note" }, "No shows found."));
        } catch (e) {
          if (seq === requestSeq) toast(e instanceof Error ? e.message : "Search failed", "error");
        }
      }, 350);
    });
  },
};
