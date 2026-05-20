import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProxyTools } from './proxy.js';
import { registerRestingHrTool } from './restingHr.js';
import { registerMaxHrTool } from './maxHr.js';
import { registerWorkoutZonesTool } from './workoutZones.js';
import { registerTrimpTool } from './trimp.js';
import { registerProfileTool } from './profile.js';

export function registerAllTools(server: McpServer): void {
    registerProxyTools(server);
    registerRestingHrTool(server);
    registerMaxHrTool(server);
    registerWorkoutZonesTool(server);
    registerTrimpTool(server);
    registerProfileTool(server);
}
