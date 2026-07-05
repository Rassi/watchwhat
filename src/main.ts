import "./styles.css";
import { registerRoute, startRouter } from "./router";
import { watchlistRoute } from "./ui/watchlist";
import { showRoute } from "./ui/show";
import { searchRoute } from "./ui/search";
import { settingsRoute } from "./ui/settings";

registerRoute(watchlistRoute);
registerRoute(showRoute);
registerRoute(searchRoute);
registerRoute(settingsRoute);

startRouter(document.getElementById("app")!);
