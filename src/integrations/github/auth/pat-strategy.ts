import { AdapterError, AuthError, redactSecrets } from "../../http/retry.js";
import type { GitHubAuthStrategy, GitHubIdentity } from "../auth.js";

export interface PatAuthStrategyOptions {
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

export class PatAuthStrategy implements GitHubAuthStrategy {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private identityPromise: Promise<GitHubIdentity> | null = null;

  constructor(options: PatAuthStrategyOptions) {
    if (options.token.trim().length === 0) {
      throw new AdapterError("GitHub PAT token is empty");
    }
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
  }

  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }

  getIdentity(): Promise<GitHubIdentity> {
    this.identityPromise ??= this.fetchIdentity();
    return this.identityPromise;
  }

  private async fetchIdentity(): Promise<GitHubIdentity> {
    const response = await this.fetchImpl(`${this.apiBase}/user`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "red-queen/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `GitHub auth failed (HTTP ${String(response.status)}). Check GITHUB_PAT.`,
      );
    }
    if (response.ok === false) {
      const body = await response.text().catch(() => "");
      throw new AdapterError(
        `GitHub /user returned HTTP ${String(response.status)}: ${redactSecrets(body.slice(0, 200))}`,
      );
    }
    const data = (await response.json()) as { login?: unknown; id?: unknown; type?: unknown };
    const login = typeof data.login === "string" ? data.login : null;
    const id = typeof data.id === "number" ? data.id : null;
    const type = typeof data.type === "string" ? data.type : null;
    if (login === null || id === null) {
      throw new AdapterError("GitHub /user returned unexpected shape");
    }
    return {
      login,
      accountId: String(id),
      isBot: type === "Bot",
    };
  }
}
