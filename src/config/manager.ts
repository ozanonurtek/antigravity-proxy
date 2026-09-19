import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { type ProxyConfig, type ProviderConfig } from './types';
import { EventEmitter } from 'node:events';

const defaultPath = existsSync(join(process.cwd(), 'data'))
  ? join(process.cwd(), 'data', 'config.json')
  : (existsSync(join(process.cwd(), 'config.json')) ? join(process.cwd(), 'config.json') : join(process.cwd(), 'data', 'config.json'));

const CONFIG_PATH = process.env.CONFIG_FILE || process.env.CONFIG_PATH || defaultPath;
export const configEventBus = new EventEmitter();

let config: ProxyConfig;

const DEFAULT_CONFIG: ProxyConfig = {
  rotation: {
    strategy: 'hybrid',
    cooldown: {
      defaultDurationMs: 60000,
      maxDurationMs: 3600000
    }
  },
  scoring: {
    healthRange: {
      min: 0,
      max: 100,
      initial: 100
    },
    penalties: {
      apiError: -10,
      refreshError: -20,
      fatalError: -50,
      systemicError: -5
    },
    rewards: {
      success: 1
    },
    weights: {
      health: 2.0,
      lru: 0.1
    }
  },
  models: {
    blacklist: [],
    routing: {
      sandboxKeywords: ['gpt', 'antigravity', 'image'],
      cliKeywords: ['claude', 'gemini-2.0', 'gemini-2.5', '-preview'],
      forceToSandbox: ['gpt']
    },
    timeouts: {
      'default': 30000,
      'claude': 60000,
      'gemini-3-pro': 45000,
      'gemini-3.1-pro': 45000,
      'thinking': 120000
    }
  },
  retry: {
    maxAttempts: 5,
    transientRetryThresholdSeconds: 5
  },
  tokens: {
    expiryBufferMs: 60000
  },
  quota: {
    refreshIntervalMs: 300000,
    initialDelayMs: 10000
  },
    endpoints: {
      sandbox: [
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse'
      ],
      cli: [
        'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://autopush-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
      ]
    },
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKey: '',
      apiKeyEnv: 'OPENCODE_API_KEY',
      sessionHeader: 'x-opencode-session',
      clientHeader: 'x-opencode-client',
      client: 'antigravity-proxy',
      enabled: true,
      // Models that are not served on the default chat/completions endpoint.
      // See https://opencode.ai/docs/zen/#endpoints
      modelApis: {
        'gpt-6-astra': 'responses',
        'gpt-5.6-sol': 'responses',
        'gpt-5.6-terra': 'responses',
        'gpt-5.6-luna': 'responses',
        'gpt-5.5': 'responses',
        'gpt-5.5-pro': 'responses',
        'gpt-5.4': 'responses',
        'gpt-5.4-pro': 'responses',
        'gpt-5.4-mini': 'responses',
        'gpt-5.4-nano': 'responses',
        'gpt-5.3-codex': 'responses',
        'gpt-5.3-codex-spark': 'responses',
        'gpt-5.2': 'responses',
        'gpt-5.2-codex': 'responses',
        'gpt-5.1': 'responses',
        'gpt-5.1-codex': 'responses',
        'gpt-5.1-codex-max': 'responses',
        'gpt-5.1-codex-mini': 'responses',
        'gpt-5': 'responses',
        'gpt-5-codex': 'responses',
        'gpt-5-nano': 'responses',
        'grok-4.6': 'responses',
        'grok-4.5': 'responses',
        'grok-build-0.1': 'responses',
        'muse-spark-1.3': 'responses',
        'muse-spark-1.2': 'responses',
        'muse-spark-1.3-contributor-free': 'responses',
        'claude-fable-5-1': 'messages',
        'claude-fable-5': 'messages',
        'claude-opus-5': 'messages',
        'claude-opus-4-8': 'messages',
        'claude-opus-4-7': 'messages',
        'claude-opus-4-6': 'messages',
        'claude-opus-4-5': 'messages',
        'claude-sonnet-5': 'messages',
        'claude-sonnet-4-6': 'messages',
        'claude-sonnet-4-5': 'messages',
        'claude-haiku-4-5': 'messages',
        'qwen3.8-flash': 'messages',
        'qwen3.7-max': 'messages',
        'qwen3.7-plus': 'messages',
        'qwen3.6-plus': 'messages',
        'qwen3.5-plus': 'messages'
      }
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: '',
      apiKeyEnv: 'OPENCODE_API_KEY',
      sessionHeader: 'x-opencode-session',
      clientHeader: 'x-opencode-client',
      client: 'antigravity-proxy',
      enabled: true,
      // See https://opencode.ai/docs/go/#endpoints
      modelApis: {
        'grok-4.6': 'responses',
        'gpt-5.6-luna': 'responses',
        'muse-spark-1.3-contributor': 'responses',
        'muse-spark-1.2-contributor': 'responses',
        'minimax-m2.7': 'messages',
        'minimax-m2.5': 'messages',
        'qwen3.8-max': 'messages',
        'qwen3.8-flash': 'messages',
        'qwen3.7-max': 'messages',
        'qwen3.7-plus': 'messages',
        'qwen3.6-plus': 'messages'
      }
    }
  ],
  logging: {
    maxBufferSize: 200,
    enableConsoleCapture: true
  },
  features: {
    googleSearchGrounding: false,
    groundingMode: 'auto',
    keepThinking: false,
    sanitizeToolNames: true,
    pidOffsetEnabled: false,
    softQuotaThresholdPercent: 90,
    jitterEnabled: true,
    jitterMinMs: 50,
    jitterMaxMs: 300
  },
  scheduling: {
    mode: 'cache_first',
    maxCacheFirstWaitSeconds: 60,
    maxRateLimitWaitSeconds: 300
  },
  security: {
    apiKeys: [],
    webPassword: ''
  }
};

