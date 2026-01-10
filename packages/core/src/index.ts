export * from "./streamClient";
export * from "./reducer";
export * from "./auth";
export * from "@cloudeval/shared";

// Explicitly export project-related functions and types
export { getProjects, type Project } from "./auth";
