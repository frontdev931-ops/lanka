import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { accessBlocked, billingEnforced, hasFeature } from '../service/plans';

export type AutoDenied = 'web_not_included' | 'agent_mode_off' | 'auto_off' | 'dialog_not_listed' | 'sending_off' | 'not_cabinets' | 'no_test_service' | 'clinic_suspended' | 'channel_not_supported' | 'plan_without_agent' | 'billing_blocked';

// Channels whose send errors are told apart reliably (see AgentApprovalService); the autonomous mode uses the same sending
// Telegram joined on 2026-11-16 (owner's decision): one owner switch turns the agent on in every supported channel
const AUTO_CHANNELS = ['INSTAGRAM', 'MESSENGER', 'TELEGRAM', 'WHATSAPP', 'WEB'];

// The permission of the agent's AUTONOMOUS mode, read again at every check (also right before every send and every visit). All of it must hold:
//   - the clinic's switches: aiAgentMode (the agent) AND aiAgentAuto (the autonomy, off by default, never implied by aiAgentMode), sending on, not suspended;
//   - the scope (Clinic.agentAutoScope). CLINIC: the clinic's owner switched the agent on for the whole clinic (Settings); then the plan must include
//     the feature patient_agent and the clinic must not be locked by billing, both read here at every check, so a lost plan stops the next action.
//     DIALOGS (the default, the restricted test mode the service owner sets): only
//   - the dialog is in the server variable AGENT_AUTO_DIALOGS, each entry  <clinicId>|<CHANNEL>|<chatId>  (commas or spaces). A missing or empty list is a
//     DENIAL for every dialog, never a permission for all;
//   - booking by cabinets, or by doctors (since 2026-11-11: the doctor is settled by DoctorChoiceService, the visit is made for that doctor only, see
//     agent-administrator.md section 41), and at least one service of the clinic's explicit autonomous set (autoServices below, section 49).

// The ONE rule of the autonomous set of services, used by the gate, the choice of services and the right to act right before every action:
//   - a set the service owner configured (agentAutoServicesSet) is authoritative: an empty one disables autonomy, and the older single value never comes back;
//   - a clinic never configured keeps its older single service (agentAutoServiceId, copied into the set by the migration of 2026-11-11);
//   - of the ids, only services of THIS clinic that are approved and active now count, in the configured order (a service made inactive or unapproved later
//     stops counting at once).
export const MAX_AUTO_SERVICES = 5;
export const configuredAutoServiceIds = (c: { agentAutoServiceIds: string[]; agentAutoServicesSet: boolean; agentAutoServiceId: string | null }): string[] =>
  c.agentAutoServicesSet ? c.agentAutoServiceIds : c.agentAutoServiceId ? [c.agentAutoServiceId] : [];

export async function autoServices(prisma: PrismaService, clinicId: string): Promise<{ id: string; title: string }[]> {
  const c = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { agentAutoServiceIds: true, agentAutoServicesSet: true, agentAutoServiceId: true } });
  const ids = c ? configuredAutoServiceIds(c) : [];
  if (!ids.length) return [];
  const rows = await prisma.kbItem.findMany({ where: { id: { in: ids }, clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } }, select: { id: true, title: true } });
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is { id: string; title: string } => !!r);
}
// The ONE validation of a set of services for the autonomous mode (the platform page and the clinic's own settings use it): every id an approved, active
// service of THIS clinic, no repeats, at most MAX_AUTO_SERVICES; anything wrong rejects the whole change (nothing is dropped silently)
export async function assertAutoServiceSet(prisma: PrismaService, clinicId: string, ids: string[]): Promise<void> {
  if (ids.length > MAX_AUTO_SERVICES) throw new BadRequestException('auto_services_too_many');
  if (new Set(ids).size !== ids.length) throw new BadRequestException('auto_services_duplicate');
  const valid = await prisma.kbItem.count({ where: { id: { in: ids }, clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } } });
  if (valid !== ids.length) throw new BadRequestException('service_not_found');
}

@Injectable()
export class AgentAutoGate {
  constructor(private prisma: PrismaService) {}

  private list(): Set<string> {
    return new Set((process.env.AGENT_AUTO_DIALOGS ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean));
  }

  listed(clinicId: string, channel: string, chatId: string): boolean {
    return this.list().has(`${clinicId}|${channel}|${chatId}`);
  }

  // null: allowed; otherwise the reason (a fixed code, no ids)
  async denied(clinicId: string, channel: string, chatId: string): Promise<AutoDenied | null> {
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiAgentMode: true, aiAgentAuto: true, agentAutoScope: true, sendingEnabled: true, scheduleMode: true, suspendedAt: true, plan: true, billingStatus: true, paidUntil: true, isDemo: true, aiWebAuto: true } });
    if (!c) return 'auto_off';
    if (c.agentAutoScope === 'CLINIC') {
      if (!hasFeature(c.plan, 'patient_agent')) return 'plan_without_agent';
      if (billingEnforced() && accessBlocked(c)) return 'billing_blocked';
    } else if (!this.listed(clinicId, channel, chatId)) return 'dialog_not_listed';
    if (c.suspendedAt) return 'clinic_suspended';
    if (!c.aiAgentMode) return 'agent_mode_off';
    if (!c.aiAgentAuto) return 'auto_off';
    if (!c.sendingEnabled) return 'sending_off';
    if (c.scheduleMode !== 'CABINETS' && c.scheduleMode !== 'DOCTORS') return 'not_cabinets';
    if (!(await autoServices(this.prisma, clinicId)).length) return 'no_test_service';
    if (!AUTO_CHANNELS.includes(channel)) return 'channel_not_supported';
    // the website chat is covered only when the owner included it explicitly (Clinic.aiWebAuto); the one switch of 2026-11-16 does not reach it by itself
    if (channel === 'WEB' && !c.aiWebAuto) return 'web_not_included';
    return null;
  }

  // the services the autonomous mode may book now (empty: none)
  testServices(clinicId: string): Promise<{ id: string; title: string }[]> {
    return autoServices(this.prisma, clinicId);
  }
}
