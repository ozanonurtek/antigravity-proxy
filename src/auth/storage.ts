import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { type AntigravityAccount, type SelectionStrategy } from "./types";

const defaultPath = existsSync(join(process.cwd(), "data"))
  ? join(process.cwd(), "data", "antigravity-accounts.json")
  : join(process.cwd(), "antigravity-accounts.json");

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || defaultPath;

interface StorageFormat {
    accounts: AntigravityAccount[];
    strategy?: SelectionStrategy;
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) {
      const data = await file.json();
      if (Array.isArray(data)) {
          // Migration from old format
          return { accounts: data, strategy: 'hybrid' };
      }
      return data;
    }
  } catch (e) {
    console.error("Failed to load accounts:", e);
  }
  return { accounts: [] };
}

// Kept for backward compatibility but deprecated
export async function loadAccounts(): Promise<AntigravityAccount[]> {
    return (await loadConfig()).accounts;
}

export async function saveConfig(config: StorageFormat): Promise<void> {
  try {
    const dir = dirname(ACCOUNTS_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(ACCOUNTS_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}
