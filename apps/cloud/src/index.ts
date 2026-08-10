import { authenticate } from "./auth";
import { EvaAgent } from "./eva-agent";
import { consumeMemoryQueue, type MemoryQueueMessage } from "./memory";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index";

export { EvaAgent };
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "eva-cloud", protocolVersion: PROTOCOL_VERSION }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname.startsWith("/api/")) {
      const user = await authenticate(request, env);
      if (!user) return jsonError("UNAUTHORIZED", "Authenticate with Cloudflare Access or your Eva cloud token.", 401);

      if (url.pathname === "/api/me") {
        return Response.json({ id: user.id.slice(0, 12), identity: user.identity, method: user.method }, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/api/ws") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonError("UPGRADE_REQUIRED", "Expected a WebSocket upgrade.", 426);
        const cleanUrl = new URL(request.url);
        cleanUrl.searchParams.delete("token");
        const headers = new Headers(request.headers);
        headers.set("x-eva-user-id", user.id);
        headers.set("x-eva-identity", user.identity);
        const agent = env.EVA_AGENT.getByName(user.id);
        return agent.fetch(new Request(cleanUrl, { method: request.method, headers }));
      }
      return jsonError("NOT_FOUND", "API route not found.", 404);
    }

    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },

  async queue(batch: MessageBatch<MemoryQueueMessage>, env: Env): Promise<void> {
    await consumeMemoryQueue(batch, env);
  },
} satisfies ExportedHandler<Env, MemoryQueueMessage>;

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, code, message }, { status, headers: { "cache-control": "no-store" } });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
