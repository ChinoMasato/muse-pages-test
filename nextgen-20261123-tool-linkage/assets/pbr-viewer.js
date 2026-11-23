/* pbr-viewer.js — HTMLスライドでノーマルマップを活かす表示コンポーネント
 *
 * 使い方: スライドのHTMLにこのファイルを読み込み、表示したい場所に
 *   <canvas class="pbr-view" data-diffuse="img.png" data-normal="img_normal.png"
 *           data-roughness="img_roughness.png" data-ao="img_ao.png"></canvas>
 * を置く。WebGLで、ポインタに追従する点光源でライティングする
 * （拡散反射は法線マップ、スペキュラの鋭さは粗さマップ、陰はAO）。
 * ポインタが無い間は光源がゆっくり周回する。WebGL不可なら通常の<img>に置き換える。
 */
(function () {
  const VS = `attribute vec2 p; varying vec2 vUv;
    void main(){ vUv = vec2(p.x*0.5+0.5, p.y*0.5+0.5); gl_Position = vec4(p,0.,1.); }`;
  const FS = `precision highp float; varying vec2 vUv;
    uniform sampler2D uDiff, uNorm, uRough, uAo;
    uniform vec3 uLight; uniform float uHasRough, uHasAo;
    void main(){
      vec3 base = texture2D(uDiff, vUv).rgb;
      vec3 n = texture2D(uNorm, vUv).rgb * 2.0 - 1.0;
      n.y = -n.y; n = normalize(n);
      float rough = uHasRough > 0.5 ? texture2D(uRough, vUv).r : 0.5;
      float ao = uHasAo > 0.5 ? texture2D(uAo, vUv).r : 1.0;
      vec3 pos = vec3(vUv, 0.0);
      vec3 L = normalize(uLight - pos);
      vec3 V = vec3(0.0, 0.0, 1.0);
      vec3 H = normalize(L + V);
      float diff = max(dot(n, L), 0.0);
      float spec = pow(max(dot(n, H), 0.0), mix(90.0, 8.0, rough)) * (1.0 - rough * 0.75);
      float dist = length(uLight - pos);
      float atten = 1.0 / (1.0 + 0.55 * dist * dist);
      vec3 col = base * (0.34 + 0.95 * diff * atten) * mix(0.72, 1.0, ao)
               + spec * atten * vec3(1.0, 0.98, 0.92);
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
    if (!gl) { // フォールバック: 通常画像として表示
      const img = document.createElement('img');
      img.src = canvas.dataset.diffuse; img.style.width = '100%';
      canvas.replaceWith(img); return;
    }
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

    const [diff, norm, rough, ao] = await Promise.all([
      loadTex(gl, canvas.dataset.diffuse), loadTex(gl, canvas.dataset.normal),
      loadTex(gl, canvas.dataset.roughness), loadTex(gl, canvas.dataset.ao)]);
    if (!diff || !norm) { init._fallback && init._fallback(canvas); return; }
    const bind = (name, tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || diff);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    };
    bind('uDiff', diff, 0); bind('uNorm', norm, 1); bind('uRough', rough, 2); bind('uAo', ao, 3);
    gl.uniform1f(gl.getUniformLocation(prog, 'uHasRough'), rough ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uHasAo'), ao ? 1 : 0);
    const lightLoc = gl.getUniformLocation(prog, 'uLight');

    let mx = null, my = null;
    addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width; my = 1 - (e.clientY - r.top) / r.height;
    });
    function frame(t) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
      gl.viewport(0, 0, canvas.width, canvas.height);
      const lx = mx === null ? 0.5 + 0.38 * Math.cos(t * 0.00045) : mx;
      const ly = my === null ? 0.55 + 0.30 * Math.sin(t * 0.00045) : my;
      gl.uniform3f(lightLoc, lx, ly, 0.55);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  document.querySelectorAll('canvas.pbr-view').forEach(init);
})();
