/* pbr-layer-viewer.js — PBRライティング × 多層スプライト視差の合体表示
 *
 * 使い方:
 *   <canvas class="pbr-layer" data-lb-diff="hub_Lb_diff.webp" data-lb-norm="hub_Lb_norm.webp"
 *           data-lm-diff="..." data-lm-norm="..." data-lf-diff="..." data-lf-norm="..."></canvas>
 *   <script src="pbr-layer-viewer.js"></script>
 * 各レイヤー（土台/中景/前景）を normal・roughness でライティングしながら、
 * 視点（ポインタ、無操作時は周回）に合わせて層ごとにUVをずらして合成する。
 * 質感（PBR）と奥行（視差）を両立させるための方式。
 * テクスチャ形式: diff = RGB に AO を折込済み、A = レイヤーalpha。
 *                 norm = RGB が法線、A が roughness。
 * WebGL不可なら土台diffuseを通常画像として表示する。
 */
(function () {
  const VS = `attribute vec2 p; varying vec2 vUv;
    void main(){ vUv = vec2(p.x*0.5+0.5, p.y*0.5+0.5); gl_Position = vec4(p,0.,1.); }`;
  const FS = `precision highp float; varying vec2 vUv;
    uniform sampler2D uLbD, uLbN, uLmD, uLmN, uLfD, uLfN;
    uniform vec3 uLight; uniform vec2 uView; uniform float uHasM, uHasF;
    vec3 shade(vec3 base, vec3 n, float rough, vec2 uv){
      vec3 P = vec3(uv, 0.0);
      vec3 L = normalize(uLight - P);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float diff = max(dot(n, L), 0.0);
      float spec = pow(max(dot(n, H), 0.0), mix(90.0, 8.0, rough)) * (1.0 - rough * 0.75);
      float dist = length(uLight - P);
      float atten = 1.0 / (1.0 + 0.55 * dist * dist);
      return base * (0.34 + 0.95 * diff * atten) + spec * atten * vec3(1.0, 0.98, 0.92);
    }
    vec4 layer(sampler2D dT, sampler2D nT, vec2 uv){
      if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
      vec4 d = texture2D(dT, uv);
      vec4 nm = texture2D(nT, uv);
      vec3 n = nm.rgb * 2.0 - 1.0; n.y = -n.y; n = normalize(n);
      return vec4(shade(d.rgb, n, nm.a, uv), d.a);
    }
    void main(){
      vec2 off = (uView - 0.5) * 0.052;
      vec3 col = vec3(0.0);
      vec4 b = layer(uLbD, uLbN, vUv + off * 0.18);
      col = b.rgb;
      if(uHasM > 0.5){
        vec4 m = layer(uLmD, uLmN, vUv + off * 0.40);
        col = mix(col, m.rgb, m.a);
      }
      if(uHasF > 0.5){
        vec4 f = layer(uLfD, uLfN, vUv + off * 1.0);
        col = mix(col, f.rgb, f.a);
      }
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
    const gl = canvas.getContext('webgl');
    const fallback = () => {
      const img = document.createElement('img');
      img.src = canvas.dataset.lbDiff; img.style.width = '100%';
      canvas.replaceWith(img);
    };
    if (!gl) return fallback();
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const d = canvas.dataset;
    const [lbD, lbN, lmD, lmN, lfD, lfN] = await Promise.all([
      loadTex(gl, d.lbDiff), loadTex(gl, d.lbNorm),
      loadTex(gl, d.lmDiff), loadTex(gl, d.lmNorm),
      loadTex(gl, d.lfDiff), loadTex(gl, d.lfNorm)]);
    if (!lbD || !lbN) return fallback();
    const bind = (name, tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || lbD);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    };
    bind('uLbD', lbD, 0); bind('uLbN', lbN, 1);
    bind('uLmD', lmD, 2); bind('uLmN', lmN, 3);
    bind('uLfD', lfD, 4); bind('uLfN', lfN, 5);
    gl.uniform1f(gl.getUniformLocation(prog, 'uHasM'), lmD && lmN ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uHasF'), lfD && lfN ? 1 : 0);
    const lightLoc = gl.getUniformLocation(prog, 'uLight');
    const viewLoc = gl.getUniformLocation(prog, 'uView');

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
      gl.uniform3f(lightLoc, vx, vy, 0.55);
      gl.uniform2f(viewLoc, vx, vy);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  document.querySelectorAll('canvas.pbr-layer').forEach(init);
})();
