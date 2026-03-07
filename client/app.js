import { PcmAudioPlayer } from './player.js';

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const speakBtn = document.getElementById('speakBtn');
const wakeToggleBtn = document.getElementById('wakeToggleBtn');
const pttToggleBtn = document.getElementById('pttToggleBtn');
const devModeToggleBtn = document.getElementById('devModeToggleBtn');
const wakeWordsInput = document.getElementById('wakeWordsInput');
const silenceMsInput = document.getElementById('silenceMsInput');
const wakeStateEl = document.getElementById('wakeStateLabel');
const voiceDockEl = document.querySelector('.voice-dock');
const controlDrawerEl = document.querySelector('.control-drawer');
const debugPanelEl = document.getElementById('debugPanel');
const tokenInput = document.getElementById('token');
const inputText = document.getElementById('inputText');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const liveTranscriptEl = document.getElementById('liveTranscript');
const finalTranscriptEl = document.getElementById('finalTranscript');
const channelLinkStatusEl = document.getElementById('channelLinkStatus');
const channelSessionIdEl = document.getElementById('channelSessionId');
const channelLastErrorEl = document.getElementById('channelLastError');
const assistantStreamEl = document.getElementById('assistantStream');
const lastServerEventEl = document.getElementById('lastServerEvent');

const player = new PcmAudioPlayer(24000);

const STORAGE_KEYS = {
  wakeEnabled: 'oc_voice_wake_enabled',
  wakeWords: 'oc_voice_wake_words',
  silenceMs: 'oc_voice_wake_silence_ms',
  pttEnabled: 'oc_voice_ptt_enabled',
  dockPosition: 'oc_voice_dock_position',
  developerMode: 'oc_voice_developer_mode'
};

const DEFAULT_WAKE_WORDS = '你好老六';
const DEFAULT_SILENCE_MS = 1200;
const TURN_MAX_DURATION_MS = 12_000;
const PTT_MAX_DURATION_MS = 90_000;
const WAKE_RESUME_DELAY_MS = 1200;
const WAKE_CAPTURE_PRIMING_MS = 1400;
const WAKE_MIN_CAPTURE_MS = 2200;
const WAKE_RETRIGGER_GUARD_MS = 2500;
const ASSISTANT_SETTLE_MS = 500;
const ASSISTANT_FALLBACK_TIMEOUT_MS = 15_000;

const STATE = {
  DISCONNECTED: 'disconnected',
  WAKE_IDLE: 'wake_idle',
  MANUAL_READY: 'manual_ready',
  CAPTURING_TURN: 'capturing_turn',
  TURN_COMMITTING: 'turn_committing',
  WAITING_ASSISTANT: 'waiting_assistant'
};

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
let speechRecognitionBlocked = false;
let speechRecognitionRestarting = false;

let assistantStream = '';
let assistantReplies = [];
let assistantReplySerial = 0;
let pendingUserPrompt = '';
let asrProvider = 'unknown';
let ttsProvider = 'unknown';
let llmEnabled = false;
let llmMode = 'unknown';

let browserTtsBuffer = '';
let browserTtsFlushTimer = null;
let browserTtsUnsupportedLogged = false;
let browserTtsSpeakingCount = 0;
let wakeChimeContext = null;
let wakeChimeUnsupportedLogged = false;

let wakeModeEnabled = readBool(STORAGE_KEYS.wakeEnabled, true);
let pushToTalkEnabled = readBool(STORAGE_KEYS.pttEnabled, true);
let developerModeEnabled = readBool(STORAGE_KEYS.developerMode, false);
let wakeWordsRaw = readString(STORAGE_KEYS.wakeWords, DEFAULT_WAKE_WORDS);
let wakeSilenceMs = readNumber(STORAGE_KEYS.silenceMs, DEFAULT_SILENCE_MS, 600, 5000);
let wakeWords = parseWakeWords(wakeWordsRaw);
let wakeWordsNormalized = wakeWords.map((word) => normalizeForWake(word)).filter(Boolean);

let voiceState = STATE.DISCONNECTED;
let wakeSuppressedUntil = 0;
let wakeLockedByAssistant = false;
let lastWakeDetectedAt = 0;
let dockPosition = readDockPosition();
let dockDragState = null;

let turnSource = 'none';
let turnFinalText = '';
let turnInterimText = '';
let turnHasSpeech = false;
let turnSilenceTimer = null;
let turnMaxTimer = null;
let wakeCapturePrimingUntil = 0;
let turnStartedAt = 0;

let assistantPendingComplete = false;
let assistantLastActivityAt = 0;
let assistantSettleTimer = null;
let assistantFallbackTimer = null;
let assistantReplyStarted = false;
let spacePressed = false;
let spaceTurnActive = false;

initWakeControls();
refreshControls();
setVoiceState(STATE.DISCONNECTED, '未连接');
status('点击连接');
setLiveTranscript('（连接后自动进入唤醒待命）');
applyDockPosition();
bindDockDrag();

