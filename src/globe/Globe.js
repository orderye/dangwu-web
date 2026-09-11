/**
 * 地球渲染：Three.js SphereGeometry + 自定义 ShaderMaterial（昼夜 + 晨昏线）。
 *
 * 坐标约定（双端统一，务必与 Android SphereMesh 一致）：
 *   贴图 u = (λ+180)/360（Three.js SphereGeometry 的 UV 恰好就是这个约定，无需额外变换）
 *   格点 p = (cosφ·cosλ, sinφ, −cosφ·sinλ)
 *   太阳方向向量 = 同公式代入直射点 (δ, λs)
 * 因此拾取时 lat = asin(y)，lon = atan2(−z, x)。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vN;
void main() {
  vUv = uv;
  vN  = normalize(mat3(modelMatrix) * normal);   // 球无缩放，世界法线即地固坐标
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D dayTex; uniform sampler2D nightTex; uniform vec3 sunDir;
varying vec2 vUv; varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  float c = dot(n, normalize(sunDir));
  float k = smoothstep(-0.09, 0.09, c);                       // 晨昏过渡带 ≈ ±5.7°
  vec3 day   = texture2D(dayTex, vUv).rgb;
  vec3 night = texture2D(nightTex, vUv).rgb * 1.1 + 0.012;    // 城市灯光略提亮
  vec3 col   = mix(night, day * (0.35 + 0.65 * clamp(c * 1.6, 0.0, 1.0)), k);
  col += vec3(1.0, 0.78, 0.35) * (1.0 - smoothstep(0.0, 0.02, abs(c))) * 0.35;  // 晨昏线描金
  gl_FragColor = vec4(pow(col, vec3(0.4545)), 1.0);           // 近似 gamma 输出
}`;

// 大气辉光（背面渲染 + fresnel，朝太阳一侧更强）
const ATMO_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vWP;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vWP = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;
const ATMO_FRAG = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vN; varying vec3 vWP;
void main() {
  vec3 V = normalize(cameraPosition - vWP);
  float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
  float lit = smoothstep(-0.4, 0.3, dot(normalize(vN), normalize(sunDir)));
  gl_FragColor = vec4(vec3(0.30, 0.55, 1.0) * rim * (0.22 + 0.78 * lit), 1.0);
}`;

export const latLonToVec = (latDeg, lonDeg, r = 1) => {
  const a = latDeg * Math.PI / 180, o = lonDeg * Math.PI / 180;
  return new THREE.Vector3(r * Math.cos(a) * Math.cos(o), r * Math.sin(a), -r * Math.cos(a) * Math.sin(o));
};

// 城市点：世界尺寸点径（随距离衰减但上下限截断）+ 圆形柔边 sprite
const CITY_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uScale;       // drawingBufferHeight / (2·tan(fov/2))
uniform float uSizeFactor;  // 随 zoom 收缩
uniform float uMinPx; uniform float uMaxPx;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uSizeFactor * uScale / -mv.z, uMinPx, uMaxPx);
  gl_Position = projectionMatrix * mv;
}`;
const CITY_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.3, r) * 0.9);
}`;

export class Globe {
  /** @param {HTMLCanvasElement} canvas @param {{onPick:(lat,lon)=>void}} opts */
  constructor(canvas, { onPick } = {}) {
    // preserveDrawingBuffer：按需渲染（静止时每秒最多一帧）下代价可忽略，
    // 且是 canvas.toDataURL 截图/分享卡片能力的前置条件。
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this._maxDpr = 3;
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 20);
    this.camera.position.set(0, 0, 3);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.45;
    this.controls.minDistance = 1.6;          // 8K 贴图下允许更近观察
    this.controls.maxDistance = 7;
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => {
      this.updateCityLod();
      this.requestRender();
    });

    this.u = {
      dayTex: { value: null },
      nightTex: { value: null },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
    };
    // SphereGeometry 192×96：放大时仍保持几何圆润；清晰度主要由 8K 贴图 + anisotropy 保障
    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(1, 192, 96),
      new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG }),
    );
    this.scene.add(this.globe);

    this.atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.055, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: { sunDir: this.u.sunDir },
        vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
        side: THREE.BackSide, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(this.atmo);

    this.markers = new THREE.Group();
    this.scene.add(this.markers);
    this.markSelected = null;
    this.markSubsolar = null;

    // 城市 Points 图层（人口 LOD + 动态点径，见 setCities / updateCityLod）
    this.cityPoints = null;
    this.cityData = null;           // 与 cityPoints 顶点顺序一致的城市数组，用于拾取后查询详情
    this._cityLodCount = 0;

    // 点击拾取：先尝试城市 Points，再拾取地球表面。
    // threshold（世界单位）在 _emitPick 里按相机距离动态缩放。
    this._ray = new THREE.Raycaster();
    this._ray.params.Points = { threshold: 0.01 };
    this._ndc = new THREE.Vector2();
    canvas.addEventListener('click', (e) => this._emitPick(e.clientX, e.clientY, onPick));

    this._queued = false;
    this.requestRender();
  }

  /** 每帧/每秒更新太阳方向（δ 赤纬、λs 直射点经度，均为度） */
  setSun(declDeg, subLonDeg) {
    const d = declDeg * Math.PI / 180, l = subLonDeg * Math.PI / 180;
    this.u.sunDir.value.set(Math.cos(d) * Math.cos(l), Math.sin(d), -Math.cos(d) * Math.sin(l));
    this.requestRender();
  }

  /** 选中点标记（白色珠 + 到球心的细杆）；重复调用只挪位置，不重建几何体 */
  setMarker(latDeg, lonDeg, color = 0xffffff, radius = 0.016) {
    const p = latLonToVec(latDeg, lonDeg);
    if (!this.markSelected) {
      const g = new THREE.Group();
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      g.add(dot);
      const stem = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      g.add(stem);
      this.markers.add(g);
      this.markSelected = g;
    }
    const [dot, stem] = this.markSelected.children;
    dot.position.copy(p).multiplyScalar(1.02);
    stem.geometry.dispose();
    stem.geometry = new THREE.BufferGeometry().setFromPoints([
      p.clone().multiplyScalar(1.0), p.clone().multiplyScalar(1.045),
    ]);
    this.requestRender();
  }

  /** 太阳直射点标记（金色）；每秒调用，复用同一个 mesh */
  setSubsolarMarker(latDeg, lonDeg) {
    if (!this.markSubsolar) {
      this.markSubsolar = new THREE.Mesh(
        new THREE.SphereGeometry(0.013, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xf4c46a, transparent: true, opacity: 0.9 }),
      );
      this.markers.add(this.markSubsolar);
    }
    this.markSubsolar.position.copy(latLonToVec(latDeg, lonDeg)).multiplyScalar(1.015);
    this.requestRender();
  }

  /** 相机对准某地点（首次进入首页时用） */
  focusOn(latDeg, lonDeg, distance = 2.6) {
    const p = latLonToVec(latDeg, lonDeg, distance);
    this.camera.position.copy(p);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  setTexture(tex, which = 'day') {
    this.u[which + 'Tex'].value = tex;
    this.requestRender();
  }

  resize(w, h) {
    // 每次重读 devicePixelRatio：跨 DPI 显示器拖动窗口、浏览器缩放后保持清晰
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this._maxDpr));
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this._updatePointScale();
    this.requestRender();
  }

  /**
   * 按需绘制：合并同一帧内的多次请求；rAF 优先对齐刷新率，
   * rAF 被挂起时（后台 tab、嵌入式 WebView）用 120ms 定时器兜底，保证仍出帧。
   * 静止时不持续占用 GPU，省电关键。
   */
  requestRender() {
    this.needsRender = true;
    if (this._queued) return;
    this._queued = true;
    const draw = () => {
      this._queued = false;
      this.render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
    setTimeout(() => { if (this._queued) draw(); }, 120);
  }

  /** 仅在需要时真正绘制：静止时 GPU 不工作，省电关键 */
  render() {
    if (!this.needsRender) return;
    this.needsRender = false;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 设置城市数据并创建 Points 图层。
   * 数据需已归一化为 { latitude, longitude, population, ... } 且按人口降序
   * （cities.json 本身降序，main.js 归一化时保持顺序），
   * 人口 LOD 通过 setDrawRange 截取前 k 个实现。
   */
  setCities(cities) {
    if (this.cityPoints) {
      this.scene.remove(this.cityPoints);
      this.cityPoints.geometry.dispose();
      this.cityPoints.material.dispose();
      this.cityPoints = null;
    }
    this.cityData = cities;

    const n = cities.length;
    const positions = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const city = cities[i];
      const p = latLonToVec(city.latitude, city.longitude, 1.001);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      // 人口分档点径（世界单位基准，uSizeFactor 随 zoom 再缩）
      const pop = city.population || 0;
      sizes[i] = pop >= 1e7 ? 2.2 : pop >= 3e6 ? 1.7 : pop >= 1e6 ? 1.35 : 1.0;
      // 人口越大越亮，颜色偏暖
      const w = Math.min(pop, 2e7) / 2e7;
      colors[i * 3] = 0.8 + w * 0.2;
      colors[i * 3 + 1] = 0.6 + w * 0.3;
      colors[i * 3 + 2] = 0.2 + w * 0.2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    this.cityMat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 1 },      // drawingBufferHeight / (2·tan(fov/2))，世界尺寸→物理像素
        uSizeFactor: { value: 1 }, // 随 zoom 收缩，近景点更小以减少重叠
        uMinPx: { value: 2.0 },    // 物理像素下限：缩太小时仍可见
        uMaxPx: { value: 6.0 },    // 物理像素上限：防止近景点变成大 sprite
      },
      vertexShader: CITY_VERT,
      fragmentShader: CITY_FRAG,
      transparent: true,
      depthWrite: false,
    });

    this.cityPoints = new THREE.Points(geo, this.cityMat);
    this.cityPoints.renderOrder = 1;  // 在地球之上
    this.scene.add(this.cityPoints);
    this.updateCityLod(true);
    this._updatePointScale();
    this.requestRender();
  }

  /** drawingBufferHeight 变化后重算世界尺寸→像素换算系数 */
  _updatePointScale() {
    if (!this.cityMat) return;
    const bufH = this.renderer.domElement.height || 1;
    this.cityMat.uniforms.uScale.value = bufH / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  /**
   * 人口 LOD：相机越近展示越多城市（远 1200 → 近全部，指数插值），
   * 同时点径随 zoom 收缩。仅在档位跨过 5% 变化时重设 drawRange，配合按需渲染省电。
   */
  updateCityLod(force = false) {
    if (!this.cityPoints || !this.cityData) return;
    const dist = this.camera.position.length();
    const t = THREE.MathUtils.clamp(
      (this.controls.maxDistance - dist) / (this.controls.maxDistance - this.controls.minDistance), 0, 1);
    const total = this.cityData.length;
    const minCount = Math.min(1200, total);
    const k = Math.max(1, Math.round(minCount * Math.pow(total / minCount, t)));
    this.cityMat.uniforms.uSizeFactor.value = THREE.MathUtils.lerp(1.0, 0.5, t);
    if (force || Math.abs(k - this._cityLodCount) > Math.max(minCount * 0.05, 1) || k === total) {
      this._cityLodCount = k;
      this.cityPoints.geometry.setDrawRange(0, k);
    }
  }

  /** 点击拾取：先尝试城市 Points（取光标处最近命中），再拾取地球表面 */
  _emitPick(clientX, clientY, onPick) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);

    // 先拾取城市 Points；threshold 随相机距离缩放：远看容差大易点中，近看不误伤邻城
    if (this.cityPoints) {
      const dist = this.camera.position.length();
      this._ray.params.Points.threshold = THREE.MathUtils.clamp(0.004 * dist, 0.005, 0.016);
      const cityHits = this._ray.intersectObject(this.cityPoints, false);
      if (cityHits.length > 0) {
        // 命中按相机距离排序，但同屏重叠时应取离光标射线最近的那个
        let best = cityHits[0];
        for (const h of cityHits) {
          if (h.distanceToRay < best.distanceToRay) best = h;
        }
        const city = this.cityData[best.index];
        if (city && this.onCityPick) {
          this.onCityPick(city);
          return true;
        }
      }
    }

    // 再拾取地球表面
    const hit = this._ray.intersectObject(this.globe, false)[0];
    if (!hit) return false;
    const lat = Math.asin(THREE.MathUtils.clamp(hit.point.y, -1, 1)) * 180 / Math.PI;
    const lon = Math.atan2(-hit.point.z, hit.point.x) * 180 / Math.PI;
    onPick?.(lat, lon);
    return true;
  }

  /** 设置城市点击回调 */
  onCityPick(cb) {
    this.onCityPick = cb;
  }
}
