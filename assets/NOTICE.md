# 数据与服务署名

## 地球影像
- `earth_day_4096.jpg`（4096×2048）—— NASA Blue Marble 同源白昼影像
- `earth_night_4096.jpg`（4096×2048）—— NASA Black Marble 同源夜灯影像

两者取自 three.js 官方仓库 `examples/textures/planets/`：
https://github.com/mrdoob/three.js

原始影像来自 NASA，属公有领域：
https://science.nasa.gov/earth/earth-observatory/

- `earth_day_8192.jpg`（8192×4096）—— 高分辨率白昼贴图
- `earth_night_8192.jpg`（8192×4096）—— 高分辨率夜灯贴图
- `textures/earth-cloud.webp` —— 云层覆盖图
- `textures/earth-material.webp` —— 海洋水体遮罩图
- `textures/earth-normal.webp` —— 切线空间法线起伏图
- `textures/earth-roughness.webp` —— 地表粗糙度图

以上影像源自 Solar System Scope 纹理库，依 CC BY 4.0 使用（署名：Solar System Scope）：
https://www.solarsystemscope.com/textures/
地球物理散射模型、海洋波光耀斑（GGX Glint）与云层投影算法参考并改进自 Solaris（Cuvii，MIT 协议）：
https://github.com/thecuvii/solaris
https://solaris.cuvii.dev/earth/

## 离线城市索引
`src/data/cities.json` 由 `tools/build-cities.mjs` 从 GeoNames `cities15000` 与
`alternateNamesV2` 构建。数据依 CC BY 4.0 使用：
https://www.geonames.org/

具体快照日期、校验和与条目数见 `src/data/cities.meta.json`。

## 在线搜索
在线搜索由 Nominatim 提供，底层数据 © OpenStreetMap contributors：
https://nominatim.org/
https://www.openstreetmap.org/copyright

公共服务联系标识为 `dangwu-app@users.noreply.github.com`；输入时只搜索离线索引，
用户显式提交后才访问在线服务。

