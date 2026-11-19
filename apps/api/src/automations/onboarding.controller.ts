import { Controller, Get, UseGuards } from '@nestjs/common';
import { Provider, Role } from '@prisma/client';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { AgentSettingsService } from './agent-settings.service';

// The setup path after the first payment, as one list on the home page: each step with whether it is done and where it is done. Nothing here
// changes anything; the agent is still switched on only by the owner in its own card, and only after its own checks (agent-settings.service.ts).
//   required: payment, Cliniccards key and the first load, the currency of the amounts, approved services in the knowledge base
//   optional: team, Telegram bot, sending switch
//   Pro only: Instagram or Messenger, the autonomous agent
@Controller('onboarding')
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(
    private prisma: PrismaService,
    private agent: AgentSettingsService,
  ) {}

  @Get()
  @Roles(Role.OWNER, Role.MANAGER)
  async get(@CurrentUser() u: AuthUser) {
    const clinicId = u.clinicId;
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, billingStatus: true, isDemo: true, sourceCurrency: true, sendingEnabled: true } });
    const [integrations, members, services, agent] = await Promise.all([
      this.prisma.integration.findMany({ where: { clinicId, apiKeyEnc: { not: null } }, select: { provider: true, lastSyncAt: true } }),
      this.prisma.membership.count({ where: { clinicId } }),
      this.prisma.kbItem.count({ where: { clinicId, kind: 'SERVICE', active: true, approvedAt: { not: null } } }),
      hasFeature(c.plan, 'patient_agent') ? this.agent.status(clinicId) : Promise.resolve(null),
    ]);
    const has = (p: Provider) => integrations.some((i) => i.provider === p);
    const cc = integrations.find((i) => i.provider === Provider.CLINICCARDS);
    const pro = hasFeature(c.plan, 'multi_channel');
    const steps = [
      { key: 'payment', done: c.isDemo || ['ACTIVE', 'PAST_DUE', 'LAUNCH_PENDING'].includes(c.billingStatus), required: true, link: '/settings?tab=billing' },
      { key: 'cliniccards', done: !!cc?.lastSyncAt, required: true, link: '/settings' },
      { key: 'services', done: services > 0, required: true, link: '/knowledge' },
      { key: 'team', done: members > 1, required: false, link: '/settings?tab=team' },
      { key: 'telegram', done: has(Provider.TELEGRAM), required: false, link: '/settings?tab=channels' },
      { key: 'sending', done: c.sendingEnabled, required: false, link: '/settings' },
      ...(pro ? [{ key: 'meta', done: has(Provider.INSTAGRAM) || has(Provider.MESSENGER), required: false, link: '/settings?tab=channels' }] : []),
      ...(agent ? [{ key: 'agent', done: agent.active, required: false, link: '/ai-admin' }] : []),
    ];
    // PENDING: paid, the launch is being prepared ("Оплачено · готуємо запуск"); the paid month starts when the service owner starts it
    return { plan: c.plan, launch: c.billingStatus === 'LAUNCH_PENDING' ? 'PENDING' : null, steps, complete: steps.filter((s) => s.required).every((s) => s.done) };
  }
}
