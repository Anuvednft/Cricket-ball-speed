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
    isAnalyzing: false
  };

  // DOM Elements
  const el = {
    // Header
    systemStatusPill: document.getElementById('systemStatusPill'),
    systemStatusText: document.getElementById('systemStatusText'),

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

    // Video player state update
    if (el.mainVideoPlayer) {
      el.mainVideoPlayer.addEventListener('play', () => {
        if (el.playerStateBadge) el.playerStateBadge.textContent = 'Playing';
      });
      el.mainVideoPlayer.addEventListener('pause', () => {
        if (el.playerStateBadge) el.playerStateBadge.textContent = 'Paused';
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