document.addEventListener('pointerdown', (event) => {
  if (!controlDrawerEl?.open) {
    return;
  }
  if (controlDrawerEl.contains(event.target)) {
    return;
  }
  controlDrawerEl.open = false;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && controlDrawerEl?.open) {
    controlDrawerEl.open = false;
  }
});

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
    setLiveTranscript('（等待频道启动）');

    send({
      type: 'channel.start',
      inputSampleRate: 16000,
      clientRole: 'web'
    });

    log('WebSocket 已连接，发送 channel.start');
    refreshControls();
  });

  ws.addEventListener('message', (event) => {
    onServerEvent(JSON.parse(event.data));
  });

  ws.addEventListener('close', async () => {
    status('点击连接');
    setChannelLinkStatus('连接已断开');
    setChannelSessionId('-');
    sessionId = null;
    llmEnabled = false;
    llmMode = 'unknown';
    asrProvider = 'unknown';
    ttsProvider = 'unknown';

    stopWakeRecognition();
    clearTurnTimers();
    clearAssistantTimers();
    resetTurnBuffers();
    spacePressed = false;
    spaceTurnActive = false;
    stopBrowserTts();

    await stopRecordingAudio();
    await player.close();

    setVoiceState(STATE.DISCONNECTED, '未连接');
    refreshControls();
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
  if (!isOrbInteractive()) {
    return;
  }
  if (!isConnected()) {
    log('连接未建立');
    return;
  }
  if (voiceState === STATE.CAPTURING_TURN) {
    await commitTurn({ reason: 'orb_click', auto: false });
    return;
  }
  await beginTurn('manual');
});

if (stopBtn) {
  stopBtn.addEventListener('click', async () => {
    await commitTurn({ reason: 'manual_button', auto: false });
  });
}

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
  pendingUserPrompt = text;
  setVoiceState(STATE.WAITING_ASSISTANT, '文本已发送，等待 OpenClaw 回复');
  assistantReplyStarted = false;
  suppressWakeForAssistant();
  setChannelLinkStatus('已提交用户文本，等待 OpenClaw 流式回复');
  armAssistantFallback();
  log(`发送 input.text: ${text}`);
});

wakeToggleBtn.addEventListener('click', () => {
  wakeModeEnabled = !wakeModeEnabled;
  writeStorage(STORAGE_KEYS.wakeEnabled, wakeModeEnabled ? '1' : '0');
  updateWakeToggleUi();

  if (!wakeModeEnabled) {
    setVoiceState(STATE.MANUAL_READY, '唤醒模式关闭，可手动录音');
    log('wake.mode: disabled');
    refreshControls();
    return;
  }

  if (isConnected() && voiceState !== STATE.CAPTURING_TURN && voiceState !== STATE.WAITING_ASSISTANT) {
    setVoiceState(STATE.WAKE_IDLE, '待命：等待唤醒词');
    ensureWakeRecognition();
  }
  log('wake.mode: enabled');
  refreshControls();
});

pttToggleBtn.addEventListener('click', () => {
  pushToTalkEnabled = !pushToTalkEnabled;
  writeStorage(STORAGE_KEYS.pttEnabled, pushToTalkEnabled ? '1' : '0');
  updatePttToggleUi();
  if (!pushToTalkEnabled) {
    spacePressed = false;
    spaceTurnActive = false;
  }
  log(`ptt.mode: ${pushToTalkEnabled ? 'enabled' : 'disabled'}`);
  refreshControls();
});

devModeToggleBtn.addEventListener('click', () => {
  developerModeEnabled = !developerModeEnabled;
  writeStorage(STORAGE_KEYS.developerMode, developerModeEnabled ? '1' : '0');
  updateDeveloperModeUi();
  applyDeveloperMode();
});

wakeWordsInput.addEventListener('change', () => {
  updateWakeWords(wakeWordsInput.value);
});

wakeWordsInput.addEventListener('blur', () => {
  updateWakeWords(wakeWordsInput.value);
});

silenceMsInput.addEventListener('change', () => {
  const parsed = clampNumber(Number(silenceMsInput.value), 600, 5000);
  wakeSilenceMs = parsed;
  silenceMsInput.value = String(parsed);
  writeStorage(STORAGE_KEYS.silenceMs, String(parsed));
  log(`wake.silence_ms: ${parsed}`);
});

window.addEventListener('keydown', (event) => {
  if (!pushToTalkEnabled || event.code !== 'Space') {
    return;
  }
  if (shouldIgnoreSpaceShortcut(event.target)) {
    return;
  }

  event.preventDefault();

  if (event.repeat || spacePressed) {
    return;
  }

  spacePressed = true;
  if (!canStartPushToTalkTurn()) {
    return;
  }

  spaceTurnActive = true;
  void beginTurn('ptt').then(() => {
    if (voiceState !== STATE.CAPTURING_TURN) {
      spaceTurnActive = false;
    }
  });
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || (!spacePressed && !spaceTurnActive)) {
    return;
  }
  if (shouldIgnoreSpaceShortcut(event.target) && !spaceTurnActive) {
    return;
  }

  event.preventDefault();
  spacePressed = false;

  if (!spaceTurnActive) {
    return;
  }
  spaceTurnActive = false;
  void commitTurn({ reason: 'space_release', auto: false });
});

window.addEventListener('blur', () => {
  if (!spaceTurnActive) {
    spacePressed = false;
    return;
  }
  spacePressed = false;
  spaceTurnActive = false;
  void commitTurn({ reason: 'space_blur', auto: false });
});

