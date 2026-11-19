"""
Final Processed Video Generator.
Produces clean, broadcast-ready output video showing ONLY:
  1. Calculated bowling speed in km/h.
  2. Date and time.

STRICT VISUAL CONSTRAINTS:
- The speed badge is positioned in the upper-left region (not touching the top edge, not in the middle-left).
- Strictly OMITS ball markers, bounding boxes, frame counters, calibration lines, and diagnostic labels.
- Freezes the final frame for a configurable duration (default 1.5s) to allow viewer comprehension.
- Independent of detection and optimization pipelines (operates on plain data dicts or result objects).
"""

from typing import Optional, Tuple, Dict, Any, Union
import datetime
import os
import sys
import cv2
import numpy as np


class FinalVideoRenderer:
    """
    Renders clean broadcast-style speed telemetry graphics onto video frames.
    """

    def __init__(
        self,
        freeze_seconds: float = 1.5,
        margin_left_ratio: float = 0.035,   # ~67px at 1080p
        margin_top_ratio: float = 0.065,    # ~70px at 1080p (safe broadcast margin, not touching top)
        badge_width_ratio: float = 0.170,   # ~326px at 1080p
        badge_height_ratio: float = 0.090   # ~97px at 1080p
    ):
        self.freeze_sec = max(0.0, float(freeze_seconds))
        self.ml_ratio = margin_left_ratio
        self.mt_ratio = margin_top_ratio
        self.bw_ratio = badge_width_ratio
        self.bh_ratio = badge_height_ratio

    def compute_badge_rect(self, frame_w: int, frame_h: int) -> Tuple[int, int, int, int]:
        """Computes resolution-independent upper-left badge coordinates."""
        bx = int(round(frame_w * self.ml_ratio))
        by = int(round(frame_h * self.mt_ratio))
        bw = max(240, int(round(frame_w * self.bw_ratio)))
        bh = max(80, int(round(frame_h * self.bh_ratio)))
        return bx, by, bw, bh

    def render_badge(
        self,
        frame: np.ndarray,
        speed_text: str,
        timestamp_str: str,
        is_measured: bool = True,
        status: str = "MEASURED"
    ) -> np.ndarray:
        """
        Overlays a clean speed badge in the upper-left area showing ONLY:
          - the date and time (small, top line)
          - the speed (large, bottom line)
        `is_measured` and `status` are accepted for compatibility but are never drawn.
        The dark panel is sized from the text itself, so the text always fits inside it
        for landscape, portrait (phone) and 4K videos alike.
        """
        h, w = frame.shape[:2]
        out_frame = frame.copy()

        # Scale from the longer side (1920 px = 1.0): identical to the old look for landscape
        # video, and a sensible size for portrait (phone) video.
        s = max(w, h) / 1920.0

        has_speed = "NOT MEASURED" not in speed_text
        date_font = cv2.FONT_HERSHEY_SIMPLEX
        speed_font = cv2.FONT_HERSHEY_DUPLEX
        date_scale = max(0.35, 0.44 * s)
        speed_scale = max(0.55, (1.05 if has_speed else 0.72) * s)
        date_thick = max(1, int(round(1.0 * s)))
        speed_thick = max(2, int(round(2.0 * s)))
        pad = max(10, int(round(16 * s)))
        gap = max(8, int(round(14 * s)))
        stripe_w = max(4, int(round(6 * s)))

        (date_w, date_h), _ = cv2.getTextSize(timestamp_str, date_font, date_scale, date_thick)
        (speed_w, speed_h), speed_base = cv2.getTextSize(speed_text, speed_font, speed_scale, speed_thick)

        bw = stripe_w + pad + max(date_w, speed_w) + pad
        bh = pad + date_h + gap + speed_h + speed_base + pad

        # Position: upper-left (same safe margins as before), always fully inside the frame
        bx, by, _, _ = self.compute_badge_rect(w, h)
        bx = max(0, min(bx, w - bw))
        by = max(0, min(by, h - bh))

        # Dark semi-transparent panel with a green accent stripe on the left
        overlay = out_frame.copy()
        cv2.rectangle(overlay, (bx, by), (bx + bw, by + bh), (18, 22, 28), -1)
        cv2.rectangle(overlay, (bx, by), (bx + stripe_w, by + bh), (46, 204, 113), -1)
        cv2.addWeighted(overlay, 0.85, out_frame, 0.15, 0, out_frame)
        cv2.rectangle(out_frame, (bx, by), (bx + bw, by + bh), (60, 68, 76), 1)

        text_x = bx + stripe_w + pad
        # Date and time (small, grey)
        cv2.putText(
            out_frame, timestamp_str, (text_x, by + pad + date_h),
            date_font, date_scale, (190, 200, 210), date_thick, cv2.LINE_AA
        )
        # Speed (large, white)
        val_color = (255, 255, 255) if has_speed else (180, 180, 245)
        cv2.putText(
            out_frame, speed_text, (text_x, by + pad + date_h + gap + speed_h),
            speed_font, speed_scale, val_color, speed_thick, cv2.LINE_AA
        )

        return out_frame


