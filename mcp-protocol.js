// MCP 2026-07-28 is request-scoped; legacy clients retain their initialize path.
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2024-11-05";
const PREFIX = "io.modelcontextprotocol/";
const CATALOG_CACHE = { ttlMs: 300_000, cacheScope: "public" };

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optional(value, key, valid) {
  return !Object.hasOwn(value, key) || valid(value[key]);
}

const string = (value) => typeof value === "string";
const stringArray = (value) => Array.isArray(value) && value.every(string);
function icon(value) {
  return object(value) && string(value.src) &&
    optional(value, "mimeType", string) && optional(value, "sizes", stringArray) &&
    optional(value, "theme", (theme) => theme === "light" || theme === "dark");
}
function implementation(value) {
  return object(value) && string(value.name) && string(value.version) &&
    ["title", "description", "websiteUrl"].every((key) => optional(value, key, string)) &&
    optional(value, "icons", (icons) => Array.isArray(icons) && icons.every(icon));
}
function capabilities(value) {
  const objectValues = (record) => object(record) && Object.values(record).every(object);
  return object(value) && optional(value, "roots", object) &&
    ["experimental", "extensions"].every((key) => optional(value, key, objectValues)) &&
    optional(value, "sampling", (sampling) => object(sampling) &&
      ["context", "tools"].every((key) => optional(sampling, key, object))) &&
    optional(value, "elicitation", (elicitation) => object(elicitation) &&
      ["form", "url"].every((key) => optional(elicitation, key, object)));
}

function requestProtocol(message) {
  const meta = message.params?._meta;
  const modern = message.method === "server/discover" ||
    (object(meta) && ["protocolVersion", "clientCapabilities", "clientInfo", "logLevel"]
      .some((name) => Object.hasOwn(meta, PREFIX + name)));
  if (!modern) return { modern: false };
  const invalid = (text) => { throw Object.assign(new Error(text), { code: -32602 }); };
  if ((typeof message.id !== "string" && !Number.isInteger(message.id)) ||
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
  if (!capabilities(meta[PREFIX + "clientCapabilities"])) {
    invalid("Missing or invalid clientCapabilities metadata");
  }
  // Validate optional fields when present, without interpreting self-reported identity.
  if (!optional(meta, PREFIX + "clientInfo", implementation)) {
    invalid("Invalid clientInfo metadata");
  }
  if (!optional(meta, PREFIX + "logLevel", (level) =>
    ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"].includes(level))) {
    invalid("Invalid logLevel metadata");
  }
  if (!optional(meta, "progressToken", (token) => string(token) ||
      (typeof token === "number" && Number.isFinite(token)))) {
    invalid("Invalid progressToken metadata");
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
