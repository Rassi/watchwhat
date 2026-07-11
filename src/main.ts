import "./styles.css";
import { registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { upcomingRoute } from "./ui/upcoming";
import { libraryRoute } from "./ui/library";
import { showRoute } from "./ui/show";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";
import { applyTheme } from "./theme";

applyTheme();

registerRoute(watchlistRoute);
registerRoute(upcomingRoute);
registerRoute(libraryRoute);
registerRoute(showRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

startRouter(document.getElementById("app")!);
