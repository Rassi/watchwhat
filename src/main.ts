import "./styles.css";
import { refreshRouteInPlace, registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { libraryRoute } from "./ui/library";
import { showRoute } from "./ui/show";
import { moviesRoute } from "./ui/movies";
import { movieRoute } from "./ui/movie";
import { releasesRoute } from "./ui/releases";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";
import { applyTheme } from "./theme";
import { ensureUnlocked } from "./gate";
import { installPullToRefresh, stripReloadParam } from "./ui/refresh";
import { dbDelete } from "./data/db";
import { purgeTraktRemnants, seedCloudStamps } from "./data/settings";
import { seedProviderSince } from "./data/sync";
import { installSyncTriggers, syncEvents } from "./data/replay";

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
// Baseline for "this film only just turned up on a service" — from what is already cached, so
// Releases starts noticing arrivals after one refresh rather than two. Once only.
void seedProviderSince();
await ensureUnlocked();

registerRoute(watchlistRoute);
registerRoute(libraryRoute);
registerRoute(showRoute);
registerRoute(moviesRoute);
registerRoute(movieRoute);
registerRoute(releasesRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

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
