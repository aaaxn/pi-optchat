// A minimal stdio MCP server for tests: one `echo` tool. It logs its start and exit to the file in argv[2].
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2], note = line => { if (log) appendFileSync(log, `${line} ${process.pid}\n`); };
note('start');
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // notifications
  if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ id, result: { tools: [{ name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: `echo:${params.arguments?.text}` }] } });
  else send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
lines.on('close', () => { note('exit'); process.exit(0); });
