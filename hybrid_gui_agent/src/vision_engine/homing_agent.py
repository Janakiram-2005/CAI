import cv2
import numpy as np
import math

def evaluate_coordinate_drift(calculated_pt, anchor_pt):
    """
    Compute Euclidean distance between calculated point and anchor point.
    """
    if calculated_pt is None or anchor_pt is None:
        return 0.0
    return math.sqrt((calculated_pt[0] - anchor_pt[0]) ** 2 + (calculated_pt[1] - anchor_pt[1]) ** 2)

class VisualHomingAgent:
    def __init__(self, drift_threshold=10):
        self.drift_threshold = drift_threshold

    def resolve_precision_click(self, master_screenshot, initial_x, initial_y, semantic_label=None, anchor_pt=None):
        """
        Closed-loop visual homing resolution.
        """
        # Ensure we have a valid numpy image
        if master_screenshot is None or not isinstance(master_screenshot, np.ndarray):
            print("[VisualHoming] Warning: Invalid master screenshot. Falling back to initial coords.")
            return initial_x, initial_y

        h, w = master_screenshot.shape[:2]
        
        # 1. Proximity check
        if anchor_pt is None:
            anchor_pt = (initial_x, initial_y)

        drift = evaluate_coordinate_drift((initial_x, initial_y), anchor_pt)
        if drift <= self.drift_threshold:
            print(f"[VisualHoming] Initial coordinate drift ({drift:.2f} px) is within threshold. Skipping loop.")
            return int(initial_x), int(initial_y)

        print(f"[VisualHoming] Initial drift is {drift:.2f} px (exceeds threshold {self.drift_threshold} px). Triggering Tracer loop.")

        curr_x, curr_y = initial_x, initial_y
        max_retries = 3
        
        for attempt in range(max_retries):
            # 2. Dynamic safe radius calculation
            radius = int(max(drift * 1.5, 32))
            
            # Safe boundary bounds check
            x_min = max(0, int(curr_x - radius))
            x_max = min(w, int(curr_x + radius))
            y_min = max(0, int(curr_y - radius))
            y_max = min(h, int(curr_y + radius))

            if (x_max - x_min) <= 0 or (y_max - y_min) <= 0:
                break

            # Slicing patch ROI
            cropped_patch = master_screenshot[y_min:y_max, x_min:x_max]

            # 3. Local Feature detection
            # Convert to grayscale
            if len(cropped_patch.shape) == 3 and cropped_patch.shape[2] == 4:
                gray = cv2.cvtColor(cropped_patch, cv2.COLOR_BGRA2GRAY)
            elif len(cropped_patch.shape) == 3:
                gray = cv2.cvtColor(cropped_patch, cv2.COLOR_BGR2GRAY)
            else:
                gray = cropped_patch

            # High-speed Canny edge detection
            edges = cv2.Canny(gray, 50, 150)
            
            # Locate structural boundaries
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            if not contours:
                print(f"[VisualHoming] Attempt {attempt+1}: No visual features/contours detected in cropped ROI.")
                break

            # Find contour whose center is closest to the patch center
            patch_center_x = (x_max - x_min) / 2.0
            patch_center_y = (y_max - y_min) / 2.0
            
            best_contour = None
            min_dist = float('inf')
            best_cx, best_cy = patch_center_x, patch_center_y

            for c in contours:
                M = cv2.moments(c)
                if M["m00"] != 0:
                    cx = M["m10"] / M["m00"]
                    cy = M["m01"] / M["m00"]
                else:
                    x_b, y_b, w_b, h_b = cv2.boundingRect(c)
                    cx = x_b + w_b / 2.0
                    cy = y_b + h_b / 2.0
                
                dist = math.sqrt((cx - patch_center_x) ** 2 + (cy - patch_center_y) ** 2)
                if dist < min_dist:
                    min_dist = dist
                    best_contour = c
                    best_cx, best_cy = cx, cy

            # Local delta offset inside patch
            local_x_delta = best_cx - patch_center_x
            local_y_delta = best_cy - patch_center_y
            
            # Map back to global metrics
            new_global_x = curr_x + local_x_delta
            new_global_y = curr_y + local_y_delta
            
            # Re-evaluate drift
            new_drift = evaluate_coordinate_drift((new_global_x, new_global_y), anchor_pt)
            print(f"[VisualHoming] Attempt {attempt+1}: Recalculated coordinates ({new_global_x:.2f}, {new_global_y:.2f}) - New drift: {new_drift:.2f} px")
            
            curr_x, curr_y = new_global_x, new_global_y
            drift = new_drift
            
            if drift <= self.drift_threshold:
                print(f"[VisualHoming] Convergence achieved! Final coordinate: ({curr_x:.2f}, {curr_y:.2f})")
                return int(curr_x), int(curr_y)

        print(f"[VisualHoming] Tracer did not fully converge (final drift: {drift:.2f} px). Falling back to prediction.")
        return int(initial_x), int(initial_y)
