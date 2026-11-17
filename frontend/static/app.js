/**
 * CRICKET BOWLING SPEED ANALYZER
 * Client-side Controller for Simplified Video Upload & Automatic Speed Detection
 * 
 * Workflow:
 * 1. User uploads video directly (or clicks a test video chip).
 * 2. Video immediately appears in HTML5 video player and can be played/scrubbed.
 * 3. Automatic speed detection launches in background.
 * 4. Calculated bowling speed & telemetry are displayed prominently alongside playback.
 * 5. User can view original, broadcast speed badge video, or diagnostic video.
 */

(function () {
  'use strict';

  // Application State
  const state = {
    currentVideoPath: null,
    currentVideoName: null,
    currentVideoMeta: null,
    originalVideoSrc: null,
    finalVideoSrc: null,
    diagVideoSrc: null,
    analysisTaskId: null,
    pollInterval: null,
    analysisResult: null,
    activeSource: 'original',
    isAnalyzing: false
  };

  // DOM Elements
  const el = {
    // Header & Status
    systemStatusPill: document.getElementById('systemStatusPill'),
    systemStatusText: document.getElementById('systemStatusText'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    settingStumpsConf: document.getElementById('settingStumpsConf'),

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
    videoSourceSwitcher: document.getElementById('videoSourceSwitcher'),
    btnSourceOriginal: document.getElementById('btnSourceOriginal'),
    btnSourceFinal: document.getElementById('btnSourceFinal'),
    btnSourceDiag: document.getElementById('btnSourceDiag'),

    // Metadata Footer
    metaFilename: document.getElementById('metaFilename'),
    metaResolution: document.getElementById('metaResolution'),
    metaFps: document.getElementById('metaFps'),
    metaDuration: document.getElementById('metaDuration'),

    // Speed Display & Telemetry
    speedDisplayNumber: document.getElementById('speedDisplayNumber'),
    speedStatusBadge: document.getElementById('speedStatusBadge'),
    speedUncertaintyText: document.getElementById('speedUncertaintyText'),
    c1c2SpeedVal: document.getElementById('c1c2SpeedVal'),
    qcScoreVal: document.getElementById('qcScoreVal'),
    analysisStatusPill: document.getElementById('analysisStatusPill'),
    telemetryStatusVal: document.getElementById('telemetryStatusVal'),
    telemetryCalibVal: document.getElementById('telemetryCalibVal'),
    telemetryFramesVal: document.getElementById('telemetryFramesVal'),
    telemetryNotesVal: document.getElementById('telemetryNotesVal'),

    // Download Links
    dlFinalVideo: document.getElementById('dlFinalVideo'),
    dlDiagVideo: document.getElementById('dlDiagVideo'),
    dlJsonReport: document.getElementById('dlJsonReport'),
    dlExcelReport: document.getElementById('dlExcelReport')
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

    // Video version switcher buttons
    if (el.btnSourceOriginal) {
      el.btnSourceOriginal.addEventListener('click', () => switchVideoSource('original'));
    }
    if (el.btnSourceFinal) {
      el.btnSourceFinal.addEventListener('click', () => switchVideoSource('final'));
    }
    if (el.btnSourceDiag) {
      el.btnSourceDiag.addEventListener('click', () => switchVideoSource('diagnostic'));
    }

    // Settings Modal
    if (el.settingsBtn && el.settingsModal) {
      el.settingsBtn.addEventListener('click', () => el.settingsModal.classList.add('active'));
    }
    if (el.closeSettingsBtn && el.settingsModal) {
      el.closeSettingsBtn.addEventListener('click', () => el.settingsModal.classList.remove('active'));
    }
    if (el.saveSettingsBtn && el.settingsModal) {
      el.saveSettingsBtn.addEventListener('click', () => {
        el.settingsModal.classList.remove('active');
      });
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
        if (el.systemStatusText) el.systemStatusText.textContent = 'AI Models Ready';
      }
    } catch {
      if (el.systemStatusPill) el.systemStatusPill.className = 'status-pill offline';
      if (el.systemStatusText) el.systemStatusText.textContent = 'Server Offline';
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
      el.sampleChipsList.innerHTML = '<span style="font-size:12px; color:#64748b;">Quick test video chips ready on upload.</span>';
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
      alert(`Unsupported video format. Please upload an MP4, MOV, AVI, or WEBM video file.`);
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
    state.activeSource = 'original';

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
    updateProgress(5, 'Uploading video to AI speed analysis server...');
    showProgressCard(true);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const uploadRes = await fetch('/api/video/upload', {
        method: 'POST',
        body: formData
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed with HTTP ${uploadRes.status}`);
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
      alert(`Could not process video: ${err.message || err}`);
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
    state.activeSource = 'original';

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
    updateProgress(15, 'Calibrating pitch & detecting bowling crease...');

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
        throw new Error(`Analysis launch failed with status ${res.status}`);
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
    let pollCount = 0;
    state.pollInterval = setInterval(async () => {
      pollCount++;
      try {
        const res = await fetch(`/api/video/analysis_status/${taskId}`);
        if (!res.ok) return;

        const data = await res.json();
        const pct = Math.max(15, data.progress_pct || 0);
        const stage = data.stage || 'Analyzing delivery stride & ball tracking...';

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
        console.debug('Polling error (transient):', err);
      }
    }, 1000);
  }

  async function retrieveAnalysisResult(taskId) {
    updateProgress(100, 'Speed analysis completed!');
    try {
      const res = await fetch(`/api/video/analysis_result/${taskId}`);
      if (!res.ok) throw new Error('Could not fetch analysis result');

      const result = await res.json();
      state.analysisResult = result;

      // Fade out progress card after short delay
      setTimeout(() => showProgressCard(false), 800);

      // Render speed & telemetry results
      displaySpeedResults(result, taskId);

    } catch (e) {
      console.error('Retrieve result error:', e);
      showProgressCard(false);
      resetSpeedDisplayToError('Results could not be read');
    }
  }

  // --------------------------------------------------------------------------
  // Display Speed Results & Telemetry
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

    if (el.speedUncertaintyText) {
      if (unc !== null && unc !== undefined) {
        el.speedUncertaintyText.textContent = `±${unc.toFixed(1)} km/h uncertainty`;
      } else {
        el.speedUncertaintyText.textContent = 'Realistic mobile physics corridor';
      }
    }

    // 2. Submetrics
    if (el.c1c2SpeedVal) {
      const c1c2 = result.c1_c2_speed_kmh;
      el.c1c2SpeedVal.textContent = (c1c2 !== null && c1c2 !== undefined) ? `${c1c2.toFixed(1)} km/h` : '--.- km/h';
    }

    if (el.qcScoreVal) {
      const qc = result.qc_score;
      el.qcScoreVal.textContent = (qc !== null && qc !== undefined) ? `${Math.round(qc)} / 100` : '-- / 100';
    }

    // 3. Telemetry card
    if (el.analysisStatusPill) {
      el.analysisStatusPill.className = isMeasured ? 'status-pill online' : 'status-pill';
      el.analysisStatusPill.textContent = result.status || 'Complete';
    }

    if (el.telemetryStatusVal) el.telemetryStatusVal.textContent = result.status || 'ESTIMATED';
    if (el.telemetryCalibVal) el.telemetryCalibVal.textContent = isMeasured ? '20.12m DRS Ground Line' : 'Canonical Mobile Pitch Model';
    if (el.telemetryFramesVal) {
      el.telemetryFramesVal.textContent = result.final_video ? 'Delivery Action Tracked' : 'Complete Delivery';
    }
    if (el.telemetryNotesVal) {
      el.telemetryNotesVal.textContent = result.rejection_reason || 'Kinematic corridor model applied.';
    }

    if (el.playerStateBadge) {
      el.playerStateBadge.className = 'status-pill online';
      el.playerStateBadge.textContent = 'Speed Verified';
    }

    // 4. Configure Output Video Switchers
    state.finalVideoSrc = `/api/video/download/final/${taskId}`;
    state.diagVideoSrc = `/api/video/download/diagnostic/${taskId}`;

    if (el.videoSourceSwitcher) {
      el.videoSourceSwitcher.style.display = 'flex';
    }
    if (el.btnSourceFinal) el.btnSourceFinal.disabled = false;
    if (el.btnSourceDiag) el.btnSourceDiag.disabled = false;

    // 5. Configure Download Links
    setupDownloadLink(el.dlFinalVideo, `/api/video/download/final/${taskId}`, `${state.currentVideoName || 'delivery'}_final.mp4`);
    setupDownloadLink(el.dlDiagVideo, `/api/video/download/diagnostic/${taskId}`, `${state.currentVideoName || 'delivery'}_diagnostic.mp4`);
    setupDownloadLink(el.dlJsonReport, `/api/video/download/json/${taskId}`, `${state.currentVideoName || 'delivery'}_report.json`);
    setupDownloadLink(el.dlExcelReport, `/api/video/download/excel/${taskId}`, `${state.currentVideoName || 'delivery'}_summary.xlsx`);
  }

  function setupDownloadLink(linkEl, url, filename) {
    if (!linkEl) return;
    linkEl.href = url;
    linkEl.download = filename;
    linkEl.classList.remove('disabled');
  }

  // --------------------------------------------------------------------------
  // Video Source Switching (Original, Broadcast Final, Diagnostic)
  // --------------------------------------------------------------------------
  function switchVideoSource(source) {
    if (source === state.activeSource) return;

    let targetSrc = null;
    if (source === 'original') {
      targetSrc = state.originalVideoSrc;
    } else if (source === 'final') {
      targetSrc = state.finalVideoSrc;
    } else if (source === 'diagnostic') {
      targetSrc = state.diagVideoSrc;
    }

    if (!targetSrc) return;

    // Preserve playback timestamp
    const prevTime = el.mainVideoPlayer.currentTime || 0;
    const wasPlaying = !el.mainVideoPlayer.paused;

    state.activeSource = source;
    el.mainVideoPlayer.src = targetSrc;
    el.mainVideoPlayer.currentTime = prevTime;

    if (wasPlaying) {
      el.mainVideoPlayer.play().catch(() => {});
    }

    // Update active button state
    if (el.btnSourceOriginal) el.btnSourceOriginal.classList.toggle('active', source === 'original');
    if (el.btnSourceFinal) el.btnSourceFinal.classList.toggle('active', source === 'final');
    if (el.btnSourceDiag) el.btnSourceDiag.classList.toggle('active', source === 'diagnostic');

    // Update title text
    if (el.videoTitleText) {
      if (source === 'original') el.videoTitleText.textContent = 'Original Delivery Video';
      else if (source === 'final') el.videoTitleText.textContent = 'Broadcast Video (Speed Badge)';
      else if (source === 'diagnostic') el.videoTitleText.textContent = 'Diagnostic Video (3D Trajectory)';
    }
  }

  // --------------------------------------------------------------------------
  // UI Helpers
  // --------------------------------------------------------------------------
  function showWorkspace(title) {
    if (el.videoWorkspace) el.videoWorkspace.style.display = 'grid';
    if (el.videoTitleText) el.videoTitleText.textContent = title || 'Delivery Video Preview';
    if (el.playerStateBadge) {
      el.playerStateBadge.className = 'status-pill';
      el.playerStateBadge.textContent = 'Analyzing...';
    }
    if (el.videoSourceSwitcher) el.videoSourceSwitcher.style.display = 'none';
    if (el.btnSourceOriginal) el.btnSourceOriginal.classList.add('active');
    if (el.btnSourceFinal) el.btnSourceFinal.classList.remove('active');
    if (el.btnSourceDiag) el.btnSourceDiag.classList.remove('active');
  }

  function showProgressCard(visible) {
    if (el.analysisProgressCard) {
      el.analysisProgressCard.style.display = visible ? 'flex' : 'none';
    }
  }

  function updateProgress(pct, stage) {
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    if (el.progressFill) el.progressFill.style.width = `${clamped}%`;
    if (el.progressPctText) el.progressPctText.textContent = `${clamped}%`;
    if (el.progressStageText) el.progressStageText.textContent = stage;
  }

  function resetSpeedDisplayToCalculating() {
    if (el.speedDisplayNumber) el.speedDisplayNumber.textContent = '--.-';
    if (el.speedStatusBadge) {
      el.speedStatusBadge.className = 'measurement-pill not-measured';
      el.speedStatusBadge.textContent = 'CALCULATING...';
    }
    if (el.speedUncertaintyText) el.speedUncertaintyText.textContent = 'Running automatic speed detection...';
    if (el.c1c2SpeedVal) el.c1c2SpeedVal.textContent = '--.- km/h';
    if (el.qcScoreVal) el.qcScoreVal.textContent = '-- / 100';
    if (el.analysisStatusPill) {
      el.analysisStatusPill.className = 'status-pill';
      el.analysisStatusPill.textContent = 'Processing';
    }
    if (el.telemetryStatusVal) el.telemetryStatusVal.textContent = 'Processing...';
    if (el.telemetryNotesVal) el.telemetryNotesVal.textContent = 'Computing bowling release velocity vector...';

    // Disable output switcher and downloads until ready
    if (el.btnSourceFinal) el.btnSourceFinal.disabled = true;
    if (el.btnSourceDiag) el.btnSourceDiag.disabled = true;
    if (el.dlFinalVideo) el.dlFinalVideo.classList.add('disabled');
    if (el.dlDiagVideo) el.dlDiagVideo.classList.add('disabled');
    if (el.dlJsonReport) el.dlJsonReport.classList.add('disabled');
    if (el.dlExcelReport) el.dlExcelReport.classList.add('disabled');
  }

  function resetSpeedDisplayToError(errMsg) {
    if (el.speedDisplayNumber) el.speedDisplayNumber.textContent = '--.-';
    if (el.speedStatusBadge) {
      el.speedStatusBadge.className = 'measurement-pill not-measured';
      el.speedStatusBadge.textContent = 'ERROR';
    }
    if (el.speedUncertaintyText) el.speedUncertaintyText.textContent = errMsg || 'Detection failed';
    if (el.telemetryNotesVal) el.telemetryNotesVal.textContent = errMsg;
    if (el.playerStateBadge) {
      el.playerStateBadge.className = 'status-pill offline';
      el.playerStateBadge.textContent = 'Error';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#039;';
        default: return m;
      }
    });
  }

})();
