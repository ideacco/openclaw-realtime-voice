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

const player = new PcmAudioPlayer(24000);

let ws = null;
let sessionId = null;
let mediaStream = null;
let mediaRecorder = null;
let speechRecognition = null;
let speechRecognitionActive = false;
let realtimeDraft = '';

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
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    recordBtn.disabled = false;
    speakBtn.disabled = false;
    endBtn.disabled = false;

    send({
      type: 'channel.start',
      inputSampleRate: 16000
    });
    log('WebSocket 已连接，发送 channel.start');
  });

  ws.addEventListener('message', (event) => {
    onServerEvent(JSON.parse(event.data));
  });

  ws.addEventListener('close', async () => {
    status('未连接');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    recordBtn.disabled = true;
    stopBtn.disabled = true;
    speakBtn.disabled = true;
    endBtn.disabled = true;
    sessionId = null;
    await stopRecording();
    await player.close();
    log('连接关闭');
  });

  ws.addEventListener('error', () => {
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
  send({ type: 'input.audio.commit', reason: 'manual' });
  log('录音提交 input.audio.commit');
});

speakBtn.addEventListener('click', () => {
  const text = inputText.value.trim();
  if (!text) {
    log('输入文本为空');
    return;
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
  switch (event.type) {
    case 'channel.started':
      sessionId = event.sessionId;
      status(`会话已启动 (${event.sessionId.slice(0, 8)})`);
      log(`channel.started voice=${event.voice} sampleRate=${event.sampleRate}`);
      break;
    case 'vad.segment':
      log(`vad.segment chunkCount=${event.chunkCount} reason=${event.reason}`);
      break;
    case 'asr.text':
      log(`asr.text: ${event.text}`);
      finalTranscriptEl.textContent = `服务端 ASR 结果：${event.text}`;
      break;
    case 'message.created':
      log(`message.created: ${event.message.content}`);
      break;
    case 'assistant.text.delta':
      log(`assistant.text.delta: ${event.text}`);
      break;
    case 'audio.output.delta':
      void player.enqueueBase64(event.data);
      break;
    case 'audio.output.completed':
      log('audio.output.completed');
      break;
    case 'channel.error':
      log(`channel.error [${event.code}] ${event.message}`);
      break;
    case 'channel.ended':
      log(`channel.ended ${event.sessionId}`);
      sessionId = null;
      break;
    default:
      log(`unknown event: ${JSON.stringify(event)}`);
  }
}

async function startRecording() {
  if (mediaRecorder) {
    return;
  }

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    log('当前浏览器不支持录音');
    return;
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

  mediaRecorder.addEventListener('stop', () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
    }
    mediaStream = null;
    mediaRecorder = null;
    recordStatus('空闲');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
  });

  mediaRecorder.start(250);
  startSpeechDebug();
  realtimeDraft = '';
  liveTranscriptEl.textContent = '识别中...';
  recordStatus('录音中...');
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  log('开始录音并推送音频分片');
}

async function stopRecording() {
  if (!mediaRecorder) {
    stopSpeechDebug();
    return;
  }

  mediaRecorder.stop();
  stopSpeechDebug();
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

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
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
