import type { VoiceChannelPluginConfig } from './src/voice-channel-plugin.js';
import { createVoiceChannelPlugin } from './src/voice-channel-plugin.js';

export default {
  id: 'voice-channel',
  register(api: any) {
    const pluginConfig = (api.getConfig?.() ?? {}) as Partial<VoiceChannelPluginConfig>;

    const channel = createVoiceChannelPlugin({
      audioServiceBaseUrl: pluginConfig.audioServiceBaseUrl ?? process.env.AUDIO_SERVICE_BASE_URL ?? 'http://127.0.0.1:8080',
      audioServiceToken: pluginConfig.audioServiceToken ?? process.env.AUDIO_SERVICE_TOKEN ?? 'dev-token',
      voice: pluginConfig.voice ?? process.env.VOICE_DEFAULT ?? 'Bunny',
      ttsSampleRate: Number(pluginConfig.ttsSampleRate ?? process.env.TTS_SAMPLE_RATE ?? 24000),
      inputSampleRate: Number(pluginConfig.inputSampleRate ?? process.env.INPUT_SAMPLE_RATE ?? 16000)
    });

    api.registerChannel?.({ plugin: channel });
  }
};
