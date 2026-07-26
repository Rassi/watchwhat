import "./styles.css";
import { registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { upcomingRoute } from "./ui/upcoming";
import { libraryRoute } from "./ui/library";
import { showRoute } from "./ui/show";
import { moviesRoute } from "./ui/movies";
import { movieRoute } from "./ui/movie";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";
import { applyTheme } from "./theme";
import { ensureUnlocked } from "./gate";
import { installPullToRefresh, stripReloadParam } from "./ui/refresh";

applyTheme();
stripReloadParam();
installPullToRefresh();
await ensureUnlocked();

registerRoute(watchlistRoute);
registerRoute(upcomingRoute);
registerRoute(libraryRoute);
registerRoute(showRoute);
registerRoute(moviesRoute);
registerRoute(movieRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

startRouter(document.getElementById("app")!);
