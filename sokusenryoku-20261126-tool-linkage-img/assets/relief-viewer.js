/* relief-viewer.js — 一枚絵を歩ける2.5Dにするイケベロス方式の表示
 *
 * 使い方:
 *   <canvas class="relief-view" data-diffuse="img_R_diff.webp" data-norm="img_R_norm.webp"
 *           data-depth="img_depth.png"></canvas>
 *   <script src="relief-viewer.js"></script>
 *
 * 手順書「イケベロス｜一枚絵から歩ける2.5D画面を作る手順」に沿った実装:
 * - 深度は Depth Anything V2 の相対深度（明るいほど手前＝視差 d）。
 * - 各頂点を原画カメラから逆投影する: z = 1 / (1/far + d × (1/near − 1/far))、
 *   位置は ((2u−1)·aspect·t·z, (1−2v)·t·z, −z)、t = tan(FOV/2)、FOV は 38 度。
 *   この形だと中央視点で描画が原画と一致する。
 * - 視点移動は小さなカメラ並進。欠けが見えないよう少しクロップ（ズーム）してある。
 * - 質感は normal / roughness の PBR ライティング（diffuse には AO 折込済み、
 *   norm の A は roughness）。ライティングは UV 空間で計算する。
 * WebGL 不可なら通常画像にフォールバックする。
 */
(function () {
  const VS = `
    attribute vec3 p; attribute vec2 aUv; attribute float aD;
    uniform mat4 uMvp;
    varying vec2 vUv; varying float vD;
    void main(){
      vUv = aUv; vD = aD;
      gl_Position = uMvp * vec4(p, 1.0);
    }`;
  const FS = `precision highp float; varying vec2 vUv; varying float vD;
    uniform sampler2D uDiff, uNorm; uniform vec3 uLight;
    void main(){
      vec3 base = texture2D(uDiff, vUv).rgb;
      vec4 nm = texture2D(uNorm, vUv);
      vec3 n = nm.rgb * 2.0 - 1.0; n.y = -n.y; n = normalize(n);
      float rough = nm.a;
      vec3 P = vec3((vUv - 0.5) * vec2(3.56, 2.0), (vD - 0.35) * 0.62);
      vec3 L = normalize(uLight - P);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float diff = max(dot(n, L), 0.0);
      float spec = pow(max(dot(n, H), 0.0), mix(90.0, 8.0, rough)) * (1.0 - rough * 0.75);
      float dist = length(uLight - P);
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

    // 深度を読み、原画カメラから逆投影して頂点を作る
    const SX = 320, SY = 180, ASPECT = 16 / 9;
    const FOV = 38 * Math.PI / 180, T = Math.tan(FOV / 2);
    const NEAR = 2.4, FAR = 10.0;
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
    const pos = [], uv = [], dep = [], idx = [];
    for (let y = 0; y <= SY; y++) for (let x = 0; x <= SX; x++) {
      const u = x / SX, v = y / SY, d = depthAt(x, y);
      const z = 1 / (1 / FAR + d * (1 / NEAR - 1 / FAR));
      pos.push((2 * u - 1) * ASPECT * T * z, (2 * v - 1) * T * z, -z);
      uv.push(u, v); dep.push(d);
    }
    for (let y = 0; y < SY; y++) for (let x = 0; x < SX; x++) {
      const a = y * (SX + 1) + x, b = a + 1, c = a + SX + 1, d2 = c + 1;
      idx.push(a, b, c, b, d2, c);
    }
    const mk = (arr, size, type, itemSize) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog, type); gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, itemSize || size, gl.FLOAT, false, 0, 0);
    };
    mk(pos, 3, 'p'); mk(uv, 2, 'aUv'); mk(dep, 1, 'aD', 1);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);

    const d = canvas.dataset;
    const [td, tn] = await Promise.all([loadTex(gl, d.diffuse), loadTex(gl, d.norm)]);
    if (!td || !tn) return fallback();
    const bind = (name, tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    };
    bind('uDiff', td, 0); bind('uNorm', tn, 1);
    const mvpLoc = gl.getUniformLocation(prog, 'uMvp');
    const lightLoc = gl.getUniformLocation(prog, 'uLight');

    // 透視投影（FOV 38度）× カメラ並進。少しズームして並進時の欠けを防ぐ。
    const ZOOM = 1.13;
    const f = ZOOM / T;
    function mvpFor(tx, ty) {
      const near = 0.1, far = 30;
      // 行優先で P × T(-tx,-ty,0) を作り、転置して渡す
      const P = [f / ASPECT, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), 2 * far * near / (near - far), 0, 0, -1, 0];
      const M = P.slice();
      // P × translate: 列3 = P × (-tx, -ty, 0, 1)
      M[3] = P[0] * -tx; M[7] = P[5] * -ty; M[11] = P[10] * 0 + P[11] * 1;
      const o = new Float32Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = M[r * 4 + c];
      return o;
    }

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
      const tx = (vx - 0.5) * 0.44, ty = (vy - 0.5) * 0.24;
      gl.uniformMatrix4fv(mvpLoc, false, mvpFor(tx, ty));
      gl.uniform3f(lightLoc, (vx - 0.5) * 3.2, (vy - 0.5) * 1.9, 1.6);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  document.querySelectorAll('canvas.relief-view').forEach(init);
})();
