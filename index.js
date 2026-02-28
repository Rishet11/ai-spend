#!/usr/bin/env node

const { createServer } = require('./src/server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
codex-spend - See where your OpenAI Codex tokens go

Usage:
  codex-spend [options]

Options:
  --port <port>   Port to run dashboard on (default: 4321)
  --no-open       Don't auto-open browser
  --help, -h      Show this help message

Examples:
  npx codex-spend          Open dashboard in browser
  codex-spend --port 8080  Use custom port
`);
  process.exit(0);
}

const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 4321;
const noOpen = args.includes('--no-open');

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}

const app = createServer();

const server = app.listen(port, '127.0.0.1', async () => {
  const url = `http://localhost:${port}`;
  
  try {
    const { parseAllSessions } = require('./src/parser');
    const data = await parseAllSessions();
    if (data && data.totals) {
      const t = data.totals;
      console.log('\n=======================================');
      console.log('       💰 Codex Spend Summary');
      console.log('=======================================');
      console.log(`Tokens Used : ${(t.totalTokens / 1_000_000).toFixed(1)}M`);
      console.log(`Cache Hit   : ${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
      console.log(`Reasoning   : ${(t.totalReasoningTokens > 1_000_000) ? (t.totalReasoningTokens / 1_000_000).toFixed(1) + 'M' : (t.totalReasoningTokens / 1000).toFixed(1) + 'K'} tokens`);
      console.log(`Est. Cost   : $${(t.totalCost || 0).toFixed(2)}`);
      console.log('=======================================\n');
    }
  } catch (err) {
    // Ignore parsing errors on boot, the UI will surface them
  }

  console.log(`  🚀 Dashboard running at: ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close();
  process.exit(0);
});
