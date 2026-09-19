export interface ProxyConfig {
  rotation: RotationConfig;
  scoring: ScoringConfig;
  models: ModelsConfig;
  retry: RetryConfig;
  tokens: TokensConfig;
  quota: QuotaConfig;
  endpoints: EndpointsConfig;
  providers: ProviderConfig[];
  logging: LoggingConfig;
  features: FeaturesConfig;
  scheduling: SchedulingConfig;
  security: SecurityConfig;
}

/**
 * External OpenAI-compatible upstream that this gateway can proxy to.
 * Requests for models prefixed with `${id}/` are forwarded to `baseUrl`.
 */
export interface ProviderConfig {
  /** Unique provider id and model prefix, e.g. "opencode" or "opencode-go" */
  id: string;
  /** Human readable name shown in dashboards */
  name?: string;
  /** OpenAI-compatible base URL (no trailing slash required) */
  baseUrl: string;
  /** Static API key for this upstream */
  apiKey?: string;
  /** Environment variable to read the API key from when `apiKey` is empty */
  apiKeyEnv?: string;
  /** Path appended to baseUrl for chat requests. Default: chat/completions */
  chatPath?: string;
  /** Path appended to baseUrl for OpenAI Responses requests. Default: responses */
  responsesPath?: string;
  /** Path appended to baseUrl for Anthropic Messages requests. Default: messages */
  messagesPath?: string;
  /** Path appended to baseUrl for model discovery. Default: models */
  modelsPath?: string;
  /**
   * Per-model upstream API overrides. Keys are upstream model ids (without the
   * `${providerId}/` prefix). Defaults to "chat" (chat/completions).
   * Many OpenCode models are only served on the Responses API (`responses`)
   * or the Anthropic Messages API (`messages`).
   */
  modelApis?: Record<string, 'chat' | 'responses' | 'messages'>;
  /** Header used to send the stable conversation/session id, e.g. "x-opencode-session" */
  sessionHeader?: string;
  /** Header used to identify this client upstream, e.g. "x-opencode-client" */
  clientHeader?: string;
  /** Value sent in `clientHeader` and as User-Agent default */
  client?: string;
  /** Extra headers forwarded on every upstream request */
  defaultHeaders?: Record<string, string>;
  /** Disable to skip this provider entirely */
  enabled?: boolean;
}

export interface SecurityConfig {
  /** API keys required to access OpenAI compatible endpoints (/v1/*) */
  apiKeys: string[];
  /** Password required to access Web Console and Management API */
  webPassword?: string;
}

export interface RotationConfig {
  strategy: 'hybrid' | 'sticky' | 'round-robin' | 'random' | 'least-used';
  cooldown: {
    defaultDurationMs: number;
    maxDurationMs: number;
  };
}

export interface ScoringConfig {
  healthRange: {
    min: number;
    max: number;
    initial: number;
  };
  penalties: {
    apiError: number;
    refreshError: number;
    fatalError: number;
    systemicError: number;
  };
  rewards: {
    success: number;
  };
  weights: {
    health: number;
    lru: number;
  };
}

export interface ModelsConfig {
  blacklist: string[];
  routing: {
    sandboxKeywords: string[];
    cliKeywords: string[];
    forceToSandbox: string[];
  };
  timeouts: Record<string, number>;
}

export interface RetryConfig {
  maxAttempts: number;
  transientRetryThresholdSeconds: number;
}

export interface TokensConfig {
  expiryBufferMs: number;
}

export interface QuotaConfig {
  refreshIntervalMs: number;
  initialDelayMs: number;
}

export interface EndpointsConfig {
  sandbox: string[];
  cli: string | string[];
}

export interface LoggingConfig {
  maxBufferSize: number;
  enableConsoleCapture: boolean;
}

export interface FeaturesConfig {
  /** Enable Google Search grounding for Gemini models */
  googleSearchGrounding: boolean;
  /** Grounding mode: 'auto' lets the model decide, 'always' forces search on every request */
  groundingMode: 'auto' | 'always';
  /** Preserve thinking blocks across conversation turns */
  keepThinking: boolean;
  /** Sanitize MCP tool names that start with numbers or have invalid chars */
  sanitizeToolNames: boolean;
  /** Enable PID-based offset for distributing accounts across parallel agents */
  pidOffsetEnabled: boolean;
  /** Soft quota threshold percentage (0-100). Skip account when quota usage exceeds this. Set to 100 to disable. */
  softQuotaThresholdPercent: number;
  /** Enable request timing jitter to reduce detection patterns */
  jitterEnabled: boolean;
  /** Minimum jitter delay in milliseconds */
  jitterMinMs: number;
  /** Maximum jitter delay in milliseconds */
  jitterMaxMs: number;
}

export interface SchedulingConfig {
  /** Scheduling mode: 'cache_first' waits for same account to preserve prompt cache, 'balance' switches immediately, 'performance_first' round-robins */
  mode: 'cache_first' | 'balance' | 'performance_first';
  /** Max seconds to wait for the same account in cache_first mode before switching */
  maxCacheFirstWaitSeconds: number;
  /** Max seconds to wait when all accounts are rate-limited before erroring */
  maxRateLimitWaitSeconds: number;
}
