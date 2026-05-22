// notifications feature — factory plugin exposing the borrower bell
// (list + mark-read). Not a layered feature router: the dispatch
// pathway is owned by NotificationRepository, decorated onto
// `app.notifications` for use by feature services (see
// features/README.md).
export { notificationRoutes } from "./notifications.routes.js";
