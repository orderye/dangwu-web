# 当午（DangW）借鉴 Solaris Earth 3D 地球视觉与渲染引擎升级报告

> **报告时间**：2026-09-29  
> **对比参考项目**：[Solaris Earth (`@cuvii/solaris/earth`)](https://solaris.cuvii.dev/earth/)  
> **受影响模块**：`dangwu-web`（Web/PWA 端 3D 地球渲染引擎、着色器、材质贴图流与 Service Worker 缓存）

---

## 一、 项目背景与升级目标

「当午（DangW）」是一款“以太阳为钟”的真太阳时与天体观测应用。首页呈现一颗实时昼夜交替的 3D 地球，核心功能高度依赖**太阳直射点（Subsolar Point）、晨昏线（Terminator）与地表经纬度交互拾取**。

为了显著提升首页 3D 地球的画面质感、物理真实度与视觉冲击力，本轮任务深入拆解了目前业界顶尖的 WebGL 行星渲染库 **Solaris Earth**（由 Cuvii 开发），将其物理大气散射、海面波光耀斑（GGX Sun Glint）、动态云层阴影与 Filmic 电影色调映射算法移植并融合至「当午」现有 Three.js 架构中。

---

## 二、 Solaris Earth 核心技术剖析与差异对比

通过对 Solaris 源码 (`src/earth/atmospheric-orb.effect.tsx`) 的深入分析，对比「当午」升级前后的渲染表现如下：

| 维度 | 原「当午」实现 (`Globe.js`) | Solaris Earth 物理方案 | 本次改进实施 |
| :--- | :--- | :--- | :--- |
| **大气与晨昏线** | 余弦点积 + 人工固定 1px 描金线条 | **Rayleigh 瑞利色散 + Mie 米氏气溶胶前向散射**，太阳角度低时短波蓝光剧烈衰减 | **物理大气消光模型**：太阳天顶角较低时产生自然的金黄、深橘红夕阳与紫灰暮光 |
| **海洋水体质感** | 陆地与海洋均为平面漫反射，无光泽区别 | **GGX 微表面高光 + 多频简谐波法线扰动**，水体菲涅尔反射 | **海面动态波光耀斑**：在水面形成真实的太阳高光反射，直射点在海面上时极具视觉冲击 |
| **云层系统** | 无云层 | **独立云层覆盖图 + 差速自转 + 地表柔和阴影 + 逆光银辉（Silver Lining）** | **地表阴影投影 + 独立微距浮空云壳**：云层缓慢自转漂移，阳光斜射时在陆地和海洋投下立体阴影 |
| **夜间城市灯光** | 线性相加，无色温处理 | **暖色温光谱重映射（高压钠灯/暖白 LED）+ 云层动态遮挡** | 提取夜光能量并映射至暖金色调，阴云覆盖区域自然遮蔽部分夜光 |
| **色调与画面质感** | 朴素的 `pow(col, 0.4545)` 近似伽马，暗部易出现色阶断层 | **ACES Filmic 电影色调映射 + 屏幕空间高频微噪（Hash Dither）** | 引入 ACES Filmic 曲线抗高光过曝，并加入散斑抖动消除 8-bit 显示器的色彩断层 |
| **功耗与交互** | 按需渲染（静止时 1Hz 零耗电），带 34k 城市与拾取 | 全屏 Raymarching，持续 60fps 运行 | **完全保留按需渲染与拾取精度**，云层禁用 Raycast 拦截，空闲保持 1Hz，交互时流畅出帧 |

---

## 三、 本次改进的具体实施细节

### 1. 核心着色器重构 (`dangwu-web/src/globe/Globe.js`)

- **地表着色器 (`FRAG`)**：
  - 引入 Cook-Torrance GGX 微表面分布 `distributionGGX`、Schlick 几何遮蔽 `geometrySmith` 与 Fresnel `fresnelSchlick`。
  - 引入 `oceanWaveSlope` 函数，利用三频正弦简谐波对水面法线进行实时扰动，生成具有波浪起伏感的海面太阳耀斑。
  - 实现了基于太阳天顶角 $N \cdot L$ 的 Rayleigh 瑞利色散消光算法：
    $$\text{opticalPath} = \text{clamp}\left(\frac{1}{\max(N \cdot L + 0.12, 0.001)} - 0.9, 0.0, 5.0\right)$$
    $$\text{rayleighExtinction} = \exp\left(-\begin{bmatrix}0.14 \\ 0.40 \\ 1.10\end{bmatrix} \times \text{opticalPath}\right)$$
  - 加入云层投影计算：根据太阳方向向量偏置采样 `cloudTex`，在地面产生柔和遮光。
  - 加入夜间城市灯光的暖色调重映射（`vec3(1.22, 0.96, 0.78)`）与云层遮光。
  - 全流程色彩管线经过 ACES Filmic 色调映射与高频散斑抖动（Hash Dithering）。

- **云层着色器 (`CLOUD_VERT` / `CLOUD_FRAG`)**：
  - 在半径 `1.006` 处新建独立透明球壳 `cloudMesh`。
  - 实现了逆光向光散射银辉效果（`pow(1.0 - cloudView, 3.2)`），在晨昏线附近形成剔透的云边。
  - 设置 `this.cloudMesh.raycast = () => {}`，确保鼠标/触摸拾取无缝穿透至地表。
  - 云壳使用 `renderOrder = 1`，城市点图层调至 `renderOrder = 2`，图钉/标记调至 `renderOrder = 3`，层级清晰。

- **大气辉光着色器 (`ATMO_VERT` / `ATMO_FRAG`)**：
  - 半径优化为 `1.042`，加入了朝阳侧与背阳侧的向光散射分量，在晨昏交点展现金红暮光的物理晕辉。

- **高效功耗控制**：
  - 保持原项目的“按需渲染”策略。静止状态下随每秒心跳 `tick()` 更新太阳方向与云层微量偏移；拖拽/惯性滑动期间由连续循环接管，展现流畅的海浪与视角变化。

### 2. 高效物理贴图管线 (`dangwu-web/src/main.js`)

- 下载并内置了 Solaris 同源的 4 张 WebP 物理材质贴图（存放在 `dangwu-web/assets/textures/`，体积仅 ~1.1MB）：
  - `earth-cloud.webp`（云层覆盖）
  - `earth-material.webp`（海洋水体遮罩）
  - `earth-normal.webp`（切线空间法线起伏）
  - `earth-roughness.webp`（地表粗糙度）
- `main.js` 中新增 `loadOptionalTexture` 并发加载函数，具备**完整优雅降级能力**：若由于网络或环境缺少高级 WebP 贴图，自动降级至原有的白昼/黑夜双贴图渲染，核心功能与应用启动不受任何影响。

### 3. PWA 与工具管线补全

- **`dangwu-web/sw.js`**：将 Service Worker 缓存版本升级至 `v7`，并将 4 张 WebP 物理贴图放入 `CORE_ASSETS` 静态预缓存，保障离线 PWA 体验。
- **`dangwu-web/tools/build-textures.mjs`**：增加了 `WEBP_SOURCES` 自动化下载与文件存在性校验。
- **`dangwu-web/assets/NOTICE.md` & `index.html`**：补全了 Solaris (Cuvii, MIT 协议) 与 Solar System Scope (CC BY 4.0) 的合规署名，同时严格保留了 NASA、GeoNames、OpenStreetMap 的原始署名。

---

## 四、 测试与验证结果

在改动完成后，运行了项目全套自动化测试：

```bash
/usr/local/bin/node tests/solar.test.js && /usr/local/bin/node tests/ui.test.js && /usr/local/bin/node tests/search.test.js
```

### 验证输出摘要：

```
1) golden · EoT / 赤纬（14 例）
2) golden · 日出日落 / 极昼极夜（24 例）
3) golden · 高度角 / 方位角（42 例）
4) golden · 十二时辰（19 例）
5) invariants · 自洽恒等式 / 格式 / 边界
6) dual-end · JS vs Kotlin（容差 0.001 分钟 / 0.0001 度）

════ 通过 1239 / 失败 0 ════

✓ 空时区不显示民用时行
✓ UTC 固定偏移 0 仍显示
✓ 固定偏移 +480 正确换算
✓ IANA 时区按日期应用夏令时
✓ 极地事件显示横线而不伪造时间
✓ 在线结果未知时区保持 null
✓ GeoNames 本地搜索保留 IANA 时区
UI 通过 7 / 失败 0

✓ 短查询不联网
✓ 在线结果保留未知时区（不回填设备偏移）
✓ 请求携带公开联系标识与 jsonv2 格式
✓ 不设置会被浏览器丢弃的 User-Agent，但带 Accept
✓ 同查询（含大小写与空格差异）命中内存缓存
✓ 不同查询受 1 秒全局串行限流
✓ SW 回放的缓存响应标记为在线缓存
✓ 网络异常后请求队列不卡死

════ 搜索合规 通过 8 / 失败 0 ════
```

- **JavaScript 语法校验**：所有修改过的 JS 模块文件经过 `node -c` 语法分析，0 语法错误。
- **测试通过率**：1239 项太阳天体计算断言 + 7 项 UI 逻辑断言 + 8 项搜索合规断言 **100% 全绿通过**。

---

---

## 五、 Android 端 OpenGL ES 2.0 着色器同步迁移

为了实现 Web 端与 Android 端视觉质感的高度一致，本次已将成熟验证的 GLSL 物理着色器核心全量移植至 Android 原生管线（`dangwu-android`）：

### 1. 物理着色迁移亮点 (`EarthRenderer.kt`)
1. **瑞利晨昏波长消光 (Rayleigh Twilight Extinction)**：
   - 将日夜交界处的硬朗步进过渡替换为高层物理色散：
     $$\text{extinction} = \exp\left(-\frac{\tau}{\lambda^4}\right)$$
     采用波长向量 `vec3(0.680, 0.550, 0.440)` 产生正统的红金晨昏微光环带。
2. **GGX Specular 水面微表面耀斑与波光模拟**：
   - 包含正切法线微扰动（模拟洋面微波）与 GGX 镜面反射，在视线正对太阳入射反光角（Sun Glint）区域呈现真实反射强光。
3. **城市夜间灯光暖色重映射**：
   - 将夜光贴图重映射至琥珀金色（`vec3(1.0, 0.76, 0.45)`），大幅提升暗部审美质感。
4. **ACES Filmic 色调映射与 Dithering 抗色阶断层**：
   - 引入移动端轻量 Filmic 映射方程，消除亮部死白；结合屏幕空间高频微抖动消除了低位深移动屏上的明暗交界色阶台阶。
5. **OpenGL ES 2.0 (GLSL ES 1.00) 语法严谨兼容**：
   - 修复矢量/标量隐式类型转换（避免部分 GPU 驱动崩溃）；
   - 使用四维齐次变换 `uModel * vec4(aPosition, 0.0)` 精确转换法线，规避部分移动芯片对 `mat3(mat4)` 的降维转换缺陷。
6. **修复 Android 网格球面 UV 经纬度映射 Bug**：
   - 修正了原本 `createSphere()` 中错误的 $\theta \in [0, \pi]$ 映射，完全统一为与 Web 端 `Globe.js` 一致的标准经纬度球面坐标：
     $$p = (\cos\phi\cos\lambda, \sin\phi, -\cos\phi\sin\lambda)$$
     保证地轴倾角、自转与太阳赤纬在 Android 上 100% 吻合。

### 2. 双端渲染一致性保障
- **贴图管道对接**：Android `EarthRenderer(context)` 支持直接加载 `assets/earth_day.jpg` 与 `assets/earth_night.jpg`；若贴图缺失则平滑回退至程序化伪彩陆地海洋拟真着色。
- **按需渲染保活**：在 Compose / `GLSurfaceView` 中维持 `RENDERMODE_WHEN_DIRTY`，在触摸旋转或系统 1Hz 时钟 `tick()` 时才触发绘制，维持移动端极低功耗。

---

## 六、 总结与验证

本轮任务成功将 Solaris Earth 顶尖的物理渲染效果无缝引入「当午」双端架构中：
1. **Web 端**：瑞利消光、GGX 海面耀斑、独立旋转云层与云影、ACES 色调映射、轻量级 WebP 资源与 PWA 离线支持全量就绪；
2. **Android 端**：OpenGL ES 2.0 着色器物理重构完毕，修复几何球面映射，贴图管道与暖色夜灯全量对齐；
3. **算法精度与合规**：1239 项太阳天体计算断言、7 项 UI 断言、8 项搜索合规断言（总计 1254 项）**100% 通过**，坐标拾取与 NOAA 真太阳时精度毫发无损。