function onServerEvent(event) {
  setLastServerEvent(formatEventForDebug(event));

  switch (event.type) {
    case 'channel.started':
    case 'session.started': {
      sessionId = event.sessionId;
      asrProvider = event.asrProvider ?? asrProvider;
      ttsProvider = event.ttsProvider ?? ttsProvider;
      llmEnabled = Boolean(event.llmEnabled);
      llmMode = event.llmMode ?? llmMode;

      status(`会话已启动 (${event.sessionId.slice(0, 8)})`);
      setChannelLinkStatus(
        `频道会话已启动 (ASR=${asrProvider}, TTS=${ttsProvider}, OpenClaw=${llmEnabled ? llmMode : 'disabled'})`
      );
      setChannelSessionId(event.sessionId);

      assistantStream = '';
      pendingUserPrompt = '';
      setAssistantStream('-');
      stopBrowserTts();
      clearTurnTimers();
      clearAssistantTimers();
      resetTurnBuffers();

      setVoiceState(
        wakeModeEnabled ? STATE.WAKE_IDLE : STATE.MANUAL_READY,
        wakeModeEnabled ? '待命：等待唤醒词' : '唤醒模式关闭，可手动录音'
      );
      ensureWakeRecognition();
      setLiveTranscript(wakeModeEnabled ? '（待命中，等待唤醒词）' : '（手动模式，可点击手动开始）');

      log(
        `${event.type} voice=${event.voice} sampleRate=${event.sampleRate} asrProvider=${event.asrProvider ?? '-'} ttsProvider=${event.ttsProvider ?? '-'} llmEnabled=${event.llmEnabled ?? '-'} llmMode=${event.llmMode ?? '-'}`
      );
      refreshControls();
      break;
    }

    case 'vad.segment':
      setChannelLinkStatus('音频分段已提交，等待 ASR/LLM/TTS');
      log(`vad.segment chunkCount=${event.chunkCount} reason=${event.reason}`);
      break;

    case 'asr.text':
      finalTranscriptEl.textContent = `服务端 ASR 结果：${event.text}`;
      log(`asr.text: ${event.text}`);
      if (voiceState === STATE.CAPTURING_TURN && asrProvider === 'browser') {
        noteTurnSpeechActivity();
      }
      break;

    case 'message.created':
      if (event.message?.role === 'user' && event.message?.content) {
        pendingUserPrompt = String(event.message.content);
      }
      setChannelLinkStatus('已提交用户文本，等待 OpenClaw 流式回复');
      log(`message.created: ${event.message.content}`);
      break;

    case 'agent.text.delta':
      appendAssistantStream(event.text);
      log(`agent.text.delta: ${event.text}`);
      break;

    case 'assistant.text.delta':
      appendAssistantStream(event.text);
      assistantReplyStarted = true;
      markAssistantActivity();
      suppressWakeForAssistant();
      if (voiceState === STATE.TURN_COMMITTING || voiceState === STATE.WAKE_IDLE || voiceState === STATE.MANUAL_READY) {
        setVoiceState(STATE.WAITING_ASSISTANT, '等待 OpenClaw 回复');
      }
      setChannelLinkStatus(
        ttsProvider === 'browser' ? 'OpenClaw 正在返回文本，本地 TTS 播放中' : 'OpenClaw 正在返回文本，TTS 正在合成'
      );
      if (ttsProvider === 'browser') {
        enqueueBrowserTts(event.text);
      }
      log(`assistant.text.delta: ${event.text}`);
      break;

    case 'audio.output.delta':
      assistantReplyStarted = true;
      markAssistantActivity();
      suppressWakeForAssistant();
      if (ttsProvider === 'browser') {
        break;
      }
      setChannelLinkStatus('正在接收音频流');
      void player.enqueueBase64(event.data);
      break;

    case 'audio.output.completed':
      if (voiceState !== STATE.WAITING_ASSISTANT && voiceState !== STATE.TURN_COMMITTING) {
        log(`audio.output.completed ignored in state=${voiceState}`);
        break;
      }
      if (!assistantReplyStarted) {
        log('audio.output.completed ignored: no assistant delta in current turn');
        break;
      }
      assistantPendingComplete = true;
      markAssistantActivity();
      if (ttsProvider === 'browser') {
        flushBrowserTts();
      }
      scheduleAssistantSettleCheck();
      log('audio.output.completed');
      break;

    case 'channel.error':
    case 'session.error':
      setChannelLinkStatus('链路异常');
      setChannelLastError(`[${event.code}] ${event.message}`);
      log(`${event.type} [${event.code}] ${event.message}`);
      if (isConnected()) {
        resumeWakeAfterTurn('error');
      }
      break;

    case 'channel.ended':
    case 'session.ended':
      log(`channel.ended ${event.sessionId}`);
      sessionId = null;
      setChannelLinkStatus('会话已结束');
      setChannelSessionId('-');
      setVoiceState(STATE.DISCONNECTED, '会话已结束');
      refreshControls();
      break;

    default:
      log(`unknown event: ${JSON.stringify(event)}`);
  }
}

async function beginTurn(source, wakeKeyword = '') {
  if (!isConnected()) {
    return;
  }

  if (voiceState === STATE.CAPTURING_TURN || voiceState === STATE.TURN_COMMITTING) {
    return;
  }

  if (voiceState === STATE.WAITING_ASSISTANT) {
    log('当前仍在等待回复，忽略新的录音触发');
    return;
  }

  clearAssistantTimers();
  resetTurnBuffers();
  turnSource = source;
  turnStartedAt = Date.now();
  wakeCapturePrimingUntil = source === 'wake' ? Date.now() + WAKE_CAPTURE_PRIMING_MS : 0;

  if (source === 'wake') {
    log(`wake.detected keyword="${wakeKeyword || '-'}"`);
  } else if (source === 'ptt') {
    log('ptt.hold_start');
  }

  if (asrProvider === 'aliyun') {
    try {
      await startRecordingAudio();
    } catch (error) {
      log(`录音启动失败: ${toErrorMessage(error)}`);
      if (source === 'wake') {
        wakeModeEnabled = false;
        updateWakeToggleUi();
        writeStorage(STORAGE_KEYS.wakeEnabled, '0');
      }
      setVoiceState(STATE.MANUAL_READY, '录音不可用，请手动文本调试');
      refreshControls();
      return;
    }
  }

  const captureNote =
    source === 'wake' ? '已唤醒：请说话' : source === 'ptt' ? '空格按住说话中' : '手动录音中';
  const linkNote =
    source === 'wake' ? '唤醒成功，正在收音' : source === 'ptt' ? '空格按住说话中' : '手动录音中';
  setVoiceState(STATE.CAPTURING_TURN, captureNote);
  setChannelLinkStatus(linkNote);
  if (source === 'wake') {
    void playWakeChime();
  }

  startTurnMaxTimer();
  refreshControls();
}

