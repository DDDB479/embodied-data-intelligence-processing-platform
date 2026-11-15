# 操作与部署说明

本页命令均在仓库根目录执行。源码不附带运行时或生产数据。v3.0 的检查阈值、断点续传、后台任务与完整恢复步骤见 [生产升级说明](PRODUCTION_UPGRADE.md)。

## 运行要求

- Windows 10/11
- Node.js 22.13 或更高版本（推荐 24 LTS）
- PowerShell 5.1 或更高版本
- LeRobot/Parquet 深度校验需要 Python 3.12 和 `pyarrow`
- LeRobot v3.0 训练交付需要独立锁定的 LeRobot 0.4.4、Torch 2.7.1 CPU、PyAV 和 datasets 运行时

## 启动

```powershell
node .\serve.js
```

浏览器访问 `http://localhost:4173/`。

Windows 上也可以运行 `启动平台.bat`。该启动器会检查健康状态，并通过计划任务维持服务。若需要局域网访问，使用 `开启局域网访问.bat` 后，从同一网络的其他电脑访问本机局域网 IP 的 4173 端口。

## 数据与安全

生产数据保存在本机 `work/` 目录中，不纳入 Git。首次启动时在平台内创建管理员账号；账号密码只保存在服务端加盐哈希中。账号、业务记录、后台任务与上传会话保存在 `work/platform.sqlite`。请勿把 `work/` 中的数据库、遗留认证 JSON、上传文件或备份提交到公共仓库。

## 上传与下载性能

浏览器导入最多同时上传 3 个文件。每个文件默认按 16 MiB 分片；活动会话的进度和分片摘要保存在 `work/upload-sessions/` 的独立清单中，不会在每个分片后同步重写全部上传记录。服务重启后沿用最后一次检查点，未提交的文件尾部会被截断并重传。分片完成时会完整复核摘要、计算整文件 SHA-256 并直接重命名到原始文件目录。

逐帧 HDF5 不应走浏览器逐文件上传。超过 200 个纯 `.h5/.hdf5` 文件时，平台会阻止批量登记并提示使用“服务端目录导入”。该入口扫描部署电脑上的目录，把每个包含 HDF5 帧文件的子目录聚合为一个 Episode，只写入小型序列清单，源文件保留原位。以 `matching_cable/68` 到 `74` 为例，11,879 个帧文件会登记为 7 个 Episode，而不是 11,879 个资产。

### Episode 预览缓存

HDF5 Episode 的四路预览在首次打开时按需生成，也可在 Episode 页批量加入队列。预览任务与质检、转换共用持久化单 worker，因此同一时间只运行一个编码任务，不会并行占满 CPU。每帧只打开一个 HDF5，生成四路 H.264 后立即释放，进程内存保持在数百 MB 级。

预览默认输出 640 宽、源 FPS、CRF 28，并附带首中末 JPEG 缩略图。缓存目录为 `work/previews/<资产编号>/<源指纹>/`，源目录指纹变化后旧缓存不会继续使用。页面提供四宫格同步播放、单机位切换、时间轴与预览缓存清理；视频接口支持 HTTP Range。缓存可以在不影响原始 HDF5、质检或 LeRobot 交付的情况下删除。

本机真实容量样本：Episode 68 共 1,777 帧，四路预览生成约 229 秒，编码进程峰值工作集约 218 MB，缓存约 15 MB。按当前参数，7 条约需 100 MB 级缓存，并始终串行执行，不会同时启动多个编码进程。

启动服务前可设置 `UPLOAD_CHUNK_SIZE_MB`，允许 1 到 64，默认 16。局域网优先使用有线网络；Wi-Fi 协商速率不等于实际吞吐，应先以真实数据包压测确认网络上限。交付 ZIP 支持 HTTP Range、`ETag` 和断点续传，普通下载不会预先扫描整个归档；完整性仍可通过 SHA-256 和独立校验接口确认。

任务中心统一汇总上传会话和后台任务。上传任务支持暂停、继续和删除：暂停会阻止后续分片发送，继续从服务端偏移恢复，删除会清理未完成临时文件。页面刷新后浏览器不再持有本地文件句柄，此时需重新选择原文件才能继续。运行中的质检和转换任务不提供强制暂停或删除，以免留下不一致的半成品；排队任务可以安全暂停和删除。

## 数据质检边界

平台区分“数据缺陷”和“质检能力限制”。文件不存在、摘要变化、结构错误、非有限数值、图像无法解码、时间缺口等属于可定位的数据问题；“解析器不支持”或“缺少必要标定元数据”属于质检阻塞或限制，不得用伪造分数代替。

