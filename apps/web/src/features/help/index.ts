// Public API of the help feature.
//   - HelpPage: full /help route with searchable articles + FAQ.
//   - HelpTrigger: navbar icon that opens the quick-access drawer.
//   - TourButton: drop-in "Take a tour" button for any module page.
//   - HELP_ARTICLES + findArticle: content registry for ad-hoc consumers.
export { HelpPage } from "./pages/HelpPage";
export { HelpTrigger } from "./components/HelpDrawer";
export { TourButton } from "./components/TourButton";
export { HELP_ARTICLES, findArticle, FAQ } from "./content";
export type { HelpArticle } from "./content";