async function commitTurn(options = { reason: 'silence', auto: true }) {
  const reason = options.reason ?? 'silence';
  const auto = options.auto !== false;

  if (voiceState !== STATE.CAPTURING_TURN) {
    return;
  }

  spaceTurnActive = false;
  clearTurnTimers();
  setVoiceState(STATE.TURN_COMMITTING, auto ? '自动提交中' : '手动提交中');

  const localText = buildTurnLocalText();

  if (asrProvider === 'browser') {
    if (!localText) {
      log('turn.auto_cancel_empty');
      resumeWakeAfterTurn('empty');
      return;
    }

    send({
      type: 'input.asr.local',
      text: localText,
      isFinal: true
    });

    pendingUserPrompt = localText;
    finalTranscriptEl.textContent = `服务端 ASR 结果：${localText}`;
    log(`turn.auto_commit source=${turnSource} reason=${reason} provider=browser text=${localText}`);

    setVoiceState(STATE.WAITING_ASSISTANT, '已提交用户文本，等待 OpenClaw 回复');
    assistantReplyStarted = false;
    setChannelLinkStatus('已自动提交，等待 OpenClaw 回复');
    suppressWakeForAssistant();
    armAssistantFallback();
    return;
  }

  await stopRecordingAudio();
  send({ type: 'input.audio.commit', reason: 'manual' });
  log(`turn.auto_commit source=${turnSource} reason=${reason} provider=aliyun`);

  setVoiceState(STATE.WAITING_ASSISTANT, '已提交音频，等待 OpenClaw 回复');
  assistantReplyStarted = false;
  setChannelLinkStatus('已自动提交音频，等待 OpenClaw 回复');
  suppressWakeForAssistant();
  armAssistantFallback();
}

function noteTurnSpeechActivity() {
  if (voiceState !== STATE.CAPTURING_TURN) {
    return;
  }
  // Push-to-talk should commit on key release, not by silence timer.
  if (turnSource === 'ptt') {
    return;
  }

  if (turnSilenceTimer) {
    clearTimeout(turnSilenceTimer);
  }

  turnSilenceTimer = window.setTimeout(() => {
    if (turnSource === 'wake' && turnStartedAt > 0) {
      const elapsed = Date.now() - turnStartedAt;
      if (elapsed < WAKE_MIN_CAPTURE_MS) {
        const remaining = WAKE_MIN_CAPTURE_MS - elapsed;
        turnSilenceTimer = window.setTimeout(() => {
          void commitTurn({ reason: 'silence', auto: true });
        }, remaining);
        log(`turn.silence_guard remaining=${remaining}ms`);
        return;
      }
    }
    void commitTurn({ reason: 'silence', auto: true });
  }, wakeSilenceMs);
}

function startTurnMaxTimer() {
  if (turnMaxTimer) {
    clearTimeout(turnMaxTimer);
  }

  const timeoutMs = turnSource === 'ptt' ? PTT_MAX_DURATION_MS : TURN_MAX_DURATION_MS;
  turnMaxTimer = window.setTimeout(() => {
    void commitTurn({ reason: turnSource === 'ptt' ? 'ptt_hard_limit' : 'max_duration', auto: true });
  }, timeoutMs);
}

function clearTurnTimers() {
  if (turnSilenceTimer) {
    clearTimeout(turnSilenceTimer);
    turnSilenceTimer = null;
  }
  if (turnMaxTimer) {
    clearTimeout(turnMaxTimer);
    turnMaxTimer = null;
  }
}

function resetTurnBuffers() {
  turnFinalText = '';
  turnInterimText = '';
  turnHasSpeech = false;
  turnSource = 'none';
  wakeCapturePrimingUntil = 0;
  turnStartedAt = 0;
}

function applyTurnTranscript(text, isFinal) {
  const cleaned = stripWakeWords(text).trim();
  if (!cleaned) {
    return;
  }

  turnHasSpeech = true;

  if (isFinal) {
    turnFinalText = mergeText(turnFinalText, cleaned);
    turnInterimText = '';
  } else {
    turnInterimText = cleaned;
  }

  const preview = `${turnFinalText}${turnInterimText}`.trim();
  setLiveTranscript(preview || '识别中...');
  noteTurnSpeechActivity();
}

function consumeTurnSegment(text, isFinal) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return;
  }

  if (Date.now() < wakeCapturePrimingUntil && isWakeResidual(raw)) {
    return;
  }

  applyTurnTranscript(raw, isFinal);
}

function isWakeResidual(text) {
  const normalized = normalizeForWake(text);
  if (!normalized) {
    return true;
  }

  for (const keyword of wakeWordsNormalized) {
    if (!keyword) {
      continue;
    }
    if (normalized.includes(keyword) || keyword.includes(normalized)) {
      return true;
    }
  }
  return false;
}

function buildTurnLocalText() {
  return `${turnFinalText}${turnInterimText}`.trim();
}

function markAssistantActivity() {
  assistantLastActivityAt = Date.now();
}

