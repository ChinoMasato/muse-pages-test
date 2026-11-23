/* layer-viewer.js — 多層スプライト（積層レイヤー）表示コンポーネント
 *
 * 使い方: 表示したい場所に
 *   <div class="layer-view" data-base="img_layer_base.webp"
 *        data-mid="img_layer_mid.webp" data-front="img_layer_front.webp"></div>
 *   <script src="layer-viewer.js"></script>
 * を置く。土台（元絵全体）・中景・前景の3層を重ね、視点（ポインタ位置、
 * 無操作時はゆっくり周回）に合わせて各層を奥行係数ぶんだけ逆方向へずらす。
 * 層は剛体のまま平行移動するので、法線ライティングのような
 * 「エンボス感」や、視差マッピングのような「溶け」が出ない。
 * レイヤー画像の作り方: make_layers.py（前景はGrabCut、中景は高さ中間帯）。
 */
(function () {
  document.querySelectorAll('.layer-view').forEach((box) => {
    const depths = [['base', 0.22], ['mid', 0.55], ['front', 1.0]];
    const layers = [];
    depths.forEach(([key, d]) => {
      const url = box.dataset[key];
      if (!url) return;
      const img = document.createElement('img');
      img.src = url; img.alt = '';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;';
      box.appendChild(img);
      layers.push({ img, d });
    });
    if (!layers.length) return;
    let tx = 0, ty = 0, cx = 0, cy = 0; // 目標視点 / 現在視点（-1..1）
    let lastPointer = -1e9;
    const onMove = (e) => {
      const r = box.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
      lastPointer = performance.now();
    };
    addEventListener('pointermove', onMove);
    addEventListener('mousemove', onMove);
    function frame(t) {
      if (t - lastPointer > 4000) { // ポインタ無操作が4秒を超えたらゆっくり周回
        tx = 0.6 * Math.cos(t * 0.00042); ty = 0.38 * Math.sin(t * 0.00042);
      }
      cx += (tx - cx) * 0.055; cy += (ty - cy) * 0.055;
      const maxShift = box.clientWidth * 0.026; // 前景の最大移動量（幅の2.6%）
      layers.forEach(({ img, d }) => {
        const sx = -cx * maxShift * d, sy = -cy * maxShift * d * 0.6;
        img.style.transform = `scale(1.045) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
})();
