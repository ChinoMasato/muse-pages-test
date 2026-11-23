/* relief-viewer.js — 深度マップで変位させた relief メッシュ表示（IKEBEROTH方式）
 *
 * 使い方:
 *   <canvas class="relief-view" data-diffuse="img_R_diff.webp" data-norm="img_R_norm.webp"
 *           data-depth="img_depth.png" data-depth-scale="0.85"></canvas>
 *   <script src="relief-viewer.js"></script>
 * 深度は Depth Anything V2 で推定した相対深度（明るいほど手前）。
 * 一枚絵を細分化メッシュの頂点深度として変位させ、透視カメラで描くため、
 * 視点を動かすと本物の遠近で絵が回り込む。質感は normal / roughness の
 * PBRライティングで付ける（diffuse には AO を折込済み、norm の A は roughness）。
 * ポインタで視点と光源が動き、無操作時はゆっくり周回する。
 * WebGL不可・頂点テクスチャ不可なら通常画像にフォールバックする。
 */
(function () {
  const VS = `
    attribute vec3 p; attribute vec2 aUv;
    uniform mat4 uMvp; uniform mat3 uRot;
    varying vec2 vUv; varying vec3 vPos;
    void main(){
      vUv = aUv;
      vPos = uRot * p;
      gl_Position = uMvp * vec4(p, 1.0);
    }`;
  const FS = `precision highp float; varying vec2 vUv; varying vec3 vPos;
    uniform sampler2D uDiff, uNorm; uniform vec3 uLight; uniform mat3 uRot;
    void main(){
      vec3 base = texture2D(uDiff, vUv).rgb;
      vec4 nm = texture2D(uNorm, vUv);
      vec3 n = nm.rgb * 2.0 - 1.0; n.y = -n.y; n = normalize(uRot * n);
      float rough = nm.a;
      vec3 L = normalize(uLight - vPos);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float diff = max(dot(n, L), 0.0);
      float spec = pow(max(dot(n, H), 0.0), mix(90.0, 8.0, rough)) * (1.0 - rough * 0.75);
      float dist = length(uLight - vPos);
      float atten = 1.0 / (1.0 + 0.30 * dist * dist);
      vec3 col = base * (0.36 + 0.95 * diff * atten) + spec * atten * vec3(1.0, 0.98, 0.92);
      gl_FragColor = vec4(col, 1.0);
    }`;

  function loadTex(gl, url) {
    return new Promise((res) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([128, 128, 255, 255]));
      if (!url) return res(null);
      const img = new Image();
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        res(tex);
      };
      img.onerror = () => res(null);
      img.src = url;
    });
  }
  // 最小限の行列ユーティリティ（行優先で計算し、転置してGLへ渡す）
  function mvp(fov, aspect, camZ, rx, ry) {
    const f = 1 / Math.tan(fov / 2), near = 0.1, far = 20;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    const P = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), 2 * far * near / (near - far), 0, 0, -1, 0];
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -camZ, 0, 0, 0, 1];
    const Ry = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1];
    const Rx = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1];
    const mul = (a, b) => { const o = new Array(16).fill(0); for (let r2 = 0; r2 < 4; r2++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r2 * 4 + k] * b[k * 4 + c]; o[r2 * 4 + c] = s; } return o; };
    const M = mul(P, mul(T, mul(Rx, Ry)));
    const R = mul(Rx, Ry);
    const tp = (m) => { const o = new Float32Array(16); for (let r2 = 0; r2 < 4; r2++) for (let c = 0; c < 4; c++) o[c * 4 + r2] = m[r2 * 4 + c]; return o; };
    const tp3 = (m) => { const o = new Float32Array(9); for (let r2 = 0; r2 < 3; r2++) for (let c = 0; c < 3; c++) o[c * 3 + r2] = m[r2 * 4 + c]; return o; };
    return { mvp: tp(M), rot: tp3(R) };
  }

  async function init(canvas) {
    const fallback = () => {
      const img = document.createElement('img');
      img.src = canvas.dataset.diffuse; img.style.width = '100%';
      canvas.replaceWith(img);
    };
    const gl = canvas.getContext('webgl');
    if (!gl || !gl.getExtension('OES_element_index_uint')) return fallback();
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fallback();
    gl.useProgram(prog);
    // グリッド形状（16:9）: 深度はCPU側で読み、頂点を変位させておく。
    // 深度差の大きい三角形は切り捨てる（イケベロスの cutTriangles と同じ考え方で、
    // 輪郭でテクスチャが引き伸ばされる破綻を防ぐ）。
    const SX = 320, SY = 180, W = 3.56, H = 2.0;
    const dImg = await new Promise((res) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null);
      i.src = canvas.dataset.depth;
    });
    if (!dImg) return fallback();
    const dc = document.createElement('canvas'); dc.width = SX + 1; dc.height = SY + 1;
    const dctx = dc.getContext('2d', { willReadFrequently: true });
    dctx.drawImage(dImg, 0, 0, SX + 1, SY + 1);
    const dpx = dctx.getImageData(0, 0, SX + 1, SY + 1).data;
    const depthAt = (x, y) => dpx[((SY - y) * (SX + 1) + x) * 4] / 255;
    const depthScale = parseFloat(canvas.dataset.depthScale || '0.62');
    const pos = [], uv = [], idx = [];
    for (let y = 0; y <= SY; y++) for (let x = 0; x <= SX; x++) {
      pos.push(-W / 2 + W * x / SX, -H / 2 + H * y / SY, (depthAt(x, y) - 0.35) * depthScale);
      uv.push(x / SX, y / SY);
    }
    for (let y = 0; y < SY; y++) for (let x = 0; x < SX; x++) {
      const a = y * (SX + 1) + x, b = a + 1, c = a + SX + 1, d2 = c + 1;
      idx.push(a, b, c, b, d2, c);
    }
    const mk = (arr, size, type) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog, type); gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
    };
    mk(pos, 3, 'p'); mk(uv, 2, 'aUv');
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    const idxCount = idx.length;

    const d = canvas.dataset;
    const [td, tn] = await Promise.all([loadTex(gl, d.diffuse), loadTex(gl, d.norm)]);
    if (!td || !tn) return fallback();
    const bind = (name, tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    };
    bind('uDiff', td, 0); bind('uNorm', tn, 1);
    const mvpLoc = gl.getUniformLocation(prog, 'uMvp');
    const rotLoc = gl.getUniformLocation(prog, 'uRot');
    const fsRotLoc = gl.getUniformLocation(prog, 'uRot');
    const lightLoc = gl.getUniformLocation(prog, 'uLight');

    let mx = null, my = null, lastPointer = -1e9;
    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width; my = 1 - (e.clientY - r.top) / r.height;
      lastPointer = performance.now();
    };
    addEventListener('pointermove', onMove);
    addEventListener('mousemove', onMove);
    function frame(t) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w > 0 && canvas.width !== Math.round(w * devicePixelRatio)) { canvas.width = Math.round(w * devicePixelRatio); canvas.height = Math.round(h * devicePixelRatio); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      let vx, vy;
      if (mx === null || t - lastPointer > 4000) {
        vx = 0.5 + 0.30 * Math.cos(t * 0.00042); vy = 0.55 + 0.19 * Math.sin(t * 0.00042);
      } else { vx = mx; vy = my; }
      const ry = (vx - 0.5) * 0.16, rx = -(vy - 0.5) * 0.10;
      const { mvp: m, rot } = mvp(0.60, W / H, 3.23, rx, ry);
      gl.uniformMatrix4fv(mvpLoc, false, m);
      gl.uniformMatrix3fv(rotLoc, false, rot);
      gl.uniform3f(lightLoc, (vx - 0.5) * 3.2, (vy - 0.5) * 1.9, 1.6);
      gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_INT, 0);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  document.querySelectorAll('canvas.relief-view').forEach(init);
})();
