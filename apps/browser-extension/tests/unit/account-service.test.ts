import { describe, expect, it, vi } from "vitest";

import {
  AccountAuthenticationService,
  normalizeAccountEmail,
} from "../../src/runtime/account/service";

describe("Account authentication service", () => {
  it("normalizes one ASCII email form and rejects invalid input", () => {
    expect(normalizeAccountEmail(" Reader@Example.Test \n")).toBe("reader@example.test");
    expect(() => normalizeAccountEmail("not-an-email")).toThrow();
    expect(() => normalizeAccountEmail("réader@example.test")).toThrow();
  });

  it("sends the raw Account password and persists identity/session data without cryptographic keys", async () => {
    const saveAuthenticated = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      account: {
        accountId: "01900000-0000-7000-8000-000000000031",
        email: "reader@example.test",
      },
      sessionId: "01900000-0000-7000-8000-000000000032",
      scope: "Account" as const,
      accessToken: "access",
      accessExpiresAt: "2026-07-25T21:00:00.000Z",
      refreshToken: "refresh",
      refreshExpiresAt: "2026-08-25T21:00:00.000Z",
    }));
    const service = new AccountAuthenticationService({ createSession }, { saveAuthenticated });

    await expect(
      service.login({ email: " Reader@Example.Test ", password: "correct horse battery staple" }),
    ).resolves.toBe("access");

    expect(createSession).toHaveBeenCalledWith(
      "reader@example.test",
      "correct horse battery staple",
    );
    expect(saveAuthenticated).toHaveBeenCalledWith({
      metadata: {
        version: 1,
        accountId: "01900000-0000-7000-8000-000000000031",
        sessionId: "01900000-0000-7000-8000-000000000032",
        email: "reader@example.test",
        scope: "Account",
      },
      refreshToken: "refresh",
    });
    expect(JSON.stringify(saveAuthenticated.mock.calls)).not.toMatch(
      /accountKey|envelope|authenticationSecret|password/i,
    );
  });

  it("rejects a VaultDevice session at the Account login boundary", async () => {
    const saveAuthenticated = vi.fn(async () => undefined);
    const service = new AccountAuthenticationService(
      {
        createSession: vi.fn(async () => ({
          account: {
            accountId: "01900000-0000-7000-8000-000000000031",
            email: "reader@example.test",
          },
          sessionId: "01900000-0000-7000-8000-000000000032",
          scope: "VaultDevice" as const,
          accessToken: "access",
          accessExpiresAt: "2026-07-25T21:00:00.000Z",
          refreshToken: "refresh",
          refreshExpiresAt: "2026-08-25T21:00:00.000Z",
        })),
      },
      { saveAuthenticated },
    );

    await expect(
      service.login({ email: "reader@example.test", password: "password" }),
    ).rejects.toMatchObject({ id: "AUTHENTICATION_FAILED" });
    expect(saveAuthenticated).not.toHaveBeenCalled();
  });
});
