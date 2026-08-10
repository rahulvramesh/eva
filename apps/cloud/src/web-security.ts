export function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Web fetch requires a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Web fetch only supports HTTP and HTTPS.");
  if (url.username || url.password) throw new Error("Web fetch URLs cannot contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw new Error("Web fetch cannot access private or local network addresses.");
  return url;
}

export function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1") return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe") || hostname.startsWith("::ffff:")) return true;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (!ipv4 || ipv4.some((octet) => octet > 255)) return false;
  const [a, b] = ipv4;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}
