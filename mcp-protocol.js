// MCP 2026-07-28 is request-scoped; legacy clients retain their initialize path.
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2024-11-05";
const PREFIX = "io.modelcontextprotocol/";
const CATALOG_CACHE = { ttlMs: 300_000, cacheScope: "public" };

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestProtocol(message) {
  const meta = message.params?._meta;
  const modern = message.method === "server/discover" ||
    (object(meta) && ["protocolVersion", "clientCapabilities", "clientInfo", "logLevel"]
      .some((name) => Object.hasOwn(meta, PREFIX + name)));
  if (!modern) return { modern: false };
  const invalid = (text) => { throw Object.assign(new Error(text), { code: -32602 }); };
  if ((typeof message.id !== "string" && !Number.isSafeInteger(message.id)) ||
      !object(message.params) || !object(meta)) {
    invalid("Modern requests require a string or integer id and params._meta");
  }
  const version = meta[PREFIX + "protocolVersion"];
  if (typeof version !== "string" || !version) invalid("Missing protocolVersion metadata");
  if (version !== MODERN_VERSION) {
    throw Object.assign(new Error("Unsupported protocol version"), {
      code: -32022,
      data: { supported: [MODERN_VERSION], requested: version },
    });
  }
  if (!object(meta[PREFIX + "clientCapabilities"])) {
    invalid("Missing or invalid clientCapabilities metadata");
  }
  return { modern: true };
}

function completeResult(result, context, serverInfo) {
  if (!context?.modern) return result;
  return {
    ...result,
    resultType: "complete",
    _meta: { ...result._meta, [PREFIX + "serverInfo"]: serverInfo },
  };
}

function discovery(instructions) {
  return {
    supportedVersions: [MODERN_VERSION],
    capabilities: { tools: {} },
    instructions,
    ...CATALOG_CACHE,
  };
}

module.exports = { LEGACY_VERSION, CATALOG_CACHE, requestProtocol, completeResult, discovery };
