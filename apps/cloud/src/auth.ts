import { createRemoteJWKSet, jwtVerify } from "jose";

export type AuthenticatedUser = {
  id: string;
  identity: string;
  method: "access" | "token";
};

type AuthEnv = Env & {
  EVA_API_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export async function authenticate(request: Request, env: AuthEnv): Promise<AuthenticatedUser | null> {
  const access = await authenticateAccess(request, env);
  if (access) return access;

  const expected = env.EVA_API_TOKEN;
  if (!expected) return null;
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const protocolToken = request.headers.get("sec-websocket-protocol")
    ?.split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith("eva-token."))
    ?.slice("eva-token.".length);
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : protocolToken ?? url.searchParams.get("token");
  if (!supplied || !(await equalSecrets(supplied, expected))) return null;
  return { id: await stableId("owner"), identity: "owner", method: "token" };
}

async function authenticateAccess(request: Request, env: AuthEnv): Promise<AuthenticatedUser | null> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD?.trim();
  if (!assertion || !teamDomain || !audience) return null;
  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, jwks, { issuer: teamDomain, audience });
    const identity = typeof payload.email === "string" ? payload.email.toLowerCase() : payload.sub;
    if (!identity) return null;
    return { id: await stableId(identity), identity, method: "access" };
  } catch {
    return null;
  }
}

function normalizeTeamDomain(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("https://") ? trimmed.replace(/\/$/, "") : `https://${trimmed.replace(/\/$/, "")}`;
}

async function stableId(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`eva:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function equalSecrets(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
