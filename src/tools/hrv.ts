import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { parseHAEDate } from '../utils/date.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sample linear regression — returns slope (ms/day) and intercept. */
function linearRegression(values: number[]): { slope: number; intercept: number } {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i]!;
        sumXY += i * values[i]!;
        sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

/** Round to 1 decimal place. */
function r1(v: number): number {
    return Math.round(v * 10) / 10;
}

type HrvDay = { date: string; hrv_ms: number };

function computeBaseline(days: HrvDay[]): {
    mean_ms: number;
    std_ms: number;
    cv_pct: number;
    min_ms: number;
    max_ms: number;
    swc_ms: number;
} {
    const vals = days.map((d) => d.hrv_ms);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    return {
        mean_ms: r1(mean),
        std_ms: r1(std),
        cv_pct: r1(std / mean * 100),
        min_ms: r1(Math.min(...vals)),
        max_ms: r1(Math.max(...vals)),
        swc_ms: r1(0.5 * std),    // Smallest Worthwhile Change
    };
}

function dayStatus(hrv: number, mean: number, std: number): string {
    if (hrv < mean - 1.5 * std) return 'suppressed';
    if (hrv < mean - 0.5 * std) return 'below_average';
    if (hrv > mean + 0.5 * std) return 'elevated';
    return 'normal';
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function registerHrvTool(server: McpServer): void {
    server.registerTool(
        'get_hrv_analysis',
        {
            description: `Analyses Heart Rate Variability (HRV) data from Apple Health.

Computes:
  - Baseline: mean, SD, CV%, min/max, SWC (Smallest Worthwhile Change = 0.5*SD)
  - Trend: linear regression slope (ms/day), overall direction
  - 7-day rolling average vs full-period baseline
  - Per-day readiness status: suppressed / below_average / normal / elevated
  - Suppression events: days with HRV < baseline_mean - 1.5*SD

Apple Watch measures overnight RMSSD and reports it as HRV in ms.

CV% interpretation:
  < 5%  : very stable (possible over-training / low adaptation)
  5-10% : stable — good baseline for comparison
  10-20%: moderate variability — typical for healthy individuals
  > 20% : high variability — acute stress, illness, or lifestyle factors

Trend interpretation:
  slope > +0.3 ms/day : improving (adaptation / recovery)
  slope < -0.3 ms/day : declining (accumulating fatigue / stress)
  otherwise           : stable`,
            inputSchema: {
                start: z.string().optional().describe(
                    "Start date (e.g. '2026-04-01 00:00:00 +0200'). Defaults to 60 days ago.",
                ),
                end: z.string().optional().describe(
                    "End date (e.g. '2026-05-20 23:59:59 +0200'). Defaults to today.",
                ),
            },
        },
        async ({ start, end }) => {
            const now = new Date();
            const todayStr = now.toISOString().slice(0, 10);
            const defaultStart = new Date(now.getTime() - 60 * 86_400_000)
                .toISOString()
                .slice(0, 10);

            const startParam = start ?? `${defaultStart} 00:00:00 +0000`;
            const endParam = end ?? `${todayStr} 23:59:59 +0000`;

            const raw = await callTCPRaw('health_metrics', {
                start: startParam,
                end: endParam,
                metrics: 'heart_rate_variability',
                interval: 'days',
                aggregate: true,
            });

            const metricsArr: Array<{ name: string; data: any[] }> =
                (raw as any).result?.data?.metrics ?? [];
            const hrvEntries: any[] =
                metricsArr.find((m) => m.name === 'heart_rate_variability')?.data ?? [];

            const days: HrvDay[] = hrvEntries
                .map((e) => {
                    const v = e.qty ?? e.Avg;
                    if (v == null || !isFinite(v)) return null;
                    const date = parseHAEDate(e.date as string);
                    if (!date) return null;
                    return { date: date.toISOString().slice(0, 10), hrv_ms: r1(v as number) };
                })
                .filter((d): d is HrvDay => d !== null)
                .sort((a, b) => a.date.localeCompare(b.date));

            if (days.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: 'No HRV data found for the requested period.' }, null, 2),
                    }],
                };
            }

            const baseline = computeBaseline(days);

            // Trend (linear regression over all days)
            const { slope } = linearRegression(days.map((d) => d.hrv_ms));
            const slopeR = r1(slope);
            const trendDir =
                slope > 0.3 ? 'improving' : slope < -0.3 ? 'declining' : 'stable';

            // 7-day rolling average — compute for each day
            const dailyWithRolling = days.map((d, i) => {
                const window = days.slice(Math.max(0, i - 6), i + 1);
                const avg7 = r1(
                    window.reduce((s, w) => s + w.hrv_ms, 0) / window.length,
                );
                const dev = r1(d.hrv_ms - baseline.mean_ms);
                return {
                    date: d.date,
                    hrv_ms: d.hrv_ms,
                    rolling_7d_avg_ms: avg7,
                    deviation_from_baseline_ms: dev,
                    status: dayStatus(d.hrv_ms, baseline.mean_ms, baseline.std_ms),
                };
            });

            // Recent 7-day summary
            const recent7 = days.slice(-7);
            const recent7Mean = r1(recent7.reduce((s, d) => s + d.hrv_ms, 0) / recent7.length);
            const recent7Status = dayStatus(recent7Mean, baseline.mean_ms, baseline.std_ms);

            // Suppression events
            const suppressionThreshold = r1(baseline.mean_ms - 1.5 * baseline.std_ms);
            const suppressionEvents = dailyWithRolling
                .filter((d) => d.status === 'suppressed')
                .map((d) => ({
                    date: d.date,
                    hrv_ms: d.hrv_ms,
                    deviation_sd: r1((d.hrv_ms - baseline.mean_ms) / baseline.std_ms),
                }));

            const result = {
                period: {
                    start: days[0]!.date,
                    end: days[days.length - 1]!.date,
                    days_with_data: days.length,
                },
                baseline,
                trend: {
                    slope_ms_per_day: slopeR,
                    direction: trendDir,
                    change_over_period_ms: r1(slopeR * (days.length - 1)),
                },
                recent_7d: {
                    mean_ms: recent7Mean,
                    vs_baseline_ms: r1(recent7Mean - baseline.mean_ms),
                    status: recent7Status,
                },
                suppression_events: {
                    threshold_ms: suppressionThreshold,
                    count: suppressionEvents.length,
                    events: suppressionEvents,
                },
                daily: dailyWithRolling,
            };

            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            };
        },
    );
}
