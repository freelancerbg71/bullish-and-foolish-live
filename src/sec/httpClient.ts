/**
 * Lightweight HTTP client for SEC endpoints with rate limiting and retries.
 */
export interface SecHttpClientOptions {
  userAgent: string;
  baseDelayMs?: number;
  maxRetries?: number;
}

export class SecHttpError extends Error {
  status?: number;
  statusText?: string;
  url: string;
  bodySnippet?: string;

  constructor(opts: { message: string; url: string; status?: number; statusText?: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = "SecHttpError";
    this.url = opts.url;
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.bodySnippet = opts.bodySnippet;
  }
}

export class SecHttpClient {
  private readonly userAgent: string;
  private readonly baseDelayMs: number;
  private readonly maxRetries: number;
  private lastRequestTime = 0;

  constructor(options: SecHttpClientOptions) {
    if (!options.userAgent || options.userAgent.length < 6) {
      throw new Error("userAgent is required and should include contact info");
    }
    this.userAgent = options.userAgent;
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.baseDelayMs) {
      await this.sleep(this.baseDelayMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  async getJson<T>(url: string): Promise<T> {
    return this.request<T>(url);
  }

  private async request<T>(url: string): Promise<T> {
    let attempt = 0;
    let backoff = this.baseDelayMs;

    while (attempt <= this.maxRetries) {
      await this.enforceRateLimit();
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": this.userAgent,
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate, br",
          },
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        const status = response.status;
        const statusText = response.statusText;
        const bodyText = await response.text();
        const bodySnippet = bodyText.slice(0, 500);

        if (status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const retryMs = retryAfter ? Number(retryAfter) * 1000 || backoff * 2 : backoff * 2;
          attempt += 1;
          await this.sleep(retryMs);
          backoff *= 2;
          continue;
        }

        if (status >= 500) {
          attempt += 1;
          if (attempt > this.maxRetries) {
            throw new SecHttpError({
              message: `SEC request failed after retries: ${status} ${statusText}`,
              url,
              status,
              statusText,
              bodySnippet,
            });
          }
          await this.sleep(backoff);
          backoff *= 2;
          continue;
        }

        throw new SecHttpError({
          message: `SEC request failed: ${status} ${statusText}`,
          url,
          status,
          statusText,
          bodySnippet,
        });
      } catch (err) {
        const isNetwork = err instanceof TypeError || (err as Error).name === "FetchError";
        if (isNetwork && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(backoff);
          backoff *= 2;
          continue;
        }
        if (err instanceof SecHttpError) {
          throw err;
        }
        throw new SecHttpError({
          message: `SEC request error: ${(err as Error).message}`,
          url,
        });
      }
    }

    throw new SecHttpError({ message: "SEC request failed after retries", url });
  }
}
