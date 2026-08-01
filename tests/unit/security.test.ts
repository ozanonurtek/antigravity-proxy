import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { loadProxyConfig, updateProxyConfig, getProxyConfig } from "../../src/config/manager";
import { isApiAuthorized, isWebAuthenticated, isWebAuthRequired, createWebSession, destroyWebSession } from "../../src/auth/security";

describe("Unit Tests: Security Module", () => {
    beforeAll(async () => {
        await loadProxyConfig();
    });

    beforeEach(async () => {
        await updateProxyConfig({
            security: {
                apiKeys: [],
                webPassword: ""
            }
        });
    });

    describe("API Key Authorization", () => {
        test("Allows access when no API keys configured", () => {
            const req = new Request("http://localhost:3000/v1/models");
            expect(isApiAuthorized(req)).toBe(true);
        });

        test("Rejects access when API keys configured but no header provided", async () => {
            await updateProxyConfig({
                security: { apiKeys: ["my-secret-key"] }
            });
            const req = new Request("http://localhost:3000/v1/models");
            expect(isApiAuthorized(req)).toBe(false);
        });

        test("Rejects access with invalid Authorization Bearer token", async () => {
            await updateProxyConfig({
                security: { apiKeys: ["my-secret-key"] }
            });
            const req = new Request("http://localhost:3000/v1/models", {
                headers: { "Authorization": "Bearer wrong-key" }
            });
            expect(isApiAuthorized(req)).toBe(false);
        });

        test("Accepts access with valid Authorization Bearer token", async () => {
            await updateProxyConfig({
                security: { apiKeys: ["key-1", "key-2"] }
            });
            const req = new Request("http://localhost:3000/v1/models", {
                headers: { "Authorization": "Bearer key-2" }
            });
            expect(isApiAuthorized(req)).toBe(true);
        });

        test("Accepts access with valid x-api-key header", async () => {
            await updateProxyConfig({
                security: { apiKeys: ["key-1", "key-2"] }
            });
            const req = new Request("http://localhost:3000/v1/models", {
                headers: { "x-api-key": "key-1" }
            });
            expect(isApiAuthorized(req)).toBe(true);
        });
    });

    describe("Web Password Session Authorization", () => {
        test("Web auth not required when webPassword is empty", () => {
            expect(isWebAuthRequired()).toBe(false);
            const req = new Request("http://localhost:3000/api/status");
            expect(isWebAuthenticated(req)).toBe(true);
        });

        test("Web auth required when webPassword is set", async () => {
            await updateProxyConfig({
                security: { apiKeys: [], webPassword: "supersecretpass" }
            });
            expect(isWebAuthRequired()).toBe(true);
            const req = new Request("http://localhost:3000/api/status");
            expect(isWebAuthenticated(req)).toBe(false);
        });

        test("Web auth succeeds with valid session token in Cookie", async () => {
            await updateProxyConfig({
                security: { apiKeys: [], webPassword: "supersecretpass" }
            });
            const sessionToken = createWebSession();
            const req = new Request("http://localhost:3000/api/status", {
                headers: { "Cookie": `ag_session=${sessionToken}` }
            });
            expect(isWebAuthenticated(req)).toBe(true);
        });

        test("Web auth fails with invalid session token in Cookie", async () => {
            await updateProxyConfig({
                security: { apiKeys: [], webPassword: "supersecretpass" }
            });
            const req = new Request("http://localhost:3000/api/status", {
                headers: { "Cookie": "ag_session=invalid-token" }
            });
            expect(isWebAuthenticated(req)).toBe(false);
        });

        test("Web auth fails after session is destroyed (logout)", async () => {
            await updateProxyConfig({
                security: { apiKeys: [], webPassword: "supersecretpass" }
            });
            const sessionToken = createWebSession();
            destroyWebSession(sessionToken);
            const req = new Request("http://localhost:3000/api/status", {
                headers: { "Cookie": `ag_session=${sessionToken}` }
            });
            expect(isWebAuthenticated(req)).toBe(false);
        });

        test("Web auth succeeds with direct webPassword in x-web-password header", async () => {
            await updateProxyConfig({
                security: { apiKeys: [], webPassword: "supersecretpass" }
            });
            const req = new Request("http://localhost:3000/api/status", {
                headers: { "x-web-password": "supersecretpass" }
            });
            expect(isWebAuthenticated(req)).toBe(true);
        });
    });
});