function armAssistantFallback() {
  if (assistantFallbackTimer) {
    clearTimeout(assistantFallbackTimer);
  }

  assistantFallbackTimer = window.setTimeout(() => {
    if (voiceState !== STATE.WAITING_ASSISTANT) {
      return;
    }
    log('assistant.wait_timeout');
    resumeWakeAfterTurn('timeout');
  }, ASSISTANT_FALLBACK_TIMEOUT_MS);
}

function clearAssistantTimers() {
  if (assistantSettleTimer) {
    clearTimeout(assistantSettleTimer);
    assistantSettleTimer = null;
  }
  if (assistantFallbackTimer) {
    clearTimeout(assistantFallbackTimer);
    assistantFallbackTimer = null;
  }
  assistantPendingComplete = false;
  assistantLastActivityAt = 0;
  assistantReplyStarted = false;
}

function scheduleAssistantSettleCheck() {
  if (!assistantPendingComplete) {
    return;
  }

  if (assistantSettleTimer) {
    clearTimeout(assistantSettleTimer);
  }

  assistantSettleTimer = window.setTimeout(() => {
    if (voiceState !== STATE.WAITING_ASSISTANT && voiceState !== STATE.TURN_COMMITTING) {
      assistantPendingComplete = false;
      return;
    }

    const elapsed = Date.now() - assistantLastActivityAt;
    if (elapsed < ASSISTANT_SETTLE_MS) {
      scheduleAssistantSettleCheck();
      return;
    }

    if (ttsProvider === 'browser' && (browserTtsSpeakingCount > 0 || browserTtsBuffer.trim())) {
      scheduleAssistantSettleCheck();
      return;
    }

    setChannelLinkStatus('当前音频段播放完成');
    resumeWakeAfterTurn('assistant_completed');
  }, ASSISTANT_SETTLE_MS);
}

function suppressWakeForAssistant() {
  wakeLockedByAssistant = true;
}

function resumeWakeAfterTurn(reason) {
  completeAssistantReply();
  clearTurnTimers();
  clearAssistantTimers();
  resetTurnBuffers();

  wakeLockedByAssistant = false;
  wakeSuppressedUntil = Date.now() + WAKE_RESUME_DELAY_MS;

  if (wakeModeEnabled) {
    setVoiceState(STATE.WAKE_IDLE, '待命：等待唤醒词');
    setLiveTranscript('（待命中，等待唤醒词）');
    restartWakeRecognition();
    log(`wake.resumed reason=${reason}`);
  } else {
    setVoiceState(STATE.MANUAL_READY, '唤醒模式关闭，可手动录音');
    setLiveTranscript('（手动模式，可点击手动开始）');
  }

  refreshControls();
}

function restartWakeRecognition() {
  if (!speechRecognition || !speechRecognitionActive) {
    return;
  }

  speechRecognitionRestarting = true;
  try {
    speechRecognition.stop();
  } catch {
    speechRecognitionRestarting = false;
    return;
  }

  window.setTimeout(() => {
    if (!speechRecognition || !speechRecognitionActive || speechRecognitionBlocked || !isConnected()) {
      speechRecognitionRestarting = false;
      return;
    }

    try {
      speechRecognition.start();
    } catch {
      // noop
    } finally {
      speechRecognitionRestarting = false;
    }
  }, 120);
}

function canDetectWakeWord() {
  if (!wakeModeEnabled) {
    return false;
  }
  if (voiceState !== STATE.WAKE_IDLE) {
    return false;
  }
  if (wakeLockedByAssistant) {
    return false;
  }
  if (Date.now() < wakeSuppressedUntil) {
    return false;
  }
  if (Date.now() - lastWakeDetectedAt < WAKE_RETRIGGER_GUARD_MS) {
    return false;
  }
  return true;
}

function ensureWakeRecognition() {
  if (!isConnected()) {
    return;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setLiveTranscript('当前浏览器不支持 SpeechRecognition，无法使用唤醒词');
    log('speech-debug unsupported');
    return;
  }

  if (speechRecognitionActive) {
    return;
  }

  speechRecognitionBlocked = false;
  speechRecognitionActive = true;
  speechRecognition = new Recognition();
  speechRecognition.lang = 'zh-CN';
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;

  speechRecognition.onresult = (event) => {
    let interim = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = String(event.results[i][0].transcript ?? '').trim();
      if (!transcript) {
        continue;
      }
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }

    if (voiceState === STATE.CAPTURING_TURN) {
      if (finalText) {
        consumeTurnSegment(finalText, true);
      }
      if (interim) {
        consumeTurnSegment(interim, false);
      }
      return;
    }

    const candidate = `${finalText}${interim}`.trim();
    if (candidate && canDetectWakeWord()) {
      const detected = findWakeKeyword(candidate);
      if (detected) {
        lastWakeDetectedAt = Date.now();
        void beginTurn('wake', detected);
        return;
      }
    }

    if (voiceState === STATE.WAKE_IDLE) {
      setLiveTranscript(interim ? `（待命识别）${interim}` : '（待命中，等待唤醒词）');
    }
  };

  speechRecognition.onerror = (event) => {
    const errorCode = String(event.error ?? 'unknown');
    log(`speech-debug error: ${errorCode}`);

    if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed' || errorCode === 'audio-capture') {
      speechRecognitionBlocked = true;
      wakeModeEnabled = false;
      updateWakeToggleUi();
      writeStorage(STORAGE_KEYS.wakeEnabled, '0');
      setVoiceState(STATE.MANUAL_READY, '麦克风权限不可用，请手动文本调试');
      setLiveTranscript('麦克风权限不可用，已关闭唤醒模式');
      refreshControls();
    }
  };

  speechRecognition.onend = () => {
    if (speechRecognitionRestarting) {
      return;
    }
    if (!speechRecognitionActive || speechRecognitionBlocked || !isConnected()) {
      return;
    }

    try {
      speechRecognition.start();
    } catch {
      // noop
    }
  };

  try {
    speechRecognition.start();
    log('speech-debug started');
  } catch {
    setLiveTranscript('语音识别启动失败，请检查麦克风权限');
    speechRecognitionActive = false;
  }
}

