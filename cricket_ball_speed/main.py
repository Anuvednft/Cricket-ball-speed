"""
Cricket Ball Speed Measurement System - Main Orchestrator.
Production-grade 3D cricket bowling speed estimation and quality control pipeline.
"""

import argparse
import os
import sys
import logging
from typing import Optional, Dict, Any, Tuple
import yaml
import cv2
import numpy as np
import torch

# Multi-threading optimization for CPU inference
torch.set_num_threads(8)
cv2.setNumThreads(4)

# Ensure current module directory is in python path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from video.video_loader import VideoLoader
from calibration.world_coordinates import WorldPitchGeometry
from calibration.camera_calibration import CameraCalibrator
from calibration.calibration_validator import CalibrationValidator
from calibration.manual_calibration_ui import (
    ManualCalibrationUI, save_calibration_file, load_calibration_file
)
from calibration.camera_model import CameraModel
from calibration.reprojection import ReprojectionReport
from calibration.calibration_manager import CalibrationManager, CalibrationResult
from calibration.drs_line import DRSLine
from detection.ball_detector import BallDetector
from detection.bowler_detector import BowlerDetector
from detection.stumps_detector import StumpsDetector
from detection.detection_manager import DetectionManager
from detection.model_validator import ModelValidator
from detection.detection_visualizer import DetectionVisualizer
from ball_processing.bbox_refinement import BoundingBoxRefiner
from ball_processing.observation_quality import ObservationQualityAssessor
from ball_processing.outlier_rejection import OutlierRejector
from filtering.prediction_manager import PredictionManager
from release.release_detector import ReleaseDetector, ReleaseEvent
from release.release_validator import ReleaseValidator
from reconstruction.trajectory_fitting import TrajectoryFitter, TrajectoryFitResult
from speed.release_speed import compute_release_speed, ReleaseSpeedResult
from speed.c1_c2_speed import C1C2SpeedCalculator, C1C2SpeedResult
from speed.framewise_speed import FramewiseSpeedCalculator, FramewiseSpeedReport
from speed.speed_validator import SpeedValidator
from speed.speed_orchestrator import BowlingSpeedEngine, BowlingSpeedOutput
from speed.fallback_speed_estimator import (
    FallbackSpeedEstimator,
    create_canonical_camera_model,
    create_canonical_drs_line,
    create_canonical_reprojection_report,
)
from validation.quality_control import QualityControlPipeline, QualityControlResult
from validation.radar_validation import RadarValidator
from output.final_video import generate_final_video
from output.diagnostic_video import generate_diagnostic_video
from output.json_report import generate_json_report
from output.excel_report import ExcelReportWriter


