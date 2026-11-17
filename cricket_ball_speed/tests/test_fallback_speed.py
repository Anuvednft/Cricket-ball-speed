"""
Unit tests for Fallback Speed Estimator, Canonical Camera Model, and Fallback Deliverables.
"""

import unittest
import numpy as np
import tempfile
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from speed.fallback_speed_estimator import (
    FallbackSpeedEstimator,
    create_canonical_camera_model,
    create_canonical_drs_line,
    create_canonical_reprojection_report
)
from filtering.prediction_manager import TrackStatePoint
from ball_processing.ball_observations import BallObservation
from detection.bowler_detector import BowlerObservation
from release.release_detector import ReleaseEvent


class DummyMetadata:
    def __init__(self, width=1920, height=1080, fps=30.0, total_frames=30, file_hash="abcdef1234567890"):
        self.width = width
        self.height = height
        self.fps = fps
        self.total_frames = total_frames
        self.file_hash = file_hash
        self.file_name = "test_delivery.mp4"
        self.duration_seconds = total_frames / fps


class TestFallbackSpeedEstimator(unittest.TestCase):

    def test_canonical_camera_model(self):
        """Tests that canonical camera model constructs valid projection geometry."""
        cam = create_canonical_camera_model(1920, 1080)
        self.assertEqual(cam.width, 1920)
        self.assertEqual(cam.height, 1080)
        self.assertAlmostEqual(cam.cx, 960.0)
        self.assertGreater(cam.fx, 1000.0)

        # Near stumps base (0, 0, 0) should project in bottom half of image
        u_near, v_near = cam.project_point(np.array([0.0, 0.0, 0.0]))
        self.assertAlmostEqual(u_near, 960.0, delta=5.0)
        self.assertGreater(v_near, 900.0)

        # Far stumps base (0, 20.12, 0) should project in upper-middle of image
        u_far, v_far = cam.project_point(np.array([0.0, 20.12, 0.0]))
        self.assertAlmostEqual(u_far, 960.0, delta=5.0)
        self.assertLess(v_far, v_near)
        self.assertGreater(v_far, 400.0)

    def test_canonical_drs_line(self):
        """Tests that canonical DRS line spans positive pixel length along pitch."""
        drs = create_canonical_drs_line(1920, 1080)
        self.assertTrue(drs.is_valid)
        self.assertGreater(drs.pixel_length, 200.0)
        self.assertEqual(drs.real_distance_m, 20.12)

    def test_canonical_reprojection_report(self):
        """Tests canonical reprojection report formatting."""
        rep = create_canonical_reprojection_report()
        self.assertTrue(rep.is_acceptable)
        self.assertLess(rep.mean_error_px, 3.0)

    def test_fallback_with_partial_ball_detections(self):
        """Tests fallback estimator when 3 ball points are detected across frames."""
        estimator = FallbackSpeedEstimator()
        meta = DummyMetadata(width=1920, height=1080, fps=60.0, total_frames=45)

        # Create 3 ball observations progressing down-pitch (v decreasing from 850 to 520)
        tracked = []
        real_pts = []
        frames_and_v = [(10, 0.166, 850.0), (16, 0.266, 710.0), (22, 0.366, 560.0)]

        for f_idx, ts, v_px in frames_and_v:
            obs = BallObservation.from_bbox(
                frame_idx=f_idx,
                timestamp_sec=ts,
                bbox=[950.0, v_px - 10.0, 970.0, v_px + 10.0],
                confidence=0.82
            )
            tp = TrackStatePoint(
                frame_index=f_idx,
                timestamp_sec=ts,
                point_type="OBSERVED",
                u=960.0,
                v=v_px,
                velocity_u=0.0,
                velocity_v=-100.0,
                confidence=0.82,
                observation=obs,
                is_real_detection=True
            )
            tracked.append(tp)
            real_pts.append(tp)

        res = estimator.estimate_fallback(
            metadata=meta,
            camera_model=None,
            tracked_points=tracked,
            real_tracked_points=real_pts,
            bowler_observations=[]
        )

        rel_speed = res["release_speed"]
        c1c2 = res["c1_c2_result"]
        qc = res["qc_result"]

        self.assertEqual(rel_speed.status, "ESTIMATED")
        self.assertTrue(rel_speed.is_valid)
        self.assertGreaterEqual(rel_speed.speed_km_h, 75.0)
        self.assertLessEqual(rel_speed.speed_km_h, 140.0)
        self.assertGreater(rel_speed.uncertainty_km_h, 0.0)

        # C1-C2 speed should be slightly lower than release speed due to drag
        self.assertLess(c1c2.average_speed_km_h, rel_speed.speed_km_h)
        self.assertAlmostEqual(c1c2.average_speed_km_h, rel_speed.speed_km_h * 0.923, delta=2.5)

        # QC status
        self.assertEqual(qc.status, "ESTIMATED")
        self.assertFalse(qc.is_measured)
        self.assertGreaterEqual(qc.quality_score, 60.0)

    def test_fallback_radar_anchoring(self):
        """Tests that when radar benchmark speed is provided, fallback anchors to it."""
        estimator = FallbackSpeedEstimator()
        meta = DummyMetadata()

        res = estimator.estimate_fallback(
            metadata=meta,
            camera_model=None,
            tracked_points=[],
            real_tracked_points=[],
            bowler_observations=[],
            radar_speed=118.5
        )

        rel_speed = res["release_speed"]
        self.assertAlmostEqual(rel_speed.speed_km_h, 118.5)
        self.assertEqual(rel_speed.status, "ESTIMATED")

    def test_fallback_synthetic_trajectory_generation(self):
        """Tests that synthetic 3D trajectory points are generated for diagnostic rendering."""
        estimator = FallbackSpeedEstimator()
        meta = DummyMetadata()

        res = estimator.estimate_fallback(
            metadata=meta,
            camera_model=None,
            tracked_points=[],
            real_tracked_points=[],
            bowler_observations=[]
        )

        traj = res["trajectory_result"]
        self.assertIsNotNone(traj)
        self.assertTrue(len(traj.fitted_3d_points) >= 8)

        # First point should be near release (Y ~ 1.2m, Z ~ 2.0m)
        p0 = traj.fitted_3d_points[0]
        self.assertAlmostEqual(p0.y, 1.20, delta=0.2)
        self.assertAlmostEqual(p0.z, 2.05, delta=0.2)

        # Later points should move down-pitch (Y increasing)
        p_last = traj.fitted_3d_points[-1]
        self.assertGreater(p_last.y, p0.y + 5.0)


if __name__ == "__main__":
    unittest.main()
