import { expect, test, describe, afterEach } from "bun:test";
import { getBaseUrl, OAUTH_CONFIG } from "../../src/utils/headers";

describe("Base URL & OAuth Config Unit Tests", () => {
  const originalBaseUrl = process.env.BASE_URL;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;

  afterEach(() => {
    if (originalBaseUrl !== undefined) {
      process.env.BASE_URL = originalBaseUrl;
    } else {
      delete process.env.BASE_URL;
    }
    if (originalClientId !== undefined) {
      process.env.GOOGLE_CLIENT_ID = originalClientId;
    } else {
      delete process.env.GOOGLE_CLIENT_ID;
    }
  });

  test("getBaseUrl defaults to http://localhost:3000 when BASE_URL is empty", () => {
    delete process.env.BASE_URL;
    expect(getBaseUrl()).toBe("http://localhost:3000");
  });

  test("getBaseUrl uses process.env.BASE_URL when provided", () => {
    process.env.BASE_URL = "http://192.168.1.100:3000";
    expect(getBaseUrl()).toBe("http://192.168.1.100:3000");
  });

  test("getBaseUrl strips trailing slashes from process.env.BASE_URL", () => {
    process.env.BASE_URL = "https://proxy.example.com///";
    expect(getBaseUrl()).toBe("https://proxy.example.com");
  });

  test("getBaseUrl prepends http:// if scheme is missing", () => {
    process.env.BASE_URL = "my-host:3000";
    expect(getBaseUrl()).toBe("http://my-host:3000");
  });

  test("OAUTH_CONFIG.redirectUri returns localhost/127.0.0.1 for default client ID", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.BASE_URL = "http://192.168.1.100:3000";
    expect(OAUTH_CONFIG.redirectUri).toBe("http://localhost:3000/oauth-callback");

    process.env.BASE_URL = "http://127.0.0.1:3000";
    expect(OAUTH_CONFIG.redirectUri).toBe("http://127.0.0.1:3000/oauth-callback");
  });

  test("OAUTH_CONFIG.redirectUri uses BASE_URL when custom GOOGLE_CLIENT_ID is provided", () => {
    process.env.GOOGLE_CLIENT_ID = "custom-client-id.apps.googleusercontent.com";
    process.env.BASE_URL = "https://custom.domain.com:8443";
    expect(OAUTH_CONFIG.redirectUri).toBe("https://custom.domain.com:8443/oauth-callback");
    expect(OAUTH_CONFIG.clientId).toBe("custom-client-id.apps.googleusercontent.com");
  });
});
