import { AudioServiceClient } from './audio-service-client.js';

export interface VoiceChannelPluginConfig {
  audioServiceBaseUrl: string;
  audioServiceWsUrl?: string;
  audioServiceToken: string;
  voice: string;
  ttsSampleRate: number;
  inputSampleRate: number;
}

export function createVoiceChannelPlugin(config: VoiceChannelPluginConfig): any {
  const clientByAccount = new Map<string, AudioServiceClient>();
  const clientListenerByAccount = new Map<string, (event: any) => void>();
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
      startAccount: async ({ cfg, account }: any) => {
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

        const listener = (event: any) => {
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
              inputSampleRate: runtimeAccount.inputSampleRate
            },
            10_000
          );
          logInfo(
            accountId,
            `STARTED sessionId=${started.sessionId} voice=${started.voice ?? runtimeAccount.voice} sampleRate=${started.sampleRate ?? runtimeAccount.ttsSampleRate} asrProvider=${started.asrProvider ?? '-'} llmEnabled=${started.llmEnabled ?? '-'}`
          );
        } catch (error) {
          client.off('event', listener);
          clientListenerByAccount.delete(accountId);
          client.close();
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

        client.endChannel();
        if (listener) {
          client.off('event', listener);
          clientListenerByAccount.delete(accountId);
        }
        client.close();
        clientByAccount.delete(accountId);
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
