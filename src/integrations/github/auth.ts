export interface GitHubIdentity {
  login: string;
  accountId: string;
  isBot: boolean;
}

export interface GitHubAuthStrategy {
  /**
   * Returns a valid token for the next REST call. Strategies that refresh
   * (hosted-app) return fresh tokens as needed; PAT returns the static token.
   */
  getToken(): Promise<string>;

  /**
   * The authenticated identity. Called at most once per adapter instance
   * (after first `getToken`). Used for self-echo filtering.
   */
  getIdentity(): Promise<GitHubIdentity>;
}
