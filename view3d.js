// Attitude view: the FreeCAD model (stabarrow.bin from Mechanik/Skripte/export_app_model.py)
// rotated by the measured gravity direction. Only roll and pitch are observable from gravity;
// the heading is kept from the previous frame (smallest correcting rotation each step), so the
// model never jumps, also with the nose straight up or down. WebGL2, no libraries.
// Frames: model axes x forward, y right, z down; world: same with z = gravity (down).

// --- quaternions [w,x,y,z], pure functions (tested in tests/view3d.test.js) ---
export const IDENTITY=[1,0,0,0];
export function qmul(a,b) {
  return [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
    a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
}
const qnorm=q=>{const n=Math.hypot(...q);return q.map(v=>v/n);};
export function rotate(q,v) {
  const p=qmul(qmul(q,[0,...v]),[q[0],-q[1],-q[2],-q[3]]);return p.slice(1);
}
// Rotation by `fraction` of the smallest rotation that turns unit vector a onto b.
export function fromTo(a,b,fraction=1) {
  const dot=Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));
  let axis=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len=Math.hypot(...axis);
  const full=Math.atan2(len,dot);
  if(len<1e-9) {
    if(dot>0) return IDENTITY;
    // Opposite: any axis perpendicular to a.
    axis=Math.abs(a[0])<0.9?[0,-a[2],a[1]]:[-a[2],0,a[0]];len=Math.hypot(...axis);
  }
  const angle=full*fraction,s=Math.sin(angle/2)/len;
  return [Math.cos(angle/2),axis[0]*s,axis[1]*s,axis[2]*s];
}
// One update: q (model -> world) turned so the measured model "down" points to world down.
// fraction < 1 smooths the 10 Hz live samples. The heading (unobservable) slowly returns to
// "nose away from the viewer" by a turn about world down, which keeps roll and pitch unchanged;
// skipped while the nose is near vertical, where the heading is undefined.
export function attitudeStep(q,down,fraction=0.35,headingReturn=0.05) {
  if(!down) return q;
  q=qnorm(qmul(fromTo(rotate(q,down),[0,0,1],fraction),q));
  const nose=rotate(q,[1,0,0]);
  if(Math.hypot(nose[0],nose[1])<0.3) return q;
  const yaw=-Math.atan2(nose[1],nose[0])*headingReturn;
  return qnorm(qmul([Math.cos(yaw/2),0,0,Math.sin(yaw/2)],q));
}
// Roll/pitch in degrees for the text display (aviation convention, from the down vector).
export function rollPitch(down) {
  const [x,y,z]=down;
  return {roll:Math.atan2(y,z)*180/Math.PI,pitch:Math.atan2(-x,Math.hypot(y,z))*180/Math.PI};
}

// --- mesh file ---
export function parseModel(buffer) {
  const d=new DataView(buffer),tag=String.fromCharCode(...new Uint8Array(buffer,0,4));
  if(tag!=='ARM1') throw Error('3D-Modell: unbekanntes Format');
  const count=d.getUint16(4,true),unit=d.getFloat32(8,true),parts=[];let o=12;
  for(let i=0;i<count;i++) {
    const color=[d.getUint8(o),d.getUint8(o+1),d.getUint8(o+2)].map(v=>v/255),flags=d.getUint8(o+3);
    const vertices=d.getUint32(o+4,true),indices=d.getUint32(o+8,true);o+=12;
    const positions=new Int16Array(buffer.slice(o,o+vertices*6));o+=vertices*6;o+=(4-o%4)%4;
    const wide=vertices>65536,index=wide?new Uint32Array(buffer.slice(o,o+indices*4)):new Uint16Array(buffer.slice(o,o+indices*2));
    o+=indices*(wide?4:2);o+=(4-o%4)%4;
    parts.push({color,flags,positions,index});
  }
  return {unit,parts};
}

