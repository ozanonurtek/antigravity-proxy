import { getProxyConfig } from "../config/manager";

// Store active web session tokens in memory
const activeWebSessions = new Set<string>();

/**
 * Checks if web authentication is enabled.
 */
export function isWebAuthRequired(): boolean {
    const config = getProxyConfig();
    return Boolean(config.security?.webPassword && config.security.webPassword.trim().length > 0);
}

/**
 * Creates a new web session token.
 */
export function createWebSession(): string {
    const token = crypto.randomUUID();
    activeWebSessions.add(token);
    return token;
}

/**
 * Destroys a web session token.
 */
export function destroyWebSession(token: string): void {
    activeWebSessions.delete(token);
}

/**
 * Verifies if the request is authenticated for web console / management endpoints.
 */
export function isWebAuthenticated(req: Request): boolean {
    if (!isWebAuthRequired()) {
        return true;
    }

    const config = getProxyConfig();
    const webPassword = config.security?.webPassword;

    // Check Authorization header (Bearer <token>)
    const authHeader = req.headers.get("authorization");
    if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (activeWebSessions.has(token) || (webPassword && token === webPassword)) {
            return true;
        }
    }

    // Check x-web-password header
    const passHeader = req.headers.get("x-web-password");
    if (passHeader && webPassword && passHeader === webPassword) {
        return true;
    }

    // Check cookies (ag_session=<token>)
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
        const cookies = parseCookies(cookieHeader);
        const sessionToken = cookies["ag_session"];
        if (sessionToken && (activeWebSessions.has(sessionToken) || (webPassword && sessionToken === webPassword))) {
            return true;
        }
    }

    // Check query parameter (e.g. for SSE: ?token=... or ?password=...)
    const url = new URL(req.url);
    const queryToken = url.searchParams.get("token") || url.searchParams.get("password");
    if (queryToken && (activeWebSessions.has(queryToken) || (webPassword && queryToken === webPassword))) {
        return true;
    }

    return false;
}

/**
 * Checks if API key authentication is enabled for OpenAI endpoints.
 */
export function isApiAuthRequired(): boolean {
    const config = getProxyConfig();
    const keys = config.security?.apiKeys || [];
    return keys.length > 0 && keys.some(k => k.trim().length > 0);
}

/**
 * Verifies if the request is authorized for OpenAI API endpoints (/v1/*).
 */
export function isApiAuthorized(req: Request): boolean {
    if (!isApiAuthRequired()) {
        return true;
    }

    const config = getProxyConfig();
    const validKeys = (config.security?.apiKeys || []).map(k => k.trim()).filter(Boolean);

    // Check Authorization header (Bearer <key>)
    const authHeader = req.headers.get("authorization");
    if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (validKeys.includes(token)) {
            return true;
        }
    }

    // Check api-key or x-api-key header
    const apiKeyHeader = req.headers.get("api-key") || req.headers.get("x-api-key");
    if (apiKeyHeader && validKeys.includes(apiKeyHeader.trim())) {
        return true;
    }

    return false;
}

function parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    cookieHeader.split(";").forEach(cookie => {
        const parts = cookie.split("=");
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join("=").trim();
            cookies[key] = value;
        }
    });
    return cookies;
}
