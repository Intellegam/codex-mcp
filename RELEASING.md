# Releasing

When bumping the version, update all of these:

1. `package.json` — `version` field
2. `server.js` — `VERSION` constant
3. Create a git tag: `git tag v{version} && git push origin v{version}`
4. In `agent-plugins/plugins/codex/.mcp.json` — update `#v{version}` tag pin
5. In the sibling `agent-plugins` repository, bump the Codex plugin version in
   `plugins/codex/.claude-plugin/plugin.json` and its entry in
   `.claude-plugin/marketplace.json`.

The `.mcp.json` uses `bunx github:Intellegam/codex-mcp#v{version}` with a pinned tag. Bunx aggressively caches bare `github:` refs, so the tag pin is required.

Merging and publishing require the user’s explicit authorization.
