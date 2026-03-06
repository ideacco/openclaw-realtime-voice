import { PcmAudioPlayer } from './player.js';

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const speakBtn = document.getElementById('speakBtn');
const endBtn = document.getElementById('endBtn');
const tokenInput = document.getElementById('token');
const inputText = document.getElementById('inputText');
const statusEl = document.getElementById('status');
const recordStatusEl = document.getElementById('recordStatus');
const logEl = document.getElementById('log');
const liveTranscriptEl = document.getElementById('liveTranscript');
const finalTranscriptEl = document.getElementById('finalTranscript');
const channelLinkStatusEl = document.getElementById('channelLinkStatus');
const channelSessionIdEl = document.getElementById('channelSessionId');
const channelLastErrorEl = document.getElementById('channelLastError');
const assistantStreamEl = document.getElementById('assistantStream');
const lastServerEventEl = document.getElementById('lastServerEvent');

const player = new PcmAudioPlayer(24000);

let ws = null;
let sessionId = null;
let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let mediaSourceNode = null;
let processorNode = null;
let pcmGainNode = null;
let pcmFlushTimer = null;
let pcmFrames = [];
let pcmByteLength = 0;
let recordingMode = null;
let speechRecognition = null;
let speechRecognitionActive = false;
let realtimeDraft = '';
let assistantStream = '';
let asrProvider = 'unknown';
let llmEnabled = false;
let llmMode = 'unknown';
let lastLocalAsrInterimText = '';
let lastLocalAsrInterimSentAt = 0;
let lastLocalAsrFinalText = '';
let hasLocalAsrFinalSent = false;

connectBtn.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) {
    log('缺少 token');
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/channel/voice/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open', () => {
    status('已连接');
    setChannelLinkStatus('WebSocket 已连接，等待 channel.started');
    setChannelSessionId('-');
    setChannelLastError('-');
    assistantStream = '';
    setAssistantStream('-');
    setLastServerEvent('-');
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    recordBtn.disabled = false;
    speakBtn.disabled = false;
    endBtn.disabled = false;

    send({
      type: 'channel.start',
      inputSampleRate: 16000,
      clientRole: 'web'
    });
    log('WebSocket 已连接，发送 channel.start');
  });

  ws.addEventListener('message', (event) => {
    onServerEvent(JSON.parse(event.data));
  });

  ws.addEventListener('close', async () => {
    status('未连接');
    setChannelLinkStatus('连接已断开');
    setChannelSessionId('-');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    recordBtn.disabled = true;
    stopBtn.disabled = true;
    speakBtn.disabled = true;
    endBtn.disabled = true;
    sessionId = null;
    llmEnabled = false;
    llmMode = 'unknown';
    await stopRecording();
    await player.close();
    log('连接关闭');
  });

  ws.addEventListener('error', () => {
    setChannelLastError('WebSocket 连接错误');
    log('WebSocket error');
  });
});

disconnectBtn.addEventListener('click', async () => {
  if (ws) {
    ws.close();
  }
});

recordBtn.addEventListener('click', async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('连接未建立');
    return;
  }

  await startRecording();
});

stopBtn.addEventListener('click', async () => {
  await stopRecording();
  sendLocalAsrIfAvailable();
  send({ type: 'input.audio.commit', reason: 'manual' });
  log('录音提交 input.audio.commit');
});

speakBtn.addEventListener('click', () => {
  const text = inputText.value.trim();
  if (!text) {
    log('输入文本为空');
    return;
  }
  if (!llmEnabled) {
    log('警告: 当前会话未启用 OpenClaw 链路，input.text 可能没有返回');
  }

  send({ type: 'input.text', text });
  log(`发送 input.text: ${text}`);
});

endBtn.addEventListener('click', async () => {
  send({ type: 'channel.end' });
  await stopRecording();
  await player.close();
  log('发送 channel.end');
});

