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
const wakeGreetingEl = document.getElementById('wakeGreeting');
const logEl = document.getElementById('log');
const liveTranscriptEl = document.getElementById('liveTranscript');
const finalTranscriptEl = document.getElementById('finalTranscript');
const channelLinkStatusEl = document.getElementById('channelLinkStatus');
const channelLastErrorEl = document.getElementById('channelLastError');
const assistantStreamEl = document.getElementById('assistantStream');
const lastServerEventEl = document.getElementById('lastServerEvent');

const player = new PcmAudioPlayer(24000);

const STORAGE_KEYS = {
  wakeEnabled: 'oc_voice_wake_enabled',
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
const ASSISTANT_SCROLL_PADDING_PX = 160;

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
let wakeWordsRaw = DEFAULT_WAKE_WORDS;
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
let assistantPlaybackActive = false;
let assistantPlaybackStopped = false;
let assistantAutoScrollFrame = 0;
let spacePressed = false;
let spaceTurnActive = false;

initWakeControls();
refreshControls();
setVoiceState(STATE.DISCONNECTED, '未连接');
status('点击连接');
setLiveTranscript('（连接后自动进入唤醒待命）');
applyDockPosition();
bindDockDrag();
void loadClientConfig();

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

assistantStreamEl.addEventListener('click', (event) => {
  const stopButton = event.target.closest('[data-stop-playback]');
  if (!stopButton) {
    return;
  }
  event.preventDefault();
  void stopAssistantPlayback('manual_stop');
});

if (stopBtn) {
  stopBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (stopBtn.disabled) {
      return;
    }
    void stopAssistantPlayback('manual_stop');
  });
}

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

  clearAssistantTimers();
  resetTurnBuffers();
  assistantPlaybackStopped = false;
  assistantPlaybackActive = false;
  void player.init().catch((error) => {
    log(`播放器预热失败: ${toErrorMessage(error)}`);
  });

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
      if (ttsProvider === 'browser' && !assistantPlaybackStopped) {
        assistantPlaybackActive = true;
        enqueueBrowserTts(event.text);
      }
      renderAssistantReplies();
      refreshControls();
      log(`assistant.text.delta: ${event.text}`);
      break;

    case 'audio.output.delta':
      assistantReplyStarted = true;
      markAssistantActivity();
      suppressWakeForAssistant();
      if (ttsProvider === 'browser') {
        break;
      }
      if (assistantPlaybackStopped) {
        break;
      }
      assistantPlaybackActive = true;
      setChannelLinkStatus('正在接收音频流');
      renderAssistantReplies();
      refreshControls();
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
  assistantPlaybackStopped = false;
  assistantPlaybackActive = false;
  void player.init().catch((error) => {
    log(`播放器预热失败: ${toErrorMessage(error)}`);
  });
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
  clearAssistantTimeouts();
  assistantPendingComplete = false;
  assistantLastActivityAt = 0;
  assistantReplyStarted = false;
  assistantPlaybackActive = false;
  assistantPlaybackStopped = false;
}

