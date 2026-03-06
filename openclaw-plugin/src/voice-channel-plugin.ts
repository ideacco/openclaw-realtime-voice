import { AudioServiceClient } from './audio-service-client.js';

export interface VoiceChannelPluginConfig {
  audioServiceBaseUrl: string;
  audioServiceWsUrl?: string;
  audioServiceToken: string;
  voice: string;
  ttsSampleRate: number;
  inputSampleRate: number;
}

interface RuntimeContextLike {
  cfg: any;
  accountId: string;
  channelRuntime?: any;
}

export function createVoiceChannelPlugin(config: VoiceChannelPluginConfig): any {
  const clientByAccount = new Map<string, AudioServiceClient>();
  const clientListenerByAccount = new Map<string, (event: any) => void>();
  const runtimeAccountByAccount = new Map<
    string,
    VoiceChannelPluginConfig & { id: string; accountId: string; label: string }
  >();
  const runtimeContextByAccount = new Map<string, RuntimeContextLike>();
  const inboundQueueByAccount = new Map<string, Promise<void>>();
  const lastFinalAsrByAccount = new Map<string, { text: string; at: number }>();
  const reconnectTimerByAccount = new Map<string, NodeJS.Timeout>();
  const reconnectAttemptByAccount = new Map<string, number>();
  const reconnectingByAccount = new Set<string>();
  const resolveAccountId = (account: any): string => account?.id ?? account?.accountId ?? 'default';

  const readLegacyPluginConfig = (cfg: any): Partial<VoiceChannelPluginConfig> => {
    const legacy = cfg?.plugins?.entries?.['voice-channel']?.config;
    return legacy && typeof legacy === 'object' ? legacy : {};
  };

  const readChannelAccounts = (cfg: any): Record<string, any> => {
    const accounts = cfg?.channels?.voice?.accounts;
    return accounts && typeof accounts === 'object' ? accounts : {};
  };

  const defaultsFrom = (cfg: any): VoiceChannelPluginConfig => {
    const legacy = readLegacyPluginConfig(cfg);
    return {
      audioServiceBaseUrl: String(legacy.audioServiceBaseUrl ?? config.audioServiceBaseUrl),
      audioServiceWsUrl: legacy.audioServiceWsUrl ?? config.audioServiceWsUrl,
      audioServiceToken: String(legacy.audioServiceToken ?? config.audioServiceToken),
      voice: String(legacy.voice ?? config.voice),
      ttsSampleRate: Number(legacy.ttsSampleRate ?? config.ttsSampleRate),
      inputSampleRate: Number(legacy.inputSampleRate ?? config.inputSampleRate)
    };
  };

  const normalizeAccount = (
    accountId: string,
    source: any,
    defaults: VoiceChannelPluginConfig
  ): VoiceChannelPluginConfig & { id: string; accountId: string; label: string } => ({
    id: accountId,
    accountId,
    label: source?.label ?? accountId,
    audioServiceBaseUrl: String(source?.audioServiceBaseUrl ?? defaults.audioServiceBaseUrl),
    audioServiceWsUrl: source?.audioServiceWsUrl ?? defaults.audioServiceWsUrl,
    audioServiceToken: String(source?.audioServiceToken ?? defaults.audioServiceToken),
    voice: String(source?.voice ?? defaults.voice),
    ttsSampleRate: Number(source?.ttsSampleRate ?? defaults.ttsSampleRate),
    inputSampleRate: Number(source?.inputSampleRate ?? defaults.inputSampleRate)
  });

  const getRuntimeAccount = (
    cfg: any,
    account: any
  ): (VoiceChannelPluginConfig & { id: string; accountId: string; label: string }) => {
    const accountId = resolveAccountId(account);
    const defaults = defaultsFrom(cfg);
    const runtimeAccount = normalizeAccount(accountId, account, defaults);

    if (!runtimeAccount.audioServiceBaseUrl) {
      throw new Error(`Voice account ${accountId} missing audioServiceBaseUrl`);
    }
    if (!runtimeAccount.audioServiceToken) {
      throw new Error(`Voice account ${accountId} missing audioServiceToken`);
    }
    return runtimeAccount;
  };

  const clearReconnect = (accountId: string): void => {
    const timer = reconnectTimerByAccount.get(accountId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimerByAccount.delete(accountId);
    }
  };

  const reconnectAccount = async (accountId: string, reason: string): Promise<void> => {
    if (reconnectingByAccount.has(accountId)) {
      return;
    }

    const client = clientByAccount.get(accountId);
    const runtimeAccount = runtimeAccountByAccount.get(accountId);
    if (!client || !runtimeAccount) {
      return;
    }

    reconnectingByAccount.add(accountId);
    try {
      await client.connect();
      logInfo(accountId, `RECONNECTED websocket reason=${reason}`);

      const started = await client.startChannelAndWaitAck(
        {
          voice: runtimeAccount.voice,
          sampleRate: runtimeAccount.ttsSampleRate,
          inputSampleRate: runtimeAccount.inputSampleRate,
          clientRole: 'plugin'
        },
        10_000
      );
      clearReconnect(accountId);
      reconnectAttemptByAccount.set(accountId, 0);
      logInfo(
        accountId,
        `RESTARTED sessionId=${started.sessionId} asrProvider=${started.asrProvider ?? '-'} ttsProvider=${started.ttsProvider ?? '-'} llmMode=${started.llmMode ?? '-'}`
      );
    } catch (error) {
      const attempts = (reconnectAttemptByAccount.get(accountId) ?? 0) + 1;
      reconnectAttemptByAccount.set(accountId, attempts);
      const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
      logError(
        accountId,
        `RECONNECT_FAILED attempt=${attempts} nextInMs=${delayMs} ${toMessage(error)}`
      );

      clearReconnect(accountId);
      reconnectTimerByAccount.set(
        accountId,
        setTimeout(() => {
          void reconnectAccount(accountId, 'retry');
        }, delayMs)
      );
    } finally {
      reconnectingByAccount.delete(accountId);
    }
  };

  return {
    id: 'voice',
    meta: {
      id: 'voice',
      label: 'Voice',
      selectionLabel: 'Voice Channel (Plugin)',
      docsPath: '/channels/voice',
      blurb: 'External realtime voice channel via websocket gateway.'
    },

    capabilities: {
      chatTypes: ['direct']
    },

    commands: {
      nativeCommands: []
    },

    config: {
      listAccountIds: (cfg: any) => {
        const accounts = readChannelAccounts(cfg);
        const ids = Object.keys(accounts).filter((id) => accounts[id]?.enabled !== false);
        return ids.length > 0 ? ids : ['default'];
      },
      resolveAccount: (cfg: any, accountId?: string) => {
        const id = accountId ?? 'default';
        const accounts = readChannelAccounts(cfg);
        const source = accounts[id];

        if (accounts[id]?.enabled === false) {
          return undefined;
        }
        if (Object.keys(accounts).length > 0 && !source) {
          return undefined;
        }

        const defaults = defaultsFrom(cfg);
        return normalizeAccount(id, source ?? {}, defaults);
      }
    },

    gateway: {
      startAccount: async ({ cfg, account, channelRuntime }: any) => {
        const runtimeAccount = getRuntimeAccount(cfg, account);
        const accountId = runtimeAccount.accountId;
        if (clientByAccount.has(accountId)) {
          logInfo(accountId, 'ALREADY_STARTED');
          return;
        }

        const client = new AudioServiceClient({
          baseUrl: runtimeAccount.audioServiceBaseUrl,
          wsUrl: runtimeAccount.audioServiceWsUrl,
          token: runtimeAccount.audioServiceToken
        });
        runtimeContextByAccount.set(accountId, {
          cfg,
          accountId,
          channelRuntime
        });
        runtimeAccountByAccount.set(accountId, runtimeAccount);
        reconnectAttemptByAccount.set(accountId, 0);

        const listener = (event: any) => {
          if (event?.type === 'connected') {
            return;
          }
          if (event?.type === 'socket.error') {
            logError(accountId, `AUDIO_SOCKET_ERROR ${event.message}`);
            return;
          }
          if (event?.type === 'disconnected') {
            logError(
              accountId,
              `AUDIO_DISCONNECTED code=${event.code} reason=${event.reason || '-'}`
            );
            void reconnectAccount(accountId, 'socket_closed');
            return;
          }
          if (event?.type === 'channel.error') {
            logError(accountId, `CHANNEL_ERROR [${event.code}] ${event.message}`);
            return;
          }
          if (event?.type === 'channel.ended') {
            logInfo(accountId, 'CHANNEL_ENDED');
            return;
          }
          if (event?.type === 'asr.text') {
            logInfo(accountId, `ASR_TEXT "${event.text}"`);
            if (!event.isFinal) {
              return;
            }
            const text = String(event.text ?? '').trim();
            if (!text) {
              return;
            }
            const last = lastFinalAsrByAccount.get(accountId);
            const now = Date.now();
            if (last && last.text === text && now - last.at < 1200) {
              return;
            }
            lastFinalAsrByAccount.set(accountId, { text, at: now });
            enqueueInboundAsr(accountId, async () => {
              await dispatchAsrToOpenClaw({
                accountId,
                text,
                targetSessionId: String(event.sessionId ?? ''),
                client,
                runtimeContext: runtimeContextByAccount.get(accountId)
              });
            }, inboundQueueByAccount);
            return;
          }
          if (event?.type === 'message.created') {
            const text = String(event?.message?.content ?? '').trim();
            if (!text) {
              return;
            }
            const last = lastFinalAsrByAccount.get(accountId);
            const now = Date.now();
            if (last && last.text === text && now - last.at < 1200) {
              return;
            }
            lastFinalAsrByAccount.set(accountId, { text, at: now });
            enqueueInboundAsr(
              accountId,
              async () => {
                await dispatchAsrToOpenClaw({
                  accountId,
                  text,
                  targetSessionId: String(event.sessionId ?? ''),
                  client,
                  runtimeContext: runtimeContextByAccount.get(accountId)
                });
              },
              inboundQueueByAccount
            );
            return;
          }
        };
        client.on('event', listener);
        clientListenerByAccount.set(accountId, listener);

        logInfo(accountId, `CONNECTING ${client.targetUrl()}`);

        try {
          await client.connect();
          logInfo(accountId, 'CONNECTED websocket');

          const started = await client.startChannelAndWaitAck(
            {
              voice: runtimeAccount.voice,
              sampleRate: runtimeAccount.ttsSampleRate,
              inputSampleRate: runtimeAccount.inputSampleRate,
              clientRole: 'plugin'
            },
            10_000
          );
          logInfo(
            accountId,
            `STARTED sessionId=${started.sessionId} voice=${started.voice ?? runtimeAccount.voice} sampleRate=${started.sampleRate ?? runtimeAccount.ttsSampleRate} asrProvider=${started.asrProvider ?? '-'} ttsProvider=${started.ttsProvider ?? '-'} llmEnabled=${started.llmEnabled ?? '-'} llmMode=${started.llmMode ?? '-'}`
          );
        } catch (error) {
          client.off('event', listener);
          clientListenerByAccount.delete(accountId);
          client.close();
          runtimeAccountByAccount.delete(accountId);
          reconnectAttemptByAccount.delete(accountId);
          clearReconnect(accountId);
          const message = toMessage(error);
          logError(accountId, `FAILED ${message}`);
          throw new Error(`Failed to start voice channel account ${accountId}: ${message}`);
        }

        clientByAccount.set(accountId, client);
      },

      stopAccount: async ({ account }: any) => {
        const accountId = resolveAccountId(account);
        const client = clientByAccount.get(accountId);
        const listener = clientListenerByAccount.get(accountId);
        if (!client) {
          return;
        }

        clearReconnect(accountId);
        reconnectAttemptByAccount.delete(accountId);
        reconnectingByAccount.delete(accountId);

        client.endChannel();
        if (listener) {
          client.off('event', listener);
          clientListenerByAccount.delete(accountId);
        }
        client.close();
        clientByAccount.delete(accountId);
        runtimeAccountByAccount.delete(accountId);
        runtimeContextByAccount.delete(accountId);
        inboundQueueByAccount.delete(accountId);
        lastFinalAsrByAccount.delete(accountId);
        logInfo(accountId, 'STOPPED');
      }
    },

    outbound: {
      deliveryMode: 'direct',
      sendText: async ({ account, text }: any) => {
        const accountId = resolveAccountId(account);
        const client = clientByAccount.get(accountId);
        if (!client) {
          throw new Error(`Voice account ${accountId} is not started`);
        }

        client.sendAssistantText(text);
        return { ok: true };
      }
    }
  };
}

