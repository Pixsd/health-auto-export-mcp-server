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
    // Connect the transport immediately so the MCP protocol is active from the
    // first byte. Deferring this until after async init (MongoDB, health check)
    // leaves a window where Claude Desktop sends data to stdin before the SDK
    // is listening, causing spurious JSON parse errors on the client side.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Health Auto Export MCP Server running on stdio');

    process.on('SIGTERM', () => {
        closeDb().finally(() => process.exit(0));
    });

    // Background init — errors are non-fatal; tools that need DB will fail
    // gracefully if the connection is not yet established.
    initDb()
        .then(() => {
            console.error('MongoDB connected and indexes ensured.');
            console.error(`Performing health check to ${HAE_HOST}:${HAE_PORT}...`);
            return healthCheck(HAE_HOST, HAE_PORT);
        })
        .then((isHealthy) => {
            if (!isHealthy) {
                console.error(
                    `Health check warning: Cannot connect to ${HAE_HOST}:${HAE_PORT}. Ensure Health Auto Export iOS app is running with TCP server enabled.`,
                );
            } else {
                console.error(
                    `Health check passed: Successfully connected to ${HAE_HOST}:${HAE_PORT}`,
                );
            }
        })
        .catch((error) => {
            console.error('Background init error:', error);
        });
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