function onServerEvent(event) {
  setLastServerEvent(formatEventForDebug(event));

  switch (event.type) {
    case 'channel.started':
    case 'session.started':
      sessionId = event.sessionId;
      asrProvider = event.asrProvider ?? asrProvider;
      llmEnabled = Boolean(event.llmEnabled);
      llmMode = event.llmMode ?? llmMode;
      status(`会话已启动 (${event.sessionId.slice(0, 8)})`);
      setChannelLinkStatus(
        `频道会话已启动 (ASR=${asrProvider}, OpenClaw=${llmEnabled ? llmMode : 'disabled'})`
      );
      setChannelSessionId(event.sessionId);
      assistantStream = '';
      setAssistantStream('-');
      log(
        `${event.type} voice=${event.voice} sampleRate=${event.sampleRate} asrProvider=${event.asrProvider ?? '-'} llmEnabled=${event.llmEnabled ?? '-'} llmMode=${event.llmMode ?? '-'}`
      );
      break;
    case 'vad.segment':
      setChannelLinkStatus('音频分段已提交，等待 ASR/LLM/TTS');
      log(`vad.segment chunkCount=${event.chunkCount} reason=${event.reason}`);
      break;
    case 'asr.text':
      log(`asr.text: ${event.text}`);
      finalTranscriptEl.textContent = `服务端 ASR 结果：${event.text}`;
      break;
    case 'message.created':
      setChannelLinkStatus('已提交用户文本，等待 OpenClaw 流式回复');
      log(`message.created: ${event.message.content}`);
      break;
    case 'agent.text.delta':
      appendAssistantStream(event.text);
      log(`agent.text.delta: ${event.text}`);
      break;
    case 'assistant.text.delta':
      appendAssistantStream(event.text);
      setChannelLinkStatus('OpenClaw 正在返回文本，TTS 正在合成');
      log(`assistant.text.delta: ${event.text}`);
      break;
    case 'audio.output.delta':
      setChannelLinkStatus('正在接收音频流');
      void player.enqueueBase64(event.data);
      break;
    case 'audio.output.completed':
      setChannelLinkStatus('当前音频段播放完成');
      log('audio.output.completed');
      break;
    case 'channel.error':
    case 'session.error':
      setChannelLinkStatus('链路异常');
      setChannelLastError(`[${event.code}] ${event.message}`);
      log(`${event.type} [${event.code}] ${event.message}`);
      break;
    case 'channel.ended':
    case 'session.ended':
      log(`channel.ended ${event.sessionId}`);
      sessionId = null;
      setChannelLinkStatus('会话已结束');
      setChannelSessionId('-');
      break;
    default:
      log(`unknown event: ${JSON.stringify(event)}`);
  }
}

async function startRecording() {
  if (recordingMode) {
    return;
  }

  if (!navigator.mediaDevices) {
    log('当前浏览器不支持录音');
    return;
  }

  realtimeDraft = '';
  lastLocalAsrInterimText = '';
  lastLocalAsrInterimSentAt = 0;
  lastLocalAsrFinalText = '';
  hasLocalAsrFinalSent = false;
  liveTranscriptEl.textContent = '识别中...';

  try {
    await startPcmRecording();
    recordingMode = 'pcm';
    log('开始录音并推送音频分片 (PCM 16-bit)');
  } catch (error) {
    log(`PCM 录音启动失败，降级为 MediaRecorder: ${error?.message ?? String(error)}`);
    await startMediaRecorderRecording();
    recordingMode = 'webm';
    log('开始录音并推送音频分片 (WebM Opus)');
  }

  startSpeechDebug();
  recordStatus('录音中...');
  recordBtn.disabled = true;
  stopBtn.disabled = false;
}

async function stopRecording() {
  if (recordingMode === 'pcm') {
    stopPcmRecording();
  } else if (recordingMode === 'webm') {
    stopMediaRecorderRecording();
  }

  recordingMode = null;
  recordStatus('空闲');
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  stopSpeechDebug();
}

async function startPcmRecording() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('AudioContext 不可用');
  }
  if (!AudioCtx.prototype.createScriptProcessor) {
    throw new Error('ScriptProcessor 不可用');
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioCtx({ sampleRate: 16000 });
  mediaSourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  pcmGainNode = audioContext.createGain();
  pcmGainNode.gain.value = 0;

  pcmFrames = [];
  pcmByteLength = 0;

  processorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const frame = float32ToPcm16(input);
    pcmFrames.push(frame);
    pcmByteLength += frame.length;
  };

  mediaSourceNode.connect(processorNode);
  processorNode.connect(pcmGainNode);
  pcmGainNode.connect(audioContext.destination);

  pcmFlushTimer = window.setInterval(() => {
    flushPcmFrames();
  }, 200);
}

