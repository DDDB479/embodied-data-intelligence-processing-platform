# Embodied Data 质量引擎集成

平台的 `POST /api/assets/lerobot-deep-check` 现在会按 `bundleId` 将扁平上传文件临时还原为数据集目录，再调用 Embodied Data 插件的四个只读命令：

- `detect`：识别数据集格式和版本
- `info`：读取 Episode、帧数、FPS、机器人类型和特征定义
- `validate`：执行结构、元数据、特征、Episode、FPS 和 LeRobot 规范校验
- `quality`：统计 `observation.state`、`action` 的维度、数值范围和 NaN/Inf

临时目录使用硬链接，不复制大视频；检查结束后自动清理。结果写入轨迹资产的 `inspection.embodied`，并进入质检证据和问题门禁。

当前机器会自动尝试使用平台运行时 Python 加载相邻的 `具身平台插件开发/src`。部署到其他机器时，可设置：

```powershell
$env:EMBODIED_SOURCE_DIR = 'D:\path\to\embodied-data-platform\src'
$env:EMBODIED_PYTHON = 'D:\path\to\python.exe'
```

也可以直接设置 `EMBODIED_CLI` 指向 `embodied` 或 `embodied.exe`。健康接口会返回 `qcEngine: evidence-v3-embodied` 和 `embodiedPlugin: available|missing`。

## 算子与流程能力

`GET /api/engine/capabilities` 返回当前服务端真实能力，不把前端按钮当成能力声明。目录按上游 Embodied Data 的算子化思路拆分为 `sync`、`clean`、`compliance`、`perception`、`label`、`export` 六类，并标出每类的执行位置和状态。除 `perception` 外，基础能力均由本平台服务端执行；`perception` 只有在插件可被发现时才显示为可用，否则显示为可选插件，执行时返回明确错误。

接口同时返回八个生产阶段：导入、清洗、筛选、标注、审核、质检、转换、交付。质检和交付结果必须带输入指纹、规则快照、问题证据及产物哈希，未满足门禁不会生成可交付结果。该集成借鉴上游项目的流程和算子边界，但保留本平台现有的真实文件存储、角色权限和验收门禁。