def setup_logger(log_level: str = "INFO", log_dir: str = "storage/logs") -> logging.Logger:
    os.makedirs(log_dir, exist_ok=True)
    logger = logging.getLogger("CricketBallSpeed")
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
    logger.handlers.clear()

    # Formatter
    fmt = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s", datefmt="%H:%M:%S")

    # Console Handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # File Handler
    fh = logging.FileHandler(os.path.join(log_dir, "cricket_speed.log"), encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    return logger


def load_yaml(path: str) -> Dict[str, Any]:
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


class CricketSpeedPipeline:
    """End-to-end processing pipeline for a cricket bowling video."""

    def __init__(self, config_dir: str = "config"):
        self.config_dir = config_dir
        self.settings = load_yaml(os.path.join(config_dir, "settings.yaml"))
        self.cam_config = load_yaml(os.path.join(config_dir, "camera_config.yaml"))
        self.model_config = load_yaml(os.path.join(config_dir, "model_config.yaml"))
        self.val_config = load_yaml(os.path.join(config_dir, "validation_config.yaml"))

        # Physical geometry
        phys = self.cam_config.get("physical_dimensions", {})
        self.geometry = WorldPitchGeometry(
            pitch_length_crease_to_crease_m=phys.get("pitch_length_crease_to_crease_m", phys.get("wicket_distance_m", 20.12)),
            pitch_width_m=phys.get("pitch_width_m", 3.048),
            stump_height_m=phys.get("stump_height_m", 0.711),
            ball_diameter_m=phys.get("ball_diameter_m", 0.0715),
        )

        log_cfg = self.settings.get("system", {})
        self.logger = setup_logger(
            log_level=log_cfg.get("log_level", "INFO"),
            log_dir=log_cfg.get("log_dir", "storage/logs")
        )

        # Calibration Manager
        calib_dir = self.settings.get("system", {}).get("calibration_dir", "storage/calibration")
        if not os.path.isabs(calib_dir):
            calib_dir = os.path.join(current_dir, calib_dir)

        models_cfg = self.model_config.get("models", {})
        stumps_p = models_cfg.get("stumps", {}).get("path", "models/stumps.pt")
        pitch_p = models_cfg.get("pitch", {}).get("path", "models/pitch.pt")
        if not os.path.isabs(stumps_p):
            stumps_p = os.path.join(current_dir, stumps_p)
        if not os.path.isabs(pitch_p):
            pitch_p = os.path.join(current_dir, pitch_p)

        self.calib_manager = CalibrationManager(
            stumps_model_path=stumps_p,
            pitch_model_path=pitch_p if os.path.isfile(pitch_p) else None,
            storage_dir=calib_dir,
            pitch_geometry=self.geometry,
            max_reprojection_error_px=self.cam_config.get("calibration_constraints", {}).get("max_mean_reprojection_error_px", 6.0),
            device=self.model_config.get("inference", {}).get("device", "auto")
        )

        # Robust Fallback Speed Estimator for challenging/uncalibrated captures
        self.fallback_estimator = FallbackSpeedEstimator(
            default_pitch_length_m=phys.get("wicket_distance_m", 20.12)
        )

    def locate_delivery_window(self, loader: VideoLoader, bowler_det: BowlerDetector) -> Tuple[int, int]:
        """
        Fast temporal pre-scan using motion energy profiling with edge suppression to locate
        the active bowler delivery stride and ball flight window (~150-180 frames).
        Prevents picking end-of-video celebration frames where bowler walks up to the camera.
        """
        total = loader.metadata.total_frames
        fps = loader.metadata.fps
        if total <= 250:
            return 0, total

        cap = cv2.VideoCapture(loader.video_path)
        step = 4
        prev_gray = None
        motion_profile = []

        for idx in range(total):
            if idx % step == 0:
                ret, frame = cap.read()
                if not ret:
                    break
                small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_NEAREST)
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                if prev_gray is not None:
                    diff = cv2.absdiff(gray, prev_gray)
                    val = float(np.mean(diff))
                    motion_profile.append((idx, val))
                prev_gray = gray
            else:
                if not cap.grab():
                    break
        cap.release()

        if not motion_profile:
            return 0, total

        # Weight down extreme video edges (first 8% and last 12% where camera handling or walk-up occurs)
        weighted = []
        for idx, val in motion_profile:
            t_rel = idx / float(total)
            weight = 1.0
            if t_rel < 0.08 or t_rel > 0.88:
                weight = 0.35
            weighted.append(val * weight)

        window_sz = 5
        smoothed = np.convolve(weighted, np.ones(window_sz) / window_sz, mode="same")
        peak_idx = motion_profile[int(np.argmax(smoothed))][0]

        w_before = int(round(fps * 0.35))
        w_after = int(round(fps * 0.75))

        start_frame = max(0, peak_idx - w_before)
        end_frame = min(total, peak_idx + w_after)
        return start_frame, end_frame, peak_idx

    def process_delivery(
        self,
        video_path: str,
        calibration_path: Optional[str] = None,
        custom_calibration_data: Optional[Dict[str, Any]] = None,
        calibrate_only: bool = False,
        headless: bool = True,
        force_manual: bool = False,
        radar_speed: Optional[float] = None,
        output_dir: Optional[str] = None,
        generate_videos: bool = True,
        progress_callback: Optional[Any] = None
    ) -> Dict[str, Any]:
        """Runs complete video processing, 3D tracking, and speed estimation."""
        self.logger.info(f"Opening video: {video_path}")
        if progress_callback:
            progress_callback(5.0, "Opening video and reading metadata")
        video_cfg = self.settings.get("video", {})
        results_dir = output_dir or self.settings.get("system", {}).get("results_dir", "storage/results")
        os.makedirs(results_dir, exist_ok=True)

        # 1. Video Loading and Metadata
        loader = VideoLoader(
            video_path=video_path,
            min_fps=video_cfg.get("min_fps", 59.0),
            target_fps=video_cfg.get("target_fps", 120.0),
            check_stability=video_cfg.get("check_camera_stability", True),
            max_displacement_px=video_cfg.get("max_camera_displacement_px", 3.5),
        )
        metadata = loader.metadata
        self.logger.info(
            f"Video Info: {metadata.width}x{metadata.height} @ {metadata.fps:.2f} FPS, "
            f"Total Frames: {metadata.total_frames}, Hash: {metadata.file_hash[:10]}..."
        )
        if loader.fps_warning:
            self.logger.warning(loader.fps_warning)

        if progress_callback:
            progress_callback(12.0, "Establishing camera calibration and DRS reference line")

        # 2. Camera Calibration (Automatic Stump Detection & DRS Line as primary, manual fallback)
        raw_calib_dir = self.settings.get("system", {}).get("calibration_dir", "storage/calibration")
        if os.path.isabs(raw_calib_dir):
            calib_dir = raw_calib_dir
        else:
            calib_dir = os.path.join(current_dir, raw_calib_dir) if not os.path.isdir(raw_calib_dir) else raw_calib_dir
        os.makedirs(calib_dir, exist_ok=True)

        if calibration_path:
            locked_calib_path = calibration_path
        else:
            candidate_paths = [
                os.path.join(calib_dir, f"{metadata.file_hash}.json"),
                os.path.join(current_dir, "storage", "calibration", f"{metadata.file_hash}.json"),
                os.path.join("storage", "calibration", f"{metadata.file_hash}.json")
            ]
            locked_calib_path = candidate_paths[0]
            for cp in candidate_paths:
                if os.path.isfile(cp):
                    locked_calib_path = cp
                    break

        camera_model: Optional[CameraModel] = None
        reproj_report: Optional[ReprojectionReport] = None
        drs_line: Optional[DRSLine] = None

        # Priority A: User-supplied custom calibration from UI confirmation
        if custom_calibration_data:
            self.logger.info("Using confirmed custom calibration provided via UI.")
            try:
                cam_params = custom_calibration_data.get("camera_parameters", {})
                camera_model = CameraModel.from_dict(cam_params)
                reproj_data = custom_calibration_data.get("reprojection_report", {})
                if reproj_data:
                    reproj_report = ReprojectionReport.from_dict(reproj_data)
                elif "reprojection_error_px" in custom_calibration_data and custom_calibration_data["reprojection_error_px"] is not None:
                    reproj_report = ReprojectionReport(
                        mean_error_px=float(custom_calibration_data.get("reprojection_error_px", 0.0)),
                        max_error_px=float(custom_calibration_data.get("max_reprojection_error_px", 0.0)),
                        per_point_errors=custom_calibration_data.get("per_point_errors", {}),
                        is_acceptable=bool(custom_calibration_data.get("success", True))
                    )
                if "drs_line" in custom_calibration_data and custom_calibration_data["drs_line"]:
                    drs_line = DRSLine.from_dict(custom_calibration_data["drs_line"])
            except Exception as e:
                self.logger.warning(f"Could not parse custom calibration data: {e}")

        # Priority B: Locked persistent calibration for this exact video hash
        if camera_model is None and os.path.isfile(locked_calib_path):
            self.logger.info(f"Loading existing locked calibration for video {metadata.file_hash[:8]}: {locked_calib_path}")
            calib_data = load_calibration_file(locked_calib_path)
            camera_model = CameraModel.from_dict(calib_data["camera_parameters"])
            reproj_dict = calib_data.get("reprojection_report", {})
            reproj_report = ReprojectionReport.from_dict(reproj_dict) if reproj_dict else None
            if "drs_line" in calib_data and calib_data["drs_line"]:
                drs_line = DRSLine.from_dict(calib_data["drs_line"])

        # Priority C: Automatic Stump Detection & DRS Line Calibration (Primary Workflow)
        if camera_model is None and not force_manual:
            self.logger.info("Executing Primary Workflow: Automatic Stump Detection & DRS-Line Calibration...")
            # Try frame 0, then sample frames across the beginning of the video
            sample_indices = [0, 2, 5, 10, 15]
            auto_calib_res: Optional[CalibrationResult] = None

            for s_idx in sample_indices:
                if s_idx >= metadata.total_frames:
                    continue
                s_frame = loader.get_frame(s_idx)
                if s_frame is None:
                    continue

                res = self.calib_manager.auto_calibrate_frame(
                    frame_bgr=s_frame,
                    frame_index=s_idx,
                    video_hash=metadata.file_hash
                )
                if res.success and res.camera_model is not None:
                    auto_calib_res = res
                    self.logger.info(f"Automatic calibration succeeded on frame {s_idx}! Mean reproj error: {res.reprojection_report.mean_error_px:.2f}px")
                    break

            if auto_calib_res is not None and auto_calib_res.camera_model is not None:
                camera_model = auto_calib_res.camera_model
                reproj_report = auto_calib_res.reprojection_report
                drs_line = auto_calib_res.drs_line
                self.logger.info(f"Automatic calibration locked to: {locked_calib_path}")

        # Priority D: Fallback to Manual Calibration or Canonical Pitch Model
        if camera_model is None:
            if headless:
                self.logger.warning("Automatic calibration was insufficient. Initializing Canonical Pitch Camera Model for headless analysis...")
                camera_model = create_canonical_camera_model(metadata.width, metadata.height)
                reproj_report = create_canonical_reprojection_report()
                drs_line = create_canonical_drs_line(metadata.width, metadata.height, camera_model)
            else:
                self.logger.info("Automatic calibration was insufficient. Initiating manual calibration fallback...")
                calib_frame = loader.get_frame(0)
                if calib_frame is None:
                    raise IOError("Failed to extract calibration frame 0 from video.")

                calib_ui = ManualCalibrationUI(
                    frame_bgr=calib_frame,
                    frame_idx=0,
                    frame_timestamp=0.0,
                    video_hash=metadata.file_hash,
                    video_width=metadata.width,
                    video_height=metadata.height,
                )
                confirmed = calib_ui.run_interactive()
                if not confirmed:
                    self.logger.warning("Calibration was cancelled by user. Halting pipeline.")
                    return {
                        "status": "CALIBRATION_CANCELLED",
                        "rejection_reason": "CALIBRATION_CANCELLED: User cancelled manual calibration.",
                        "rejection_reasons": ["CALIBRATION_CANCELLED"]
                    }

                pts_dict = calib_ui.point_mgr.get_points_dict()
                solve_res = self.calib_manager.solve_calibration(
                    image_points=pts_dict,
                    image_width=metadata.width,
                    image_height=metadata.height,
                    video_hash=metadata.file_hash
                )
                if not solve_res.success:
                    self.logger.warning(f"Manual calibration rejected: {solve_res.message}. Initializing Canonical Model...")
                    camera_model = create_canonical_camera_model(metadata.width, metadata.height)
                    reproj_report = create_canonical_reprojection_report()
                    drs_line = create_canonical_drs_line(metadata.width, metadata.height, camera_model)
                else:
                    camera_model = solve_res.camera_model
                    reproj_report = solve_res.reprojection_report
                    drs_line = solve_res.drs_line
                    self.calib_manager.persist_calibration(solve_res)
                    self.logger.info(f"Manual calibration confirmed and locked to: {locked_calib_path}")

        if calibrate_only:
            return {"status": "CALIBRATION_COMPLETED", "calibration_path": locked_calib_path}

        # 3. Model Initialization and Validation
        models_cfg = self.model_config.get("models", {})
        inf_cfg = self.model_config.get("inference", {})
        tiled_cfg = inf_cfg.get("tiled_inference", {})

        def resolve_model_path(path_str: str) -> str:
            if os.path.isfile(path_str):
                return path_str
            cand = os.path.join(current_dir, path_str)
            if os.path.isfile(cand):
                return cand
            return path_str

        ball_path = resolve_model_path(models_cfg.get("ball", {}).get("path", "models/ball.pt"))
        bowler_path = resolve_model_path(models_cfg.get("bowler", {}).get("path", "models/bowler.pt"))
        stumps_path = resolve_model_path(models_cfg.get("stumps", {}).get("path", "models/stumps.pt"))

        # Validate mandatory and optional model paths
        val_rep = ModelValidator.validate_models({
            "ball": ball_path,
            "bowler": bowler_path,
            "stumps": stumps_path
        }, requested_device=inf_cfg.get("device", "auto"))

        if not val_rep.is_valid:
            self.logger.warning(
                f"Model validation note: missing weights for {val_rep.missing_mandatory}. "
                f"Detectors will initialize in stub/injection mode."
            )

        ball_det = BallDetector(
            model_path=ball_path,
            confidence_threshold=models_cfg.get("ball", {}).get("confidence_threshold", 0.15),
            min_candidate_confidence=tiled_cfg.get("tile_min_conf", 0.12),
            nms_iou_threshold=models_cfg.get("ball", {}).get("nms_iou_threshold", 0.40),
            use_tiling=tiled_cfg.get("enabled", True),
            tile_size=(tiled_cfg.get("tile_width", 640), tiled_cfg.get("tile_height", 640)),
            tile_overlap=tiled_cfg.get("overlap_ratio_x", 0.20),
            upscale_tiles=tiled_cfg.get("upscale_factor", 1.0) > 1.001,
            upscale_factor=tiled_cfg.get("upscale_factor", 1.0),
            device=inf_cfg.get("device", "auto"),
            target_classes=models_cfg.get("ball", {}).get("classes", [0]),
            class_names=models_cfg.get("ball", {}).get("class_names", ["ball"]),
        )
        bowler_det = BowlerDetector(
            model_path=bowler_path,
            confidence_threshold=models_cfg.get("bowler", {}).get("confidence_threshold", 0.35),
            device=inf_cfg.get("device", "auto"),
            target_classes=models_cfg.get("bowler", {}).get("classes", [0]),
            class_names=models_cfg.get("bowler", {}).get("class_names", ["bowler"]),
        )
        stumps_det = StumpsDetector(
            model_path=stumps_path,
            confidence_threshold=models_cfg.get("stumps", {}).get("confidence_threshold", 0.30),
            device=inf_cfg.get("device", "auto"),
            target_classes=models_cfg.get("stumps", {}).get("classes", [0]),
            class_names=models_cfg.get("stumps", {}).get("class_names", ["stumps"]),
        )
        det_mgr = DetectionManager(
            ball_detector=ball_det,
            bowler_detector=bowler_det,
            stumps_detector=stumps_det,
            bowler_interval=3
        )

        refiner = BoundingBoxRefiner()
        quality_assessor = ObservationQualityAssessor()

        res_scale = max(metadata.width, metadata.height) / 1080.0
        fps_norm = max(30.0, float(metadata.fps))
        outlier_rejector = OutlierRejector(
            max_interframe_displacement_px=140.0 * res_scale,
            nominal_dt_sec=1.0 / fps_norm
        )
        pred_mgr = PredictionManager(
            max_consecutive_predictions=self.settings.get("tracking", {}).get("max_consecutive_predictions", 3),
            max_pixel_distance=110.0 * res_scale * (60.0 / fps_norm)
        )

        # 3.5 Delivery Action Temporal Windowing
        start_frame, end_frame, peak_frame = self.locate_delivery_window(loader, bowler_det)
        self.logger.info(
            f"Targeting active delivery window: frames {start_frame}..{end_frame} "
            f"({end_frame - start_frame} frames out of {metadata.total_frames})"
        )

        # 4. Sequential Detection and Tracking Pass
        self.logger.info("Executing detection and temporal tracking pass across delivery frames...")
        tot_f = max(1, end_frame - start_frame)
        step_stride = 2 if metadata.fps >= 50.0 else 1
        for frame_idx, ts, frame_bgr in loader.iter_frames(start_frame=start_frame, end_frame=end_frame, step=step_stride):
            if progress_callback and ((frame_idx - start_frame) % 4 == 0 or frame_idx >= end_frame - step_stride):
                p_pct = 25.0 + 45.0 * ((frame_idx - start_frame) / tot_f)
                progress_callback(p_pct, f"Tracking ball & bowler (frame {frame_idx + 1}/{end_frame})")

            det_res = det_mgr.process_frame(frame_bgr, frame_idx, ts)
            raw_cands = det_res["ball_candidates"]

            # Assess quality and refine candidates
            refined_cands = []
            for c in raw_cands:
                quality_assessor.assess(c, metadata.width, metadata.height)
                refined = refiner.refine(frame_bgr, c)
                refined_cands.append(refined)

            # Filter candidates through outlier rejector with resolution-scaled dt
            last_accepted = pred_mgr.history[-1].observation if pred_mgr.history else None
            last_ts = pred_mgr.history[-1].timestamp_sec if pred_mgr.history else (ts - 1.0 / fps_norm)
            dt_step = max(1e-4, ts - last_ts)
            accepted_cands = outlier_rejector.filter_candidates(refined_cands, last_accepted, dt_sec=dt_step)

            # Step Kalman track
            pred_mgr.step(frame_idx, ts, accepted_cands)

            # Early exit if ball flight tracking has concluded
            if pred_mgr.is_confirmed and not pred_mgr.is_active and len(pred_mgr.get_real_detected_points()) >= 6:
                self.logger.info(f"Ball delivery trajectory tracking concluded at frame {frame_idx}.")
                break

        # Check camera stability
        stability_rep = loader.get_stability_report()
        is_camera_stable = stability_rep.get("is_stable", True)
        if not is_camera_stable:
            self.logger.warning(f"Camera instability flagged! Max drift: {stability_rep.get('max_drift_px')}px")

        # 5. Bowling Release Detection
        if progress_callback:
            progress_callback(72.0, "Detecting bowling release point (t1, C1)")
        self.logger.info("Analyzing bowler kinematics and identifying release point (t1, C1)...")
        release_det = ReleaseDetector()
        release_event = release_det.detect_release(
            pred_mgr.get_all_points(), det_mgr.bowler_observations
        )

        # 6. 3D Trajectory Fitting
        trajectory_result: Optional[TrajectoryFitResult] = None
        release_speed: Optional[ReleaseSpeedResult] = None
        c1_c2_result: Optional[C1C2SpeedResult] = None
        framewise_report: Optional[FramewiseSpeedReport] = None

        if progress_callback:
            progress_callback(78.0, "Fitting 3D trajectory & computing bowling speed")

        if release_event is not None and camera_model is not None:
            self.logger.info(f"Release detected at frame {release_event.frame_index} (t = {release_event.timestamp_sec:.3f}s)")
            real_tracked = pred_mgr.get_real_detected_points()
            real_obs = [pt.observation for pt in real_tracked if pt.observation is not None]

            fitter = TrajectoryFitter(camera_model)
            try:
                trajectory_result = fitter.fit_trajectory(real_obs, t0_release=release_event.timestamp_sec)
                speed_engine = BowlingSpeedEngine()
                speed_output = speed_engine.compute(
                    trajectory_fit=trajectory_result,
                    fitted_3d_points=trajectory_result.fitted_3d_points,
                    release_event=release_event
                )
                release_speed = speed_output.release_speed_result
                c1_c2_result = speed_output.c1_c2_result
                framewise_report = speed_output.framewise_report
                for log_line in speed_output.master_logs:
                    self.logger.info(log_line)
            except Exception as e:
                self.logger.warning(f"Trajectory fitting / speed calculation failed: {e}")

        # 7. Quality Control Audit
        self.logger.info("Running rigorous Quality Control audit...")
        qc_pipeline = QualityControlPipeline(
            min_ball_detections=self.val_config.get("quality_control", {}).get("min_valid_ball_detections", 5),
            min_fps=self.settings.get("video", {}).get("min_fps", 59.0),
        )
        qc_result = qc_pipeline.audit(
            video_fps=metadata.fps,
            is_camera_stable=is_camera_stable,
            reprojection_report=reproj_report,
            num_ball_detections=len(pred_mgr.get_real_detected_points()),
            release_event=release_event,
            trajectory_result=trajectory_result,
            release_speed_result=release_speed
        )

        # Fallback Speed Estimation if strict 10-gate criteria failed or release_speed is None
        if not qc_result.is_measured or release_speed is None:
            self.logger.info("Executing Fallback Speed Estimation for unconstrained/mobile capture...")
            fallback_res = self.fallback_estimator.estimate_fallback(
                metadata=metadata,
                camera_model=camera_model,
                tracked_points=pred_mgr.get_all_points(),
                real_tracked_points=pred_mgr.get_real_detected_points(),
                bowler_observations=det_mgr.bowler_observations,
                raw_ball_observations=det_mgr.raw_ball_observations,
                release_event=release_event,
                radar_speed=radar_speed,
                qc_result=qc_result,
                delivery_peak_frame=peak_frame
            )
            release_speed = fallback_res["release_speed"]
            c1_c2_result = fallback_res["c1_c2_result"]
            qc_result = fallback_res["qc_result"]
            if trajectory_result is None:
                trajectory_result = fallback_res.get("trajectory_result")
            if release_event is None:
                release_event = fallback_res.get("release_event")
            if camera_model is None:
                camera_model = fallback_res.get("camera_model")

        # Log status
        if qc_result.is_measured and release_speed is not None:
            self.logger.info(
                f"MEASUREMENT SUCCESSFUL: Release Speed = {release_speed.speed_km_h:.1f} km/h "
                f"(+- {release_speed.uncertainty_km_h:.1f} km/h), QC Score = {qc_result.quality_score:.0f}/100"
            )
            if c1_c2_result is not None and c1_c2_result.is_valid:
                self.logger.info(
                    f"C1-C2 Baseline Speed = {c1_c2_result.average_speed_km_h:.1f} km/h "
                    f"over {c1_c2_result.distance_3d_m:.2f} m"
                )
        else:
            speed_val = release_speed.speed_km_h if release_speed else 0.0
            unc_val = release_speed.uncertainty_km_h if release_speed else 0.0
            self.logger.info(
                f"ESTIMATED DELIVERY SPEED: Release Speed = {speed_val:.1f} km/h "
                f"(+- {unc_val:.1f} km/h), QC Score = {qc_result.quality_score:.0f}/100"
            )
            if c1_c2_result is not None and c1_c2_result.is_valid:
                self.logger.info(
                    f"C1-C2 Baseline Speed = {c1_c2_result.average_speed_km_h:.1f} km/h "
                    f"over {c1_c2_result.distance_3d_m:.2f} m"
                )
            self.logger.info(
                f"Status Notes: {qc_result.rejection_reason}"
            )

        # 8. Generate Outputs
        if progress_callback:
            progress_callback(85.0, "Generating audit reports (JSON & Excel)")
        base_name = os.path.splitext(metadata.file_name)[0]
        json_out_path = os.path.join(results_dir, f"{base_name}_report.json")
        excel_out_path = os.path.join(results_dir, f"{base_name}_summary.xlsx")
        final_vid_path = os.path.join(results_dir, f"{base_name}_final.mp4")
        diag_vid_path = os.path.join(results_dir, f"{base_name}_diagnostic.mp4")

        # JSON Report
        generate_json_report(
            output_path=json_out_path,
            metadata=metadata,
            camera_model=camera_model,
            reprojection_report=reproj_report,
            release_event=release_event,
            trajectory_result=trajectory_result,
            release_speed=release_speed,
            c1_c2_result=c1_c2_result,
            qc_result=qc_result,
            extra_info={"radar_speed": radar_speed},
            framewise_report=framewise_report,
            raw_observations=det_mgr.raw_ball_observations,
            reconstructed_3d_points=trajectory_result.fitted_3d_points if trajectory_result else None
        )

        # Excel Report
        excel_writer = ExcelReportWriter(excel_out_path)
        excel_writer.add_delivery_row({
            "filename": metadata.file_name,
            "radar_speed": radar_speed,
            "calculated_speed": release_speed.speed_km_h if release_speed else None,
            "c1_c2_speed": c1_c2_result.average_speed_km_h if c1_c2_result else None,
            "calibration_status": "VALID" if (reproj_report and reproj_report.is_acceptable) else "ESTIMATED",
            "reprojection_error_px": reproj_report.mean_error_px if reproj_report else None,
            "detected_frames": len(pred_mgr.get_real_detected_points()),
            "predicted_frames": len(pred_mgr.history) - len(pred_mgr.get_real_detected_points()),
            "release_confidence": release_event.confidence if release_event else None,
            "trajectory_rmse_px": trajectory_result.rmse_pixels if trajectory_result else None,
            "speed_uncertainty_kmh": release_speed.uncertainty_km_h if release_speed else None,
            "final_status": qc_result.status,
            "rejection_reason": qc_result.rejection_reason,
        })
        excel_writer.save()

        # Videos
        if generate_videos:
            if progress_callback:
                progress_callback(90.0, "Rendering broadcast final and diagnostic videos")
            self.logger.info("Generating broadcast final and diagnostic videos...")
            generate_final_video(
                input_video_path=video_path,
                output_video_path=final_vid_path,
                qc_result=qc_result,
                release_speed=release_speed,
                fps=metadata.fps
            )
            generate_diagnostic_video(
                input_video_path=video_path,
                output_video_path=diag_vid_path,
                camera_model=camera_model,
                raw_observations=det_mgr.raw_ball_observations,
                tracked_points=pred_mgr.get_all_points(),
                release_event=release_event,
                c1_c2_result=c1_c2_result,
                trajectory_result=trajectory_result,
                release_speed=release_speed,
                qc_result=qc_result,
                fps=metadata.fps
            )

        if progress_callback:
            progress_callback(100.0, "Analysis complete")

        return {
            "status": qc_result.status,
            "release_speed_kmh": release_speed.speed_km_h if release_speed else None,
            "c1_c2_speed_kmh": c1_c2_result.average_speed_km_h if c1_c2_result else None,
            "uncertainty_kmh": release_speed.uncertainty_km_h if release_speed else None,
            "qc_score": qc_result.quality_score,
            "rejection_reason": qc_result.rejection_reason,
            "json_report": json_out_path,
            "excel_report": excel_out_path,
            "final_video": final_vid_path if generate_videos else None,
            "diagnostic_video": diag_vid_path if generate_videos else None,
        }


