import fs from "node:fs";
import path from "node:path";

export function installCuaFixture(base) {
  const resources = path.join(base, "Relocated ChatGPT.app/Contents/Resources");
  const files = [
    "cua_node/bin/node", "cua_node/bin/node_repl",
    "cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs",
    "cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs",
    "codex-cli/CodexCLI.app/Contents/MacOS/codex"
  ];
  for (const file of files) {
    const full = path.join(resources, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "fixture asset; never executed\n", { mode: 0o700 });
  }
  const template = path.join(resources, "plugins/openai-bundled/plugins/unified-computer-use/.mcp.json");
  fs.mkdirSync(path.dirname(template), { recursive: true });
  const config = {
    command: "node", args: [], enabled: false,
    enabled_tools: ["js", "js_reset", "turn_ended"], omit_tools_from: ["code_mode", "deferred"],
    startup_timeout_sec: 120, tools: { js: { output_token_limit: 25000 } }
  };
  fs.writeFileSync(template, JSON.stringify({ mcpServers: { cua_repl: config } }));
  fs.writeFileSync(path.join(resources, "../Info.plist"), '<plist><dict><key>CFBundleShortVersionString</key><string>26.1007.71326</string><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  return { resources, template, config };
}