遥操 HDF5 当前支持 `teleop-hdf5-v1` 和 `matching_cable_frames_v1` 结构：检查时间戳、主从关节/末端位姿、力通道、4 路 RGB、2 路深度图像，并按同一目录内全部帧推断 FPS、重复时间戳和缺口。服务端目录导入会把整个帧目录作为一个 Episode 流式检查。`puppet/6f` 为可选通道，缺失或恒零会记录为未启用限制，不生成数据缺陷。缺少关节单位、相机内参/外参时仍会记录结果，但物理量语义和跨模态标定保持为未验证。

`matching_cable_frames_v1` 转换为官方 LeRobot v3.0 时，`master/joint_position` 写入 `action`，`puppet/joint_position` 写入 `observation.state`；`puppet/eef`、`master/eef`、关节力矩和六维力作为附加数值字段。四路 RGB 转为视频，两路深度图验证可读后保留在原始 HDF5 中。转换完成后继续执行官方 Dataset、首中末帧和 DataLoader 验包。

运行环境需要 `h5py`、`av`、`numpy`、`pyarrow`。生产质检会实际解码图像和视频，数据集越大耗时越长；建议按批次执行，不要对已完成且文件未变化的批次反复全量扫描。

## 自动识别已有标注

上传完成后，服务端会自动分析根目录或 `meta/` 下的 `annotations.jsonl`，并兼容 `meta/episodes.jsonl` 的 `tasks` 以及 `meta/tasks.jsonl` 与 Parquet `task_index` 的组合。标注文件至少需要能解析出 Episode 编号和任务指令。

自动导入会记录源文件路径、SHA-256、匹配数量和解析错误。全部 Episode 均匹配时，标注直接通过且不再要求人工填写；部分匹配时只把未覆盖 Episode 留在人工队列。文件中的不同指令会按 Episode 保留，转成 LeRobot 交付时会重建 `task_index` 并回写 Parquet，避免任务索引冲突。

## 入库、删除与进度

入库分组要求由数据包预设决定。LeRobot v2.1 与标准三组包要求 `meta`、`trajectory`、`media`；HDF5、MCAP、Parquet、结构化数据和媒体包按预设使用对应必需组。已登记资产必须全部完成原始文件上传，质量检测接口才会接受该批次。跨文件缺片仍由质量规则检出。

数据资产页可按类型、状态、模型、数据包和文件夹筛选。勾选资产后可批量删除；选择具体数据包或文件夹后，还可直接删除整个范围。已验收、归档或已被数据集/交付记录引用的资产仍由服务端拒绝删除。

任务中心按生产任务和数据包展示上传、清洗、质检、标注、转换五个阶段及总进度，并继续保留后台任务执行详情与业务待办。

## 数据标注

源标注未覆盖的范围仍按采集任务或数据集人工处理，一个任务只维护一条任务指令，不要求逐 Episode 重复填写。人工流程为：

1. 完成轨迹质检后，在“标注与审核”中查看自动导入未覆盖的任务或数据集。
2. 每个范围填写一条任务指令；同一任务下的全部 Episode 自动继承，不生成逐条填写页面。
3. 保存指令后提交一次审核；审核阶段只能填写意见，不能修改指令。
4. 审核通过后，该范围内的全部 Episode 同时满足标注门禁；退回后可修改并重新提交。
5. 导出时平台把任务指令展开到每个 Episode 的 `annotations.jsonl`，无需人工逐 Episode 操作。

资产带有 `taskId` 时按采集任务归组；尚未关联采集任务时按导入数据集（`bundleId`）归组。后续将资产绑定到同一采集任务后，一个任务可以覆盖多个数据包。

例如同一采集任务的多个数据包，可以共同使用一条审核后的通用任务指令；请填写与自己任务一致的内容。

源文件中的逐 Episode 指令、执行结果、失败原因和动作分段会在安全的情况下保留并写入交付。人工任务指令仍以任务或数据集为单位；平台不会把源文件缺失的信息推断成成功或完整动作分段。

## 交付清单与多视角

一个生产批次只生成一份交付清单。服务端按 `bundleId` 校验唯一性，重复生成会直接返回已有清单，不会新增交付记录。导出入口必须先选择具体批次，不能把多个批次混入同一份清单。

遥操数据以 Episode 为逻辑数据条数：一个 `episode_XXXXXX.parquet` 及其全部相机视角共同组成一条数据。视角名称从 `meta/info.json` 的 `features` 中读取，例如 `observation.images.head`、`left`、`right`、`fourth`。只有某个 Episode 的声明视角全部存在时，才满足批次验收和交付门禁；Manifest 中会把 4 个 MP4 归入同一条 Episode，而不会按文件数重复计算数据条数。

视角数量不按 UMI、EGO 或遥操类型写死，而是从数据集自身检验：优先读取 `meta/info.json` 中 `features` 的视频字段；缺少该声明时，从同一数据集的 `videos/` 目录提取实际视角并建立该批次自己的视角集合。随后逐个 Episode 检查是否包含该集合，任一 Episode 缺视角都会进入“待补齐”，不能验收或交付。

