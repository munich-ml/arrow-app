// Mounting of the XIAO in the model. Body frame: x forward, y right, z down; rates
// roll/pitch/yaw follow the right-hand rule. Acceleration is shown as load factor
// n = -a_measured, so the vertical axis reads +1 g with the model upright (servos up).
// The rotation sensor -> body is the gyro mapping; the accel mapping is that rotation negated.
// History: the first tilt test (04.11.2026) was done upside down and corrected by 180 degrees
// about the longitudinal axis. Frame Rev U then turned the XIAO 180 degrees about the vertical
// axis (components still down, USB now to port / CAD -Y): x, y, roll and pitch flipped again.
// Flash and the raw CSV columns keep sensor axes; only display and extra CSV columns use this.
export const BODY_COLUMNS=['p_dps','q_dps','r_dps','nx_g','ny_g','nz_g'];
// Plain aviation terms for the UI; signs are explained in the analysis tooltip.
export const BODY_LABELS={gyro:['Rollen','Nicken','Gieren'],accel:['Längsachse','Querachse','Hochachse']};
// Sensor order gx,gy,gz,ax,ay,az -> body order p,q,r,nx,ny,nz.
export function bodyAxes([gx,gy,gz,ax,ay,az]) {
  return [-gy,gx,gz,ay,-ax,-az].map(v=>v+0); // +0 turns -0 into 0
}
