import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type AutoDenied = 'agent_mode_off' | 'auto_off' | 'dialog_not_listed' | 'sending_off' | 'not_cabinets' | 'no_test_service' | 'clinic_suspended' | 'channel_not_supported';

// Channels whose send errors are told apart reliably (see AgentApprovalService); the autonomous mode uses the same sending
const AUTO_CHANNELS = ['INSTAGRAM', 'MESSENGER', 'WHATSAPP', 'WEB'];

// The permission of the agent's AUTONOMOUS mode, read again at every check (also right before every send and every visit). All of it must hold:
//   - the clinic's switches: aiAgentMode (the agent) AND aiAgentAuto (the autonomy, off by default, never implied by aiAgentMode), sending on, not suspended;
//   - the dialog is in the server variable AGENT_AUTO_DIALOGS, each entry  <clinicId>|<CHANNEL>|<chatId>  (commas or spaces). A missing or empty list is a
//     DENIAL for every dialog, never a permission for all;
//   - at this stage only booking by cabinets and one configured test service of the clinic (Clinic.agentAutoServiceId).
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
    if (!this.listed(clinicId, channel, chatId)) return 'dialog_not_listed';
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiAgentMode: true, aiAgentAuto: true, sendingEnabled: true, scheduleMode: true, agentAutoServiceId: true, suspendedAt: true } });
    if (!c) return 'auto_off';
    if (c.suspendedAt) return 'clinic_suspended';
    if (!c.aiAgentMode) return 'agent_mode_off';
    if (!c.aiAgentAuto) return 'auto_off';
    if (!c.sendingEnabled) return 'sending_off';
    if (c.scheduleMode !== 'CABINETS') return 'not_cabinets';
    if (!c.agentAutoServiceId) return 'no_test_service';
    if (!AUTO_CHANNELS.includes(channel)) return 'channel_not_supported';
    return null;
  }

  async testService(clinicId: string): Promise<{ id: string; title: string } | null> {
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { agentAutoServiceId: true } });
    if (!c?.agentAutoServiceId) return null;
    const s = await this.prisma.kbItem.findFirst({ where: { id: c.agentAutoServiceId, clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } }, select: { id: true, title: true } });
    return s;
  }
}