def generate_final_video(
    input_video_path: str,
    output_video_path: str,
    qc_result: Union[Any, Dict[str, Any], bool],
    release_speed: Optional[Union[Any, Dict[str, Any], float]] = None,
    fps: float = 60.0,
    freeze_last_frame_seconds: float = 1.5,
    custom_timestamp_str: Optional[str] = None,
    release_frame_index: Optional[int] = None,
    show_delay_after_release_sec: float = 1.0
) -> str:
    """
    Renders the broadcast final video showing ONLY bowling speed and date/time.
    Supports decoupled inputs (dataclass objects, dicts, or raw values).
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_video_path)), exist_ok=True)
    cap = cv2.VideoCapture(input_video_path)
    if not cap.isOpened():
        raise IOError(f"Could not open input video: {input_video_path}")

    writer = None
    try:
        orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        in_fps = float(cap.get(cv2.CAP_PROP_FPS))
        out_fps = in_fps if in_fps > 0 else fps

        # Standardize ultra-high-res 4K videos (>1920px) to 1080p for web compatibility and fast rendering
        if max(orig_w, orig_h) > 1920:
            scale = 1920.0 / max(orig_w, orig_h)
            w = int(round(orig_w * scale))
            h = int(round(orig_h * scale))
        else:
            w, h = orig_w, orig_h

        codecs = ["mp4v"] if sys.platform == "win32" else ["avc1", "mp4v"]
        for codec in codecs:
            try:
                fourcc = cv2.VideoWriter_fourcc(*codec)
                test_writer = cv2.VideoWriter(output_video_path, fourcc, out_fps, (w, h))
                if test_writer.isOpened():
                    writer = test_writer
                    break
            except Exception:
                continue
        if writer is None or not writer.isOpened():
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(output_video_path, fourcc, out_fps, (w, h))

        renderer = FinalVideoRenderer(freeze_seconds=freeze_last_frame_seconds)

        # Resolve measurement status (decoupled from specific types)
        status_text = "MEASURED"
        if isinstance(qc_result, bool):
            is_measured = qc_result
            status_text = "MEASURED" if is_measured else "NOT_MEASURED"
        elif isinstance(qc_result, dict):
            status_text = qc_result.get("status", "NOT_MEASURED")
            is_measured = bool(qc_result.get("is_measured", False)) or (status_text == "MEASURED")
        else:
            status_text = getattr(qc_result, "status", "NOT_MEASURED")
            is_measured = bool(getattr(qc_result, "is_measured", False)) or (status_text == "MEASURED")

        # Resolve speed value (decoupled from specific types)
        speed_kmh = None
        if release_speed is not None:
            if isinstance(release_speed, (int, float)):
                speed_kmh = float(release_speed)
            elif isinstance(release_speed, dict):
                speed_kmh = release_speed.get("speed_km_h")
            else:
                speed_kmh = getattr(release_speed, "speed_km_h", None)

        if speed_kmh is not None and speed_kmh > 0.0:
            speed_str = f"{speed_kmh:.1f} km/h"
        else:
            speed_str = "NOT MEASURED"

        time_str = custom_timestamp_str or datetime.datetime.now().strftime("%Y-%m-%d  %H:%M:%S")

        # Speed appears `show_delay_after_release_sec` after the release frame.
        # If no release frame is known, the badge is shown only on the closing freeze frame.
        if release_frame_index is not None and release_frame_index >= 0:
            badge_start_frame = int(release_frame_index) + int(round(out_fps * max(0.0, show_delay_after_release_sec)))
        else:
            # Release unknown: never show the speed before the ball is thrown; show it on the closing freeze only.
            badge_start_frame = 10 ** 9

        last_frame = None
        last_plain_frame = None
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break
            if frame.shape[1] != w or frame.shape[0] != h:
                frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
            if frame_idx >= badge_start_frame:
                rendered = renderer.render_badge(
                    frame, speed_str, time_str, is_measured=is_measured, status=status_text
                )
            else:
                rendered = frame
            writer.write(rendered)
            last_frame = rendered
            last_plain_frame = frame
            frame_idx += 1

        # Freeze last frame if configured
        if last_frame is not None and freeze_last_frame_seconds > 0:
            freeze_src = last_frame
            # If the video ended before the speed was due to appear, still show it on the freeze
            if frame_idx <= badge_start_frame and last_plain_frame is not None:
                freeze_src = renderer.render_badge(
                    last_plain_frame, speed_str, time_str, is_measured=is_measured, status=status_text
                )
            freeze_frames = int(round(out_fps * freeze_last_frame_seconds))
            for _ in range(freeze_frames):
                writer.write(freeze_src)
    finally:
        cap.release()
        if writer is not None:
            writer.release()

    return output_video_path