import type { ToolDefinition } from './registry.js';
import type { AppConfig, RoomState, UserRole } from '../types.js';
import { isHighRiskPrompt, shouldRefusePrompt } from '../core/security.js';

export type ToolPolicyDecision =
  | { action: 'allow'; reason: string }
  | { action: 'require_approval'; reason: string }
  | { action: 'deny'; reason: string };

export class ToolPolicyEngine {
  constructor(private readonly config: AppConfig) {}

  evaluate(input: {
    tool?: ToolDefinition;
    prompt: string;
    role: UserRole;
    room: RoomState;
    hasApprover: boolean;
  }): ToolPolicyDecision {
    if (shouldRefusePrompt(input.prompt)) {
      return { action: 'deny', reason: 'prompt_refused' };
    }

    const tool = input.tool;
    if (!tool) {
      if (isHighRiskPrompt(input.prompt) && this.config.tools.policy.defaultHighRiskRequiresApproval && input.hasApprover) {
        return { action: 'require_approval', reason: 'high_risk_prompt' };
      }
      return { action: 'allow', reason: 'no_tool' };
    }

    const override = this.config.tools.policy.roomToolOverrides.find((entry) => entry.roomId === input.room.id);
    const deniedTools = new Set([...this.config.tools.policy.denyTools, ...(override?.denyTools ?? [])]);
    const explicitlyAllowed = new Set(override?.allowTools ?? []);

    if (deniedTools.has(tool.name) && !explicitlyAllowed.has(tool.name)) {
      return { action: 'deny', reason: `tool_denied:${tool.name}` };
    }

    if (tool.riskLevel === 'blocked') {
      return { action: 'deny', reason: `tool_blocked:${tool.name}` };
    }

    if (tool.capabilities?.network && !this.config.tools.policy.allowNetworkTools) {
      return { action: 'deny', reason: `network_tools_disabled:${tool.name}` };
    }

    if (tool.capabilities?.fileWrite && !this.config.tools.policy.allowFileWriteTools) {
      return { action: 'deny', reason: `file_write_tools_disabled:${tool.name}` };
    }

    if (!tool.allowedRoles.includes(input.role)) {
      return { action: 'deny', reason: `role_not_allowed:${input.role}:${tool.name}` };
    }

    const highRisk = tool.riskLevel === 'high' || isHighRiskPrompt(input.prompt);
    if (highRisk && this.config.tools.policy.defaultHighRiskRequiresApproval && input.hasApprover) {
      if (input.role === 'system_admin' || input.role === 'group_admin') {
        return { action: 'allow', reason: 'admin_high_risk_tool' };
      }
      return { action: 'require_approval', reason: `high_risk_tool:${tool.name}` };
    }

    return { action: 'allow', reason: `tool_allowed:${tool.name}` };
  }
}