function stopWakeRecognition() {
  speechRecognitionActive = false;
  speechRecognitionRestarting = false;
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

function enqueueBrowserTts(delta) {
  if (ttsProvider !== 'browser') {
    return;
  }

  browserTtsBuffer += delta;

  const tail = delta.slice(-1);
  if (/[\n。！？!?；;，,.]/.test(tail) || browserTtsBuffer.length >= 42) {
    flushBrowserTts();
    return;
  }

  if (browserTtsFlushTimer) {
    clearTimeout(browserTtsFlushTimer);
  }

  browserTtsFlushTimer = window.setTimeout(() => {
    flushBrowserTts();
  }, 240);
}

function flushBrowserTts() {
  if (browserTtsFlushTimer) {
    clearTimeout(browserTtsFlushTimer);
    browserTtsFlushTimer = null;
  }

  if (ttsProvider !== 'browser') {
    browserTtsBuffer = '';
    return;
  }

  const text = browserTtsBuffer.trim();
  if (!text) {
    browserTtsBuffer = '';
    return;
  }

  browserTtsBuffer = '';
  speakBrowserText(text);
}

function speakBrowserText(text) {
  const synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
    if (!browserTtsUnsupportedLogged) {
      log('当前浏览器不支持 speechSynthesis，本地 TTS 不可用');
      browserTtsUnsupportedLogged = true;
    }
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.pitch = 1;

  browserTtsSpeakingCount += 1;

  utterance.onstart = () => {
    setChannelLinkStatus('本地 TTS 播放中');
  };

  utterance.onend = () => {
    browserTtsSpeakingCount = Math.max(0, browserTtsSpeakingCount - 1);
    scheduleAssistantSettleCheck();
  };

  utterance.onerror = () => {
    browserTtsSpeakingCount = Math.max(0, browserTtsSpeakingCount - 1);
    scheduleAssistantSettleCheck();
  };

  synth.speak(utterance);
}

function stopBrowserTts() {
  if (browserTtsFlushTimer) {
    clearTimeout(browserTtsFlushTimer);
    browserTtsFlushTimer = null;
  }

  browserTtsBuffer = '';
  browserTtsSpeakingCount = 0;

  const synth = window.speechSynthesis;
  if (synth) {
    synth.cancel();
  }
}

async function startRecordingAudio() {
  if (recordingMode) {
    return;
  }

  if (!navigator.mediaDevices) {
    throw new Error('当前浏览器不支持录音');
  }

  try {
    await startPcmRecording();
    recordingMode = 'pcm';
    log('开始录音并推送音频分片 (PCM 16-bit)');
  } catch (error) {
    log(`PCM 录音启动失败，降级为 MediaRecorder: ${toErrorMessage(error)}`);
    await startMediaRecorderRecording();
    recordingMode = 'webm';
    log('开始录音并推送音频分片 (WebM Opus)');
  }
}

async function stopRecordingAudio() {
  if (recordingMode === 'pcm') {
    stopPcmRecording();
  } else if (recordingMode === 'webm') {
    stopMediaRecorderRecording();
  }

  recordingMode = null;
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

function initWakeControls() {
  wakeWordsInput.value = wakeWordsRaw;
  silenceMsInput.value = String(wakeSilenceMs);
  updateWakeToggleUi();
  updatePttToggleUi();
  updateDeveloperModeUi();
  applyDeveloperMode();
}

function updateWakeToggleUi() {
  wakeToggleBtn.textContent = wakeModeEnabled ? '唤醒模式：开' : '唤醒模式：关';
}

function updatePttToggleUi() {
  pttToggleBtn.textContent = pushToTalkEnabled ? '空格按住说话：开' : '空格按住说话：关';
}

function updateDeveloperModeUi() {
  devModeToggleBtn.textContent = developerModeEnabled ? '开发模式：开' : '开发模式：关';
}

function applyDeveloperMode() {
  if (!debugPanelEl) {
    return;
  }
  debugPanelEl.hidden = !developerModeEnabled;
  if (!developerModeEnabled) {
    debugPanelEl.open = false;
  }
}

function updateWakeWords(rawValue) {
  const fallback = DEFAULT_WAKE_WORDS;
  const parsed = parseWakeWords(rawValue);
  wakeWords = parsed.length > 0 ? parsed : parseWakeWords(fallback);
  wakeWordsRaw = wakeWords.join(',');
  wakeWordsInput.value = wakeWordsRaw;
  wakeWordsNormalized = wakeWords.map((word) => normalizeForWake(word)).filter(Boolean);
  writeStorage(STORAGE_KEYS.wakeWords, wakeWordsRaw);
  log(`wake.words: ${wakeWordsRaw}`);
}

function setVoiceState(nextState, note) {
  voiceState = nextState;
  document.body.setAttribute('data-voice-state', nextState);

  let label = '未知';
  switch (nextState) {
    case STATE.DISCONNECTED:
      label = '未连接';
      break;
    case STATE.WAKE_IDLE:
      label = '待命（等待唤醒词）';
      break;
    case STATE.MANUAL_READY:
      label = '手动模式';
      break;
    case STATE.CAPTURING_TURN:
      label = '收音中';
      break;
    case STATE.TURN_COMMITTING:
      label = '提交中';
      break;
    case STATE.WAITING_ASSISTANT:
      label = '等待回复';
      break;
    default:
      label = nextState;
  }

  wakeStateEl.textContent = label;
  refreshControls();
}

function refreshControls() {
  const connected = isConnected();
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;

  speakBtn.disabled = !connected;
  wakeToggleBtn.disabled = !connected;
  pttToggleBtn.disabled = !connected;
  wakeWordsInput.disabled = !connected;
  silenceMsInput.disabled = !connected;

  if (!connected) {
    recordBtn.disabled = false;
    recordBtn.setAttribute('aria-disabled', 'true');
    recordBtn.classList.add('is-inactive');
    if (stopBtn) {
      stopBtn.disabled = true;
    }
    return;
  }

  const canManualStart = voiceState === STATE.WAKE_IDLE || voiceState === STATE.MANUAL_READY;
  const canStop = voiceState === STATE.CAPTURING_TURN;
  const canOrbToggle = canManualStart || canStop;

  recordBtn.disabled = false;
  recordBtn.setAttribute('aria-disabled', String(!canOrbToggle));
  recordBtn.classList.toggle('is-inactive', !canOrbToggle);
  if (stopBtn) {
    stopBtn.disabled = !canStop;
  }
}

function isConnected() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function isOrbInteractive() {
  if (!isConnected()) {
    return false;
  }
  return voiceState === STATE.WAKE_IDLE || voiceState === STATE.MANUAL_READY || voiceState === STATE.CAPTURING_TURN;
}

function status(text) {
  statusEl.textContent = text;
}

function setLiveTranscript(text) {
  liveTranscriptEl.textContent = text;
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
  if (!text || text === '-') {
    assistantStream = '';
    assistantReplies = [];
    assistantReplySerial = 0;
    pendingUserPrompt = '';
    renderAssistantReplies();
    return;
  }

  assistantStream = text;
  assistantReplySerial = 1;
  assistantReplies = [
    {
      id: 'assistant-1',
      index: 1,
      prompt: pendingUserPrompt,
      text,
      complete: true
    }
  ];
  pendingUserPrompt = '';
  renderAssistantReplies();
}

function appendAssistantStream(delta) {
  if (!delta) {
    return;
  }

  const reply = ensureAssistantReply();
  reply.text += delta;
  assistantStream = reply.text;
  renderAssistantReplies();
}

function ensureAssistantReply() {
  const latest = assistantReplies[assistantReplies.length - 1];
  if (latest && !latest.complete) {
    return latest;
  }

  assistantReplySerial += 1;
  const reply = {
    id: `assistant-${assistantReplySerial}`,
    index: assistantReplySerial,
    prompt: pendingUserPrompt,
    text: '',
    complete: false
  };

  assistantReplies.push(reply);
  pendingUserPrompt = '';
  if (assistantReplies.length > 16) {
    assistantReplies = assistantReplies.slice(-16);
  }
  return assistantReplies[assistantReplies.length - 1];
}

function completeAssistantReply() {
  const latest = assistantReplies[assistantReplies.length - 1];
  if (!latest || latest.complete) {
    return;
  }

  latest.complete = true;
  assistantStream = '';
  renderAssistantReplies();
}

function renderAssistantReplies() {
  if (!assistantReplies.length) {
    assistantStreamEl.innerHTML = `
      <article class="assistant-entry assistant-entry-empty">
        <p class="assistant-entry-label">等待回复</p>
        <p class="assistant-entry-body">OpenClaw 的回复会直接在这里铺开显示。</p>
      </article>
    `;
    return;
  }

  assistantStreamEl.innerHTML = assistantReplies
    .map((reply) => {
      const label = reply.complete ? `回复 ${String(reply.index).padStart(2, '0')}` : `回复 ${String(reply.index).padStart(2, '0')} · 生成中`;
      const promptMarkup = reply.prompt
        ? `
          <div class="assistant-entry-prompt">
            <p class="assistant-entry-prompt-label">你的输入</p>
            <p class="assistant-entry-prompt-body">${escapeHtml(reply.prompt)}</p>
          </div>
        `
        : '';
      return `
        <article class="assistant-entry${reply.complete ? '' : ' assistant-entry-current'}" data-reply-index="${reply.index}">
          ${promptMarkup}
          <p class="assistant-entry-label">${escapeHtml(label)}</p>
          <p class="assistant-entry-body">${escapeHtml(reply.text || '...')}</p>
        </article>
      `;
    })
    .join('');
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\n', '<br />');
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

function readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function readString(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.trim() ? raw : fallback;
  } catch {
    return fallback;
  }
}

function readNumber(key, fallback, min, max) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (!Number.isFinite(raw)) {
      return fallback;
    }
    return clampNumber(raw, min, max);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // noop
  }
}