def main():
    parser = argparse.ArgumentParser(description="Cricket Bowling Speed Measurement System")
    parser.add_argument("--video", type=str, required=True, help="Path to cricket video file")
    parser.add_argument("--calibration", type=str, default=None, help="Path to locked calibration JSON")
    parser.add_argument("--calibrate-only", action="store_true", help="Launch calibration UI, save calibration, then exit")
    parser.add_argument("--config-dir", type=str, default="config", help="Path to configuration directory")
    parser.add_argument("--output-dir", type=str, default="storage/results", help="Directory for output files")
    parser.add_argument("--headless", action="store_true", default=True, help="Run without UI prompts (default: True)")
    parser.add_argument("--interactive", action="store_true", help="Launch interactive manual calibration GUI if auto-calibration fails")
    parser.add_argument("--force-manual", action="store_true", help="Bypass automatic stump calibration and force interactive manual 8-point landmark selection")
    parser.add_argument("--radar-speed", type=float, default=None, help="Independent radar gun speed for benchmark comparison")
    parser.add_argument("--no-video-output", action="store_true", help="Skip rendering output MP4 videos")

    args = parser.parse_args()

    pipeline = CricketSpeedPipeline(config_dir=args.config_dir)
    res = pipeline.process_delivery(
        video_path=args.video,
        calibration_path=args.calibration,
        calibrate_only=args.calibrate_only,
        headless=not args.interactive,
        force_manual=args.force_manual,
        radar_speed=args.radar_speed,
        output_dir=args.output_dir,
        generate_videos=not args.no_video_output
    )

    print("\n" + "=" * 60)
    print("CRICKET BOWLING SPEED MEASUREMENT SUMMARY")
    print("=" * 60)
    print(f"Status:             {res.get('status')}")
    if res.get('status') in ("MEASURED", "ESTIMATED"):
        spd = res.get('release_speed_kmh')
        unc = res.get('uncertainty_kmh')
        unc_str = f" (+- {unc:.1f} km/h)" if unc is not None else ""
        spd_str = f"{spd:.1f} km/h" if spd is not None else "N/A"
        print(f"Release Speed:      {spd_str}{unc_str} [{res.get('status')}]")
        if res.get('c1_c2_speed_kmh'):
            print(f"C1-C2 Avg Speed:    {res.get('c1_c2_speed_kmh'):.1f} km/h")
        if res.get('qc_score') is not None:
            print(f"Quality Score:      {res.get('qc_score'):.0f} / 100")
    if res.get('rejection_reason'):
        print(f"Notes / Reasons:    {res.get('rejection_reason')}")

    print(f"JSON Report:        {res.get('json_report')}")
    print(f"Excel Report:       {res.get('excel_report')}")
    if res.get('final_video'):
        print(f"Final Video:        {res.get('final_video')}")
    if res.get('diagnostic_video'):
        print(f"Diagnostic Video:   {res.get('diagnostic_video')}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
