import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApp } from "../src/server/api/app.js";
import { createApiClient, createTestApp } from "./helpers.js";

it("keeps logins independent and detects a session lost after a server restart", async () => {
  const { db, hardware } = createTestApp();
  let server = createApp({ db, hardware }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const first = createApiClient(port);
    const second = createApiClient(port);
    const credentials = { username: "cashier", password: "2222" };
    const [firstLogin, secondLogin] = await Promise.all([
      first("auth/login", credentials),
      second("auth/login", credentials),
    ]);
    expect(firstLogin.status).toBe(200);
    expect(secondLogin.status).toBe(200);
    expect(firstLogin.headers.get("set-cookie")).not.toBe(secondLogin.headers.get("set-cookie"));
    expect(await (await first("session")).json()).toMatchObject({ actor: { username: "cashier" } });
    expect(await (await second("session")).json()).toMatchObject({
      authenticated: true,
      actor: { username: "cashier" },
    });

    expect((await first("auth/logout", {})).status).toBe(200);
    const signedOut = await (await first("session")).json();
    expect(signedOut.actor.username).toBeUndefined();
    expect(await (await second("session")).json()).toMatchObject({ actor: { username: "cashier" } });

    server.close();
    await once(server, "close");
    server = createApp({ db, hardware }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const restartedPort = (server.address() as AddressInfo).port;
    const oldCookie = secondLogin.headers.get("set-cookie")!.split(";", 1)[0];
    const stale = await fetch(`http://127.0.0.1:${restartedPort}/api/session`, {
      headers: { Cookie: oldCookie },
    });
    expect(await stale.json()).toMatchObject({ authenticated: false });
    for (const [path, sessionHeader] of [
      ["orders", { Cookie: oldCookie }],
      ["invoices/generate", { "X-POS-Client": "1" }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${restartedPort}/api/${path}`, {
        method: "POST",
        headers: { ...sessionHeader, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    }
    const reconnect = createApiClient(restartedPort);
    expect((await reconnect("auth/login", credentials)).status).toBe(200);
    expect(await (await reconnect("session")).json()).toMatchObject({ authenticated: true });
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
