// agents feature — the directory of field originators and the
// commission each has earned. Layered: routes / controller / schemas.
// The commission arithmetic itself lives in @loan/loans, and assignment
// lives on LoanRepository next to the loan lifecycle it belongs to.
export { agentRoutes } from "./agents.routes";
export { assignAgentSchema } from "./schemas";
