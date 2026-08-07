// agents feature — field originators and the commission they earn.
//
// Two audiences and two pages: `AgentsPage` is the staff directory
// (agents.read / agents.manage), `MyBookPage` is what an agent sees of
// themselves (agents.self). `LoanAgentCard` is exported because the loan
// detail page renders it inline rather than owning attribution itself.
export { AgentsPage } from "./pages/Agents";
export { MyBookPage } from "./pages/MyBook";
export { LoanAgentCard } from "./components/LoanAgentCard";
