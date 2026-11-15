# 旧版本升级指南

当前稳定版本为 `v3.6.3`，上一发布源码快照为 `1fb00bd`。本次升级增加了 UMI Session 接入、HDF5 与 UMI 原生 LeRobot 交付、浏览器兼容预览、小文件上传吞吐优化，以及统一任务中心。平台界面已同步更新，当前截图见 [SCREENSHOTS.md](SCREENSHOTS.md)。

## 会保留什么

- `work/` 中的账号、SQLite 业务数据、原始文件、预览、备份和交付包不会被源码更新删除或覆盖。
- `runtime/` 中的本地 Node.js、Python 和官方 LeRobot 运行环境不会被源码更新覆盖。
- 现有 SQLite 数据继续原位使用；更新脚本不会执行 `git reset`、`git clean`，也不会清空业务目录。
- 更新前会在 `work/backups/before-update-*.sqlite` 创建一个一致的数据库备份。

## 推荐方式：双击更新

当前版本仓库根目录提供 `更新平台.bat`。确认电脑已安装 Git 和 Node.js 后，直接双击该文件。

更新窗口会依次完成：

1. 检查当前是否为 `main` 分支，以及是否存在未提交或未跟踪的源码改动。
2. 备份 SQLite 数据库。
3. 拉取并快进合并 `origin/main`。
4. 同步 Python 交付依赖；如果存在 `uv`，同步官方 LeRobot 运行环境。
5. 重启托管服务，并等待 `/health` 健康检查通过。

只要工作区不干净，脚本就会停止，不会覆盖本地修改。`work/`、`runtime/`、日志和缓存不属于源码，更新时可以继续保留。

## 从 1fb00bd 第一次升级

旧版本中还没有 `更新平台.bat`，因此第一次需要取得当前仓库的更新入口。在仓库目录右键打开终端，执行：

```powershell
git status --short
git pull --ff-only origin main
```

如果 `git status --short` 显示任何源码修改，请先提交、备份或妥善处理，不要强制拉取覆盖。拉取完成后，双击仓库中的 `更新平台.bat`，并等待窗口显示 `Platform update completed.`。

以后有新版本时，直接双击同一个 `更新平台.bat` 即可。

## 高级用法

仍可在 PowerShell 中运行底层脚本。只更新源码但不重启服务：

```powershell
.\update-platform.ps1 -NoRestart
```

依赖由其他流程管理时：

```powershell
.\update-platform.ps1 -SkipDependencies
```

两种参数可以同时使用。普通使用者不需要添加参数。

## 更新后检查

1. 打开 `http://localhost:4173/health`，确认 `version` 为 `3.6.3`。
2. 登录平台，确认原有业务记录、任务和已验收批次仍在。
3. 打开一个原有 HDF5 或 UMI 批次，确认源文件清单和 Episode 数量没有变化。
4. 运行一次标准质检。
5. 打开一个 UMI Episode，确认 H.264 预览可以播放。
6. 确认 `work/backups/before-update-*.sqlite` 已生成后，再接受本次更新。

## 回滚

源码回退和数据回退是两件事。更新失败时，先保留现场和 `work/backups/`，不要自行混用不同时间的 `platform.sqlite`、`platform.sqlite-wal` 和 `platform.sqlite-shm`。

如需回退源码，可停止平台后切回上一快照：

```powershell
git switch --detach 1fb00bd
```

如需同时回退业务数据库，请按 [操作说明](OPERATIONS.md) 中的完整备份恢复流程操作，并确保平台已经停止。不要只覆盖 `platform.sqlite` 而保留旧 WAL 文件。

## 注意事项

- 当前仍是单机部署。同一个 `work/` 目录不能同时运行多个服务监管进程。
- 更新过程需要访问 GitHub；网络失败时脚本会在源码更新前停止或保留已创建备份。
- 本指南只负责源码和依赖升级，不代表具体生产数据已经通过验收。
