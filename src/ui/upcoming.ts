/** Upcoming tab: the next month of episodes for tracked shows (Trakt calendar). */

import type { Route } from "../router";
import { el, spinner, toast } from "./components";
import { isAuthenticated, isConfigured } from "../data/settings";
import { getMyCalendar, type CalendarEntry } from "../api/trakt";
import { dbGet, dbPut } from "../data/db";
import { loadLibrary } from "../data/sync";
import { posterUrl } from "../api/tmdb";
import { homeTabs } from "./hometabs";

const CACHE_TTL = 6 * 3600 * 1000;
const DAYS = 30;

interface UpcomingCache {
  fetchedAt: number;
  entries: CalendarEntry[];
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export const upcomingRoute: Route = {
  name: "upcoming",
  tab: "home",
  async render(container) {
    container.append(homeTabs("upcoming"));
    if (!isConfigured() || !isAuthenticated()) {
      container.append(el("div", { class: "empty-note" }, "Connect to Trakt in Settings first."));
      return;
    }

    const body = el("div", {});
    container.append(body);
    body.append(spinner("Loading upcoming episodes…"));

    let cache = await dbGet<UpcomingCache>("meta", "upcoming");
    if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL) {
      try {
        const start = new Date().toISOString().slice(0, 10);
        cache = { fetchedAt: Date.now(), entries: await getMyCalendar(start, DAYS) };
        await dbPut("meta", "upcoming", cache);
      } catch (e) {
        if (!cache) {
          body.replaceChildren(el("div", { class: "empty-note" }, "Could not load the calendar."));
          toast(e instanceof Error ? e.message : "Calendar failed", "error");
          return;
        }
      }
    }

    if (!cache) return;
    const lib = await loadLibrary();
    body.replaceChildren();

    // Trakt returns past few hours too; keep today onwards, grouped by local date.
    const entries = cache.entries
      .filter((e) => new Date(e.first_aired).getTime() > Date.now() - 24 * 3600 * 1000)
      .sort((a, b) => a.first_aired.localeCompare(b.first_aired));

    let currentLabel = "";
    let group: HTMLElement | null = null;
    for (const entry of entries) {
      const label = dateLabel(entry.first_aired);
      if (label !== currentLabel) {
        currentLabel = label;
        body.append(el("div", { class: "date-header" }, label));
        group = el("div", { class: "card upcoming-group" });
        body.append(group);
      }
      const cached = lib.shows.get(entry.show.ids.trakt);
      const poster = posterUrl(cached?.poster, "w154");
      const img = el("img", { class: "up-poster", loading: "lazy", alt: "" });
      if (poster) img.src = poster;
      const pad = (n: number) => String(n).padStart(2, "0");
      const row = el(
        "div",
        { class: "upcoming-row" },
        poster ? img : el("div", { class: "up-poster placeholder-still" }),
        el(
          "div",
          { class: "info" },
          el("div", { class: "t" }, entry.show.title),
          el(
            "div",
            { class: "o" },
            `S${pad(entry.episode.season)} | E${pad(entry.episode.number)}${entry.episode.title ? ` · ${entry.episode.title}` : ""}`,
          ),
        ),
        el(
          "span",
          { class: "up-time" },
          new Date(entry.first_aired).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
        ),
      );
      row.addEventListener("click", () => (location.hash = `#/show/${entry.show.ids.trakt}`));
      group!.append(row);
    }

    if (entries.length === 0) {
      body.append(el("div", { class: "empty-note" }, `Nothing scheduled for your shows in the next ${DAYS} days.`));
    }
  },
};
