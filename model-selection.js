const DEFAULT_MODEL = "gpt-6.2-sol";

function selectModel(value, useDefault = true) {
  const selected = value === undefined && useDefault
    ? process.env.CODEX_MCP_MODEL || DEFAULT_MODEL : value;
  if (selected === "inherit" && !useDefault) {
    throw new Error("inherit is only available for new sessions; omit reply model to retain selection");
  }
  if (selected === undefined || selected === "inherit") return undefined;
  if (typeof selected !== "string" || !selected.trim() || selected !== selected.trim()) {
    throw new Error("model must be a non-empty model ID or inherit");
  }
  return selected;
}

const MODEL_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "Codex model ID, such as gpt-6.2-sol or gpt-6.2-astra. New sessions use CODEX_MCP_MODEL or gpt-6.2-sol; inherit uses local Codex configuration on new sessions only. Replies retain their model unless explicitly overridden.",
};
module.exports = { selectModel, MODEL_SCHEMA };