export async function loadProxyConfig(): Promise<ProxyConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    const exists = await file.exists();
    
    if (!exists) {
      console.log('[Config] config.json not found, creating with defaults...');
      config = applyEnvOverrides(DEFAULT_CONFIG);
      await saveProxyConfig(config);
      return config;
    }
    
    const text = await file.text();
    const loadedConfig = JSON.parse(text);
    const merged = deepMerge(DEFAULT_CONFIG, loadedConfig) as ProxyConfig;
    merged.providers = syncProviderDefaults(DEFAULT_CONFIG.providers, merged.providers);
    config = applyEnvOverrides(merged);
    console.log(`[Config] Loaded configuration: strategy=${config.rotation.strategy}`);
    return config;
  } catch (e) {
    console.error('[Config] Failed to load config.json, using defaults:', e);
    config = applyEnvOverrides(DEFAULT_CONFIG);
    return config;
  }
}

/**
 * Merge persisted providers with the built-in defaults so newly added default
 * fields (e.g. `modelApis`) apply even when an older config was already saved.
 */
function syncProviderDefaults(defaults: ProviderConfig[] = [], loaded: ProviderConfig[] = []): ProviderConfig[] {
  if (!loaded.length) return defaults;
  return loaded.map(provider => {
    const base = defaults.find(d => d.id === provider.id);
    if (!base) return provider;
    return {
      ...base,
      ...provider,
      modelApis: { ...(base.modelApis || {}), ...(provider.modelApis || {}) },
      defaultHeaders: { ...(base.defaultHeaders || {}), ...(provider.defaultHeaders || {}) }
    };
  });
}

function applyEnvOverrides(cfg: ProxyConfig): ProxyConfig {
  const result = { ...cfg };
  if (!result.security) {
    result.security = { apiKeys: [], webPassword: '' };
  } else {
    result.security = { ...result.security };
  }

  const envApiKeys = process.env.API_KEYS || process.env.API_KEY || '';
  if (envApiKeys) {
    const parsedKeys = envApiKeys.split(',').map(k => k.trim()).filter(Boolean);
    result.security.apiKeys = Array.from(new Set([...(result.security.apiKeys || []), ...parsedKeys]));
  }

  const envWebPassword = process.env.WEB_PASSWORD || process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || '';
  if (envWebPassword) {
    result.security.webPassword = envWebPassword.trim();
  }

  return result;
}

export async function saveProxyConfig(newConfig: ProxyConfig): Promise<void> {
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    config = newConfig;
    configEventBus.emit('update', config);
    console.log(`[Config] Configuration saved successfully to ${CONFIG_PATH}`);
  } catch (e) {
    console.error(`[Config] Failed to save config to ${CONFIG_PATH}:`, e);
    throw e;
  }
}

export function getProxyConfig(): ProxyConfig {
  if (!config) {
    throw new Error('[Config] Configuration not initialized. Call loadProxyConfig() first.');
  }
  return config;
}

export async function updateProxyConfig(updates: Partial<ProxyConfig>): Promise<ProxyConfig> {
  const merged = deepMerge(config, updates);
  await saveProxyConfig(merged);
  return merged;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}
