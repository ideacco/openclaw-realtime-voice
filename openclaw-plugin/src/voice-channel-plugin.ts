import { AudioServiceClient } from './audio-service-client.js';

export interface VoiceChannelPluginConfig {
  audioServiceBaseUrl: string;
  audioServiceToken: string;
  voice: string;
  ttsSampleRate: number;
  inputSampleRate: number;
}

export function createVoiceChannelPlugin(config: VoiceChannelPluginConfig): any {
  const clientByAccount = new Map<string, AudioServiceClient>();

  return {
    id: 'voice',
    meta: {
      displayName: 'Voice Channel',
      capabilities: {
        supportsTextOutbound: true,
        supportsMediaOutbound: false
      }
    },

    config: {
      listAccountIds: async () => ['default'],
      resolveAccount: async () => ({
        id: 'default',
        label: 'Default Voice Account'
      })
    },

    gateway: {
      startAccount: async ({ account }: any) => {
        const accountId = account?.id ?? 'default';
        if (clientByAccount.has(accountId)) {
          return;
        }

        const client = new AudioServiceClient({
          baseUrl: config.audioServiceBaseUrl,
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
        const accountId = account?.id ?? 'default';
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
      sendText: async ({ account, text }: any) => {
        const accountId = account?.id ?? 'default';
        const client = clientByAccount.get(accountId);
        if (!client) {
          throw new Error(`Voice account ${accountId} is not started`);
        }

        client.sendText(text);
      }
    }
  };
}
