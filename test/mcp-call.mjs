/**
 * CLI wrapper to call any Ondbay MCP tool from the terminal.
 * Usage: node test/mcp-call.mjs <tool_name> '<json_arguments>'
 *        node test/mcp-call.mjs --list
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = '/home/kerlon/Projetos/mcp-project';
const [toolName, argsJson] = process.argv.slice(2);

if (!toolName) {
  console.log('Usage: node test/mcp-call.mjs <tool> \'<json_args>\'');
  console.log('       node test/mcp-call.mjs --list');
  process.exit(0);
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ONDBAY_PROJECT_ROOT: PROJECT_ROOT },
  });

  const client = new Client({ name: 'cli-caller', version: '1.0.0' });
  await client.connect(transport);

  if (toolName === '--list') {
    const tools = await client.listTools();
    for (const t of tools.tools) {
      console.log(`  ${t.name} — ${t.description?.slice(0, 90)}`);
    }
    process.exit(0);
  }

  const args = argsJson ? JSON.parse(argsJson) : {};
  const result = await client.callTool({ name: toolName, arguments: args });

  if (result.isError) {
    console.error('ERROR:', result.content?.[0]?.text);
    process.exit(1);
  }

  for (const item of result.content) {
    if (item.type === 'text') {
      try { console.log(JSON.stringify(JSON.parse(item.text), null, 2)); }
      catch { console.log(item.text); }
    }
  }
  process.exit(0);
}

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 12000);
main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
