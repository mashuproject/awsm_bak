import { describe, expect, it, vi } from "vitest";

import {
  AccountAuthenticationService,
  normalizeAccountUsername,
} from "../../src/runtime/account/service";

describe("Account authentication service", () => {
  it("normalizes one ASCII username form and rejects invalid input", () => {
    expect(normalizeAccountUsername(" Quiet_Vault \n")).toBe("quiet_vault");
    expect(() => normalizeAccountUsername("ends-with-")).toThrow();
    expect(() => normalizeAccountUsername("ab")).toThrow();
    expect(() => normalizeAccountUsername("reader@example.test")).toThrow();
    expect(() => normalizeAccountUsername("réader_test")).toThrow();
  });

  it("sends the raw Account password and persists identity/session data without cryptographic keys", async () => {
    const saveAuthenticated = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      account: {
        accountId: "01900000-0000-7000-8000-000000000031",
        username: "reader_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
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
      service.login({ username: " Reader_Test ", password: "correct horse battery staple" }),
    ).resolves.toBe("access");

    expect(createSession).toHaveBeenCalledWith("reader_test", "correct horse battery staple");
    expect(saveAuthenticated).toHaveBeenCalledWith({
      metadata: {
        version: 1,
        accountId: "01900000-0000-7000-8000-000000000031",
        sessionId: "01900000-0000-7000-8000-000000000032",
        username: "reader_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
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
            username: "reader_test",
            inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
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
      service.login({ username: "reader_test", password: "password" }),
    ).rejects.toMatchObject({ id: "AUTHENTICATION_FAILED" });
    expect(saveAuthenticated).not.toHaveBeenCalled();
  });
});
