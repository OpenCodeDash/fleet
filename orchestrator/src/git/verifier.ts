import { dirname } from "node:path";
import type { GitVerifier } from "../loop/types.ts";
import type { CommandRunner } from "../provision/types.ts";

export interface GitVerifierOptions {
  /** Remote URL or name to verify against (e.g. a git URL, or `origin` with `repoDir`). */
  remote: string;
  runner: CommandRunner;
  /** Local clone (for the ancestry check). Cloned on demand if it does not exist. */
  repoDir?: string;
  /** Ref the reviewer merges into (default `refs/heads/main`). */
  mainRef?: string;
  /** Token for a private `https://` remote; injected as `x-access-token:<token>@`. */
  token?: string;
}

/**
 * Verifies author/reviewer handoffs against the git remote. `remoteRefExists` and
 * `branchDeleted` run `git ls-remote` against the remote URL directly, so an author handoff
 * needs no local clone; only the reviewer's ancestry check needs one (cloned on demand).
 * See docs/handoff.md.
 */
export class CommandGitVerifier implements GitVerifier {
  private readonly remote: string;
  private readonly runner: CommandRunner;
  private readonly repoDir: string | undefined;
  private readonly mainRef: string;
  private readonly token: string | undefined;

  constructor(options: GitVerifierOptions) {
    this.remote = options.remote;
    this.runner = options.runner;
    this.repoDir = options.repoDir;
    this.mainRef = options.mainRef ?? "refs/heads/main";
    this.token = options.token;
  }

  /** A local clone is only needed to resolve a symbolic remote name (e.g. `origin`), not a URL. */
  private remoteArgs(): string[] {
    if (this.repoDir === undefined) return [];
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//.test(this.remote) || this.remote.includes("@");
    return isUrl ? [] : ["-C", this.repoDir];
  }

  /** The remote URL, with the token embedded for a private `https://` remote. */
  private remoteUrl(): string {
    if (this.token === undefined || this.token.length === 0 || !this.remote.startsWith("https://")) {
      return this.remote;
    }
    return this.remote.replace(/^https:\/\//, `https://x-access-token:${this.token}@`);
  }

  /** Clone into `repoDir` if it is not already a git work tree. */
  private async ensureRepo(): Promise<void> {
    const dir = this.repoDir;
    if (dir === undefined) return;
    const check = await this.runner.run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    if (check.code === 0) return;
    await this.runner.run("mkdir", ["-p", dirname(dir)]);
    // Best-effort: a failed clone surfaces as a failed verification, not a crash.
    await this.runner.run("git", ["clone", "--quiet", this.remoteUrl(), dir]);
  }

  async remoteRefExists(branch: string, sha: string): Promise<boolean> {
    const result = await this.runner.run("git", [
      ...this.remoteArgs(),
      "ls-remote",
      this.remoteUrl(),
      `refs/heads/${branch}`,
    ]);
    if (result.code !== 0) return false;
    // `ls-remote` prints "<sha>\t<ref>"; the ref must still point at the reviewed commit.
    return result.stdout.split("\n").some((line) => line.split("\t")[0] === sha);
  }

  async isAncestorOfMain(sha: string): Promise<boolean> {
    if (this.repoDir === undefined) {
      throw new Error("CommandGitVerifier: isAncestorOfMain requires a local clone (repoDir)");
    }
    await this.ensureRepo();
    // Fetch the current main tip, then check ancestry against it (a local clone's refs go
    // stale once the reviewer merges upstream).
    await this.runner.run("git", [
      "-C",
      this.repoDir,
      "fetch",
      "--quiet",
      this.remoteUrl(),
      this.mainRef,
    ]);
    const result = await this.runner.run("git", [
      "-C",
      this.repoDir,
      "merge-base",
      "--is-ancestor",
      sha,
      "FETCH_HEAD",
    ]);
    return result.code === 0;
  }

  async branchDeleted(branch: string): Promise<boolean> {
    const result = await this.runner.run("git", [
      ...this.remoteArgs(),
      "ls-remote",
      "--heads",
      this.remoteUrl(),
      `refs/heads/${branch}`,
    ]);
    return result.code === 0 && result.stdout.trim().length === 0;
  }
}