function logInfo(accountId: string, message: string): void {
  console.info(`[voice-channel][${accountId}] ${message}`);
}

function logError(accountId: string, message: string): void {
  console.error(`[voice-channel][${accountId}] ${message}`);
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function enqueueInboundAsr(
  accountId: string,
  task: () => Promise<void>,
  queueMap: Map<string, Promise<void>>
): void {
  const prev = queueMap.get(accountId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await task();
    })
    .catch((error) => {
      logError(accountId, `ASR_DISPATCH_FAILED ${toMessage(error)}`);
    });
  queueMap.set(accountId, next);
}

async function dispatchAsrToOpenClaw(params: {
  accountId: string;
  text: string;
  targetSessionId: string;
  client: AudioServiceClient;
  runtimeContext?: RuntimeContextLike;
}): Promise<void> {
  const { accountId, text, targetSessionId, client, runtimeContext } = params;
  const runtime = runtimeContext?.channelRuntime;
  const cfg = runtimeContext?.cfg;
  if (!runtime) {
    logError(accountId, 'channelRuntime is not available, cannot dispatch ASR text to OpenClaw');
    return;
  }
  if (!cfg) {
    logError(accountId, 'plugin config not available for ASR dispatch');
    return;
  }

  const route = runtime.routing.resolveAgentRoute({
    cfg,
    channel: 'voice',
    accountId,
    peer: {
      kind: 'direct',
      id: `voice:${accountId}`
    }
  });

  const body = runtime.reply.formatAgentEnvelope({
    channel: 'Voice',
    from: `voice:${accountId}`,
    timestamp: Date.now(),
    envelope: runtime.reply.resolveEnvelopeFormatOptions(cfg),
    body: text
  });

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `voice:user:${accountId}`,
    To: `voice:session:${accountId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: 'direct',
    ConversationLabel: `voice:${accountId}`,
    SenderName: 'Voice User',
    SenderId: `voice-user:${accountId}`,
    Provider: 'voice',
    Surface: 'voice',
    MessageSid: `voice-${Date.now()}`,
    OriginatingChannel: 'voice',
    OriginatingTo: `voice:session:${accountId}`,
    CommandAuthorized: false
  });

  const storePath = runtime.session.resolveStorePath(cfg?.session?.store, {
    agentId: route.agentId
  });
  await runtime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error: unknown) => {
      logError(accountId, `SESSION_RECORD_FAILED ${toMessage(error)}`);
    }
  });

  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: any, info: any) => {
        const replyText = String(payload?.text ?? '').trim();
        if (!replyText) {
          return;
        }
        client.sendAssistantText(replyText, targetSessionId || undefined);
        logInfo(
          accountId,
          `OPENCLAW_REPLY kind=${String(info?.kind ?? 'unknown')} target=${targetSessionId || '-'} len=${replyText.length}`
        );
      },
      onError: (error: unknown, info: any) => {
        logError(
          accountId,
          `OPENCLAW_REPLY_ERROR kind=${String(info?.kind ?? 'unknown')} ${toMessage(error)}`
        );
      }
    }
  });
}
