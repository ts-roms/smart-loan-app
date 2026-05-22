// cooperative feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Seven entity types
// (contributions, savings, funds, withdrawals, expenses, other-income,
// big-brother) sharing the same create + list shape; the GL auto-post
// happens inside CooperativeRepository.
export { cooperativeRoutes } from "./cooperative.routes.js";
