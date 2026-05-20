import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRequest } from '../tcp/client.js';

// Common date range schema used by all proxy tools.
const dateRangeSchema = {
    start: z.string().describe("Start timestamp (e.g., '2025-01-18 00:00:00 -0500')"),
    end: z.string().describe("End timestamp (e.g., '2025-01-18 23:59:59 -0500')"),
};

export function registerProxyTools(server: McpServer): void {
    server.registerTool(
        'get_health_metrics',
        {
            description:
                'Get health metrics data (heart rate, steps, sleep, blood glucose, etc.) for a specified date range from Apple Health',
            inputSchema: {
                ...dateRangeSchema,
                metrics: z
                    .string()
                    .optional()
                    .describe(
                        "Metrics to export as comma-separated list (e.g., 'heart_rate,step_count'). Leave empty for all metrics.",
                    ),
                interval: z
                    .string()
                    .optional()
                    .describe("Aggregation interval: 'minutes', 'hours', or 'days' (default: 'hours')"),
                aggregate: z
                    .boolean()
                    .optional()
                    .describe('Whether to aggregate metrics (default: true)'),
            },
        },
        async ({ start, end, metrics, interval, aggregate }) => {
            return sendRequest('health_metrics', {
                start,
                end,
                metrics: metrics ?? '',
                interval: interval ?? 'hours',
                aggregate: aggregate ?? true,
            });
        },
    );

    server.registerTool(
        'get_workouts',
        {
            description:
                'Get workout data (exercise sessions) for a specified date range from Apple Health',
            inputSchema: {
                ...dateRangeSchema,
                includeMetadata: z
                    .boolean()
                    .optional()
                    .describe('Include health metric metadata (default: true)'),
                includeRoutes: z
                    .boolean()
                    .optional()
                    .describe('Include GPS route data (default: false)'),
                metadataAggregation: z
                    .string()
                    .optional()
                    .describe("Aggregation interval for metadata: 'seconds' or 'minutes' (default: 'minutes')"),
            },
        },
        async ({ start, end, includeMetadata, includeRoutes, metadataAggregation }) => {
            return sendRequest('workouts', {
                start,
                end,
                includeMetadata: includeMetadata ?? true,
                includeRoutes: includeRoutes ?? false,
                metadataAggregation: metadataAggregation ?? 'minutes',
            });
        },
    );

    server.registerTool(
        'get_symptoms',
        {
            description: 'Get symptoms data for a specified date range from Apple Health',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('symptoms', { start, end }),
    );

    server.registerTool(
        'get_state_of_mind',
        {
            description:
                'Get state of mind (mood/emotion) data for a specified date range from Apple Health (iOS 18+)',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('state_of_mind', { start, end }),
    );

    server.registerTool(
        'get_medications',
        {
            description:
                'Get medications data for a specified date range from Apple Health (iOS 26+)',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('medications', { start, end }),
    );

    server.registerTool(
        'get_cycle_tracking',
        {
            description:
                'Get menstrual cycle tracking data for a specified date range from Apple Health',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('cycle_tracking', { start, end }),
    );

    server.registerTool(
        'get_ecg',
        {
            description:
                'Get ECG (electrocardiogram) data for a specified date range from Apple Health',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('ecg', { start, end }),
    );

    server.registerTool(
        'get_heart_notifications',
        {
            description:
                'Get heart notification events (irregular rhythm, high/low heart rate alerts) for a specified date range from Apple Health',
            inputSchema: dateRangeSchema,
        },
        async ({ start, end }) => sendRequest('heart_notifications', { start, end }),
    );
}
