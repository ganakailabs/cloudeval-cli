export * from "./streamClient";
export * from "./reducer";
export * from "./auth";
export * from "./reportsClient";
export * from "./billingClient";
export * from "./projectClient";
export * from "./credentialsClient";
export * from "@cloudeval/shared";

// Explicitly export project-related functions and types
export {
  getProjects,
  getCLIHeaders,
  normalizeApiBase,
  type Project,
} from "./auth";
