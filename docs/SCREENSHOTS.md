# 界面截图来源

拍摄日期：2026-11-15（Asia/Shanghai）。页面来自当前版本在本机实际运行的浏览器界面，未使用生成式图片拼接或重绘。

## 数据与环境

- 截图对应服务版本 `3.6.3`，使用本机隔离的演示和验证记录，不连接生产账号或生产存储。
- 浏览器视口宽度为 1600 像素；页面导航、筛选、状态和表格均为当前版本真实渲染结果。
- 截图只用于说明界面与操作入口，不代表截图中的批次已经完成生产验收。
- 导入、质检、转换和交付数量来自本地验证过程；运行状态和产物编号只属于该次验证。

## 隐私处理

- 账号名统一替换为 `Demo Admin`，头像使用单个字母 `D`。
- 业务包名、Scenario、Session 和资产编号已在浏览器显示层替换为 `UMI Demo Batch`、`teleop_demo`、`session_demo_00001` 等演示值。
- 质检批次编号统一替换为 `QC-DEMO-00001`。
- 当前截图不包含本地绝对路径、账号密码、登录凭证、生产文件或运行时目录。
- UMI 截图保留播放器、帧数、时长和状态，真实采集视频画面已隐藏并替换为演示遮罩。
- 隐私替换只作用于截图页面显示，未修改服务端业务记录或原始文件。

## 图片索引

| 图片 | 内容与范围 |
| --- | --- |
| [10-overview-current.png](screenshots/10-overview-current.png) | 当前批次总览、四个核心入口、质量健康度和待处理问题 |
| [11-intake-current.png](screenshots/11-intake-current.png) | 服务端目录导入、批次分组、文件规模和入库状态 |
| [12-production-current.png](screenshots/12-production-current.png) | 生产批次的导入、质检、问题、标注、验收和交付门禁 |
| [13-annotation-current.png](screenshots/13-annotation-current.png) | 标注标准、Episode 与视频覆盖率、异常复核和审核状态 |
| [14-assets-current.png](screenshots/14-assets-current.png) | UMI Session、遥操 HDF5、LeRobot 资产的筛选与批量操作 |
| [15-jobs-current.png](screenshots/15-jobs-current.png) | 上传、清洗、质检、标注、转换进度及后台任务操作 |
| [16-delivery-current.png](screenshots/16-delivery-current.png) | LeRobot v3.0、MCAP、Zarr、官方加载、独立验包和下载 |
| [17-umi-playback-current.png](screenshots/17-umi-playback-current.png) | UMI Episode 的 H.264 播放器、帧数、时长、质检和标注状态 |
| [18-system-management-current.png](screenshots/18-system-management-current.png) | 系统管理、质量门禁、处理算子、规则、成员权限和审计入口 |

## 展示范围

README 将截图按“批次总览、数据接入、生产批次、标注审核、任务中心、交付核验、数据浏览、系统管理”组织，并单独展示 UMI 播放页。不同图片展示的是验证流程的不同页面和状态，不应拼接解释为一条生产数据全部通过验收。

旧版 `00-*` 至 `09-*` 图片继续保留在仓库中用于历史对照，但当前 README 和本索引只引用 2026-11-15 拍摄的 `10-*` 至 `18-*` 当前界面截图。

## 重新拍摄

重新截图时应使用本机测试账号和演示数据，并执行以下检查：

1. 浏览器视口保持 1600×1000，避免不同缩放比例导致表格与按钮错位。
2. 确认导航、页签、任务状态和操作入口与当前版本一致。
3. 在截图前替换账号、业务名称、Session、资产和批次编号，并确认页面中没有本地绝对路径。
4. UMI 或其他带真实视频画面的页面必须遮挡视频内容，只保留播放器结构和脱敏状态。
5. 重新核对文件尺寸、可读性和敏感信息后，再更新 README 与本文日期。

README 通过仓库内相对路径展示图片，GitHub 可直接渲染，点击图片可查看原图。
