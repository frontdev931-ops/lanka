import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentAutoService } from './agent-auto.service';
import { AgentAutoGate } from './agent-auto-gate';
import { AutoReplyService } from './auto-reply.service';
import { MessengerService, SendError } from './messenger.service';

const CHANNELS = ['TELEGRAM', 'INSTAGRAM', 'MESSENGER', 'WHATSAPP', 'VIBER', 'WEB'];

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private messenger: MessengerService,
    private autoReply: AutoReplyService,
    private auto: AgentAutoService,
    private gate: AgentAutoGate,
  ) {}

  // List of dialogues: by the last message of each chat, newest first; unread ones are counted separately
  async conversations(clinicId: string) {
    const [last, unread, names] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { clinicId },
        distinct: ['channel', 'chatId'],
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { patient: { select: { id: true, fullName: true } } },
      }),
      this.prisma.chatMessage.groupBy({ by: ['channel', 'chatId'], where: { clinicId, direction: 'IN', readAt: null }, _count: true }),
      // the name is known only from incoming messages, while the last message in a dialogue may be a reply
      this.prisma.chatMessage.findMany({ where: { clinicId, contactName: { not: null } }, distinct: ['channel', 'chatId'], orderBy: { createdAt: 'desc' }, select: { channel: true, chatId: true, contactName: true } }),
    ]);
    const nameMap = new Map(names.map((n) => [`${n.channel}:${n.chatId}`, n.contactName]));
    const unreadMap = new Map(unread.map((u) => [`${u.channel}:${u.chatId}`, u._count]));
    const who = await this.whoAnswers(clinicId, last.map((m) => ({ channel: m.channel, chatId: m.chatId })));
    return last.map((m) => ({
      channel: m.channel,
      chatId: m.chatId,
      patient: m.patient,
      contactName: nameMap.get(`${m.channel}:${m.chatId}`) ?? null,
      lastText: m.text.slice(0, 120),
      lastDirection: m.direction,
      lastAt: m.createdAt,
      unread: unreadMap.get(`${m.channel}:${m.chatId}`) ?? 0,
      // who answers the next message of this dialogue by itself: 'AI' (the autonomous agent or the automatic reply) or 'STAFF'
      answers: who.get(`${m.channel}:${m.chatId}`) ?? 'STAFF',
    }));
  }

  // Who answers next, for the list of dialogues. The same rules as the senders, read once for the list:
  //   - a dialogue a person took over (ConversationState.owner HUMAN) is the staff's;
  //   - the autonomous agent: AgentAutoGate allows it for the channel (scope CLINIC) or for this listed dialogue (scope DIALOGS);
  //   - otherwise the older automatic reply (aiEnabled + aiAutoReply, not in agent mode), except during the pause after a person's answer;
  //   - otherwise the staff (drafts are only suggestions).
  // The senders check everything again at the moment of sending; this is a label, it decides nothing.
  private async whoAnswers(clinicId: string, chats: { channel: string; chatId: string }[]): Promise<Map<string, 'AI' | 'STAFF'>> {
    const out = new Map<string, 'AI' | 'STAFF'>();
    if (!chats.length) return out;
    const [c, human] = await Promise.all([
      this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { aiEnabled: true, aiAutoReply: true, aiAgentMode: true, aiPauseMinutes: true, sendingEnabled: true } }),
      this.prisma.conversationState.findMany({ where: { clinicId, owner: 'HUMAN' }, select: { channel: true, chatId: true } }),
    ]);
    if (!c) return out;
    const humanSet = new Set(human.map((h) => `${h.channel}:${h.chatId}`));
    const byChannel = new Map<string, Awaited<ReturnType<AgentAutoGate['denied']>>>();
    for (const ch of new Set(chats.map((x) => x.channel))) byChannel.set(ch, await this.gate.denied(clinicId, ch, '__list__'));
    const legacy = c.aiEnabled && c.aiAutoReply && !c.aiAgentMode && c.sendingEnabled;
    const pauseMs = (c.aiPauseMinutes ?? 30) * 60_000;
    const paused = new Set<string>();
    if (legacy && pauseMs > 0) {
      const recent = await this.prisma.chatMessage.findMany({ where: { clinicId, direction: 'OUT', authorUserId: { not: null }, error: null, createdAt: { gt: new Date(Date.now() - pauseMs) } }, distinct: ['channel', 'chatId'], select: { channel: true, chatId: true } });
      const resumed = await this.prisma.chatBotResume.findMany({ where: { clinicId, resumedAt: { gt: new Date(Date.now() - pauseMs) } }, select: { channel: true, chatId: true } });
      const back = new Set(resumed.map((r) => `${r.channel}:${r.chatId}`));
      for (const r of recent) if (!back.has(`${r.channel}:${r.chatId}`)) paused.add(`${r.channel}:${r.chatId}`);
    }
    for (const x of chats) {
      const key = `${x.channel}:${x.chatId}`;
      const d = byChannel.get(x.channel);
      const agent = d === null || (d === 'dialog_not_listed' && this.gate.listed(clinicId, x.channel, x.chatId) && (await this.gate.denied(clinicId, x.channel, x.chatId)) === null);
      out.set(key, humanSet.has(key) ? 'STAFF' : agent ? 'AI' : legacy && !paused.has(key) ? 'AI' : 'STAFF');
    }
    return out;
  }

  // Open a dialogue: the latest messages, incoming ones are marked as read
  async thread(clinicId: string, channel: string, chatId: string) {
    const messages = await this.prisma.chatMessage.findMany({ where: { clinicId, channel, chatId }, orderBy: { createdAt: 'desc' }, take: 200, include: { patient: { select: { id: true, fullName: true } } } });
    if (!messages.length) throw new NotFoundException('conversation_not_found');
    await this.prisma.chatMessage.updateMany({ where: { clinicId, channel, chatId, direction: 'IN', readAt: null }, data: { readAt: new Date() } });
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true } });
    const named = messages.find((m) => m.patient);
    return {
      channel,
      chatId,
      // The internal identity of this dialog: the line for AUTOBOOKING_TEST_DIALOGS (clinic | channel | internal chat id, never a name or a username)
      dialogKey: `${clinicId}|${channel}|${chatId}`,
      replyWindowOpen: await this.messenger.windowOpen(clinicId, channel, chatId),
      patient: named?.patient ?? null,
      contactName: messages.find((m) => m.contactName)?.contactName ?? null,
      optedOut: !!ch?.optedOutAt,
      // The AI is silent in this chat until this moment because a person answered; staff can give the dialog back to the bot
      botPausedUntil: (await this.autoReply.pausedUntil(clinicId, channel, chatId))?.toISOString() ?? null,
      // the agent's autonomous mode: the dialogue is a person's until they give it back
      agentOwnerHuman: (await this.prisma.conversationState.findUnique({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, select: { owner: true } }))?.owner === 'HUMAN',
      messages: messages
        .reverse()
        .map((m) => ({ id: m.id, direction: m.direction, text: m.text, createdAt: m.createdAt, error: m.error, system: m.direction === 'OUT' && !m.authorUserId && !m.byAi, byAi: m.byAi })),
    };
  }

  // A staff reply. It goes out only while the master switch is on and only to a chat that has not opted out.
  async reply(clinicId: string, userId: string, channel: string, chatId: string, text: string) {
    if (!CHANNELS.includes(channel)) throw new BadRequestException('bad_channel');
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { sendingEnabled: true, aiAgentAuto: true } });
    if (!clinic.sendingEnabled) throw new BadRequestException('sending_disabled');
    const known = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId }, select: { id: true } });
    if (!known) throw new NotFoundException('conversation_not_found');
    const ch = await this.prisma.patientChannel.findFirst({ where: { clinicId, channel, externalId: chatId }, select: { optedOutAt: true, patientId: true } });
    if (ch?.optedOutAt) throw new BadRequestException('opted_out');
    const base = { clinicId, channel, chatId, direction: 'OUT', text, authorUserId: userId, patientId: ch?.patientId ?? null };
    try {
      await this.messenger.send(clinicId, channel, chatId, text);
    } catch (e) {
      if (e instanceof SendError && e.reason === 'not_connected') throw new BadRequestException(channel === 'TELEGRAM' ? 'bot_not_connected' : channel === 'INSTAGRAM' ? 'instagram_not_connected' : 'channel_not_connected');
      if (e instanceof SendError && e.reason === 'window_closed') throw new BadRequestException('window_closed');
      if (e instanceof SendError && e.blocked) await this.prisma.patientChannel.updateMany({ where: { clinicId, channel, externalId: chatId }, data: { optedOutAt: new Date() } });
      await this.prisma.chatMessage.create({ data: { ...base, error: e instanceof SendError ? e.message.slice(0, 200) : 'Не вдалося надіслати' } });
      throw new BadRequestException('send_failed');
    }
    await this.prisma.chatMessage.create({ data: base });
    // A person answered: with the agent's autonomous mode on, the dialogue is theirs until they give it back explicitly (resume), not only for a while
    if (clinic.aiAgentAuto) await this.prisma.conversationState.upsert({ where: { clinicId_channel_chatId: { clinicId, channel, chatId } }, create: { clinicId, channel, chatId, owner: 'HUMAN' }, update: { owner: 'HUMAN' } });
    return { ok: true };
  }

  // End the pause after a person's answer: the AI answers the next message again
  async resumeBot(clinicId: string, channel: string, chatId: string) {
    const known = await this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId }, select: { id: true } });
    if (!known) throw new NotFoundException('conversation_not_found');
    const r = await this.autoReply.resume(clinicId, channel, chatId);
    // The dialogue goes back to the agent explicitly; a message nobody handled meanwhile is looked at now
    await this.prisma.conversationState.updateMany({ where: { clinicId, channel, chatId }, data: { owner: 'BOT' } });
    await this.auto.onInbound(clinicId, channel, chatId);
    return r;
  }

  // Link an unknown chat to a patient card by hand (when the number did not match)
  async link(clinicId: string, channel: string, chatId: string, patientId: string) {
    const [patient, known] = await Promise.all([
      this.prisma.patient.findFirst({ where: { id: patientId, clinicId, removedAt: null }, select: { id: true } }),
      this.prisma.chatMessage.findFirst({ where: { clinicId, channel, chatId }, select: { contactName: true } }),
    ]);
    if (!patient || !known) throw new NotFoundException('not_found');
    await this.prisma.patientChannel.upsert({
      where: { patientId_channel: { patientId, channel } },
      create: { clinicId, patientId, channel, externalId: chatId },
      update: { externalId: chatId, optedOutAt: null, linkedAt: new Date() },
    });
    await this.prisma.chatMessage.updateMany({ where: { clinicId, channel, chatId }, data: { patientId } });
    return { ok: true };
  }
}
