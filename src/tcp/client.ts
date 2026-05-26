import * as net from 'net';
import { HAE_HOSTS, HAE_PORT, DEFAULT_TIMEOUT, CONNECT_TIMEOUT } from '../config.js';

// Internal: attempt sendRequest on a single host; rejects on connection failure.
function singleHostRequest(
    host: string,
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

    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let responseData = '';
        let hasResponded = false;
        let connected = false;

        client.setTimeout(CONNECT_TIMEOUT);

        client.connect(HAE_PORT, host, () => {
            connected = true;
            client.setTimeout(DEFAULT_TIMEOUT);
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
                    reject(error);
                }
            }
        });

        client.on('timeout', () => {
            if (!hasResponded) {
                hasResponded = true;
                client.destroy();
                if (!connected) {
                    reject(new Error(`Connection to ${host}:${HAE_PORT} timed out`));
                } else {
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: `Request to Health Auto Export timed out after ${DEFAULT_TIMEOUT}ms`,
                            },
                        ],
                    });
                }
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

// Wraps the response in an MCP content block (used by simple proxy tools).
// Tries each host in HAE_HOSTS in order, falling back on connection failure.
export async function sendRequest(
    toolName: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    let lastError: Error | null = null;
    for (const host of HAE_HOSTS) {
        try {
            return await singleHostRequest(host, toolName, args);
        } catch (e) {
            lastError = e as Error;
        }
    }
    return {
        content: [
            {
                type: 'text',
                text: `Failed to connect to Health Auto Export at ${HAE_HOSTS.join(', ')}:${HAE_PORT}: ${lastError?.message}`,
            },
        ],
    };
}

// Internal: attempt callTCPRaw on a single host; rejects on connection failure.
function singleHostRaw(
    host: string,
    toolName: string,
    args: Record<string, unknown>,
): Promise<unknown> {
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
        let connected = false;
        client.setTimeout(CONNECT_TIMEOUT);
        client.connect(HAE_PORT, host, () => {
            connected = true;
            client.setTimeout(DEFAULT_TIMEOUT);
            client.write(message);
        });
        client.on('data', (d) => { raw += d.toString(); });
        client.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
        client.on('error', reject);
        client.on('timeout', () => {
            client.destroy();
            reject(new Error(connected ? 'TCP timeout' : `Connection to ${host}:${HAE_PORT} timed out`));
        });
    });
}

// Returns the raw parsed JSON response (throws on error).
// Used by tools that need to combine and process multiple data sources.
// Tries each host in HAE_HOSTS in order, falling back on connection failure.
export async function callTCPRaw(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    let lastError: Error | null = null;
    for (const host of HAE_HOSTS) {
        try {
            return await singleHostRaw(host, toolName, args);
        } catch (e) {
            lastError = e as Error;
        }
    }
    throw lastError ?? new Error(`Failed to connect to any configured host`);
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
