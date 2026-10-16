// 3B kelime bulutu (three.js): kelimeler bir kürenin üzerine (Fibonacci dağılımı) yerleştirilir; boyut ve parlaklık
// sıklığa göre. Fareyle sürükleyerek döndürülür, tekerlekle yakınlaştırılır; bırakınca yavaşça kendi döner.
// Kelimenin üzerine gelince bilgi, tıklayınca onPick(kelime). Ana pencere window.Cloud3D.mount() ile kullanır.

import * as THREE from '../../node_modules/three/build/three.module.js';

const PALETTE_DARK = ['#22d3ee', '#818cf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#60a5fa', '#2dd4bf', '#e879f9'];
const PALETTE_LIGHT = ['#0891b2', '#4f46e5', '#7c3aed', '#db2777', '#059669', '#b45309', '#c2410c', '#2563eb', '#0d9488', '#a21caf'];
const RADIUS = 11;

const isLight = () => matchMedia('(prefers-color-scheme: light)').matches;
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

// Kelime → doku (tuval). Yüksek çözünürlüklü çizilir, sprite ölçeğiyle küçültülür.
function wordTexture(text, color, light) {
  const font = 600;
  const px = 64;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${font} ${px}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w;
  c.height = px + 28;
  ctx.font = `${font} ${px}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.shadowColor = light ? 'rgba(255,255,255,.9)' : color;
  ctx.shadowBlur = light ? 6 : 14;
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, aspect: w / c.height };
}

function mount(host, words, { onPick, onHover } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = 'cloud3d-canvas';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  const DEFAULT_Z = 30;
  camera.position.set(0, 0, DEFAULT_Z);
  const group = new THREE.Group();
  scene.add(group);

  // Arka plan: hafif yıldız alanı ve kürenin ince çizgileri (derinlik algısı)
  let stars = null;
  let ring = null;
  function backdrop() {
    if (stars) { scene.remove(stars); stars.geometry.dispose(); stars.material.dispose(); }
    if (ring) { group.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }
    const light = isLight();
    const g = new THREE.BufferGeometry();
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 40 + Math.random() * 60;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars = new THREE.Points(g, new THREE.PointsMaterial({ color: light ? 0x64748b : 0x94a3b8, size: 0.18, transparent: true, opacity: light ? 0.35 : 0.55 }));
    scene.add(stars);
    ring = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(RADIUS * 0.985, 24, 16)),
      new THREE.LineBasicMaterial({ color: light ? 0x0891b2 : 0x22d3ee, transparent: true, opacity: light ? 0.07 : 0.06 }),
    );
    group.add(ring);
  }
  backdrop();

  let sprites = [];
  function build(list) {
    for (const s of sprites) { group.remove(s); s.material.map.dispose(); s.material.dispose(); }
    sprites = [];
    const light = isLight();
    const pal = light ? PALETTE_LIGHT : PALETTE_DARK;
    const items = list.slice(0, 400);
    if (!items.length) return;
    const hi = Math.log(items[0].n + 1);
    const lo = Math.log(items[items.length - 1].n + 1);
    const N = items.length;
    const golden = Math.PI * (3 - Math.sqrt(5));
    // Sık kelimeler kürenin her yanına dağılsın diye sıra karıştırılır (kararlı)
    const order = items.map((w, i) => ({ w, k: ((Math.sin(i * 91.7 + 3.1) * 10000) % 1 + 1) % 1 })).sort((a, b) => a.k - b.k).map((o) => o.w);
    order.forEach((w, i) => {
      const r01 = hi === lo ? 0.5 : (Math.log(w.n + 1) - lo) / (hi - lo);
      const color = pal[Math.abs(hash(w.term)) % pal.length];
      const { tex, aspect } = wordTexture(w.term, color, light);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      const y = 1 - (i / Math.max(1, N - 1)) * 2;
      const rr = Math.sqrt(1 - y * y);
      const th = golden * i;
      const rad = RADIUS * (0.92 + r01 * 0.12);
      sp.position.set(Math.cos(th) * rr * rad, y * rad, Math.sin(th) * rr * rad);
      const hgt = 0.5 + r01 * 1.3;
      sp.scale.set(hgt * aspect, hgt, 1);
      sp.userData = { word: w, base: sp.scale.clone(), r01 };
      group.add(sp);
      sprites.push(sp);
    });
  }
  build(words);

  // --- Etkileşim ----------------------------------------------------------------------
  const el = renderer.domElement;
  let dragging = false;
  let moved = 0;
  let last = { x: 0, y: 0 };
  let vel = { x: 0.0009, y: 0.0028 }; // kendiliğinden yavaş dönüş
  let idleAt = 0;
  let hovered = null;
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let targetZ = DEFAULT_Z;

  const pick = (ev) => {
    const r = el.getBoundingClientRect();
    mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(sprites, false);
    // Önde (kameraya yakın) olan kelime seçilir
    return hits.length ? hits[0].object : null;
  };

  const onDown = (ev) => { dragging = true; moved = 0; last = { x: ev.clientX, y: ev.clientY }; el.setPointerCapture(ev.pointerId); };
  const onMove = (ev) => {
    if (dragging) {
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: ev.clientX, y: ev.clientY };
      rotate(dy * 0.006, dx * 0.006);
      vel = { x: dy * 0.0012, y: dx * 0.0012 };
      idleAt = performance.now();
      return;
    }
    const sp = pick(ev);
    if (sp !== hovered) {
      if (hovered) hovered.scale.copy(hovered.userData.base);
      hovered = sp;
      if (hovered) hovered.scale.copy(hovered.userData.base).multiplyScalar(1.3);
      el.style.cursor = hovered ? 'pointer' : 'grab';
    }
    if (onHover) {
      const r = host.getBoundingClientRect();
      onHover(hovered ? hovered.userData.word : null, ev.clientX - r.left, ev.clientY - r.top);
    }
  };
  const onUp = (ev) => {
    dragging = false;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* yok */ }
    if (moved < 5) {
      const sp = pick(ev);
      if (sp && onPick) onPick(sp.userData.word.term);
    }
  };
  const onWheel = (ev) => {
    ev.preventDefault();
    targetZ = Math.max(12, Math.min(60, targetZ * (ev.deltaY > 0 ? 1.1 : 0.9)));
  };
  const onLeave = () => { if (hovered) { hovered.scale.copy(hovered.userData.base); hovered = null; } if (onHover) onHover(null); };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', () => reset());
  el.style.cursor = 'grab';

  const qx = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const AX = new THREE.Vector3(1, 0, 0);
  const AY = new THREE.Vector3(0, 1, 0);
  function rotate(ax, ay) {
    qx.setFromAxisAngle(AX, ax);
    qy.setFromAxisAngle(AY, ay);
    group.quaternion.premultiply(qy).premultiply(qx);
  }

  function reset() {
    group.quaternion.identity();
    targetZ = DEFAULT_Z;
    vel = { x: 0.0009, y: 0.0028 };
  }

  // Boyut
  const resize = () => {
    const w = host.clientWidth || 1;
    const hgt = host.clientHeight || 1;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // Tema değişince renkleri yeniden çiz
  const mq = matchMedia('(prefers-color-scheme: light)');
  let current = words;
  const onTheme = () => { backdrop(); build(current); };
  mq.addEventListener('change', onTheme);

  // Döngü: arka taraftaki kelimeler soluk, öndekiler parlak
  const tmp = new THREE.Vector3();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!dragging) {
      const since = performance.now() - idleAt;
      // Sürüklemeden sonra hız yavaşça varsayılan dönüşe iner
      const k = Math.min(1, since / 2500);
      const vx = vel.x * (1 - k) + 0.0009 * k;
      const vy = vel.y * (1 - k) + 0.0028 * k;
      if (!reduced) rotate(vx, vy);
    }
    camera.position.z += (targetZ - camera.position.z) * 0.12;
    for (const sp of sprites) {
      sp.getWorldPosition(tmp);
      const depth = (tmp.z + RADIUS) / (2 * RADIUS); // 0 arka, 1 ön
      sp.material.opacity = sp === hovered ? 1 : 0.18 + depth * 0.82 * (0.7 + sp.userData.r01 * 0.3);
      sp.renderOrder = Math.round(depth * 1000);
    }
    if (stars) stars.rotation.y += 0.0002;
    renderer.render(scene, camera);
  };
  tick();

  return {
    update(list) { current = list; build(list); },
    reset,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener('change', onTheme);
      for (const s of sprites) { s.material.map.dispose(); s.material.dispose(); }
      if (stars) { stars.geometry.dispose(); stars.material.dispose(); }
      if (ring) { ring.geometry.dispose(); ring.material.dispose(); }
      renderer.dispose();
      el.remove();
    },
  };
}

window.Cloud3D = { mount };
