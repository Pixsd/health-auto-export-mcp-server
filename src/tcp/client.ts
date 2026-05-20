import * as net from 'net';
import { HAE_HOST, HAE_PORT, DEFAULT_TIMEOUT } from '../config.js';

// Wraps the response in an MCP content block (used by simple proxy tools).
export async function sendRequest(
    toolName: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const requestId = Math.floor(Math.random() * 1000);
    const jsonrpcRequest = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'callTool',
        params: { name: toolName, arguments: args },
    };

    const message = JSON.stringify(jsonrpcRequest);

    return new Promise((resolve) => {
        const client = new net.Socket();
        let responseData = '';
        let hasResponded = false;

        client.setTimeout(DEFAULT_TIMEOUT);

        client.connect(HAE_PORT, HAE_HOST, () => {
            client.write(message);
        });

        client.on('data', (data) => {
            responseData += data.toString();
        });

        client.on('end', () => {
            if (!hasResponded) {
                hasResponded = true;
                if (responseData) {
                    try {
                        const parsedResponse = JSON.parse(responseData);
                        resolve({
                            content: [
                                { type: 'text', text: JSON.stringify(parsedResponse, null, 2) },
                            ],
                        });
                    } catch {
                        resolve({ content: [{ type: 'text', text: responseData }] });
                    }
                } else {
                    resolve({
                        content: [{ type: 'text', text: 'No response data received' }],
                    });
                }
            }
        });

        client.on('error', (error) => {
            if (!hasResponded) {
                hasResponded = true;
                if (responseData) {
                    try {
                        const parsedResponse = JSON.parse(responseData);
                        resolve({
                            content: [
                                { type: 'text', text: JSON.stringify(parsedResponse, null, 2) },
                            ],
                        });
                    } catch {
                        resolve({ content: [{ type: 'text', text: responseData }] });
                    }
                } else {
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: `Failed to connect to Health Auto Export at ${HAE_HOST}:${HAE_PORT}: ${error.message}`,
                            },
                        ],
                    });
                }
            }
        });

        client.on('timeout', () => {
            if (!hasResponded) {
                hasResponded = true;
                client.destroy();
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: `Request to Health Auto Export timed out after ${DEFAULT_TIMEOUT}ms`,
                        },
                    ],
                });
            }
        });

        client.on('close', () => {
            if (!hasResponded) {
                hasResponded = true;
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: 'Connection to Health Auto Export closed unexpectedly',
                        },
                    ],
                });
            }
        });
    });
}

// Returns the raw parsed JSON response (throws on error).
// Used by tools that need to combine and process multiple data sources.
export function callTCPRaw(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const requestId = Math.floor(Math.random() * 1000);
    const message = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'callTool',
        params: { name: toolName, arguments: args },
    });
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let raw = '';
        client.setTimeout(DEFAULT_TIMEOUT);
        client.connect(HAE_PORT, HAE_HOST, () => client.write(message));
        client.on('data', (d) => { raw += d.toString(); });
        client.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('TCP timeout')); });
    });
}

export async function healthCheck(
    host: string,
    port: number,
    timeout: number = 5000,
): Promise<boolean> {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let hasResponded = false;

        client.setTimeout(timeout);

        client.connect(port, host, () => {
            if (!hasResponded) {
                hasResponded = true;
                client.end();
                resolve(true);
            }
        });

        client.on('error', () => {
            if (!hasResponded) {
                hasResponded = true;
                resolve(false);
            }
        });

        client.on('timeout', () => {
            if (!hasResponded) {
                hasResponded = true;
                client.destroy();
                resolve(false);
            }
        });
    });
}