function stopPcmRecording() {
  if (pcmFlushTimer) {
    clearInterval(pcmFlushTimer);
    pcmFlushTimer = null;
  }

  flushPcmFrames();

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (mediaSourceNode) {
    mediaSourceNode.disconnect();
    mediaSourceNode = null;
  }
  if (pcmGainNode) {
    pcmGainNode.disconnect();
    pcmGainNode = null;
  }
  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

async function startMediaRecorderRecording() {
  if (!window.MediaRecorder) {
    throw new Error('MediaRecorder 不可用');
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  mediaRecorder.addEventListener('dataavailable', async (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }

    const base64 = await blobToBase64(event.data);
    send({
      type: 'input.audio.chunk',
      data: base64,
      encoding: 'webm_opus',
      sampleRate: 48000
    });
  });

  mediaRecorder.start(250);
}

function stopMediaRecorderRecording() {
  if (!mediaRecorder) {
    return;
  }
  mediaRecorder.stop();
  mediaRecorder = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function flushPcmFrames() {
  if (pcmFrames.length === 0 || pcmByteLength <= 0) {
    return;
  }

  const merged = new Uint8Array(pcmByteLength);
  let offset = 0;
  for (const frame of pcmFrames) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  pcmFrames = [];
  pcmByteLength = 0;

  send({
    type: 'input.audio.chunk',
    data: uint8ToBase64(merged),
    encoding: 'pcm_s16le',
    sampleRate: audioContext?.sampleRate ?? 16000
  });
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('连接未建立');
    return;
  }
  ws.send(JSON.stringify(payload));
}

function status(text) {
  statusEl.textContent = text;
}

function recordStatus(text) {
  recordStatusEl.textContent = text;
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${message}\n${logEl.textContent}`;
}

function setChannelLinkStatus(text) {
  channelLinkStatusEl.textContent = text;
}

function setChannelSessionId(text) {
  channelSessionIdEl.textContent = text;
}

function setChannelLastError(text) {
  channelLastErrorEl.textContent = text;
}

function setAssistantStream(text) {
  assistantStreamEl.textContent = text;
}

function appendAssistantStream(delta) {
  assistantStream += delta;
  if (assistantStream.length > 8000) {
    assistantStream = assistantStream.slice(-8000);
  }
  setAssistantStream(assistantStream || '-');
}

function setLastServerEvent(text) {
  lastServerEventEl.textContent = text;
}

function formatEventForDebug(event) {
  if (!event || typeof event !== 'object') {
    return String(event);
  }

  const cloned = { ...event };
  if (typeof cloned.data === 'string' && cloned.data.length > 120) {
    cloned.data = `<base64 ${cloned.data.length} chars>`;
  }

  return JSON.stringify(cloned, null, 2);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  return uint8ToBase64(new Uint8Array(buffer));
}

function float32ToPcm16(input) {
  const output = new Uint8Array(input.length * 2);
  const view = new DataView(output.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    const s = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(i * 2, s, true);
  }
  return output;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function startSpeechDebug() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    liveTranscriptEl.textContent = '当前浏览器不支持实时语音识别（SpeechRecognition）';
    return;
  }

  speechRecognitionActive = true;
  speechRecognition = new Recognition();
  speechRecognition.lang = 'zh-CN';
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;

  speechRecognition.onresult = (event) => {
    let interim = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }

    if (finalText) {
      realtimeDraft += finalText;
    }

    const content = `${realtimeDraft}${interim}`.trim();
    liveTranscriptEl.textContent = content || '识别中...';

    if (asrProvider === 'browser') {
      const finalChunk = finalText.trim();
      if (finalChunk && finalChunk !== lastLocalAsrFinalText) {
        send({
          type: 'input.asr.local',
          text: finalChunk,
          isFinal: true
        });
        lastLocalAsrFinalText = finalChunk;
        hasLocalAsrFinalSent = true;
        log(`发送 input.asr.local(final): ${finalChunk}`);
      }

      const interimChunk = interim.trim();
      const now = Date.now();
      if (
        interimChunk &&
        interimChunk !== lastLocalAsrInterimText &&
        now - lastLocalAsrInterimSentAt >= 160
      ) {
        send({
          type: 'input.asr.local',
          text: interimChunk,
          isFinal: false
        });
        lastLocalAsrInterimText = interimChunk;
        lastLocalAsrInterimSentAt = now;
      }
    }
  };

  speechRecognition.onerror = (event) => {
    log(`speech-debug error: ${event.error}`);
  };

  speechRecognition.onend = () => {
    if (speechRecognitionActive) {
      try {
        speechRecognition.start();
      } catch {
        // noop
      }
    }
  };

  try {
    speechRecognition.start();
  } catch {
    liveTranscriptEl.textContent = '语音识别启动失败，请检查麦克风权限';
  }
}

function stopSpeechDebug() {
  speechRecognitionActive = false;
  if (!speechRecognition) {
    return;
  }
  try {
    speechRecognition.stop();
  } catch {
    // noop
  }
  speechRecognition = null;
}

function sendLocalAsrIfAvailable() {
  if (asrProvider !== 'browser') {
    return;
  }
  if (hasLocalAsrFinalSent) {
    return;
  }

  const liveText = (liveTranscriptEl.textContent ?? '').trim();
  const localText =
    liveText && liveText !== '识别中...' && !liveText.startsWith('当前浏览器不支持')
      ? liveText
      : realtimeDraft.trim();

  if (!localText) {
    log('本地 ASR 文本为空，跳过 input.asr.local');
    return;
  }
  if (localText === lastLocalAsrFinalText) {
    return;
  }

  send({
    type: 'input.asr.local',
    text: localText,
    isFinal: true
  });
  lastLocalAsrFinalText = localText;
  hasLocalAsrFinalSent = true;
  log(`发送 input.asr.local: ${localText}`);
}
