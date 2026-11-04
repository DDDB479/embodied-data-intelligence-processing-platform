# 界面截图来源

拍摄日期：2026-11-04（Asia/Shanghai）。页面来自本仓库代码在本机实际运行的浏览器截图，未经界面内容拼接或生成式重绘。

## 数据与环境

- 使用交付接口测试的隔离夹具，独立运行服务与临时 `DATA_WORK_DIR`；生产服务和生产 `work/` 未用于截图。
- 数据集名为 `Demo Teleoperation Batch`，账号为 `Demo Admin`、`Viewer`，邮箱使用 `example.invalid` 测试域。
- 合成样本包含 2 个 Episode、6 行轨迹与一个相机视角。Parquet 是实际生成的文件，MP4 路径中的媒体内容是字节保真测试占位内容，不是可播放的采集视频。
- 转换测试预置了质检和验收状态，用于单独验证转换、校验和下载接口；它不等价于经过全部导入、质检和人工验收的生产数据。
- 质检与问题截图是在上述隔离环境中，点击“全部数据 → 开始质检”后的实际结果：6 项问题、0% 通过率。没有为展示而将问题关闭或改为通过。
- 标注页通过实际的“重新打开 → 修改指令 → 提交审核”操作展示待审核状态。

## 图片索引

| 图片 | 内容与范围 |
| --- | --- |
| [00-overview.jpg](screenshots/00-overview.jpg) | 实际质检后的总览，保留待处理问题 |
| [01-intake.jpg](screenshots/01-intake.jpg) | 交付接口夹具初始化后的目录分组与数据包列表 |
| [02-production.jpg](screenshots/02-production.jpg) | 质检执行并刷新服务端状态后的 V6 模板与门禁阻断 |
| [03-quality.jpg](screenshots/03-quality.jpg) | 实际执行的检测批次与失败结果 |
| [04-issues.jpg](screenshots/04-issues.jpg) | 检测生成的问题、证据及复检入口 |
| [05-annotation.jpg](screenshots/05-annotation.jpg) | 合成任务指令提交审核后的界面 |
| [06-rules.jpg](screenshots/06-rules.jpg) | 默认规则、阈值与本机可发现的引擎能力；插件状态依赖部署环境 |
| [07-delivery.jpg](screenshots/07-delivery.jpg) | 预置验收状态的转换专项测试；三种格式均经真实转换和回读 |
| [08-permissions.jpg](screenshots/08-permissions.jpg) | 隔离测试账号及权限页面，不展示真实成员 |
| [09-runs.jpg](screenshots/09-runs.jpg) | 实际检测运行的节点轨迹与问题证据摘要 |

这些图片用于说明页面与操作入口。不同页面展示的是测试环境的不同阶段，不应拼接解释为一条生产验收全通过的完整链路。运行时间、评分和产物编号仅属于该次隔离测试。

## 重新生成

安装转换依赖后，可运行仓库中的测试演示模式：

```powershell
$env:DELIVERY_UI_PREVIEW = '1'
node tests/delivery-api.test.js
```

测试会创建独立临时目录，完成接口检查，并在 `http://127.0.0.1:4186/` 短时打开一个仅绑定本机回环地址的测试代理。代理在此隔离测试实例上注入测试会话，不要把此模式用于生产服务或局域网展示。按回车或等待 5 分钟后结束，临时状态随测试清理。

上述模式用于准备测试页面，不自动截图。重新拍摄时通过浏览器操作，仍应使用合成文件和测试账号，核对截图内容，并更新本文的日期和范围。README 通过仓库内相对路径展示图片，GitHub 可直接渲染，点击可查看原图。
