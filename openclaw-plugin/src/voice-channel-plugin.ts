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
  const resolveAccountId = (account: any): string => account?.id ?? account?.accountId ?? 'default';

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

    config: {
      listAccountIds: (_cfg: any) => ['default'],
      resolveAccount: (_cfg: any, accountId?: string) => ({
        id: accountId ?? 'default',
        accountId: accountId ?? 'default',
        label: 'Default Voice Account'
      })
    },

    gateway: {
      startAccount: async ({ account }: any) => {
        const accountId = resolveAccountId(account);
        if (clientByAccount.has(accountId)) {
          return;
        }

        const client = new AudioServiceClient({
          baseUrl: config.audioServiceBaseUrl,
          wsUrl: config.audioServiceWsUrl,
          token: config.audioServiceToken
        });

        await client.connect();
        client.startChannel({
          voice: config.voice,
          sampleRate: config.ttsSampleRate,
          inputSampleRate: config.inputSampleRate
        });

        clientByAccount.set(accountId, client);
      },

      stopAccount: async ({ account }: any) => {
        const accountId = resolveAccountId(account);
        const client = clientByAccount.get(accountId);
        if (!client) {
          return;
        }

        client.endChannel();
        client.close();
        clientByAccount.delete(accountId);
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

        client.sendText(text);
        return { ok: true };
      }
    }
  };
}
