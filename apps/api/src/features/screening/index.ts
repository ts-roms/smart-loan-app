// screening feature — factory plugin exposing AML watchlist + screening
// status routes. Not a layered feature router: the actual screening
// provider is decorated onto `app.screening` for use by customer +
// loan-apply flows (see features/README.md).
export { screeningRoutes } from "./screening.routes.js";
