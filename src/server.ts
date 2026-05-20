import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HAE_HOST, HAE_PORT } from './config.js';
import { healthCheck } from './tcp/client.js';
import { registerAllTools } from './tools/index.js';
import { initDb, closeDb } from './db/client.js';

const server = new McpServer({
    name: 'Health Auto Export',
    version: '1.0.0',
});

registerAllTools(server);

async function main(): Promise<void> {
    await initDb();
    console.error('MongoDB connected and indexes ensured.');

    console.error(`Performing health check to ${HAE_HOST}:${HAE_PORT}...`);
    const isHealthy = await healthCheck(HAE_HOST, HAE_PORT);

    if (!isHealthy) {
        console.error(
            `Health check warning: Cannot connect to ${HAE_HOST}:${HAE_PORT}. Server will start anyway - ensure Health Auto Export iOS app is running with TCP server enabled.`,
        );
    } else {
        console.error(
            `Health check passed: Successfully connected to ${HAE_HOST}:${HAE_PORT}`,
        );
    }

    process.on('SIGTERM', () => {
        closeDb().finally(() => process.exit(0));
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Health Auto Export MCP Server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
