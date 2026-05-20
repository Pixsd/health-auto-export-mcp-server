import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callTCPRaw } from '../tcp/client.js';

// Body metric keys to fetch from Apple Health via HAE.
const BODY_METRICS = [
    'height',
    'weight_body_mass',
    'body_mass_index',
    'body_fat_percentage',
    'lean_body_mass',
    'waist_circumference',
] as const;

/**
 * Given a list of daily-aggregated data points, returns the most recent
 * entry that has a numeric `qty` value.
 */
function latestQty(
    data: Array<{ date: string; qty?: number; Avg?: number }>,
): { date: string; value: number } | null {
    for (let i = data.length - 1; i >= 0; i--) {
        const d = data[i]!;
        const v = d.qty ?? d.Avg;
        if (v !== undefined && v !== null && isFinite(v)) {
            return { date: d.date.slice(0, 10), value: v };
        }
    }
    return null;
}

export function registerProfileTool(server: McpServer): void {
    server.registerTool(
        'get_profile',
        {
            description: `Returns the user's physical profile and current medications in a single call.

BODY METRICS (most recent recorded value from the last 365 days):
  - height              : in cm
  - body_mass           : weight in kg
  - body_mass_index     : BMI (also computed from height + weight if not recorded)
  - body_fat_percentage : %
  - lean_body_mass      : kg
  - waist_circumference : cm

MEDICATIONS:
  - List of medications logged in Apple Health in the last 90 days.

Use this tool at the start of a session to get context about the user before
analysing workouts, TRIMP, or health trends.`,
            inputSchema: {},
        },
        async () => {
            const now = new Date();
            const today = now.toISOString().slice(0, 10);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000)
                .toISOString()
                .slice(0, 10);
            const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000)
                .toISOString()
                .slice(0, 10);

            const [metricsRes, medsRes] = await Promise.all([
                callTCPRaw('health_metrics', {
                    start: `${thirtyDaysAgo} 00:00:00 +0000`,
                    end: `${today} 23:59:59 +0000`,
                    metrics: BODY_METRICS.join(','),
                    interval: 'days',
                    aggregate: true,
                }),
                callTCPRaw('medications', {
                    start: `${ninetyDaysAgo} 00:00:00 +0000`,
                    end: `${today} 23:59:59 +0000`,
                }),
            ]);

            // Extract most recent value for each body metric.
            // HAE returns metrics as an array: [{ name, units, data: [...] }]
            const metricsArray: Array<{ name: string; units: string; data: any[] }> =
                (metricsRes as any).result?.data?.metrics ?? [];
            const metricsMap = new Map(metricsArray.map((m) => [m.name, m]));

            const body: Record<string, { date: string; value: number } | null> = {};
            for (const key of BODY_METRICS) {
                const entries: Array<any> = metricsMap.get(key)?.data ?? [];
                body[key] = latestQty(entries);
            }

            // Compute BMI from height + weight if Apple Health doesn't have it.
            // body.height.value is in metres (HAE native unit).
            if (!body.body_mass_index && body.height && body.weight_body_mass) {
                const heightM = body.height.value; // already metres
                const bmi = body.weight_body_mass.value / (heightM * heightM);
                body.body_mass_index = {
                    date: body.weight_body_mass.date,
                    value: Math.round(bmi * 10) / 10,
                };
            }

            const medications: any[] =
                (medsRes as any).result?.data?.medications ?? [];

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                body_metrics: {
                                    height_cm: body.height
                                        ? { value: body.height.value * 100, date: body.height.date }
                                        : null,
                                    weight_kg: body.weight_body_mass,
                                    bmi: body.body_mass_index,
                                    body_fat_pct: body.body_fat_percentage,
                                    lean_body_mass_kg: body.lean_body_mass,
                                    waist_circumference_cm: body.waist_circumference,
                                },
                                medications,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );
}