### V6 多格式交付

在“导出与交付”选择已验收批次和目标格式。每个批次保留一份基础交付记录，可分别追加 LeRobot、MCAP、Zarr 产物。转换完成后提供经过 ZIP CRC 验证的下载包及 SHA-256；失败的转换不会登记为成功。

- LeRobot：官方 v3.0 目录，保留全部 Parquet 列、视频分片和审核后的任务指令；通过官方 0.4.4 Dataset 加载、首中末帧解码与 DataLoader 冒烟后才可交付。
- MCAP：每个 Episode 一个 `.mcap`，按原时间戳写入 JSON 轨迹消息；原视频以独立文件随 ZIP 保留，MCAP 元数据记录相对路径。使用 `embodied-json` profile，不是 ROS/ROS2 bag，不包含解码后图像话题。
- Zarr：每个 Episode 一个 Zarr v2 group，数值列保存为数组，其余列以带编码说明的 JSON 字符串保存；原视频、元数据和审核指令随 ZIP 保留。不是所有训练框架通用的特定 Zarr 布局，消费者应按列名和属性读取。

平台内部先把源数据物化为 LeRobot v2.1 工作目录，再调用官方 0.4.4 转换器生成 LeRobot v3.0；对外交付格式不再标记为 v2.1。MCAP 和 Zarr 仍从该 v2.1 工作目录生成。其他原始格式必须先成功生成完整 LeRobot 基础目录；不承诺任意源格式之间无损互转。转换逐 Episode 回读全部列值和时间戳，并验证视频。LeRobot v3.0 还会由独立程序解包回读、核对文件清单和数据集指纹、逐帧解码视频、检查 Episode/相机/帧数对应，并校验官方加载报告。转换和 ZIP 会额外占用磁盘，需预留输出空间。

Python 依赖安装：

```powershell
.\runtime\python\Scripts\python.exe -m pip install -r tools\requirements-delivery.txt
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $PWD 'runtime\lerobot')
uv sync --project tools\lerobot-runtime --locked
```

部署时仅开放首页、`assets/` 和界面图片的静态访问；`work/`、`.git/` 及源码不作为静态文件公开。交付 ZIP 通过登录和角色鉴权后的 `/api/exports/<id>/package?format=mcap|zarr|lerobot` 下载。

### LeRobot 基础目录

服务端会把所选批次物化到 `work/deliveries/<清单编号>/lerobot/` 作为 v2.1 工作目录，保留 `meta/`、`data/` 和 `videos/` 结构，并记录源文件格式、视角数量与校验证据。最终 LeRobot 训练交付位于 `converted/`，格式为官方 v3.0；MCAP、Zarr 产物也存放在该目录。

源数据已经是 LeRobot v2.x 时采用硬链接物化，不复制大文件也不丢失视频。LeRobot v3.0 使用独立运行时 `runtime/lerobot/Scripts/python.exe`，版本固定为 LeRobot 0.4.4；缺少运行时或版本不符时，最终 LeRobot 转换会被阻断。非 LeRobot 源只能在转换器确认不会丢弃视频流时处理；如果会删除 `observation.images.*` 视频特征，平台会拒绝生成交付包，而不是产出一个缺视角的“伪 LeRobot”数据集。

## V6 流程模板

平台以 V6 作为生产流程模板，V5 和配音分支不再进入新流程。V6 模板覆盖采集接入、融合预处理、自动与人工质检、位姿准备与标注、裁剪/语义/翻译、跳过语义条件分支、交付打包和 LeRobot/MCAP/Zarr 输出。

每个节点记录执行类型和真实可用状态：

- `已完成`：平台已有真实证据。
- `待执行`：能力已接入，等待当前批次执行。
- `未接入`：算法、人工任务或转换器尚未接入，不能计入完成，也不能让批次伪装成 V6 完整闭环。

当前已接入的主要节点包括文件夹导入、自动质检、问题处置、任务指令标注、LeRobot 交付物化、MCAP/Zarr 转换、交付检测和批次验收；数据融合、脱敏、去畸变、点云、位姿/语义标注等节点仍处于待接入状态。MCAP/Zarr 节点仅在对应产物转换与回读校验成功后完成。

## 验证

```powershell
node --check serve.js
node --check assets\extensions.js
node --test tests\annotation-workflow.test.js tests\annotation-api.test.js tests\workflow-gates.test.js tests\workflow-api.test.js
node --test tests\delivery-api.test.js
.\runtime\python\Scripts\python.exe -m unittest discover -s tests -p test_delivery_convert.py -v
```

LeRobot 数据深度校验脚本位于 `tools/lerobot_schema_check.py`，用于检查 Parquet 字段、行数、动作/观测列和 Episode 结构；平台不会把未通过真实校验的数据伪装成已验收状态。
