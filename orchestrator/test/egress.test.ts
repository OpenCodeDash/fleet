import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { test } from "node:test";
import {
  EgressProxy,
  buildAllowlist,
  hostMatches,
  isAllowed,
  normalizeHost,
  type EgressEvent,
} from "../src/egress/index.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function proxyRequest(
  proxyPort: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "GET", path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectProbe(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += String(chunk);
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(data);
    });
  });
}

test("normalizeHost strips ports and lowercases", () => {
  assert.equal(normalizeHost("API.GitHub.com:443"), "api.github.com");
  assert.equal(normalizeHost("api.github.com"), "api.github.com");
});

test("hostMatches supports exact and wildcard patterns", () => {
  assert.equal(hostMatches("api.github.com", "api.github.com"), true);
  assert.equal(hostMatches("a.example.com", "*.example.com"), true);
  assert.equal(hostMatches("api.github.com", "*.example.com"), false);
  assert.equal(hostMatches("evil-example.com", "*.example.com"), false);
});

test("buildAllowlist unions, dedupes and sorts sources", () => {
  assert.deepEqual(
    buildAllowlist({
      orchestrator: "orch.internal",
      mcpEgress: ["api.github.com", "orch.internal"],
      extra: ["LLM.example.com"],
      provider: ["llm.example.com"],
    }),
    ["api.github.com", "llm.example.com", "orch.internal"],
  );
});

test("forwards an allowlisted HTTP request", async () => {
  const origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
  });
  const originPort = await listen(origin);

  const events: EgressEvent[] = [];
  const proxy = new EgressProxy({ allowlist: ["127.0.0.1"], onEvent: (event) => events.push(event) });
  const proxyPort = await proxy.listen();
  try {
    const result = await proxyRequest(proxyPort, `http://127.0.0.1:${originPort}/x`);
    assert.equal(result.status, 200);
    assert.equal(result.body, "hello");
    assert.deepEqual(events, [{ host: "127.0.0.1", allowed: true, method: "GET" }]);
  } finally {
    await proxy.close();
    origin.close();
  }
});

test("denies a non-allowlisted host with 403", async () => {
  const proxy = new EgressProxy({ allowlist: ["api.github.com"] });
  const proxyPort = await proxy.listen();
  try {
    const result = await proxyRequest(proxyPort, "http://blocked.example/x");
    assert.equal(result.status, 403);
    assert.match(result.body, /blocked by egress policy/);
  } finally {
    await proxy.close();
  }
});

test("denies a non-allowlisted CONNECT tunnel", async () => {
  const proxy = new EgressProxy({ allowlist: ["api.github.com"] });
  const proxyPort = await proxy.listen();
  try {
    const response = await connectProbe(proxyPort, "blocked.example:443");
    assert.match(response, /403 Forbidden/);
  } finally {
    await proxy.close();
  }
});

test("isAllowed consults the whole list", () => {
  assert.equal(isAllowed("api.github.com", ["*.example.com", "api.github.com"]), true);
  assert.equal(isAllowed("nope.dev", ["*.example.com", "api.github.com"]), false);
});