function readDockPosition() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.dockPosition);
    if (!raw) {
      return { x: 0, y: 0 };
    }
    const parsed = JSON.parse(raw);
    const x = Number(parsed?.x);
    const y = Number(parsed?.y);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

function writeDockPosition() {
  writeStorage(STORAGE_KEYS.dockPosition, JSON.stringify(dockPosition));
}

function applyDockPosition() {
  if (!voiceDockEl) {
    return;
  }
  if (window.innerWidth <= 980) {
    voiceDockEl.style.removeProperty('--dock-offset-x');
    voiceDockEl.style.removeProperty('--dock-offset-y');
    return;
  }
  voiceDockEl.style.setProperty('--dock-offset-x', `${dockPosition.x}px`);
  voiceDockEl.style.setProperty('--dock-offset-y', `${dockPosition.y}px`);
}

function clampDockPosition(nextX, nextY) {
  if (!voiceDockEl || window.innerWidth <= 980) {
    return { x: 0, y: 0 };
  }

  const rect = voiceDockEl.getBoundingClientRect();
  const baseLeft = rect.left - dockPosition.x;
  const baseTop = rect.top - dockPosition.y;
  const minLeft = 12;
  const minTop = 72;
  const maxRight = window.innerWidth - 12;
  const maxBottom = window.innerHeight - 12;
  const minX = minLeft - baseLeft;
  const maxX = maxRight - (baseLeft + rect.width);
  const minY = minTop - baseTop;
  const maxY = maxBottom - (baseTop + rect.height);

  return {
    x: Math.min(maxX, Math.max(minX, nextX)),
    y: Math.min(maxY, Math.max(minY, nextY))
  };
}