function clearAssistantTimeouts() {
  if (assistantSettleTimer) {
    clearTimeout(assistantSettleTimer);
    assistantSettleTimer = null;
  }
  if (assistantFallbackTimer) {
    clearTimeout(assistantFallbackTimer);
    assistantFallbackTimer = null;
  }
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
  stopWakeRecognition();
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
    ensureWakeRecognition();
    log(`wake.resumed reason=${reason}`);
  } else {
    setVoiceState(STATE.MANUAL_READY, '唤醒模式关闭，可手动录音');
    setLiveTranscript('（手动模式，可点击手动开始）');
    if (asrProvider === 'browser') {
      ensureWakeRecognition();
    }
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

async function stopAssistantPlayback(reason = 'manual_stop') {
  if (!assistantReplyStarted) {
    return;
  }

  if (isConnected()) {
    send({ type: 'tts.stop' });
  }

  assistantPlaybackStopped = true;
  assistantPlaybackActive = false;
  assistantPendingComplete = false;
  clearAssistantTimeouts();
  stopBrowserTts();
  await player.stop();
  setChannelLinkStatus('已停止当前语音播报');
  renderAssistantReplies();
  refreshControls();

  if (asrProvider === 'browser') {
    ensureWakeRecognition();
  }

  log(`assistant.playback_stopped reason=${reason}`);
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
  if (assistantPlaybackStopped) {
    return;
  }

  const sanitized = sanitizeTextForTts(delta);
  if (!sanitized) {
    return;
  }

  browserTtsBuffer += sanitized;

  const tail = sanitized.slice(-1);
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

  if (assistantPlaybackStopped) {
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
  if (assistantPlaybackStopped) {
    return;
  }

  const sanitized = sanitizeTextForTts(text);
  if (!sanitized) {
    return;
  }

  const synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
    if (!browserTtsUnsupportedLogged) {
      log('当前浏览器不支持 speechSynthesis，本地 TTS 不可用');
      browserTtsUnsupportedLogged = true;
    }
    return;
  }

  const utterance = new SpeechSynthesisUtterance(sanitized);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.pitch = 1;

  browserTtsSpeakingCount += 1;
  assistantPlaybackActive = true;

  utterance.onstart = () => {
    setChannelLinkStatus('本地 TTS 播放中');
  };

  utterance.onend = () => {
    browserTtsSpeakingCount = Math.max(0, browserTtsSpeakingCount - 1);
    assistantPlaybackActive = browserTtsSpeakingCount > 0 || Boolean(browserTtsBuffer.trim());
    scheduleAssistantSettleCheck();
  };

  utterance.onerror = () => {
    browserTtsSpeakingCount = Math.max(0, browserTtsSpeakingCount - 1);
    assistantPlaybackActive = browserTtsSpeakingCount > 0 || Boolean(browserTtsBuffer.trim());
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
  assistantPlaybackActive = false;

  const synth = window.speechSynthesis;
  if (synth) {
    synth.cancel();
  }
}

function sanitizeTextForTts(text) {
  const cleaned = String(text ?? '')
    .replace(/[`#*_~|><]/g, ' ')
    .replace(/(^|[\s([{'"“”‘’])[-_]{1,6}(?=$|[\s)\]}'"“”‘’])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  const semantic = cleaned.replace(/[.,!?;:，。！？；：、…\s\-_/\\()[\]{}'"“”‘’]/g, '');
  if (!semantic) {
    return '';
  }

  return cleaned;
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
  wakeWordsInput.readOnly = true;
  silenceMsInput.value = String(wakeSilenceMs);
  updateWakeToggleUi();
  updatePttToggleUi();
  updateDeveloperModeUi();
  applyDeveloperMode();
}

function updateWakeToggleUi() {
  wakeToggleBtn.textContent = wakeModeEnabled ? '唤醒模式：开' : '唤醒模式：关';
  updateWakeGreetingUi();
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
  updateWakeGreetingUi();
  log(`wake.words: ${wakeWordsRaw}`);
}

function updateWakeGreetingUi() {
  if (!wakeGreetingEl) {
    return;
  }
  const primaryWakeWord = wakeWords[0] || DEFAULT_WAKE_WORDS;
  wakeGreetingEl.textContent = `嗨，我是「${primaryWakeWord}」，想要做点什么？`;
  wakeGreetingEl.hidden = !wakeModeEnabled;
}

async function loadClientConfig() {
  try {
    const response = await fetch('/client-config.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const config = await response.json();
    if (Array.isArray(config?.wakeWords)) {
      updateWakeWords(config.wakeWords.join(','));
      return;
    }
  } catch (error) {
    log(`client.config fallback: ${toErrorMessage(error)}`);
  }

  updateWakeWords(DEFAULT_WAKE_WORDS);
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
      stopBtn.hidden = true;
      stopBtn.disabled = true;
    }
    return;
  }

  const canManualStart = voiceState === STATE.WAKE_IDLE || voiceState === STATE.MANUAL_READY;
  const canStop = voiceState === STATE.CAPTURING_TURN;
  const canOrbToggle = canManualStart || canStop;
  const canStopPlayback = canStopCurrentPlayback();

  recordBtn.disabled = false;
  recordBtn.setAttribute('aria-disabled', String(!canOrbToggle));
  recordBtn.classList.toggle('is-inactive', !canOrbToggle);
  if (stopBtn) {
    stopBtn.hidden = !canStopPlayback;
    stopBtn.disabled = !canStopPlayback;
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
  scheduleAssistantAutoScroll('smooth');
}

function appendAssistantStream(delta) {
  if (!delta) {
    return;
  }

  const reply = ensureAssistantReply();
  reply.text += delta;
  assistantStream = reply.text;
  renderAssistantReplies();
  scheduleAssistantAutoScroll();
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
  scheduleAssistantAutoScroll();
}

function renderAssistantReplies() {
  if (!assistantReplies.length) {
    assistantStreamEl.innerHTML = `
      <article class="assistant-entry assistant-entry-empty">
        <p class="assistant-entry-label">等待回复</p>
        <div class="assistant-entry-body markdown-body"><p>OpenClaw 的回复会直接在这里铺开显示。</p></div>
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
          <div class="assistant-entry-head">
            <p class="assistant-entry-label">${escapeHtml(label)}</p>
          </div>
          <div class="assistant-entry-body markdown-body">${renderMarkdown(reply.text || '...')}</div>
        </article>
      `;
    })
    .join('');
}

function scheduleAssistantAutoScroll(behavior = 'auto') {
  if (assistantAutoScrollFrame) {
    cancelAnimationFrame(assistantAutoScrollFrame);
  }

  assistantAutoScrollFrame = requestAnimationFrame(() => {
    assistantAutoScrollFrame = 0;
    const latest = assistantStreamEl.querySelector('.assistant-entry:last-of-type');
    if (!latest) {
      return;
    }

    const rect = latest.getBoundingClientRect();
    const targetTop =
      window.scrollY + rect.bottom - window.innerHeight + ASSISTANT_SCROLL_PADDING_PX;

    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior
    });
  });
}

function canStopReplyPlayback(reply) {
  if (assistantPlaybackStopped) {
    return false;
  }
  if (!assistantReplyStarted) {
    return false;
  }
  const latest = assistantReplies[assistantReplies.length - 1];
  if (!latest || latest.id !== reply.id) {
    return false;
  }
  return assistantPlaybackActive;
}

function canStopCurrentPlayback() {
  return assistantReplies.some((reply) => canStopReplyPlayback(reply));
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

function escapeHtmlInline(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttr(text) {
  return escapeHtmlInline(text);
}

function renderMarkdown(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return '<p>...</p>';
  }

  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks.map(renderMarkdownBlock).join('');
}

function renderMarkdownBlock(block) {
  const codeMatch = block.match(/^```([\w-]+)?\n([\s\S]*?)\n```$/);
  if (codeMatch) {
    const language = codeMatch[1] ? `<span class="md-code-lang">${escapeHtmlInline(codeMatch[1])}</span>` : '';
    return `<pre class="md-code-block">${language}<code>${escapeHtmlInline(codeMatch[2])}</code></pre>`;
  }

  const headingMatch = block.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = Math.min(6, headingMatch[1].length);
    return `<h${level}>${renderMarkdownInline(headingMatch[2])}</h${level}>`;
  }

  const quoteLines = block.split('\n');
  if (quoteLines.every((line) => /^\s*>\s?/.test(line))) {
    const quoted = quoteLines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
    return `<blockquote>${renderMarkdown(quoted)}</blockquote>`;
  }

  if (isMarkdownTable(block)) {
    return renderMarkdownTable(block);
  }

  if (isMarkdownListBlock(block)) {
    return renderMarkdownList(block);
  }

  return `<p>${renderMarkdownInline(block).replace(/\n/g, '<br />')}</p>`;
}

function isMarkdownTable(block) {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return false;
  }
  return /^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(lines[1]);
}

function renderMarkdownTable(block) {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = splitMarkdownTableRow(lines[0]);
  const alignments = splitMarkdownTableRow(lines[1]).map(parseMarkdownTableAlignment);
  const bodyRows = lines.slice(2).map(splitMarkdownTableRow);

  const headerHtml = header
    .map((cell, index) => `<th${markdownTableAlignAttr(alignments[index])}>${renderMarkdownInline(cell)}</th>`)
    .join('');
  const bodyHtml = bodyRows
    .map((row) => {
      const cells = header.map((_, index) => row[index] ?? '');
      const cellsHtml = cells
        .map((cell, index) => `<td${markdownTableAlignAttr(alignments[index])}>${renderMarkdownInline(cell)}</td>`)
        .join('');
      return `<tr>${cellsHtml}</tr>`;
    })
    .join('');

  return `
    <div class="md-table-wrap">
      <table class="md-table">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  `;
}

function splitMarkdownTableRow(line) {
  const normalized = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split('|').map((cell) => cell.trim());
}

function parseMarkdownTableAlignment(cell) {
  const trimmed = String(cell).trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) {
    return 'center';
  }
  if (right) {
    return 'right';
  }
  if (left) {
    return 'left';
  }
  return '';
}

function markdownTableAlignAttr(alignment) {
  return alignment ? ` style="text-align:${alignment}"` : '';
}

function isMarkdownListBlock(block) {
  const lines = block.split('\n').filter((line) => line.trim());
  if (!lines.length) {
    return false;
  }
  return lines.every((line) => {
    if (/^\s{4,}/.test(line)) {
      return false;
    }
    return /^\s*(?:[-*+]|\d+\.)\s+/.test(line) || /^\s*[-*+]\s+\[(?: |x|X)\]\s+/.test(line);
  });
}

function renderMarkdownList(block) {
  const items = block
    .split('\n')
    .map(parseMarkdownListLine)
    .filter(Boolean);

  if (!items.length) {
    return `<p>${renderMarkdownInline(block).replace(/\n/g, '<br />')}</p>`;
  }

  const root = [];
  const stack = [{ indent: -1, children: root }];

  for (const item of items) {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const node = { ...item, children: [] };
    parent.children.push(node);
    stack.push({ indent: item.indent, children: node.children });
  }

  return renderMarkdownListNodes(root);
}

function parseMarkdownListLine(line) {
  const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(\[(?: |x|X)\]\s+)?(.+)$/);
  if (!match) {
    return null;
  }

  return {
    indent: Math.floor(match[1].replace(/\t/g, '    ').length / 2),
    ordered: /\d+\./.test(match[2]),
    checked: match[3] ? /x|X/.test(match[3]) : null,
    text: match[4].trim()
  };
}

function renderMarkdownListNodes(nodes) {
  if (!nodes.length) {
    return '';
  }

  let html = '';
  let index = 0;
  while (index < nodes.length) {
    const ordered = nodes[index].ordered;
    const group = [];
    while (index < nodes.length && nodes[index].ordered === ordered) {
      group.push(nodes[index]);
      index += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    const className = group.some((item) => item.checked !== null) ? ' class="md-task-list"' : '';
    const itemsHtml = group
      .map((item) => {
        const checkbox =
          item.checked === null
            ? ''
            : `<span class="md-task-checkbox${item.checked ? ' is-checked' : ''}" aria-hidden="true"></span>`;
        const children = renderMarkdownListNodes(item.children);
        return `<li${item.checked !== null ? ' class="md-task-item"' : ''}>${checkbox}<span>${renderMarkdownInline(item.text)}</span>${children}</li>`;
      })
      .join('');
    html += `<${tag}${className}>${itemsHtml}</${tag}>`;
  }
  return html;
}

function renderMarkdownInline(text) {
  let working = String(text ?? '');
  const tokens = [];

  const stash = (html) => {
    const token = `@@MD_TOKEN_${tokens.length}@@`;
    tokens.push({ token, html });
    return token;
  };

  working = working.replace(/`([^`\n]+)`/g, (_match, code) => {
    return stash(`<code>${escapeHtmlInline(code)}</code>`);
  });

  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, rawUrl) => {
    const safeUrl = sanitizeMarkdownUrl(rawUrl);
    if (!safeUrl) {
      return escapeHtmlInline(label);
    }
    return stash(
      `<a href="${escapeHtmlAttr(safeUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtmlInline(label)}</a>`
    );
  });

  working = escapeHtmlInline(working);
  working = working.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  working = working.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  working = working.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  working = working.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  working = working.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  for (const { token, html } of tokens) {
    working = working.replaceAll(token, html);
  }

  return working;
}

function sanitizeMarkdownUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.toString();
    }
  } catch {
    return '';
  }
  return '';
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
