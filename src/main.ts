import "./styles.css";
import { registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { libraryRoute } from "./ui/library";
import { showRoute } from "./ui/show";
import { moviesRoute } from "./ui/movies";
import { movieRoute } from "./ui/movie";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";
import { applyTheme } from "./theme";
import { ensureUnlocked } from "./gate";
import { installPullToRefresh, stripReloadParam } from "./ui/refresh";
import { dbDelete } from "./data/db";
import { purgeTraktRemnants } from "./data/settings";

applyTheme();
stripReloadParam();
installPullToRefresh();
// The Upcoming tab is gone; drop the calendar it cached so it stops riding
// along in every export. A no-op once it has run.
void dbDelete("meta", "upcoming");
// Same for what the Trakt integration left behind in localStorage.
purgeTraktRemnants();
await ensureUnlocked();

registerRoute(watchlistRoute);
registerRoute(libraryRoute);
registerRoute(showRoute);
registerRoute(moviesRoute);
registerRoute(movieRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

startRouter(document.getElementById("app")!);