// --- rendering ---
const VS=`#version 300 es
in vec3 position;uniform mat4 model,view,projection;uniform float unit;out vec3 eye;
void main(){vec4 p=view*model*vec4(position*unit,1.0);eye=p.xyz;gl_Position=projection*p;}`;
const FS=`#version 300 es
precision mediump float;in vec3 eye;uniform vec3 color;uniform float flat_;out vec4 outColor;
void main(){
  if(flat_>0.5){outColor=vec4(color,1.0);return;}
  vec3 n=normalize(cross(dFdx(eye),dFdy(eye)));vec3 l=normalize(vec3(0.4,0.8,0.6));
  float diffuse=abs(dot(n,l));outColor=vec4(color*(0.35+0.65*diffuse),1.0);
}`;
// Model/world (x fwd, y right, z down) -> GL (x right, y up, z towards the viewer).
const TO_GL=[0,0,-1,0, 1,0,0,0, 0,-1,0,0, 0,0,0,1]; // column-major
function mat4mul(a,b) {
  const r=new Array(16).fill(0);
  for(let c=0;c<4;c++) for(let row=0;row<4;row++) for(let k=0;k<4;k++) r[c*4+row]+=a[k*4+row]*b[c*4+k];
  return r;
}
function quatMat(q) {
  const [w,x,y,z]=q;
  return [1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y),0, 2*(x*y-w*z),1-2*(x*x+z*z),2*(y*z+w*x),0,
    2*(x*z+w*y),2*(y*z-w*x),1-2*(x*x+y*y),0, 0,0,0,1];
}
function rotX(a){const c=Math.cos(a),s=Math.sin(a);return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1];}
function rotY(a){const c=Math.cos(a),s=Math.sin(a);return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];}
const translate=(x,y,z)=>[1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
function perspective(fov,aspect,near,far) {
  const f=1/Math.tan(fov/2),nf=1/(near-far);
  return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
}
export class AttitudeView {
  constructor(canvas) {
    this.canvas=canvas;this.q=IDENTITY;this.parts=[];
    const gl=this.gl=canvas.getContext('webgl2',{antialias:true});
    if(!gl) throw Error('WebGL2 nicht verfügbar');
    const shader=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));return s;};
    const p=this.program=gl.createProgram();
    gl.attachShader(p,shader(gl.VERTEX_SHADER,VS));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,FS));gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    this.loc=Object.fromEntries(['model','view','projection','unit','color','flat_'].map(n=>[n,gl.getUniformLocation(p,n)]));
    this.grid=this._grid();
  }
  _buffer(positions,index) {
    const gl=this.gl,vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,positions,gl.STATIC_DRAW);
    const at=gl.getAttribLocation(this.program,'position');gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at,3,positions instanceof Int16Array?gl.SHORT:gl.FLOAT,false,0,0);
    let count=positions.length/3,type=null;
    if(index){const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,index,gl.STATIC_DRAW);
      count=index.length;type=index instanceof Uint32Array?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT;}
    gl.bindVertexArray(null);return {vao,count,type};
  }
  // Ground grid in world coordinates (mm), 30 mm below the model centre.
  _grid() {
    const lines=[];
    for(let i=-100;i<=100;i+=20) lines.push(i,-100,30,i,100,30,-100,i,30,100,i,30);
    return this._buffer(new Float32Array(lines),null);
  }
  async load(url) {
    const response=await fetch(url);if(!response.ok) throw Error('3D-Modell nicht gefunden');
    const model=parseModel(await response.arrayBuffer());this.unit=model.unit;
    this.parts=model.parts.map(p=>({...p,...this._buffer(p.positions,p.index)}));
    this.render();
  }
  update(down,fraction) {this.q=attitudeStep(this.q,down,fraction);this.render();}
  reset() {this.q=IDENTITY;this.render();}
  render() {
    const gl=this.gl,c=this.canvas,dpr=Math.min(2,globalThis.devicePixelRatio||1);
    const w=Math.round(c.clientWidth*dpr),h=Math.round(c.clientHeight*dpr);
    if(!w||!h) return;
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
    gl.viewport(0,0,w,h);gl.clearColor(0.055,0.098,0.133,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.useProgram(this.program);
    // Camera behind, right and above the model, looking at the centre.
    const view=mat4mul(translate(0,0,-190),mat4mul(rotX(0.42),rotY(-0.75)));
    gl.uniformMatrix4fv(this.loc.view,false,view);
    gl.uniformMatrix4fv(this.loc.projection,false,perspective(0.6,w/h,10,1000));
    gl.uniform1f(this.loc.flat_,1);gl.uniform1f(this.loc.unit,1);gl.uniform3fv(this.loc.color,[0.17,0.24,0.29]);
    gl.uniformMatrix4fv(this.loc.model,false,TO_GL);
    gl.bindVertexArray(this.grid.vao);gl.drawArrays(gl.LINES,0,this.grid.count);
    gl.uniform1f(this.loc.flat_,0);gl.uniform1f(this.loc.unit,this.unit||0.01);
    gl.uniformMatrix4fv(this.loc.model,false,mat4mul(TO_GL,quatMat(this.q)));
    for(const p of this.parts) {
      gl.uniform3fv(this.loc.color,p.color);gl.bindVertexArray(p.vao);gl.drawElements(gl.TRIANGLES,p.count,p.type,0);
    }
    gl.bindVertexArray(null);
  }
}
