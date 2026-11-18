/** Public surface of the SCM module (§5.2: other modules import only this file). */
export { git, askpassEnv, GitError, shaRe, gitDirOf, cloneWork, removeWork, refreshSandboxGit } from "./git";
export { createGitLabScm, type GitLabOptions, type GitLabRepo } from "./gitlab";
export { createLocalBareRepo, createLocalScm, installGuard, preReceiveHook } from "./local";
export * from "./types";
