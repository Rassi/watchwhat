import "./styles.css";
import { refreshRouteInPlace, registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { libraryRoute } from "./ui/library";
import { showRoute } from "./ui/show";
import { moviesRoute } from "./ui/movies";
import { movieRoute } from "./ui/movie";
import { releasesRoute } from "./ui/releases";
import { discoverRoute } from "./ui/discover";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";
import { applyTheme } from "./theme";
import { ensureUnlocked } from "./gate";
import { installPullToRefresh, stripReloadParam } from "./ui/refresh";
import { dbDelete } from "./data/db";
import { purgeTraktRemnants, seedCloudStamps } from "./data/settings";
import { migrateMovieListsToSettings, seedListAddedAt, seedProviderSince, trimProviderCountries } from "./data/sync";
import { installSyncTriggers, syncEvents } from "./data/replay";
import { installResumeWatch, maybeRecordThisLaunch, noteLaunch } from "./ui/debugflicker";

applyTheme();
stripReloadParam();
installPullToRefresh();
// The Upcoming tab is gone; drop the calendar it cached so it stops riding
// along in every export. A no-op once it has run.
void dbDelete("meta", "upcoming");
// Same for what the Trakt integration left behind in localStorage.
purgeTraktRemnants();
// Settings this device already had predate the sync stamps, so give them one —
// otherwise nothing would ever seed a server that has never held any. Once only.
seedCloudStamps();
// Three one-off passes over the cached films, all local and none costing a request. First
// shed watch listings for countries nothing reads — records cached before the fetch was
// narrowed still carry all ~40 TMDB returns. Then set the baseline for "this film only just
// turned up on a service", so Releases starts noticing arrivals after one refresh rather than
// two. Strictly in sequence: they rewrite whole movie records, so run concurrently they would
// read the same snapshot and the second to finish would undo the first.
void (async () => {
  await trimProviderCountries();
  await seedProviderSince();
  // Then give every custom-list membership a date of its own, so the lists stop being ordered
  // by the watchlist's date — and so the repair pass has something true to send.
  await seedListAddedAt();
  // And move the custom list catalogue into the synced settings, so a device set up from sync
  // alone gets the list *names* rather than replaying memberships onto lists it cannot see.
  await migrateMovieListsToSettings();
})();
await ensureUnlocked();

registerRoute(watchlistRoute);
registerRoute(libraryRoute);
registerRoute(showRoute);
registerRoute(moviesRoute);
registerRoute(movieRoute);
registerRoute(releasesRoute);
registerRoute(discoverRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

// Temporary, with the rest of the flicker investigation. The launch note is unconditional — it is
// how a web process iOS killed and restarted becomes visible at all. Before the router, so the
// very first render is inside any recording.
noteLaunch();
maybeRecordThisLaunch();
// And the other way back in: iOS often suspends a home-screen app rather than killing it, so
// reopening after a night resumes this very page and never runs any of the above.
installResumeWatch();

startRouter(document.getElementById("app")!);

// After the gate and the router, so a queue left over from last session drains
// and anything the other device did arrives in the background, rather than
// delaying first paint. The screen is already on-screen by then, so a pull that
// changes anything has to redraw it — otherwise a sync looks like it did
// nothing until you navigate away and back.
syncEvents.addEventListener("applied", (e) => {
  // One exception to redrawing: settings that arrived from another device, while
  // the Settings screen is the one open. Its preference fields are an unsaved
  // draft, and re-rendering would throw away whatever is half-typed in them —
  // that screen listens for this itself and updates only the controls the user
  // is not currently editing. Every other screen renders straight from stored
  // data and loses nothing.
  const detail = (e as CustomEvent<{ settingsOnly?: boolean }>).detail;
  if (detail?.settingsOnly && location.hash.replace(/^#\/?/, "").split("/")[0] === "settings") return;
  void refreshRouteInPlace();
});
installSyncTriggers();
