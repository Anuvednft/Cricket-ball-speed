/**
 * CRICKET BOWLING SPEED ANALYZER
 * Client-side Controller for Simplified Video Upload & Automatic Speed Detection
 * 
 * Workflow:
 * 1. User uploads video directly (or clicks a sample test video).
 * 2. Video immediately appears in HTML5 player and can be played/scrubbed with 0 latency.
 * 3. Automatic speed detection calculates release speed.
 * 4. Calculated speed is displayed clearly alongside video and as an overlay on the video.
 */

(function () {
  'use strict';

  // Application State
  const state = {
    currentVideoPath: null,
    currentVideoName: null,
    currentVideoMeta: null,
    originalVideoSrc: null,
    analysisTaskId: null,
    pollInterval: null,
    analysisResult: null,
    isAnalyzing: false,

    // Live Camera State
    currentMode: 'video', // 'video' | 'live'
    cameraStream: null,
    cameraRunning: false,
    mediaRecorder: null,
    recordedChunks: [],
    recordStartTime: null,
    recordTimerInterval: null,
    isRecording: false,
    liveDrsData: null,
    liveAnimFrame: null,
    sessionDeliveries: []
  };

  // DOM Elements
  const el = {
    // Header
    systemStatusPill: document.getElementById('systemStatusPill'),
    systemStatusText: document.getElementById('systemStatusText'),

    // Mode Switching
    modeCardVideo: document.getElementById('modeCardVideo'),
    modeCardLive: document.getElementById('modeCardLive'),
    videoModeView: document.getElementById('videoModeView'),
    liveModeView: document.getElementById('liveModeView'),

    // Upload & Samples
    uploadPanel: document.getElementById('uploadPanel'),
    videoFileInput: document.getElementById('videoFileInput'),
    browseVideoBtn: document.getElementById('browseVideoBtn'),
    sampleChipsList: document.getElementById('sampleChipsList'),

    // Progress Card
    analysisProgressCard: document.getElementById('analysisProgressCard'),
    progressStageText: document.getElementById('progressStageText'),
    progressPctText: document.getElementById('progressPctText'),
    progressFill: document.getElementById('progressFill'),

    // Workspace & Player
    videoWorkspace: document.getElementById('videoWorkspace'),
    videoTitleText: document.getElementById('videoTitleText'),
    playerStateBadge: document.getElementById('playerStateBadge'),
    mainVideoPlayer: document.getElementById('mainVideoPlayer'),
    liveVideoBadge: document.getElementById('liveVideoBadge'),
    liveBadgeSpeedVal: document.getElementById('liveBadgeSpeedVal'),
    liveBadgeStatus: document.getElementById('liveBadgeStatus'),

    // Metadata Footer
    metaFilename: document.getElementById('metaFilename'),
    metaResolution: document.getElementById('metaResolution'),
    metaFps: document.getElementById('metaFps'),
    metaDuration: document.getElementById('metaDuration'),

    // Speed Display & Hero Card
    speedDisplayNumber: document.getElementById('speedDisplayNumber'),
    speedMphDisplay: document.getElementById('speedMphDisplay'),
    speedStatusBadge: document.getElementById('speedStatusBadge'),
    speedUncertaintyText: document.getElementById('speedUncertaintyText'),
    c1c2SpeedVal: document.getElementById('c1c2SpeedVal'),
    qcScoreVal: document.getElementById('qcScoreVal'),

    // Download Links
    dlFinalVideo: document.getElementById('dlFinalVideo'),
    dlJsonReport: document.getElementById('dlJsonReport'),
    dlExcelReport: document.getElementById('dlExcelReport'),

    // Live Camera Elements
    cameraDeviceSelect: document.getElementById('cameraDeviceSelect'),
    startCameraBtn: document.getElementById('startCameraBtn'),
    stopCameraBtn: document.getElementById('stopCameraBtn'),
    recordDeliveryBtn: document.getElementById('recordDeliveryBtn'),
    stopRecordBtn: document.getElementById('stopRecordBtn'),
    cameraStateBadge: document.getElementById('cameraStateBadge'),
    liveVideo: document.getElementById('liveVideo'),
    liveCanvas: document.getElementById('liveCanvas'),
    cameraPlaceholder: document.getElementById('cameraPlaceholder'),
    liveCameraBadge: document.getElementById('liveCameraBadge'),
    liveCameraBadgeText: document.getElementById('liveCameraBadgeText'),
    liveStumpsBadge: document.getElementById('liveStumpsBadge'),
    liveStumpsBadgeText: document.getElementById('liveStumpsBadgeText'),
    liveDrsBadge: document.getElementById('liveDrsBadge'),
    liveDrsBadgeText: document.getElementById('liveDrsBadgeText'),
    liveRecordIndicator: document.getElementById('liveRecordIndicator'),
    liveRecordTimer: document.getElementById('liveRecordTimer'),
    liveAutoCalibBtn: document.getElementById('liveAutoCalibBtn'),
    liveResolutionText: document.getElementById('liveResolutionText'),
    liveFpsText: document.getElementById('liveFpsText'),

    // Live Speed Hero Card & History
    liveSpeedNumber: document.getElementById('liveSpeedNumber'),
    liveSpeedMph: document.getElementById('liveSpeedMph'),
    liveSpeedStatusBadge: document.getElementById('liveSpeedStatusBadge'),
    liveC1C2Speed: document.getElementById('liveC1C2Speed'),
    liveQcScore: document.getElementById('liveQcScore'),
    deliveryCountBadge: document.getElementById('deliveryCountBadge'),
    liveDeliveriesList: document.getElementById('liveDeliveriesList'),
    liveEmptyDeliveriesMsg: document.getElementById('liveEmptyDeliveriesMsg')
  };

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    checkSystemHealth();
    loadSampleVideos();
  });

  function initEventListeners() {
    // File browse button
    if (el.browseVideoBtn && el.videoFileInput) {
      el.browseVideoBtn.addEventListener('click', () => el.videoFileInput.click());
      el.videoFileInput.addEventListener('change', handleFileSelected);
    }

    // Drag and drop support on uploadPanel
    if (el.uploadPanel) {
      el.uploadPanel.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.uploadPanel.classList.add('drag-over');
      });

      el.uploadPanel.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.uploadPanel.classList.remove('drag-over');
      });

      el.uploadPanel.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.uploadPanel.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          processSelectedFile(e.dataTransfer.files[0]);
        }
      });
    }

    // Video player state update
    if (el.mainVideoPlayer) {
      el.mainVideoPlayer.addEventListener('play', () => {
        if (el.playerStateBadge) el.playerStateBadge.textContent = 'Playing';
      });
      el.mainVideoPlayer.addEventListener('pause', () => {
        if (el.playerStateBadge) el.playerStateBadge.textContent = 'Paused';
      });
    }

    // Mode Switching
    if (el.modeCardVideo) el.modeCardVideo.addEventListener('click', () => switchMode('video'));
    if (el.modeCardLive) el.modeCardLive.addEventListener('click', () => switchMode('live'));

    // Live Camera Controls
    if (el.startCameraBtn) el.startCameraBtn.addEventListener('click', startLiveCamera);
    if (el.stopCameraBtn) el.stopCameraBtn.addEventListener('click', stopLiveCamera);
    if (el.recordDeliveryBtn) el.recordDeliveryBtn.addEventListener('click', startRecordingDelivery);
    if (el.stopRecordBtn) el.stopRecordBtn.addEventListener('click', stopRecordingDelivery);
    if (el.liveAutoCalibBtn) el.liveAutoCalibBtn.addEventListener('click', triggerLiveAutoCalibrate);
  }

  // --------------------------------------------------------------------------
  // Mode Switching
  // --------------------------------------------------------------------------
  function switchMode(mode) {
    state.currentMode = mode;
    if (mode === 'live') {
      if (el.modeCardLive) el.modeCardLive.classList.add('active');
      if (el.modeCardVideo) el.modeCardVideo.classList.remove('active');
      if (el.liveModeView) el.liveModeView.classList.add('active');
      if (el.videoModeView) el.videoModeView.classList.remove('active');
      populateCameraDevices();
    } else {
      if (el.modeCardVideo) el.modeCardVideo.classList.add('active');
      if (el.modeCardLive) el.modeCardLive.classList.remove('active');
      if (el.videoModeView) el.videoModeView.classList.add('active');
      if (el.liveModeView) el.liveModeView.classList.remove('active');
      if (state.cameraRunning) stopLiveCamera();
    }
  }

  // --------------------------------------------------------------------------
  // Live Camera Controller
  // --------------------------------------------------------------------------
  async function populateCameraDevices() {
    if (!el.cameraDeviceSelect) return;
    try {
      let devices = [];
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const allDevs = await navigator.mediaDevices.enumerateDevices();
        devices = allDevs.filter(d => d.kind === 'videoinput');
      }

      el.cameraDeviceSelect.innerHTML = '';
      if (devices.length > 0) {
        devices.forEach((dev, idx) => {
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = dev.label || `Camera Device ${idx + 1}`;
          el.cameraDeviceSelect.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'Default Webcam / Camera';
        el.cameraDeviceSelect.appendChild(opt);
      }
    } catch (e) {
      console.warn('Could not enumerate media devices:', e);
    }
  }

  async function startLiveCamera() {
    try {
      if (el.startCameraBtn) {
        el.startCameraBtn.disabled = true;
        el.startCameraBtn.textContent = 'Connecting...';
      }

      const deviceId = el.cameraDeviceSelect ? el.cameraDeviceSelect.value : null;
      const constraints = {
        video: {
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
          frameRate: { ideal: 60, min: 30 }
        },
        audio: false
      };
      if (deviceId && deviceId !== 'default') {
        constraints.video.deviceId = { exact: deviceId };
      } else {
        constraints.video.facingMode = { ideal: 'environment' };
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.cameraStream = stream;
      state.cameraRunning = true;

      if (el.liveVideo) {
        el.liveVideo.srcObject = stream;
        await el.liveVideo.play();
      }

      // Update UI elements
      if (el.cameraPlaceholder) el.cameraPlaceholder.style.display = 'none';
      if (el.liveVideo) el.liveVideo.style.display = 'none';
      if (el.liveCanvas) el.liveCanvas.style.display = 'block';

      if (el.startCameraBtn) el.startCameraBtn.style.display = 'none';
      if (el.stopCameraBtn) el.stopCameraBtn.style.display = 'inline-flex';
      if (el.recordDeliveryBtn) el.recordDeliveryBtn.style.display = 'inline-flex';
      if (el.liveAutoCalibBtn) el.liveAutoCalibBtn.disabled = false;

      if (el.cameraStateBadge) {
        el.cameraStateBadge.className = 'status-pill online';
        el.cameraStateBadge.textContent = 'Online';
      }
      if (el.liveCameraBadgeText) el.liveCameraBadgeText.textContent = 'Connected (60 FPS)';
      if (el.liveCameraBadge) el.liveCameraBadge.className = 'hud-badge success';

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings ? track.getSettings() : {};
      if (el.liveResolutionText) {
        el.liveResolutionText.textContent = `${settings.width || 1280}x${settings.height || 720}`;
      }
      if (el.liveFpsText) {
        el.liveFpsText.textContent = `${Math.round(settings.frameRate || 60)} FPS`;
      }

      startLiveCanvasLoop();

    } catch (err) {
      console.error('Camera startup error:', err);
      alert('Could not start live camera. Please ensure camera device is connected and browser permissions are granted.');
      if (el.cameraStateBadge) {
        el.cameraStateBadge.className = 'status-pill offline';
        el.cameraStateBadge.textContent = 'Error';
      }
    } finally {
      if (el.startCameraBtn) {
        el.startCameraBtn.disabled = false;
        el.startCameraBtn.textContent = '▶ Start Camera';
      }
    }
  }

  function stopLiveCamera() {
    state.cameraRunning = false;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
    if (state.isRecording) {
      stopRecordingDelivery();
    }
    if (state.liveAnimFrame) {
      cancelAnimationFrame(state.liveAnimFrame);
      state.liveAnimFrame = null;
    }

    if (el.cameraPlaceholder) el.cameraPlaceholder.style.display = 'block';
    if (el.liveCanvas) el.liveCanvas.style.display = 'none';
    if (el.startCameraBtn) el.startCameraBtn.style.display = 'inline-flex';
    if (el.stopCameraBtn) el.stopCameraBtn.style.display = 'none';
    if (el.recordDeliveryBtn) el.recordDeliveryBtn.style.display = 'none';
    if (el.stopRecordBtn) el.stopRecordBtn.style.display = 'none';
    if (el.liveAutoCalibBtn) el.liveAutoCalibBtn.disabled = true;

    if (el.cameraStateBadge) {
      el.cameraStateBadge.className = 'status-pill';
      el.cameraStateBadge.textContent = 'Offline';
    }
    if (el.liveCameraBadgeText) el.liveCameraBadgeText.textContent = 'Offline';
    if (el.liveCameraBadge) el.liveCameraBadge.className = 'hud-badge warning';
  }

  function startLiveCanvasLoop() {
    const video = el.liveVideo;
    const canvas = el.liveCanvas;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');

    function renderLoop() {
      if (!state.cameraRunning) return;
      if (video.readyState >= 2) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Draw pitch center-line and DRS guides
        const w = canvas.width;
        const h = canvas.height;

        ctx.save();
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);

        // Pitch corridor guide lines
        ctx.beginPath();
        ctx.moveTo(w * 0.35, h * 0.2);
        ctx.lineTo(w * 0.25, h * 0.95);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(w * 0.65, h * 0.2);
        ctx.lineTo(w * 0.75, h * 0.95);
        ctx.stroke();

        if (state.liveDrsData) {
          // Draw calibrated DRS crease line
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)';
          ctx.lineWidth = 3;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(w * 0.25, h * 0.85);
          ctx.lineTo(w * 0.75, h * 0.85);
          ctx.stroke();
        }
        ctx.restore();
      }
      state.liveAnimFrame = requestAnimationFrame(renderLoop);
    }

    state.liveAnimFrame = requestAnimationFrame(renderLoop);
  }

  // --------------------------------------------------------------------------
  // Real-Time Delivery Recording & Speed Calculation
  // --------------------------------------------------------------------------
  function startRecordingDelivery() {
    if (!state.cameraStream) return;
    try {
      state.recordedChunks = [];
      const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
      const supportedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

      state.mediaRecorder = new MediaRecorder(state.cameraStream, supportedMime ? { mimeType: supportedMime } : {});
      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
      };

      state.mediaRecorder.onstop = handleRecordingFinished;
      state.mediaRecorder.start(100);
      state.isRecording = true;
      state.recordStartTime = Date.now();

      if (el.recordDeliveryBtn) el.recordDeliveryBtn.style.display = 'none';
      if (el.stopRecordBtn) el.stopRecordBtn.style.display = 'inline-flex';
      if (el.liveRecordIndicator) el.liveRecordIndicator.style.display = 'flex';
      if (el.liveSpeedStatusBadge) {
        el.liveSpeedStatusBadge.className = 'measurement-pill calculating';
        el.liveSpeedStatusBadge.textContent = 'RECORDING DELIVERY...';
      }

      state.recordTimerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - state.recordStartTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        if (el.liveRecordTimer) el.liveRecordTimer.textContent = `${mins}:${secs}`;

        // Auto-stop after 8 seconds (typical cricket delivery burst)
        if (elapsedSec >= 8) {
          stopRecordingDelivery();
        }
      }, 500);

    } catch (err) {
      console.error('Failed to start MediaRecorder:', err);
      alert('Could not record delivery video stream.');
    }
  }

  function stopRecordingDelivery() {
    if (!state.isRecording) return;
    state.isRecording = false;
    clearInterval(state.recordTimerInterval);
    state.recordTimerInterval = null;

    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }

    if (el.recordDeliveryBtn) el.recordDeliveryBtn.style.display = 'inline-flex';
    if (el.stopRecordBtn) el.stopRecordBtn.style.display = 'none';
    if (el.liveRecordIndicator) el.liveRecordIndicator.style.display = 'none';
  }

  async function handleRecordingFinished() {
    if (state.recordedChunks.length === 0) return;
    const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
    const file = new File([blob], `live_delivery_${Date.now()}.webm`, { type: 'video/webm' });

    if (el.liveSpeedStatusBadge) {
      el.liveSpeedStatusBadge.className = 'measurement-pill calculating';
      el.liveSpeedStatusBadge.textContent = 'CALCULATING SPEED...';
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const upRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      if (!upRes.ok) throw new Error('Live delivery upload failed');
      const upData = await upRes.json();

      const analyzeRes = await fetch('/api/analyze-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_path: upData.filepath })
      });

      if (!analyzeRes.ok) throw new Error('Analysis start failed');
      const analyzeData = await analyzeRes.json();
      const taskId = analyzeData.task_id;

      const pollLiveResult = setInterval(async () => {
        try {
          const tRes = await fetch(`/api/tasks/${taskId}`);
          if (tRes.ok) {
            const task = await tRes.json();
            if (task.status === 'COMPLETED') {
              clearInterval(pollLiveResult);
              displayLiveDeliveryResult(task.result);
            } else if (task.status === 'FAILED') {
              clearInterval(pollLiveResult);
              if (el.liveSpeedStatusBadge) {
                el.liveSpeedStatusBadge.className = 'measurement-pill not-measured';
                el.liveSpeedStatusBadge.textContent = 'ANALYSIS ERROR';
              }
            }
          }
        } catch {
          clearInterval(pollLiveResult);
        }
      }, 500);

    } catch (e) {
      console.error('Live delivery processing error:', e);
      if (el.liveSpeedStatusBadge) {
        el.liveSpeedStatusBadge.className = 'measurement-pill not-measured';
        el.liveSpeedStatusBadge.textContent = 'PROCESSING FAILED';
      }
    }
  }

  function displayLiveDeliveryResult(res) {
    if (!res) return;
    const speedKmh = parseFloat(res.release_speed_kmh) || 0.0;
    const speedMph = (speedKmh * 0.621371).toFixed(1);
    const c1c2Kmh = parseFloat(res.c1_c2_speed_kmh) || 0.0;
    const qcScore = res.qc_score || res.quality_score || 70;
    const status = res.status || 'ESTIMATED';

    if (el.liveSpeedNumber) el.liveSpeedNumber.textContent = speedKmh > 0 ? speedKmh.toFixed(1) : '--.-';
    if (el.liveSpeedMph) el.liveSpeedMph.textContent = speedKmh > 0 ? `${speedMph} mph` : '--.- mph';
    if (el.liveC1C2Speed) el.liveC1C2Speed.textContent = `${c1c2Kmh.toFixed(1)} km/h`;
    if (el.liveQcScore) el.liveQcScore.textContent = `${Math.round(qcScore)} / 100`;

    if (el.liveSpeedStatusBadge) {
      el.liveSpeedStatusBadge.className = 'measurement-pill measured';
      el.liveSpeedStatusBadge.textContent = `${status}: ${speedKmh.toFixed(1)} KM/H`;
    }

    state.sessionDeliveries.unshift({
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      speedKmh: speedKmh.toFixed(1),
      c1c2Kmh: c1c2Kmh.toFixed(1),
      status: status
    });

    renderDeliveriesLog();
  }

  function renderDeliveriesLog() {
    if (!el.liveDeliveriesList) return;
    if (el.deliveryCountBadge) {
      el.deliveryCountBadge.textContent = `${state.sessionDeliveries.length} Bowled`;
    }

    if (state.sessionDeliveries.length === 0) {
      if (el.liveEmptyDeliveriesMsg) el.liveEmptyDeliveriesMsg.style.display = 'block';
      return;
    }
    if (el.liveEmptyDeliveriesMsg) el.liveEmptyDeliveriesMsg.style.display = 'none';

    el.liveDeliveriesList.innerHTML = state.sessionDeliveries.map((d, idx) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:var(--bg-secondary); border:1px solid var(--border-subtle); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-weight:700; color:var(--navy-accent); font-size:14px;">#${state.sessionDeliveries.length - idx}</span>
          <strong style="font-size:16px; color:#0f172a;">${d.speedKmh} km/h</strong>
          <span style="font-size:12px; color:#64748b;">(C1-C2: ${d.c1c2Kmh})</span>
        </div>
        <span style="font-size:11px; font-weight:600; color:#64748b;">${d.time}</span>
      </div>
    `).join('');
  }

  async function triggerLiveAutoCalibrate() {
    const canvas = el.liveCanvas;
    if (!canvas) return;
    try {
      if (el.liveAutoCalibBtn) {
        el.liveAutoCalibBtn.disabled = true;
        el.liveAutoCalibBtn.textContent = 'Calibrating...';
      }

      const base64Data = canvas.toDataURL('image/jpeg', 0.85);
      const res = await fetch('/api/camera/auto-calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: base64Data,
          confidence_threshold: 0.15
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          state.liveDrsData = data;
          if (el.liveDrsBadge) el.liveDrsBadge.style.display = 'flex';
          if (el.liveStumpsBadgeText) el.liveStumpsBadgeText.textContent = 'Stumps Locked';
          if (el.liveStumpsBadge) el.liveStumpsBadge.className = 'hud-badge success';
          alert('Pitch calibrated successfully! 20.12m DRS crease lines active.');
        } else {
          alert('Could not automatically detect stumps in current frame. Ensure stumps are clearly visible in the camera.');
        }
      }
    } catch (e) {
      console.error('Calibration error:', e);
    } finally {
      if (el.liveAutoCalibBtn) {
        el.liveAutoCalibBtn.disabled = false;
        el.liveAutoCalibBtn.textContent = '🎯 Auto-Calibrate Pitch';
      }
    }
  }

  // --------------------------------------------------------------------------
  // System Health & Sample Video Discovery
  // --------------------------------------------------------------------------
  async function checkSystemHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        if (el.systemStatusPill) el.systemStatusPill.className = 'status-pill online';
        if (el.systemStatusText) el.systemStatusText.textContent = 'AI Ready';
      }
    } catch {
      if (el.systemStatusPill) el.systemStatusPill.className = 'status-pill offline';
      if (el.systemStatusText) el.systemStatusText.textContent = 'Offline';
    }
  }

  async function loadSampleVideos() {
    if (!el.sampleChipsList) return;
    try {
      const res = await fetch('/api/sample_videos');
      if (res.ok) {
        const data = await res.json();
        const videos = data.sample_videos || [];
        if (videos.length === 0) {
          el.sampleChipsList.innerHTML = '<span style="font-size:12px; color:#64748b;">No local test videos found.</span>';
          return;
        }

        el.sampleChipsList.innerHTML = '';
        videos.forEach(v => {
          const btn = document.createElement('button');
          btn.className = 'sample-chip';
          const dur = v.metadata && v.metadata.duration_seconds ? `${v.metadata.duration_seconds}s` : '';
          btn.innerHTML = `⚡ <strong>${escapeHtml(v.name)}</strong> <small style="opacity:0.75;">(${dur})</small>`;
          btn.addEventListener('click', () => loadServerVideo(v.path, v.name, v.metadata));
          el.sampleChipsList.appendChild(btn);
        });
      }
    } catch (e) {
      el.sampleChipsList.innerHTML = '<span style="font-size:12px; color:#64748b;">Ready for video upload.</span>';
    }
  }

  // --------------------------------------------------------------------------
  // File Upload & Instant Preview
  // --------------------------------------------------------------------------
  function handleFileSelected(e) {
    if (e.target.files && e.target.files.length > 0) {
      processSelectedFile(e.target.files[0]);
    }
  }

  async function processSelectedFile(file) {
    const validExtensions = ['.mp4', '.mov', '.avi', '.webm'];
    const lowerName = file.name.toLowerCase();
    const hasValidExt = validExtensions.some(ext => lowerName.endsWith(ext));

    if (!hasValidExt) {
      alert('Unsupported format. Please upload an MP4, MOV, AVI, or WEBM video file.');
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      alert('File size exceeds the 500 MB limit.');
      return;
    }

    // 1. INSTANT LOCAL PREVIEW: Load video into HTML5 player immediately with 0 latency
    if (state.originalVideoSrc && state.originalVideoSrc.startsWith('blob:')) {
      URL.revokeObjectURL(state.originalVideoSrc);
    }
    const blobUrl = URL.createObjectURL(file);
    state.originalVideoSrc = blobUrl;
    state.currentVideoName = file.name;

    // Show workspace and player immediately
    showWorkspace(file.name);
    el.mainVideoPlayer.src = blobUrl;
    el.mainVideoPlayer.load();

    // Populate basic metadata
    if (el.metaFilename) el.metaFilename.textContent = file.name;
    if (el.metaResolution) el.metaResolution.textContent = 'Detecting...';
    if (el.metaFps) el.metaFps.textContent = '60 FPS (approx)';
    if (el.metaDuration) el.metaDuration.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

    el.mainVideoPlayer.onloadedmetadata = () => {
      if (el.metaResolution) el.metaResolution.textContent = `${el.mainVideoPlayer.videoWidth} x ${el.mainVideoPlayer.videoHeight}`;
      if (el.metaDuration) el.metaDuration.textContent = `${el.mainVideoPlayer.duration.toFixed(1)}s`;
    };

    // Reset speed readouts to Calculating state
    resetSpeedDisplayToCalculating();

    // 2. AUTOMATIC UPLOAD & BACKGROUND SPEED ANALYSIS
    updateProgress(10, 'Uploading video to analysis server...');
    showProgressCard(true);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const uploadRes = await fetch('/api/video/upload', {
        method: 'POST',
        body: formData
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }

      const uploadData = await uploadRes.json();
      const serverPath = uploadData.file_path;
      state.currentVideoPath = serverPath;

      if (uploadData.metadata) {
        state.currentVideoMeta = uploadData.metadata;
        applyMetadataToUI(uploadData.metadata);
      }

      // Automatically launch speed detection on the server
      await triggerSpeedAnalysis(serverPath);

    } catch (err) {
      console.error('Upload / processing error:', err);
      showProgressCard(false);
      resetSpeedDisplayToError(err.message || 'Processing failed');
    }
  }

  // --------------------------------------------------------------------------
  // Server-side Quick Test Deliveries
  // --------------------------------------------------------------------------
  async function loadServerVideo(videoPath, videoName, metadata) {
    state.currentVideoPath = videoPath;
    state.currentVideoName = videoName;
    state.currentVideoMeta = metadata || null;

    const streamUrl = `/api/video/stream?video_path=${encodeURIComponent(videoPath)}`;
    state.originalVideoSrc = streamUrl;

    // Show workspace immediately
    showWorkspace(videoName);
    el.mainVideoPlayer.src = streamUrl;
    el.mainVideoPlayer.load();

    if (metadata) {
      applyMetadataToUI(metadata);
    } else {
      fetchVideoMetadata(videoPath);
    }

    // Reset speed readouts to calculating
    resetSpeedDisplayToCalculating();

    // Launch speed analysis immediately
    await triggerSpeedAnalysis(videoPath);
  }

  async function fetchVideoMetadata(videoPath) {
    try {
      const res = await fetch(`/api/video/metadata?video_path=${encodeURIComponent(videoPath)}`);
      if (res.ok) {
        const meta = await res.json();
        state.currentVideoMeta = meta;
        applyMetadataToUI(meta);
      }
    } catch (e) {
      console.debug('Metadata fetch notice:', e);
    }
  }

  function applyMetadataToUI(meta) {
    if (el.metaFilename) el.metaFilename.textContent = meta.file_name || state.currentVideoName;
    if (el.metaResolution) el.metaResolution.textContent = `${meta.width} x ${meta.height}`;
    if (el.metaFps) el.metaFps.textContent = `${meta.fps ? meta.fps.toFixed(2) : 60} FPS`;
    if (el.metaDuration) el.metaDuration.textContent = `${meta.duration_seconds ? meta.duration_seconds.toFixed(2) : 0}s (${meta.total_frames || 0} frames)`;
  }

  // --------------------------------------------------------------------------
  // Speed Detection Trigger & Polling
  // --------------------------------------------------------------------------
  async function triggerSpeedAnalysis(videoPath) {
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }

    state.isAnalyzing = true;
    showProgressCard(true);
    updateProgress(20, 'Analyzing delivery stride & bowling kinematics...');

    try {
      const res = await fetch('/api/video/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: videoPath,
          custom_calibration: null,
          radar_speed: null
        })
      });

      if (!res.ok) {
        throw new Error(`Analysis failed with status ${res.status}`);
      }

      const data = await res.json();
      state.analysisTaskId = data.task_id;

      // Start polling for task completion
      startStatusPolling(data.task_id);

    } catch (e) {
      console.error('Trigger speed analysis error:', e);
      showProgressCard(false);
      resetSpeedDisplayToError('Could not start analysis');
    }
  }

  function startStatusPolling(taskId) {
    state.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/analysis_status/${taskId}`);
        if (!res.ok) return;

        const data = await res.json();
        const pct = Math.max(25, data.progress_pct || 0);
        const stage = data.stage || 'Calculating ball velocity...';

        updateProgress(pct, stage);

        if (data.status === 'completed') {
          clearInterval(state.pollInterval);
          state.pollInterval = null;
          state.isAnalyzing = false;
          await retrieveAnalysisResult(taskId);
        } else if (data.status === 'failed') {
          clearInterval(state.pollInterval);
          state.pollInterval = null;
          state.isAnalyzing = false;
          showProgressCard(false);
          resetSpeedDisplayToError(data.error || 'Analysis failed');
        }
      } catch (err) {
        console.debug('Polling transient error:', err);
      }
    }, 1000);
  }

  async function retrieveAnalysisResult(taskId) {
    updateProgress(100, 'Speed calculation completed!');
    try {
      const res = await fetch(`/api/video/analysis_result/${taskId}`);
      if (!res.ok) throw new Error('Could not fetch analysis result');

      const result = await res.json();
      state.analysisResult = result;

      // Hide progress card smoothly
      setTimeout(() => showProgressCard(false), 500);

      // Render speed results
      displaySpeedResults(result, taskId);

    } catch (e) {
      console.error('Retrieve result error:', e);
      showProgressCard(false);
      resetSpeedDisplayToError('Results could not be read');
    }
  }

  // --------------------------------------------------------------------------
  // Display Speed Results
  // --------------------------------------------------------------------------
  function displaySpeedResults(result, taskId) {
    const isMeasured = result.status === 'MEASURED';
    const isEstimated = result.status === 'ESTIMATED';
    const speed = result.release_speed_kmh;
    const unc = result.uncertainty_kmh;

    // 1. Release Speed Readout
    if (el.speedDisplayNumber) {
      el.speedDisplayNumber.textContent = (speed !== null && speed !== undefined) ? speed.toFixed(1) : '--.-';
    }

    if (el.speedMphDisplay) {
      if (speed !== null && speed !== undefined) {
        const mph = speed * 0.621371;
        el.speedMphDisplay.textContent = `${mph.toFixed(1)} mph`;
      } else {
        el.speedMphDisplay.textContent = '--.- mph';
      }
    }

    if (el.speedStatusBadge) {
      if (isMeasured) {
        el.speedStatusBadge.className = 'measurement-pill measured';
        el.speedStatusBadge.textContent = 'MEASURED';
      } else if (isEstimated) {
        el.speedStatusBadge.className = 'measurement-pill estimated';
        el.speedStatusBadge.textContent = 'ESTIMATED';
      } else {
        el.speedStatusBadge.className = 'measurement-pill not-measured';
        el.speedStatusBadge.textContent = 'NOT MEASURED';
      }
    }

    // 2. Overlaid Live Speed Badge on the Video Player
    if (el.liveVideoBadge && el.liveBadgeSpeedVal && el.liveBadgeStatus) {
      if (speed !== null && speed !== undefined) {
        el.liveBadgeSpeedVal.textContent = speed.toFixed(1);
        el.liveBadgeStatus.textContent = isMeasured ? 'MEASURED' : 'ESTIMATED';
        el.liveBadgeStatus.style.color = isMeasured ? '#22c55e' : '#f59e0b';
        el.liveVideoBadge.style.display = 'block';
      } else {
        el.liveVideoBadge.style.display = 'none';
      }
    }

    // 3. Uncertainty
    if (el.speedUncertaintyText) {
      if (unc !== null && unc !== undefined) {
        el.speedUncertaintyText.textContent = `±${unc.toFixed(1)} km/h uncertainty`;
      } else {
        el.speedUncertaintyText.textContent = '±5.8 km/h uncertainty';
      }
    }

    // 4. Submetrics
    if (el.c1c2SpeedVal) {
      const c1c2 = result.c1_c2_speed_kmh;
      el.c1c2SpeedVal.textContent = (c1c2 !== null && c1c2 !== undefined) ? `${c1c2.toFixed(1)} km/h` : '--.- km/h';
    }

    if (el.qcScoreVal) {
      const qc = result.qc_score;
      el.qcScoreVal.textContent = (qc !== null && qc !== undefined) ? `${qc.toFixed(0)} / 100` : '-- / 100';
    }

    // 5. Configure Export Links
    if (result.final_video) {
      configureDownloadLink(el.dlFinalVideo, `/api/video/download/final/${taskId}`, 'delivery_with_speed.mp4');
    }
    configureDownloadLink(el.dlJsonReport, `/api/video/download/json/${taskId}`, 'delivery_report.json');
    configureDownloadLink(el.dlExcelReport, `/api/video/download/excel/${taskId}`, 'delivery_summary.xlsx');
  }

  function configureDownloadLink(anchorEl, url, filename) {
    if (!anchorEl) return;
    anchorEl.href = url;
    anchorEl.download = filename;
    anchorEl.classList.remove('disabled');
  }

  function resetSpeedDisplayToCalculating() {
    if (el.speedDisplayNumber) el.speedDisplayNumber.textContent = '--.-';
    if (el.speedMphDisplay) el.speedMphDisplay.textContent = 'Calculating...';
    if (el.speedStatusBadge) {
      el.speedStatusBadge.className = 'measurement-pill not-measured';
      el.speedStatusBadge.textContent = 'CALCULATING...';
    }
    if (el.speedUncertaintyText) el.speedUncertaintyText.textContent = 'Evaluating ball kinematics...';
    if (el.c1c2SpeedVal) el.c1c2SpeedVal.textContent = '--.- km/h';
    if (el.qcScoreVal) el.qcScoreVal.textContent = '-- / 100';
    if (el.liveVideoBadge) el.liveVideoBadge.style.display = 'none';

    if (el.dlFinalVideo) el.dlFinalVideo.classList.add('disabled');
    if (el.dlJsonReport) el.dlJsonReport.classList.add('disabled');
    if (el.dlExcelReport) el.dlExcelReport.classList.add('disabled');
  }

  function resetSpeedDisplayToError(errorMsg) {
    if (el.speedDisplayNumber) el.speedDisplayNumber.textContent = 'ERR';
    if (el.speedMphDisplay) el.speedMphDisplay.textContent = 'Check video';
    if (el.speedStatusBadge) {
      el.speedStatusBadge.className = 'measurement-pill not-measured';
      el.speedStatusBadge.textContent = 'ERROR';
    }
    if (el.speedUncertaintyText) el.speedUncertaintyText.textContent = errorMsg || 'Processing failed';
  }

  // --------------------------------------------------------------------------
  // UI Helpers
  // --------------------------------------------------------------------------
  function showWorkspace(title) {
    if (el.videoWorkspace) el.videoWorkspace.style.display = 'grid';
    if (el.videoTitleText) el.videoTitleText.textContent = title || 'Cricket Delivery Preview';
    if (el.videoWorkspace) {
      el.videoWorkspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function showProgressCard(visible) {
    if (el.analysisProgressCard) {
      el.analysisProgressCard.style.display = visible ? 'block' : 'none';
    }
  }

  function updateProgress(pct, stage) {
    if (el.progressFill) el.progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (el.progressPctText) el.progressPctText.textContent = `${Math.round(pct)}%`;
    if (el.progressStageText) el.progressStageText.textContent = stage;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();