function bindDockDrag() {
  if (!voiceDockEl || !recordBtn) {
    return;
  }

  window.addEventListener('resize', () => {
    dockPosition = clampDockPosition(dockPosition.x, dockPosition.y);
    applyDockPosition();
    writeDockPosition();
  });

  voiceDockEl.addEventListener('pointerdown', (event) => {
    if (window.innerWidth <= 980) {
      return;
    }
    if (!(event.target instanceof Node) || !recordBtn.contains(event.target)) {
      return;
    }
    if (isOrbInteractive()) {
      return;
    }

    dockDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: dockPosition.x,
      originY: dockPosition.y
    };
    voiceDockEl.setPointerCapture(event.pointerId);
    recordBtn.classList.add('is-dragging');
    event.preventDefault();
  });

  voiceDockEl.addEventListener('pointermove', (event) => {
    if (!dockDragState || dockDragState.pointerId !== event.pointerId) {
      return;
    }

    const next = clampDockPosition(
      dockDragState.originX + (event.clientX - dockDragState.startX),
      dockDragState.originY + (event.clientY - dockDragState.startY)
    );

    dockPosition = next;
    applyDockPosition();
  });

  const stopDrag = (event) => {
    if (!dockDragState || dockDragState.pointerId !== event.pointerId) {
      return;
    }
    dockPosition = clampDockPosition(dockPosition.x, dockPosition.y);
    applyDockPosition();
    writeDockPosition();
    recordBtn.classList.remove('is-dragging');
    if (voiceDockEl.hasPointerCapture(event.pointerId)) {
      voiceDockEl.releasePointerCapture(event.pointerId);
    }
    dockDragState = null;
  };

  voiceDockEl.addEventListener('pointerup', stopDrag);
  voiceDockEl.addEventListener('pointercancel', stopDrag);
}

function parseWakeWords(raw) {
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeForWake(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s`~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?，。！？；：、“”‘’（）【】《》·…—]/g, '');
}

function findWakeKeyword(text) {
  const normalized = normalizeForWake(text);
  if (!normalized) {
    return null;
  }

  for (let i = 0; i < wakeWordsNormalized.length; i += 1) {
    const keyword = wakeWordsNormalized[i];
    if (!keyword) {
      continue;
    }
    if (normalized.includes(keyword)) {
      return wakeWords[i] ?? null;
    }
  }

  return null;
}

function stripWakeWords(text) {
  let output = String(text ?? '');
  for (const keyword of wakeWords) {
    if (!keyword) {
      continue;
    }
    output = output.split(keyword).join(' ');
  }
  output = output.replace(/^[，。！？!?,;；:\s]+/, '');
  output = output.replace(/\s+/g, ' ');
  return output.trim();
}

function mergeText(base, next) {
  if (!base) {
    return next;
  }

  const prevChar = base.slice(-1);
  const nextChar = next.slice(0, 1);
  const needSpace = /[A-Za-z0-9]$/.test(prevChar) && /^[A-Za-z0-9]/.test(nextChar);
  return needSpace ? `${base} ${next}` : `${base}${next}`;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function canStartPushToTalkTurn() {
  if (!isConnected()) {
    return false;
  }
  if (!document.hasFocus()) {
    return false;
  }
  if (voiceState === STATE.WAITING_ASSISTANT || voiceState === STATE.TURN_COMMITTING) {
    return false;
  }
  return voiceState === STATE.WAKE_IDLE || voiceState === STATE.MANUAL_READY;
}

function shouldIgnoreSpaceShortcut(target) {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return false;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
    return true;
  }
  if (element.isContentEditable) {
    return true;
  }
  return Boolean(element.closest('[contenteditable="true"]'));
}

async function playWakeChime() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    if (!wakeChimeUnsupportedLogged) {
      log('wake.chime unavailable: AudioContext 不可用');
      wakeChimeUnsupportedLogged = true;
    }
    return;
  }

  try {
    if (!wakeChimeContext || wakeChimeContext.state === 'closed') {
      wakeChimeContext = new AudioCtx();
    }

    if (wakeChimeContext.state === 'suspended') {
      await wakeChimeContext.resume();
    }

    const ctx = wakeChimeContext;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);
    gain.connect(ctx.destination);

    const toneA = ctx.createOscillator();
    toneA.type = 'sine';
    toneA.frequency.setValueAtTime(880, now);
    toneA.connect(gain);
    toneA.start(now);
    toneA.stop(now + 0.08);

    const toneB = ctx.createOscillator();
    toneB.type = 'sine';
    toneB.frequency.setValueAtTime(1320, now + 0.085);
    toneB.connect(gain);
    toneB.start(now + 0.085);
    toneB.stop(now + 0.17);
  } catch (error) {
    log(`wake.chime failed: ${toErrorMessage(error)}`);
  }
}
