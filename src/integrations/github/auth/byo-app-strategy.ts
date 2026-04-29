import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { userAgent as defaultUserAgent } from "../../../core/version.js";
import { AdapterError, AuthError, redactSecrets } from "../../http/retry.js";
import type { GitHubAuthStrategy, GitHubIdentity } from "../auth.js";

export interface ByoAppAuthStrategyOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  clockSkewSec?: number;
  refreshBufferMs?: number;
  userAgent?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_CLOCK_SKEW_SEC = 30;
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60_000;
const JWT_TTL_SEC = 9 * 60;

interface CachedInstallationToken {
  token: string;
  expiresAt: number;
}

export class ByoAppAuthStrategy implements GitHubAuthStrategy {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKeyPem: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly clockSkewSec: number;
  private readonly refreshBufferMs: number;
  private readonly userAgent: string;

  private cachedKey: KeyObject | null = null;
  private cachedToken: CachedInstallationToken | null = null;
  private inflight: Promise<CachedInstallationToken> | null = null;
  private identityPromise: Promise<GitHubIdentity> | null = null;

  constructor(options: ByoAppAuthStrategyOptions) {
    if (options.appId.trim().length === 0) {
      throw new AdapterError("GitHub App ID is empty");
    }
    if (options.installationId.trim().length === 0) {
      throw new AdapterError("GitHub installation ID is empty");
    }
    if (options.privateKeyPem.includes("BEGIN") === false) {
      throw new AdapterError("GitHub App private key does not look like a PEM");
    }
    this.appId = options.appId;
    this.installationId = options.installationId;
    this.privateKeyPem = options.privateKeyPem;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.clockSkewSec = options.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
    this.refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    this.userAgent = options.userAgent ?? defaultUserAgent();
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken !== null && this.cachedToken.expiresAt - this.refreshBufferMs > now) {
      return this.cachedToken.token;
    }
    this.inflight ??= this.mintInstallationToken().finally(() => {
      this.inflight = null;
    });
    const fresh = await this.inflight;
    this.cachedToken = fresh;
    return fresh.token;
  }

  getIdentity(): Promise<GitHubIdentity> {
    this.identityPromise ??= this.fetchIdentity();
    return this.identityPromise;
  }

  private importPrivateKey(): KeyObject {
    if (this.cachedKey !== null) {
      return this.cachedKey;
    }
    const pem = this.privateKeyPem;
    const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
    const isPkcs8 = pem.includes("BEGIN PRIVATE KEY");
    if (isPkcs1 === false && isPkcs8 === false) {
      throw new AdapterError(
        "GitHub App private key PEM header not recognized. Expected PKCS#1 ('BEGIN RSA PRIVATE KEY') or PKCS#8 ('BEGIN PRIVATE KEY').",
      );
    }
    try {
      this.cachedKey = createPrivateKey({ key: pem, format: "pem" });
    } catch (err) {
      throw new AdapterError(
        `GitHub App private key failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.cachedKey;
  }

  private async signAppJwt(): Promise<string> {
    const key = this.importPrivateKey();
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(nowSec - this.clockSkewSec)
      .setExpirationTime(nowSec + JWT_TTL_SEC)
      .setIssuer(this.appId)
      .sign(key);
  }

  private appHeaders(jwt: string): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async mintInstallationToken(): Promise<CachedInstallationToken> {
    const jwt = await this.signAppJwt();
    const url = `${this.apiBase}/app/installations/${this.installationId}/access_tokens`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.appHeaders(jwt),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `GitHub App auth failed (HTTP ${String(response.status)}). Check appId, installationId, and private key.`,
      );
    }
    if (response.status === 404) {
      throw new AuthError(
        `GitHub installation ${this.installationId} not found. The App may not be installed on the target account.`,
      );
    }
    if (response.ok === false) {
      const body = await response.text().catch(() => "");
      throw new AdapterError(
        `GitHub installation token endpoint returned HTTP ${String(response.status)}: ${redactSecrets(body.slice(0, 200))}`,
      );
    }
    const data = (await response.json()) as { token?: unknown; expires_at?: unknown };
    const token = typeof data.token === "string" ? data.token : null;
    const expiresAtRaw = typeof data.expires_at === "string" ? data.expires_at : null;
    if (token === null || expiresAtRaw === null) {
      throw new AdapterError("GitHub installation token response missing fields");
    }
    const expiresAt = Date.parse(expiresAtRaw);
    if (Number.isNaN(expiresAt)) {
      throw new AdapterError("GitHub installation token expires_at is not a valid date");
    }
    return { token, expiresAt };
  }

  private async fetchIdentity(): Promise<GitHubIdentity> {
    const jwt = await this.signAppJwt();
    const response = await this.fetchImpl(`${this.apiBase}/app`, {
      method: "GET",
      headers: this.appHeaders(jwt),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `GitHub App identity lookup failed (HTTP ${String(response.status)}). Check appId and private key.`,
      );
    }
    if (response.ok === false) {
      const body = await response.text().catch(() => "");
      throw new AdapterError(
        `GitHub /app returned HTTP ${String(response.status)}: ${redactSecrets(body.slice(0, 200))}`,
      );
    }
    const data = (await response.json()) as { slug?: unknown; id?: unknown };
    const slug = typeof data.slug === "string" ? data.slug : null;
    const id = typeof data.id === "number" ? data.id : null;
    if (slug === null || id === null) {
      throw new AdapterError("GitHub /app returned unexpected shape");
    }
    return {
      login: `${slug}[bot]`,
      accountId: String(id),
      isBot: true,
    };
  }
}
