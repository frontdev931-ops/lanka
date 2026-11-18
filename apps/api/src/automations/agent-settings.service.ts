import { BadRequestException, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';
import { MAX_AUTO_SERVICES, assertAutoServiceSet, autoServices, configuredAutoServiceIds } from './agent-auto-gate';

// What has to be true before the clinic's owner may switch the autonomous agent on. The same list is shown in Settings with a way to fix each item.
export const AGENT_PREREQUISITES = ['plan', 'billing', 'ai', 'sending', 'channel', 'schedule', 'services'] as const;
export type AgentPrerequisite = (typeof AGENT_PREREQUISITES)[number];

// The clinic's own control of the autonomous patient agent (Settings → AI administrator → Reply mode). Three separate things:
//   1. the plan includes it (the feature patient_agent: Pro);
//   2. the clinic finished the setup (the prerequisites below);
//   3. the owner switched it on (activate), and may switch it off at any time.
// A plan alone switches nothing on. Activation sets the scope CLINIC: the agent may then answer every eligible dialogue of the clinic, new ones too, without
// the server list of dialogs (that list stays the older restricted test mode, scope DIALOGS, and is never widened here without this explicit step).
// Whether the agent may act is still decided by AgentAutoGate at every action; booking writes keep their own switches. One switch covers Instagram,
// Messenger and Telegram (owner's decision of 2026-11-16).
@Injectable()
export class AgentSettingsService {
  constructor(
    private prisma: PrismaService,
    private ai: AiService,
  ) {}

  async status(clinicId: string) {
    const c = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { plan: true, billingStatus: true, paidUntil: true, isDemo: true, aiEnabled: true, aiAgentMode: true, aiAgentAuto: true, agentAutoScope: true, sendingEnabled: true, scheduleMode: true, agentAutoServiceIds: true, agentAutoServicesSet: true, agentAutoServiceId: true },
    });
    const [ai, channels, chosen, available] = await Promise.all([
      this.ai.status(clinicId),
      this.prisma.integration.count({ where: { clinicId, provider: { in: [Provider.INSTAGRAM, Provider.MESSENGER, Provider.TELEGRAM] }, apiKeyEnc: { not: null } } }),
      autoServices(this.prisma, clinicId),
      this.prisma.kbItem.findMany({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    ]);
    const met: Record<AgentPrerequisite, boolean> = {
      plan: hasFeature(c.plan, 'patient_agent'),
      billing: !(billingEnforced() && accessBlocked(c)),
      ai: ai.available && c.aiEnabled,
      sending: c.sendingEnabled,
      channel: channels > 0,
      schedule: c.scheduleMode === 'CABINETS' || c.scheduleMode === 'DOCTORS',
      services: chosen.length > 0,
    };
    const missing = AGENT_PREREQUISITES.filter((k) => !met[k]);
    // on for the whole clinic: only after the owner's own activation. An older test activation (scope DIALOGS) is reported apart and is not "on" here.
    const active = c.aiAgentMode && c.aiAgentAuto && c.agentAutoScope === 'CLINIC';
    return {
      inPlan: met.plan,
      prerequisites: AGENT_PREREQUISITES.map((key) => ({ key, met: met[key] })),
      ready: missing.length === 0,
      active,
      // the agent is switched on, but something it needs is gone (the plan ended, sending was switched off…): it does not act until that is fixed
      paused: active && missing.length > 0,
      testMode: c.aiAgentMode && c.aiAgentAuto && c.agentAutoScope !== 'CLINIC',
      services: chosen,
      // the ids as saved (a service that stopped being approved or active is not in `services` any more)
      serviceIds: configuredAutoServiceIds(c),
      availableServices: available,
      maxServices: MAX_AUTO_SERVICES,
      // one switch for every supported channel (Telegram since 2026-11-16)
      channels: ['INSTAGRAM', 'MESSENGER', 'TELEGRAM'],
    };
  }

  async setServices(clinicId: string, userId: string, ids: string[]) {
    await assertAutoServiceSet(this.prisma, clinicId, ids);
    const before = configuredAutoServiceIds(await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { agentAutoServiceIds: true, agentAutoServicesSet: true, agentAutoServiceId: true } }));
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { agentAutoServiceIds: ids, agentAutoServicesSet: true, agentAutoServiceId: ids[0] ?? null } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'agent.services', details: { before, after: ids } } });
    return this.status(clinicId);
  }

  async activate(clinicId: string, userId: string) {
    const st = await this.status(clinicId);
    if (!st.inPlan) throw new BadRequestException('plan_feature');
    if (!st.ready) throw new BadRequestException('agent_not_ready');
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { aiAgentMode: true, aiAgentAuto: true, agentAutoScope: 'CLINIC' } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'agent.activated', details: { scope: 'CLINIC', services: st.serviceIds } } });
    return this.status(clinicId);
  }

  // Off: the agent stops answering by itself. aiAgentMode stays on, so the agent keeps preparing drafts for the staff and the older automatic reply is
  // NOT switched back on in its place.
  async deactivate(clinicId: string, userId: string) {
    await this.prisma.clinic.update({ where: { id: clinicId }, data: { aiAgentAuto: false } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'agent.deactivated' } });
    return this.status(clinicId);
  }
}
