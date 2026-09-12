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
    this.controls.minDistance = 7 / 12;       // = 0.5833；保证 12× 档为精确倍数，8K 贴图支撑该距离观察
    this.controls.maxDistance = 7;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;   // 关闭内置 zoom，统一用 pointer 事件处理
    this.controls.addEventListener('change', () => {
      this.updateCityLod();
      this.requestRender();
    });
    // 只记录用户手动转出的朝向（松手那一刻取终值），避免内置 damping 每次 change 都触发
    canvas.addEventListener('pointerup', () => { if (this._downAt) this._recordSnapshot(); });
    canvas.addEventListener('pointercancel', () => { if (this._downAt) this._recordSnapshot(); });

    // ── 统一交互层：pointer 事件驱动拖拽/点击/缩放 ──
    // 标签层 pointer-events: none（CSS），事件穿透到 canvas 统一处理
    this._interacting = false;
    this._loopUntil = 0;
    this._loopQueued = false;
    this._downAt = null;
    this._downTime = 0;

    const onDown = (e) => {
      this._downAt = { x: e.clientX, y: e.clientY };
      this._downTime = performance.now();
    };
    const onUp = (e) => {
      const dt = performance.now() - this._downTime;
      const dx = e.clientX - this._downAt?.x ?? 0;
      const dy = e.clientY - this._downAt?.y ?? 0;
      const moved = Math.hypot(dx, dy) > 5;
      if (!moved && dt < 300) {
        // 轻触/点击：拾取
        this._emitPick(e.clientX, e.clientY, onPick);
      }
      this._downAt = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const controls = this.controls;

      // ── 第一步：沿视线缩放（target=球心，视线方向不变）──
      this._ray.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
      const hit = this._ray.intersectObject(this.globe, false)[0];
      const hitNdc = hit ? hit.point.clone().project(this.camera) : null;

      const dist = this.camera.position.distanceTo(controls.target);
      const factor = Math.exp(e.deltaY * 0.0014);
      const newDist = THREE.MathUtils.clamp(dist * factor,
                                           controls.minDistance, controls.maxDistance);
      if (newDist === dist) return;
      // 沿 (相机-target) 方向移动相机，target 不动 → 视线方向完全不变
      const dir = this.camera.position.clone().sub(controls.target).normalize();
      this.camera.position.copy(controls.target).addScaledVector(dir, newDist);

      // ── 第二步：pan 补偿（相机+target 同步平移），让 hit 点回到原屏幕位置 ──
      // 纯平移不改变视线方向 → 零旋转零乱滚；拖拽仍绕球心稳定旋转
      if (hit && hitNdc) {
        this.camera.updateMatrixWorld();
        this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
        const v = hit.point.clone().project(this.camera);   // 缩放后 hit 的 NDC
        const dxN = ndcX - v.x, dyN = ndcY - v.y;
        if (Math.abs(dxN) > 1e-6 || Math.abs(dyN) > 1e-6) {
          const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
          const dCam = this.camera.position.distanceTo(hit.point);
          const halfH = Math.tan(this.camera.fov * Math.PI / 360) * dCam;
          const halfW = halfH * this.camera.aspect;
          // 世界空间补偿向量
          const pan = right.multiplyScalar(dxN * halfW).addScaledVector(up, dyN * halfH);
          // 逐级收缩：球心投影不漂出视口中部（NDC ≤ 0.55），防止地球飞出屏幕
          const LIMIT = 0.55;
          for (const f of [1, 0.7, 0.5, 0.3, 0.15, 0]) {
            this.camera.position.addScaledVector(pan, f);
            controls.target.addScaledVector(pan, f);
            this.camera.updateMatrixWorld();
            this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
            const o = new THREE.Vector3().copy(controls.target).project(this.camera);
            if (Math.abs(o.x) <= LIMIT && Math.abs(o.y) <= LIMIT) break;
            // 回滚本次尝试
            this.camera.position.addScaledVector(pan, -f);
            controls.target.addScaledVector(pan, -f);
          }
          // target 漂移离球心太远时，拉回球心（牺牲锚定保稳定）
          const tLen = controls.target.length();
          if (tLen > 0.5) {
            controls.target.multiplyScalar(0.5 / tLen);
          }
        }
      }

      controls.update();
      this.updateCityLod();
      this._recordSnapshot();
      this.requestRender();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // 标签层 CSS pointer-events: none，事件穿透到 canvas 统一处理，无需额外监听

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

    // 城市名标签层：HTML 覆盖层，随 zoom 分级显示（见 _updateLabels）。
    // 紧跟在 canvas 之后插入 DOM，保持「canvas < 标签 < 其余 UI」的绘制次序。
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'globe-labels';
    this.labelLayer.hidden = true;
    canvas.insertAdjacentElement('afterend', this.labelLayer);
    this._labelDivs = new Map();    // cityId -> div（复用节点，避免每帧重建）
    this._labelTmp = new THREE.Vector3();
    this._labelCam = new THREE.Vector3();

    // 点击拾取：先尝试城市 Points，再拾取地球表面。
    // threshold（世界单位）在 _emitPick 里按相机距离动态缩放。
    this._ray = new THREE.Raycaster();
    this._ray.params.Points = { threshold: 0.01 };
    this._ndc = new THREE.Vector2();

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
    this._snapshot();
    this.requestRender();
  }

  /**
   * 保存当前机位（视角朝向 + 相对球心距离），供 setZoomLevel 恢复。
   * 档位切换只改「离多远」，不重置用户拖出来的朝向。
   */
  _snapshot() {
    this._snap = {
      dir: this.camera.position.clone().sub(this.controls.target).normalize(),
      dist: this.camera.position.distanceTo(this.controls.target),
    };
  }

  /** 用户交互后回调：刷新机位快照 + 通知外部（档位高亮） */
  _onUserViewChange() {
    this._snapshot();
    if (this.onViewChange) this.onViewChange(this.activeZoomIndex());
  }

  /** 仅刷新机位快照（拖动松手时记录朝向终值） */
  _recordSnapshot() {
    this._snapshot();
    if (this.onViewChange) this.onViewChange(this.activeZoomIndex());
  }

  getDistance() {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /**
   * 放大档位（倍数 = 相对地球完整可见时的放大系数）。
   * 档位只改相机到球心的距离：朝向（含用户手动拖拽出的角度）保持不变，
   * 只把 target 重新拉回球心，从而不引入额外旋转。
   * 距离 = 7 / factor，下限由 controls.minDistance 钳制。
   */
  static ZOOM_LEVELS = [
    { label: '2×', factor: 2.0, distance: 7 / 2 },
    { label: '3×', factor: 3.0, distance: 7 / 3 },
    { label: '4×', factor: 4.0, distance: 7 / 4 },
    { label: '6×', factor: 6.0, distance: 7 / 6 },
    { label: '8×', factor: 8.0, distance: 7 / 8 },
    { label: '12×', factor: 12.0, distance: 7 / 12 },
  ];

  setZoomLevel(index, instant = false) {
    if (!this._snap) this._snapshot();
    const level = Globe.ZOOM_LEVELS[index];
    if (!level) return;
    const targetDist = THREE.MathUtils.clamp(level.distance, this.controls.minDistance, this.controls.maxDistance);
    const t0 = performance.now();
    // OrbitControls.update() 以 camera.position 为输入重算位置，
    // 故「设 camera.position → 清 target → update()」即可改变半径而不影响朝向。
    // damping 开启时 update() 还会叠加上次拖拽/滚轮的残留增量（sphericalDelta、scale），
    // 使结果不确定；切档期间临时关闭，保证动画收敛到精确距离。
    const apply = (d) => {
      this.controls.enableDamping = false;
      this.controls.target.set(0, 0, 0);
      this.camera.position.copy(this._snap.dir).multiplyScalar(d);
      this.controls.update();
      this.controls.enableDamping = true;
      this._snap.dist = d;
    };
    const start = this.getDistance();
    if (instant || Math.abs(targetDist - start) < 1e-4) {
      apply(targetDist);
      this.updateCityLod();
      this.requestRender();
      return;
    }
    // 短动画：220ms easeOutCubic，避免整屏瞬移。
    // 动画进度挂在渲染循环上（_startLoop 每帧 render → render 检测 _zoomT0 推进），
    // 而不是另起一条 rAF 链：按需渲染在静止页面时 rAF 可能被节流，独立链只跑一两帧。
    this._zoomStart = t0;
    this._zoomFrom = start;
    this._zoomTo = targetDist;
    this._zoomApply = apply;
    this._loopUntil = performance.now() + 300;
    this._zoomActive = true;
    this._startLoop();
    this.requestRender();
  }

  /** 由 render() 每帧调用：推进档位动画到目标距离 */
  _stepZoom() {
    if (!this._zoomActive) return false;
    const t = Math.min((performance.now() - this._zoomStart) / 220, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this._zoomApply(THREE.MathUtils.lerp(this._zoomFrom, this._zoomTo, eased));
    if (t >= 1) {
      this._zoomActive = false;
      this._zoomApply = null;
      return true;   // 刚结束，需要一次收尾渲染
    }
    return false;
  }

  /** 当前距离对应的最近档位数，用于按钮高亮（非精确档位时为 null） */
  activeZoomIndex() {
    const d = this.getDistance();
    const hit = Globe.ZOOM_LEVELS.findIndex((l) => Math.abs(THREE.MathUtils.clamp(l.distance, this.controls.minDistance, this.controls.maxDistance) - d) < 0.02);
    return hit >= 0 ? hit : null;
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
    // 地球显示在中部偏左上（右侧留给时间面板）：视口向右下偏移 → 球体向左上偏移
    this.camera.setViewOffset(w, h, w * 0.09, h * 0.05, w, h);
    this._updatePointScale();
    this.requestRender();
  }

  /** 连续渲染循环：交互期/惯性期每帧绘制，窗口期过后自动停止 */
  _startLoop() {
    if (this._loopQueued) return;
    this._loopQueued = true;
    const step = () => {
      this._loopQueued = false;
      this.render();
      if (this._interacting || performance.now() < this._loopUntil) {
        this._loopQueued = true;
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * 按需绘制：合并同一帧内的多次请求；rAF 优先对齐刷新率，
   * rAF 被挂起时（后台 tab、嵌入式 WebView）用 120ms 定时器兜底，保证仍出帧。
   * 静止时不持续占用 GPU，省电关键；交互期由连续循环接管（见 requestRender 开头）。
   */
  requestRender() {
    this.needsRender = true;
    if (this._loopQueued) return;
    if (this._interacting || performance.now() < this._loopUntil) {
      this._startLoop();
      return;
    }
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
    // 档位动画期间由 _stepZoom 推进相机到精确目标距离；
    // 此时跳过 controls.update()，否则其 damping 残留会把相机拉离动画位置。
    const zoomDone = this._zoomActive ? this._stepZoom() : false;
    if (!this._zoomActive) this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._updateLabels();
    // 动画推进后继续出帧，直到收敛到目标距离
    if (this._zoomActive || zoomDone) this.requestRender();
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
    // 数据已更换：丢弃旧标签（数据按人口降序，标签扫描依赖该顺序）
    for (const div of this._labelDivs.values()) div.remove();
    this._labelDivs.clear();
    this.labelLayer.hidden = false;
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

  /**
   * 城市名标签（放大逻辑）：
   *   - 人口下限随 zoom 下降：远景（世界视野）只标 ≥600 万的都会，
   *     最近（城市视野）降到 ≥20 万；数据按人口降序，扫到阈值即停。
   *   - 数量上限随 zoom 放宽（10 → 44），投影到屏幕后按人口优先贪心放置，
   *     屏幕空间去重叠，避免标签成糊。
   *   - 背面城市用地平线判据（cosθ > R/d）剔除；div 节点复用，不逐帧重建。
   */
  _updateLabels() {
    const data = this.cityData;
    if (!data || !data.length || this.labelLayer.hidden) return;
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    const dist = this.camera.position.length();
    const t = THREE.MathUtils.clamp(
      (this.controls.maxDistance - dist) / (this.controls.maxDistance - this.controls.minDistance), 0, 1);
    const popFloor = THREE.MathUtils.lerp(6e6, 2e5, t);
    const maxLabels = Math.round(THREE.MathUtils.lerp(10, 44, t));
    const camN = this._labelCam.copy(this.camera.position).normalize();
    const horizon = 1 / dist + 0.03;
    const placed = [];
    const shown = new Set();
    const v = this._labelTmp;
    const scan = Math.min(data.length, 2000);
    for (let i = 0; i < scan && placed.length < maxLabels; i++) {
      const city = data[i];
      if ((city.population || 0) < popFloor) break;   // 降序数据，后面只会更小
      const a = city.latitude * Math.PI / 180, o = city.longitude * Math.PI / 180;
      v.set(Math.cos(a) * Math.cos(o), Math.sin(a), -Math.cos(a) * Math.sin(o));
      if (v.dot(camN) < horizon) continue;            // 在地球背面
      v.multiplyScalar(1.001).project(this.camera);
      if (v.x < -1.02 || v.x > 1.02 || v.y < -1.02 || v.y > 1.02) continue;
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      const label = city.nameZh || city.asciiName || city.name;
      const wd = label.length * (/[^\x00-\xff]/.test(label) ? 12 : 6.5) + 10;
      let blocked = false;
      for (const p of placed) {
        if (Math.abs(p.x - x) < (p.w + wd) / 2 + 4 && Math.abs(p.y - y) < 16) { blocked = true; break; }
      }
      if (blocked) continue;
      placed.push({ x, y, w: wd });
      shown.add(city.id);
      let div = this._labelDivs.get(city.id);
      if (!div) {
        div = document.createElement('div');
        div.className = 'globe-label';
        div.title = '查看城市详情';
        // 名城标签压在小城市标签之上：重叠处点击命中名城
        div.style.zIndex = String(Math.min(2000000000, Math.round(city.population || 0)));
        // 点名字＝点城市：直接打开城市卡片
        div.addEventListener('click', () => this.onCityPick?.(city));
        this.labelLayer.appendChild(div);
        this._labelDivs.set(city.id, div);
      }
      div.textContent = label;
      div.style.transform = `translate(${x + 6}px, ${y - 8}px)`;
    }
    for (const [id, div] of this._labelDivs) {
      if (!shown.has(id)) {
        div.remove();
        this._labelDivs.delete(id);
      }
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
        // 密集城区多点重叠：取「离射线最近者」会点中小区县；
        // 改为在贴近射线的候选（≤最近距离 ×1.3）里选人口最大的名城
        let minRay = Infinity;
        for (const h of cityHits) minRay = Math.min(minRay, h.distanceToRay);
        let best = null;
        let bestPop = -1;
        for (const h of cityHits) {
          if (h.distanceToRay > minRay * 1.3 + 1e-9) continue;
          const pop = this.cityData[h.index]?.population || 0;
          if (pop > bestPop) { best = h; bestPop = pop; }
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
